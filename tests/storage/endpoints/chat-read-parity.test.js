// Endpoint parity coverage for the chat-related read paths affected by the
// Phase 5 migration. The audit identified these as broken under db mode:
//   - POST /api/characters/chats           (list chats per character)
//   - POST /api/chats/get-delta            (paginated chat read)
//   - POST /api/chats/rename               (existsSync gate)
//   - POST /api/chats/delete               (existsSync gate)
//   - POST /api/chats/export               (file read)
//   - POST /api/chats/search               (group scan)
//   - POST /api/chats/recent               (3-dir fs scan)
//   - POST /api/chats/meta                 (fs write of merged metadata)
//   - POST /api/chats/meta/patch           (fs json-patch)
//
// Each test exercises the real Express router with a real storage engine and
// asserts that data round-trips through the same Repo regardless of mode.

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as chatsRouter } from '../../../src/endpoints/chats.js';
import { router as charactersRouter } from '../../../src/endpoints/characters.js';
import { getChatRepo } from '../../../src/storage/index.js';

const SAMPLE_HEADER = {
    user_name: 'tester',
    character_name: 'Alice',
    create_date: '2026-06-22 12:00:00',
    chat_metadata: { lorebook: 'TestLore' },
};
const SAMPLE_MESSAGES = [
    { name: 'User', is_user: true, mes: 'Hello Alice!', send_date: '2026-06-22 12:00:01' },
    { name: 'Alice', is_user: false, mes: 'Hello tester!', send_date: '2026-06-22 12:00:02' },
];

