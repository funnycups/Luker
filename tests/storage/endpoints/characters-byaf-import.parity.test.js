// Parity test for BYAF character import. Pre-fix `createChatAsCurrentPersona`
// inside `importFromByaf` wrote the imported chat with `writeFileAtomicSync`
// straight to disk; in db modes the chat was invisible to ChatRepo and
// silently lost on read. The fix routes the write through ChatRepo.save.
//
// Fixture shape is copy-pasted from tests/e2e/character/18-import-byaf.e2e.js
// (Halden the Quill-Keeper) — that e2e proves the BYAF zip layout passes the
// parser end-to-end. We use the repo's default Seraphina PNG as the icon so
// the parser's image fallback path is never taken (DEFAULT_AVATAR_PATH is
// './public/img/ai4.png' which is cwd-relative and brittle inside Jest).
//
// Test setup is the same multer shim pattern as
// `chats-import.parity.test.js`: place the zip on disk in a temp
// folder, synthesize `request.file`, POST through the real
// `/api/characters/import` route so the production handler runs unchanged.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import AdmZip from 'adm-zip';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as charactersRouter } from '../../../src/endpoints/characters.js';
import { getChatRepo } from '../../../src/storage/index.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const DEFAULT_ICON_PATH = path.resolve(REPO_ROOT, 'default/content/default_Seraphina.png');

const CHARACTER_NAME = 'Halden the Quill-Keeper';

const MANIFEST = {
    formatVersion: 1,
    characters: ['character/halden.json'],
    scenarios: ['scenario/library-stairwell.json'],
    author: { name: 'luker-storage-parity', backyardURL: '' },
};

const CHARACTER = {
    name: CHARACTER_NAME,
    displayName: CHARACTER_NAME,
    persona: 'A quiet archivist who keeps a wax-sealed ledger of every borrowed lantern in the harbor library.',
    isNSFW: false,
    images: [{ path: '../image/halden.png', label: '' }],
    loreItems: [
        { key: 'lantern ledger', value: 'The ledger records every lantern that ever left the library and the names of those who took them.' },
    ],
};

const SCENARIO = {
    narrative: 'You meet Halden at the foot of the library stairwell with a lantern that does not yet have an entry in the ledger.',
    firstMessages: [{ text: '*Halden taps the spine of his ledger with the back of a pen.* "If you brought that lantern in here, friend, it needs a name and a seal."' }],
    exampleMessages: [],
    formattingInstructions: 'You are Halden. Stay in scene. Reply with one or two paragraphs.',
    messages: [],
};

function buildHaldenByaf() {
    const iconPng = fs.readFileSync(DEFAULT_ICON_PATH);
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(MANIFEST), 'utf8'));
    zip.addFile('character/halden.json', Buffer.from(JSON.stringify(CHARACTER), 'utf8'));
    zip.addFile('scenario/library-stairwell.json', Buffer.from(JSON.stringify(SCENARIO), 'utf8'));
    zip.addFile('image/halden.png', iconPng);
    return zip.toBuffer();
}

// Multer shim — same rationale as chats-import.parity.test.js:18-33.
// Place a real file at <destination>/<filename> and synthesize req.file the
// way multer's diskStorage would. The handler then `fsPromises.readFile`s
// the upload path and `fsPromises.unlink`s it — exactly as in production.
function mountMulterShim(app, uploadProvider) {
    app.use('/api/characters/import', (req, _res, next) => {
        const { destination, filename, content } = uploadProvider();
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, filename), content);
        req.file = { destination, filename, originalname: filename };
        next();
    });
}

describe.each(ENDPOINT_HARNESSES)('BYAF character import on $name', ({ mode }) => {
    let harness;
    let uploadPayload;

    beforeEach(async () => {
        uploadPayload = null;
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                mountMulterShim(app, () => uploadPayload);
                app.use('/api/characters', charactersRouter);
            },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('REGRESSION: BYAF import writes the scenario chat through ChatRepo', async () => {
        uploadPayload = {
            destination: path.join(os.tmpdir(), `byaf-import-${Date.now()}`),
            filename: 'halden.byaf',
            content: buildHaldenByaf(),
        };
        const res = await request(harness.app)
            .post('/api/characters/import')
            .send({ user_name: 'User', file_type: 'byaf' })
            .expect(200);
        expect(res.body.error).not.toBe(true);
        const charFileName = res.body.file_name;
        expect(typeof charFileName).toBe('string');
        expect(charFileName.length).toBeGreaterThan(0);

        // charFileName is the .png basename (no extension) the character was
        // saved as. The chat under it must be readable through ChatRepo on
        // every engine; on db modes it must be readable through the engine,
        // not through a residual disk file from the buggy code path.
        const chats = await getChatRepo().listForCharacter(harness.handle, charFileName);
        expect(Array.isArray(chats)).toBe(true);
        expect(chats.length).toBeGreaterThan(0);

        const chatName = chats[0].key.name;
        const chat = await getChatRepo().get(harness.handle, charFileName, chatName);
        expect(chat).not.toBeNull();
        // Header always present (chat[0] in BYAF's getChatFromScenario output).
        // The first scenario in the fixture has one firstMessage so the body
        // must contain at least that one message.
        expect(Array.isArray(chat.body)).toBe(true);
        expect(chat.body.length).toBeGreaterThanOrEqual(1);
        expect(chat.body[0].mes).toContain('ledger');

        // The multer temp upload must be cleaned up by the handler.
        expect(fs.existsSync(path.join(uploadPayload.destination, uploadPayload.filename))).toBe(false);
    });
});
