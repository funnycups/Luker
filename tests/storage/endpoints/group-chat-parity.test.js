// Endpoint parity for /api/chats/group/* — group chat lifecycle through every
// storage engine. These were previously universally fs-only.

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as chatsRouter } from '../../../src/endpoints/chats.js';
import { getChatRepo } from '../../../src/storage/index.js';

const SAMPLE_HEADER = {
    user_name: 'tester',
    character_name: '',
    chat_metadata: { is_group_chat: true },
};
const SAMPLE_MESSAGES = [
    { name: 'User', is_user: true, mes: 'hi everyone', send_date: '2026-06-22 12:00:01' },
    { name: 'Bot1', is_user: false, mes: 'hello', send_date: '2026-06-22 12:00:02' },
];

describe.each(ENDPOINT_HARNESSES)('group chat endpoints on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => { app.use('/api/chats', chatsRouter); },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('REGRESSION: /api/chats/group/save creates a group chat via Repo', async () => {
        const id = 'group-001';
        await request(harness.server)
            .post('/api/chats/group/save')
            .send({ id, chat: SAMPLE_MESSAGES, is_group: true })
            .expect(200);

        const chat = await getChatRepo().get(harness.handle, '', id, { isGroup: true, groupId: id });
        expect(chat).not.toBeNull();
        expect(chat.body).toHaveLength(SAMPLE_MESSAGES.length);
        expect(chat.body[1].mes).toBe('hello');
    });

    test('REGRESSION: /api/chats/group/get returns Repo-saved group chat', async () => {
        const id = 'group-002';
        await getChatRepo().save(harness.handle, '', id, SAMPLE_HEADER, SAMPLE_MESSAGES, null,
            { isGroup: true, groupId: id });

        const res = await request(harness.server)
            .post('/api/chats/group/get')
            .send({ id })
            .expect(200);
        // Endpoint returns the same shape as /chats/get: an array starting
        // with the header followed by messages, OR an object with chat/...
        // Verify either the body messages survive or the array form does.
        if (Array.isArray(res.body)) {
            expect(res.body.length).toBeGreaterThanOrEqual(SAMPLE_MESSAGES.length);
        } else {
            const chat = res.body.chat ?? res.body.body ?? [];
            expect(chat).toHaveLength(SAMPLE_MESSAGES.length);
        }
    });

    test('REGRESSION: /api/chats/group/append appends to Repo group chat', async () => {
        const id = 'group-004';
        await getChatRepo().save(harness.handle, '', id, SAMPLE_HEADER, SAMPLE_MESSAGES, null,
            { isGroup: true, groupId: id });

        await request(harness.server)
            .post('/api/chats/group/append')
            .send({ id, messages: [{ name: 'User', mes: 'follow-up' }] })
            .expect(200);

        const chat = await getChatRepo().get(harness.handle, '', id, { isGroup: true, groupId: id });
        expect(chat.body).toHaveLength(SAMPLE_MESSAGES.length + 1);
        expect(chat.body[chat.body.length - 1].mes).toBe('follow-up');
    });

    test('REGRESSION: /api/chats/group/patch applies JSON patch to Repo group chat body', async () => {
        const id = 'group-005';
        await getChatRepo().save(harness.handle, '', id, SAMPLE_HEADER, SAMPLE_MESSAGES, null,
            { isGroup: true, groupId: id });
        const before = await getChatRepo().get(harness.handle, '', id, { isGroup: true, groupId: id });

        await request(harness.server)
            .post('/api/chats/group/patch')
            .send({
                id,
                integrity: before.integrity,
                operations: [{ op: 'replace', path: '/body/0/mes', value: 'edited' }],
            })
            .expect(200);

        const chat = await getChatRepo().get(harness.handle, '', id, { isGroup: true, groupId: id });
        expect(chat.body[0].mes).toBe('edited');
    });

    test('group DOM array patches preserve exact guards and companions', async () => {
        const repo = getChatRepo(), id = 'group-dom-patch';
        await repo.save(harness.handle, '', id, SAMPLE_HEADER, SAMPLE_MESSAGES, null, { isGroup: true, groupId: id });
        const companion = { nodes: [{ id: 'spring', facts: ['north', 'birches'] }], edges: [], revision: 7 };
        await repo.setState(harness.handle, '', id, 'memory_graph', companion, { isGroup: true, groupId: id });
        const before = await repo.get(harness.handle, '', id, { isGroup: true, groupId: id });
        const normalized = { ...SAMPLE_MESSAGES[1], extra: {}, swipes: ['hello'], swipe_id: 0,
            swipe_info: [{ send_date: SAMPLE_MESSAGES[1].send_date, extra: {} }] };
        const edited = { ...normalized, mes: 'DOM group edit', swipes: ['DOM group edit'] };
        await request(harness.server).post('/api/chats/group/patch').send({ id, integrity: before.integrity,
            chat_metadata: { note_prompt: 'retained metadata' },
            operations: [{ op: 'test', path: '/1', value: SAMPLE_MESSAGES[1] }, { op: 'replace', path: '/1', value: edited }],
        }).expect(200);
        const after = await repo.get(harness.handle, '', id, { isGroup: true, groupId: id });
        expect(after.body).toEqual([SAMPLE_MESSAGES[0], edited]);
        expect(after.header.chat_metadata).toMatchObject({ is_group_chat: true, note_prompt: 'retained metadata' });
        expect(await repo.getState(harness.handle, '', id, 'memory_graph', { isGroup: true, groupId: id })).toEqual(companion);
        await request(harness.server).post('/api/chats/group/patch').send({ id, integrity: after.integrity,
            operations: [{ op: 'test', path: '/1', value: { ...normalized, mes: 'different old text' } }, { op: 'replace', path: '/1', value: normalized }],
        }).expect(409);
        expect((await repo.get(harness.handle, '', id, { isGroup: true, groupId: id })).body).toEqual(after.body);
    });

    test('REGRESSION: /api/chats/group/meta merges into Repo group chat_metadata', async () => {
        const id = 'group-006';
        await getChatRepo().save(harness.handle, '', id, SAMPLE_HEADER, SAMPLE_MESSAGES, null,
            { isGroup: true, groupId: id });
        const before = await getChatRepo().get(harness.handle, '', id, { isGroup: true, groupId: id });

        await request(harness.server)
            .post('/api/chats/group/meta')
            .send({
                id,
                integrity: before.integrity,
                chat_metadata: { new_field: 'x' },
            })
            .expect(200);

        const chat = await getChatRepo().get(harness.handle, '', id, { isGroup: true, groupId: id });
        expect(chat.header.chat_metadata.new_field).toBe('x');
        expect(chat.header.chat_metadata.is_group_chat).toBe(true);
    });

    test('REGRESSION: /api/chats/group/meta/patch patches Repo chat_metadata', async () => {
        const id = 'group-007';
        await getChatRepo().save(harness.handle, '', id, SAMPLE_HEADER, SAMPLE_MESSAGES, null,
            { isGroup: true, groupId: id });
        const before = await getChatRepo().get(harness.handle, '', id, { isGroup: true, groupId: id });

        await request(harness.server)
            .post('/api/chats/group/meta/patch')
            .send({
                id,
                integrity: before.integrity,
                operations: [{ op: 'add', path: '/note', value: 'hello' }],
            })
            .expect(200);

        const chat = await getChatRepo().get(harness.handle, '', id, { isGroup: true, groupId: id });
        expect(chat.header.chat_metadata.note).toBe('hello');
    });

    test('REGRESSION: /api/chats/group/delete removes Repo group chat', async () => {
        const id = 'group-008';
        await getChatRepo().save(harness.handle, '', id, SAMPLE_HEADER, SAMPLE_MESSAGES, null,
            { isGroup: true, groupId: id });

        await request(harness.server)
            .post('/api/chats/group/delete')
            .send({ id })
            .expect(200);

        const after = await getChatRepo().get(harness.handle, '', id, { isGroup: true, groupId: id });
        expect(after).toBeNull();
    });

    test('REGRESSION: group chats persist across engine restart', async () => {
        const id = 'group-restart';
        await getChatRepo().save(harness.handle, '', id, SAMPLE_HEADER, SAMPLE_MESSAGES, null,
            { isGroup: true, groupId: id });

        await harness.reopenEngine();

        const res = await request(harness.server)
            .post('/api/chats/group/get')
            .send({ id })
            .expect(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThanOrEqual(SAMPLE_MESSAGES.length);
    });

    // --- .jsonl suffix tolerance (ids forwarded from list endpoints) ---

    test('REGRESSION: /api/chats/group/save strips a .jsonl suffix from id', async () => {
        await request(harness.server)
            .post('/api/chats/group/save')
            .send({ id: 'group-sfx-save.jsonl', chat: SAMPLE_MESSAGES, is_group: true })
            .expect(200);

        const chat = await getChatRepo().get(harness.handle, '', 'group-sfx-save',
            { isGroup: true, groupId: 'group-sfx-save' });
        expect(chat).not.toBeNull();
        expect(chat.body).toHaveLength(SAMPLE_MESSAGES.length);
    });

    test('REGRESSION: /api/chats/group/get strips a .jsonl suffix from id', async () => {
        const id = 'group-sfx-get';
        await getChatRepo().save(harness.handle, '', id, SAMPLE_HEADER, SAMPLE_MESSAGES, null,
            { isGroup: true, groupId: id });

        const res = await request(harness.server)
            .post('/api/chats/group/get')
            .send({ id: `${id}.jsonl` })
            .expect(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThanOrEqual(SAMPLE_MESSAGES.length);
    });

    test('REGRESSION: /api/chats/group/delete strips a .jsonl suffix from id', async () => {
        const id = 'group-sfx-delete';
        await getChatRepo().save(harness.handle, '', id, SAMPLE_HEADER, SAMPLE_MESSAGES, null,
            { isGroup: true, groupId: id });

        await request(harness.server)
            .post('/api/chats/group/delete')
            .send({ id: `${id}.jsonl` })
            .expect(200);

        const after = await getChatRepo().get(harness.handle, '', id, { isGroup: true, groupId: id });
        expect(after).toBeNull();
    });

    test('REGRESSION: /api/chats/group/merge accepts suffixed source names', async () => {
        await getChatRepo().save(harness.handle, '', 'gseg-a', SAMPLE_HEADER, SAMPLE_MESSAGES, null,
            { isGroup: true, groupId: 'gseg-a' });

        const res = await request(harness.server)
            .post('/api/chats/group/merge')
            .send({
                id: 'parent-grp-sfx',
                segments: [{ source: 'gseg-a.jsonl' }],
                target_name: 'gmerged-sfx',
            })
            .expect(200);
        expect(res.body.new_chat.file_name).toBe('gmerged-sfx');

        const merged = await getChatRepo().get(harness.handle, '', 'gmerged-sfx',
            { isGroup: true, groupId: 'gmerged-sfx' });
        expect(merged).not.toBeNull();
        expect(merged.body).toHaveLength(SAMPLE_MESSAGES.length);
    });
});
