// Parity test for chat import endpoints. Pre-Stage-1 these wrote files to
// disk directly and were invisible to db engines.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as chatsRouter } from '../../../src/endpoints/chats.js';
import { getChatRepo } from '../../../src/storage/index.js';

// Multer shim — instead of pulling in the real multer middleware, place a
// pre-existing temp file on disk and synthesize the request.file object the
// handler expects. The handler then `fs.readFileSync(temp)` + `fs.unlinkSync(temp)`
// exactly as in production. Tests therefore exercise the real handler path,
// not a sanitized variant.
function mountMulterShim(app, uploadProvider) {
    app.use('/api/chats/import', (req, _res, next) => {
        const { destination, filename, content } = uploadProvider();
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, filename), content);
        req.file = { destination, filename };
        next();
    });
    app.use('/api/chats/group/import', (req, _res, next) => {
        const { destination, filename, content } = uploadProvider();
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, filename), content);
        req.file = { destination, filename };
        next();
    });
}

const GROUP_JSONL = [
    JSON.stringify({ user_name: 'tester', character_name: '', chat_metadata: { is_group_chat: true } }),
    JSON.stringify({ name: 'User', is_user: true, mes: 'hi everyone' }),
    JSON.stringify({ name: 'Bot1', is_user: false, mes: 'hello' }),
].join('\n');

