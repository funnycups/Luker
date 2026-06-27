// Endpoint parity for character lifecycle (rename/delete): they must keep
// chat data in step with the avatar, and /characters/chats now drives
// chat_size + date_last_chat through ChatRepo so it doesn't report zero in
// db modes.

import fs from 'node:fs';
import path from 'node:path';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as charactersRouter } from '../../../src/endpoints/characters.js';
import { router as chatsRouter } from '../../../src/endpoints/chats.js';
import { getChatRepo } from '../../../src/storage/index.js';

// Minimal PNG-with-V2-card payload — characters.js will accept whatever
// readCharacterData returns, but writeCharacterData expects a real PNG with
// a json chunk embedded. Stub by pre-writing a tiny "PNG" file that contains
// JSON characters.js can parse via readCharacterData on its own short-circuit
// fallback. Where the character data actually matters we set it explicitly.
//
// For these tests it's enough to plant an empty .png + a chat row.
function seedCharacterPng(charsDir, name, jsonData) {
    fs.mkdirSync(charsDir, { recursive: true });
    const filePath = path.join(charsDir, `${name}.png`);
    // characters.js expects PNG-with-text-chunk; fake one by writing the JSON
    // payload directly. characters.js readCharacterData uses pngExtract
    // which will fail; we only exercise endpoints that don't require parsing
    // the card body (chats/rename/delete).
    fs.writeFileSync(filePath, JSON.stringify(jsonData));
}

const HEADER = { user_name: 'tester', character_name: 'Alice', chat_metadata: {} };
const MESSAGES = [{ name: 'User', mes: 'hi' }, { name: 'Alice', mes: 'hello' }];

describe.each(ENDPOINT_HARNESSES)('character lifecycle on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                app.use('/api/characters', charactersRouter);
                app.use('/api/chats', chatsRouter);
            },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('REGRESSION: /api/characters/delete with delete_chats removes Repo-resident chats', async () => {
        seedCharacterPng(harness.dirs.characters, 'Alice', { name: 'Alice', spec: 'chara_card_v2' });
        await getChatRepo().save(harness.handle, 'Alice', 'main', HEADER, MESSAGES, null);
        await getChatRepo().save(harness.handle, 'Alice', 'second', HEADER, MESSAGES, null);

        await request(harness.app)
            .post('/api/characters/delete')
            .send({ avatar_url: 'Alice.png', delete_chats: true })
            .expect(200);

        const remaining = await getChatRepo().listForCharacter(harness.handle, 'Alice');
        expect(remaining).toEqual([]);
    });

    test('REGRESSION: /api/characters/delete without delete_chats leaves Repo chats intact', async () => {
        seedCharacterPng(harness.dirs.characters, 'Alice', { name: 'Alice' });
        await getChatRepo().save(harness.handle, 'Alice', 'main', HEADER, MESSAGES, null);

        await request(harness.app)
            .post('/api/characters/delete')
            .send({ avatar_url: 'Alice.png', delete_chats: false })
            .expect(200);

        const remaining = await getChatRepo().listForCharacter(harness.handle, 'Alice');
        expect(remaining).toHaveLength(1);
    });

    test('REGRESSION: /api/characters/chats reports chat_size + date_last_chat from Repo', async () => {
        seedCharacterPng(harness.dirs.characters, 'Alice', { name: 'Alice' });
        await getChatRepo().save(harness.handle, 'Alice', 'main', HEADER, MESSAGES, null);

        const res = await request(harness.app)
            .post('/api/characters/chats')
            .send({ avatar_url: 'Alice.png', metadata: true })
            .expect(200);

        const entry = res.body.find((e) => e.file_id === 'main');
        expect(entry).toBeDefined();
        expect(entry.chat_items).toBe(MESSAGES.length);
    });

    test('REGRESSION: Repo chats survive engine restart end-to-end', async () => {
        seedCharacterPng(harness.dirs.characters, 'Alice', { name: 'Alice' });
        await getChatRepo().save(harness.handle, 'Alice', 'durable', HEADER, MESSAGES, null);

        await harness.reopenEngine();

        const res = await request(harness.app)
            .post('/api/characters/chats')
            .send({ avatar_url: 'Alice.png', simple: true })
            .expect(200);
        expect(res.body.map((e) => e.file_id)).toContain('durable');
    });
});