describe.each(ENDPOINT_HARNESSES)('chat read endpoints on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                app.use('/api/chats', chatsRouter);
                app.use('/api/characters', charactersRouter);
            },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    // --- /api/characters/chats ---

    test('REGRESSION: /api/characters/chats lists chats stored via ChatRepo (no fs scan)', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'chat-a', SAMPLE_HEADER, SAMPLE_MESSAGES, null);
        await getChatRepo().save(harness.handle, 'Alice', 'chat-b', SAMPLE_HEADER, SAMPLE_MESSAGES, null);

        const res = await request(harness.app)
            .post('/api/characters/chats')
            .send({ avatar_url: 'Alice.png', simple: true })
            .expect(200);
        expect(Array.isArray(res.body)).toBe(true);
        const ids = res.body.map((e) => e.file_id).sort();
        expect(ids).toEqual(['chat-a', 'chat-b']);
    });

    test('REGRESSION: /api/characters/chats (metadata=true) returns chatItems + last message from ChatRepo', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'main', SAMPLE_HEADER, SAMPLE_MESSAGES, null);

        const res = await request(harness.app)
            .post('/api/characters/chats')
            .send({ avatar_url: 'Alice.png', metadata: true })
            .expect(200);
        expect(Array.isArray(res.body)).toBe(true);
        const entry = res.body.find((e) => e.file_id === 'main');
        expect(entry).toBeDefined();
        expect(entry.chat_items).toBe(SAMPLE_MESSAGES.length);
        expect(entry.mes).toBe(SAMPLE_MESSAGES[SAMPLE_MESSAGES.length - 1].mes);
        expect(entry.chat_metadata?.lorebook).toBe('TestLore');
    });

    // --- /api/chats/get-delta ---

    test('REGRESSION: /api/chats/get-delta returns the full chat body for a Repo-saved chat', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'main', SAMPLE_HEADER, SAMPLE_MESSAGES, null);

        const res = await request(harness.app)
            .post('/api/chats/get-delta')
            .send({ avatar_url: 'Alice.png', file_name: 'main', from_index: 0 })
            .expect(200);
        expect(Array.isArray(res.body.chat)).toBe(true);
        expect(res.body.chat).toHaveLength(SAMPLE_MESSAGES.length);
        expect(res.body.chat[0].mes).toBe(SAMPLE_MESSAGES[0].mes);
    });

    test('REGRESSION: /api/chats/get-delta from_index=N returns tail correctly', async () => {
        const many = [
            ...SAMPLE_MESSAGES,
            { name: 'User', mes: 'msg #3' },
            { name: 'Alice', mes: 'msg #4' },
        ];
        await getChatRepo().save(harness.handle, 'Alice', 'main', SAMPLE_HEADER, many, null);

        const res = await request(harness.app)
            .post('/api/chats/get-delta')
            .send({ avatar_url: 'Alice.png', file_name: 'main', from_index: 2 })
            .expect(200);
        expect(res.body.chat).toHaveLength(2);
        expect(res.body.chat[0].mes).toBe('msg #3');
    });

    // --- /api/chats/rename ---

    test('REGRESSION: /api/chats/rename works for Repo-resident chats (no fs existsSync gate)', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'old', SAMPLE_HEADER, SAMPLE_MESSAGES, null);

        await request(harness.app)
            .post('/api/chats/rename')
            .send({ avatar_url: 'Alice.png', original_file: 'old.jsonl', renamed_file: 'new.jsonl', is_group: false })
            .expect(200);

        const oldChat = await getChatRepo().get(harness.handle, 'Alice', 'old');
        const newChat = await getChatRepo().get(harness.handle, 'Alice', 'new');
        expect(oldChat).toBeNull();
        expect(newChat).not.toBeNull();
        expect(newChat.body[0].mes).toBe(SAMPLE_MESSAGES[0].mes);
    });

    // --- /api/chats/delete ---

    test('REGRESSION: /api/chats/delete works for Repo-resident chats', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'doomed', SAMPLE_HEADER, SAMPLE_MESSAGES, null);

        await request(harness.app)
            .post('/api/chats/delete')
            .send({ avatar_url: 'Alice.png', chatfile: 'doomed.jsonl', is_group: false })
            .expect(200);

        const after = await getChatRepo().get(harness.handle, 'Alice', 'doomed');
        expect(after).toBeNull();
    });

    // --- /api/chats/export ---

    test('REGRESSION: /api/chats/export returns Repo-resident chat content (jsonl format)', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'expo', SAMPLE_HEADER, SAMPLE_MESSAGES, null);

        const res = await request(harness.app)
            .post('/api/chats/export')
            .send({ avatar_url: 'Alice.png', file: 'expo.jsonl', format: 'jsonl', is_group: false })
            .expect(200);
        // The endpoint wraps the file contents in `{message, result}`.
        const exported = res.body.result;
        expect(typeof exported).toBe('string');
        expect(exported.length).toBeGreaterThan(0);
        const lines = exported.split('\n').filter((l) => l.length);
        expect(lines.length).toBeGreaterThanOrEqual(1 + SAMPLE_MESSAGES.length);
        const parsedHeader = JSON.parse(lines[0]);
        expect(parsedHeader.user_name).toBe('tester');
    });

    // --- /api/chats/search ---

    test('REGRESSION: /api/chats/search finds Repo-resident chats matching the query', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'topic-elephants', SAMPLE_HEADER, [
            { name: 'User', mes: 'tell me about elephants' },
            { name: 'Alice', mes: 'they are big mammals' },
        ], null);
        await getChatRepo().save(harness.handle, 'Alice', 'topic-tigers', SAMPLE_HEADER, [
            { name: 'User', mes: 'tigers anything' },
        ], null);

        const res = await request(harness.app)
            .post('/api/chats/search')
            .send({ query: 'elephants', avatar_url: 'Alice.png' })
            .expect(200);
        expect(Array.isArray(res.body)).toBe(true);
        const ids = res.body.map((r) => r.file_name);
        expect(ids).toContain('topic-elephants.jsonl');
        expect(ids).not.toContain('topic-tigers.jsonl');
    });

    // --- /api/chats/recent ---

    test('REGRESSION: /api/chats/recent surfaces Repo-resident chats with their latest mtime', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'older', SAMPLE_HEADER, SAMPLE_MESSAGES, null);
        await getChatRepo().save(harness.handle, 'Alice', 'newer', SAMPLE_HEADER, SAMPLE_MESSAGES, null);

        const res = await request(harness.app)
            .post('/api/chats/recent')
            .send({})
            .expect(200);
        expect(Array.isArray(res.body)).toBe(true);
        const ids = res.body.map((r) => r.file_id);
        expect(ids).toEqual(expect.arrayContaining(['older', 'newer']));
    });

    // --- /api/chats/meta + /meta/patch ---

    test('REGRESSION: /api/chats/meta merges into Repo chat_metadata (not a stale fs file)', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'main', SAMPLE_HEADER, SAMPLE_MESSAGES, null);
        const before = await getChatRepo().get(harness.handle, 'Alice', 'main');

        await request(harness.app)
            .post('/api/chats/meta')
            .send({
                avatar_url: 'Alice.png',
                file_name: 'main',
                is_group: false,
                integrity: before.integrity,
                chat_metadata: { lorebook: 'NewLore', new_flag: 'yes' },
            })
            .expect(200);

        const chat = await getChatRepo().get(harness.handle, 'Alice', 'main');
        expect(chat.header.chat_metadata.lorebook).toBe('NewLore');
        expect(chat.header.chat_metadata.new_flag).toBe('yes');
        // Body must be preserved.
        expect(chat.body).toHaveLength(SAMPLE_MESSAGES.length);
        expect(chat.body[0].mes).toBe(SAMPLE_MESSAGES[0].mes);
    });

    test('REGRESSION: /api/chats/meta/patch (JSON Patch) mutates Repo chat_metadata', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'main', SAMPLE_HEADER, SAMPLE_MESSAGES, null);
        const before = await getChatRepo().get(harness.handle, 'Alice', 'main');

        // The patch is applied to the chat_metadata object directly (NOT to
        // a /chat_metadata sub-path). The Repo's updateChatMetadata semantics
        // shallow-merge, and the endpoint pipes the JSON patch through
        // applyJsonPatch on the existing chat_metadata.
        await request(harness.app)
            .post('/api/chats/meta/patch')
            .send({
                avatar_url: 'Alice.png',
                file_name: 'main',
                is_group: false,
                integrity: before.integrity,
                operations: [
                    { op: 'add', path: '/foo', value: 'bar' },
                ],
            })
            .expect(200);

        const chat = await getChatRepo().get(harness.handle, 'Alice', 'main');
        expect(chat.header.chat_metadata.foo).toBe('bar');
        expect(chat.body).toHaveLength(SAMPLE_MESSAGES.length);
    });

    // --- read-after-restart ---

    test('REGRESSION: chats persist across engine restart (user repro)', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'durable', SAMPLE_HEADER, SAMPLE_MESSAGES, null);

        await harness.reopenEngine();

        const res = await request(harness.app)
            .post('/api/characters/chats')
            .send({ avatar_url: 'Alice.png', simple: true })
            .expect(200);
        expect(res.body.map((e) => e.file_id)).toContain('durable');
    });
});