describe.each(ENDPOINT_HARNESSES)('chat import endpoints on $name', ({ mode }) => {
    let harness;
    let uploadPayload;

    beforeEach(async () => {
        uploadPayload = null;
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                mountMulterShim(app, () => uploadPayload);
                app.use('/api/chats', chatsRouter);
            },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('REGRESSION: /api/chats/group/import writes through ChatRepo', async () => {
        uploadPayload = {
            destination: path.join(os.tmpdir(), `import-test-${Date.now()}`),
            filename: 'upload.jsonl',
            content: GROUP_JSONL,
        };
        const res = await request(harness.app)
            .post('/api/chats/group/import')
            .send()
            .expect(200);
        expect(res.body.error).not.toBe(true);
        const chatname = res.body.res;
        expect(typeof chatname).toBe('string');

        const chat = await getChatRepo().get(harness.handle, '', chatname, { isGroup: true, groupId: chatname });
        expect(chat).not.toBeNull();
        expect(chat.body).toHaveLength(2);
        expect(chat.body[0].mes).toBe('hi everyone');
        expect(chat.body[1].mes).toBe('hello');

        // Multer temp file must be cleaned up.
        expect(fs.existsSync(path.join(uploadPayload.destination, uploadPayload.filename))).toBe(false);
    });

    test('REGRESSION: /api/chats/group/import without header tags as group via engine options, not header metadata', async () => {
        // Bug guarded: createChatHeader({ is_group_chat: true }) mis-nested
        // the flag at chat_metadata.is_group_chat. Group-tagging must come
        // from ChatRepo.save's isGroup/groupId options, not header content.
        // Headerless payload triggers the fallback path that synthesizes
        // a fresh header via createChatHeader({}).
        const HEADERLESS = [
            JSON.stringify({ name: 'User', is_user: true, mes: 'headerless hi' }),
            JSON.stringify({ name: 'Bot', is_user: false, mes: 'headerless hello' }),
        ].join('\n');
        uploadPayload = {
            destination: path.join(os.tmpdir(), `import-headerless-${Date.now()}`),
            filename: 'upload.jsonl',
            content: HEADERLESS,
        };
        const res = await request(harness.app)
            .post('/api/chats/group/import')
            .send()
            .expect(200);
        expect(res.body.error).not.toBe(true);
        const chatname = res.body.res;
        expect(typeof chatname).toBe('string');

        const chat = await getChatRepo().get(harness.handle, '', chatname, { isGroup: true, groupId: chatname });
        expect(chat).not.toBeNull();
        expect(chat.body).toHaveLength(2);
        expect(chat.body[0].mes).toBe('headerless hi');
        // Header was synthesized; chat_metadata must NOT carry the legacy
        // is_group_chat field — group identity lives in engine options.
        expect(chat.header?.chat_metadata?.is_group_chat).toBeUndefined();
    });

    test('REGRESSION: /api/chats/import (jsonl) writes through ChatRepo', async () => {
        const avatarUrl = 'Alice';
        const characterName = 'Alice';
        const userName = 'User';
        const JSONL = [
            JSON.stringify({ user_name: userName, character_name: characterName, chat_metadata: {} }),
            JSON.stringify({ name: 'User', is_user: true, mes: 'imported hi' }),
            JSON.stringify({ name: 'Alice', is_user: false, mes: 'imported hello' }),
        ].join('\n');
        uploadPayload = {
            destination: path.join(os.tmpdir(), `import-jsonl-${Date.now()}`),
            filename: 'upload.jsonl',
            content: JSONL,
        };
        const res = await request(harness.app)
            .post('/api/chats/import')
            .send({ avatar_url: `${avatarUrl}.png`, character_name: characterName, user_name: userName, file_type: 'jsonl' })
            .expect(200);
        expect(res.body.error).not.toBe(true);
        expect(Array.isArray(res.body.fileNames)).toBe(true);
        const fileName = res.body.fileNames[0];
        const name = path.parse(fileName).name;

        const chat = await getChatRepo().get(harness.handle, avatarUrl, name);
        expect(chat).not.toBeNull();
        expect(chat.body).toHaveLength(2);
        expect(chat.body[0].mes).toBe('imported hi');
        expect(chat.body[1].mes).toBe('imported hello');

        expect(fs.existsSync(path.join(uploadPayload.destination, uploadPayload.filename))).toBe(false);
    });

    test('REGRESSION: /api/chats/import (json — kobold lite) writes through ChatRepo', async () => {
        const avatarUrl = 'Bob';
        const characterName = 'Bob';
        const userName = 'User';
        // Kobold-Lite payload: actions are strings containing the {{[INPUT]}}/{{[OUTPUT]}}
        // tokens that importKoboldLiteChat uses to detect user vs character messages.
        // savedsettings present (even empty) is what routes the importer at the dispatch
        // switch in /api/chats/import.
        const KOBOLD = JSON.stringify({
            savedsettings: {},
            actions: [
                '{{[OUTPUT]}} hi from kobold',
            ],
            prompt: '{{[INPUT]}} opening line',
        });
        uploadPayload = {
            destination: path.join(os.tmpdir(), `import-json-${Date.now()}`),
            filename: 'upload.json',
            content: KOBOLD,
        };
        const res = await request(harness.app)
            .post('/api/chats/import')
            .send({ avatar_url: `${avatarUrl}.png`, character_name: characterName, user_name: userName, file_type: 'json' })
            .expect(200);
        expect(res.body.error).not.toBe(true);
        expect(Array.isArray(res.body.fileNames)).toBe(true);
        const name = path.parse(res.body.fileNames[0]).name;

        const chat = await getChatRepo().get(harness.handle, avatarUrl, name);
        expect(chat).not.toBeNull();
        expect(chat.body.length).toBeGreaterThan(0);
    });

    test('REGRESSION: /api/chats/import (json — Ooba) writes through ChatRepo', async () => {
        // Ooba detected via `Array.isArray(jsonData.data_visible)` at chats.js:2886.
        // importOobaChat (chats.js:531) returns a single jsonl string — exercises
        // the non-array branch of the handler's `Array.isArray(chat)` dispatch.
        const avatarUrl = 'Diana';
        const characterName = 'Diana';
        const userName = 'User';
        const OOBA = JSON.stringify({
            data_visible: [
                ['hi from ooba user', 'hi from ooba char'],
            ],
        });
        uploadPayload = {
            destination: path.join(os.tmpdir(), `import-ooba-${Date.now()}`),
            filename: 'upload.json',
            content: OOBA,
        };
        const res = await request(harness.app)
            .post('/api/chats/import')
            .send({ avatar_url: `${avatarUrl}.png`, character_name: characterName, user_name: userName, file_type: 'json' })
            .expect(200);
        expect(res.body.error).not.toBe(true);
        expect(Array.isArray(res.body.fileNames)).toBe(true);
        expect(res.body.fileNames).toHaveLength(1);
        const name = path.parse(res.body.fileNames[0]).name;

        const chats = await getChatRepo().listForCharacter(harness.handle, avatarUrl);
        expect(chats).toHaveLength(1);

        const chat = await getChatRepo().get(harness.handle, avatarUrl, name);
        expect(chat).not.toBeNull();
        expect(chat.body.length).toBeGreaterThan(0);
        const messageTexts = chat.body.map((m) => m.mes);
        expect(messageTexts).toContain('hi from ooba user');
        expect(messageTexts).toContain('hi from ooba char');
    });

    test('REGRESSION: /api/chats/import (json — CAI) dispatches to the array-return branch', async () => {
        // CAI detected via `jsonData.histories !== undefined` at chats.js:2884.
        // importCAIChat (chats.js:601) returns an array — exercises the
        // `Array.isArray(chat)` true branch of the handler. We use an empty
        // histories array because the upstream importCAIChat has a known TDZ
        // bug when histories is non-empty (`newChats.push` inside its own
        // initializer), so the only safely-exercisable shape is the empty-array
        // case. That still proves the dispatch + array branch run without
        // error, which is what this regression locks down for db modes.
        const avatarUrl = 'Eve';
        const characterName = 'Eve';
        const userName = 'User';
        const CAI = JSON.stringify({
            histories: {
                histories: [],
            },
        });
        uploadPayload = {
            destination: path.join(os.tmpdir(), `import-cai-${Date.now()}`),
            filename: 'upload.json',
            content: CAI,
        };
        const res = await request(harness.app)
            .post('/api/chats/import')
            .send({ avatar_url: `${avatarUrl}.png`, character_name: characterName, user_name: userName, file_type: 'json' })
            .expect(200);
        expect(res.body.error).not.toBe(true);
        expect(Array.isArray(res.body.fileNames)).toBe(true);
        expect(res.body.fileNames).toHaveLength(0);

        // Nothing should have landed in the Repo (zero histories → zero chats).
        const chats = await getChatRepo().listForCharacter(harness.handle, avatarUrl);
        expect(chats).toHaveLength(0);
    });

    test('REGRESSION: solo-import survives engine restart', async () => {
        const avatarUrl = 'Carol';
        const JSONL = [
            JSON.stringify({ user_name: 'User', character_name: 'Carol', chat_metadata: {} }),
            JSON.stringify({ name: 'User', is_user: true, mes: 'survive me' }),
        ].join('\n');
        uploadPayload = {
            destination: path.join(os.tmpdir(), `import-survive-${Date.now()}`),
            filename: 'upload.jsonl',
            content: JSONL,
        };
        const res = await request(harness.app)
            .post('/api/chats/import')
            .send({ avatar_url: `${avatarUrl}.png`, character_name: 'Carol', user_name: 'User', file_type: 'jsonl' })
            .expect(200);
        const name = path.parse(res.body.fileNames[0]).name;

        await harness.reopenEngine();

        const chat = await getChatRepo().get(harness.handle, avatarUrl, name);
        expect(chat).not.toBeNull();
        expect(chat.body[0].mes).toBe('survive me');
    });
});
