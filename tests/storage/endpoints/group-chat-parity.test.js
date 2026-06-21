// Endpoint parity for /api/chats/group/* — group chat lifecycle through every
// storage engine. Pre-Phase 6 these were universally fs-only.

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
        await request(harness.app)
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

        const res = await request(harness.app)
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

    test('REGRESSION: /api/chats/group/get-delta paginates Repo-saved group chat body', async () => {
        const id = 'group-003';
        const body = [
            ...SAMPLE_MESSAGES,
            { name: 'User', mes: 'msg 3' },
            { name: 'Bot1', mes: 'msg 4' },
        ];
        await getChatRepo().save(harness.handle, '', id, SAMPLE_HEADER, body, null,
            { isGroup: true, groupId: id });

        const res = await request(harness.app)
            .post('/api/chats/group/get-delta')
            .send({ id, from_index: 2 })
            .expect(200);
        expect(Array.isArray(res.body.chat)).toBe(true);
        expect(res.body.chat).toHaveLength(2);
        expect(res.body.chat[0].mes).toBe('msg 3');
    });

    test('REGRESSION: /api/chats/group/append appends to Repo group chat', async () => {
        const id = 'group-004';
        await getChatRepo().save(harness.handle, '', id, SAMPLE_HEADER, SAMPLE_MESSAGES, null,
            { isGroup: true, groupId: id });

        await request(harness.app)
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

        await request(harness.app)
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

    test('REGRESSION: /api/chats/group/meta merges into Repo group chat_metadata', async () => {
        const id = 'group-006';
        await getChatRepo().save(harness.handle, '', id, SAMPLE_HEADER, SAMPLE_MESSAGES, null,
            { isGroup: true, groupId: id });
        const before = await getChatRepo().get(harness.handle, '', id, { isGroup: true, groupId: id });

        await request(harness.app)
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

        await request(harness.app)
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

        await request(harness.app)
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

        const res = await request(harness.app)
            .post('/api/chats/group/get-delta')
            .send({ id, from_index: 0 })
            .expect(200);
        expect(Array.isArray(res.body.chat)).toBe(true);
        expect(res.body.chat).toHaveLength(SAMPLE_MESSAGES.length);
    });
});
