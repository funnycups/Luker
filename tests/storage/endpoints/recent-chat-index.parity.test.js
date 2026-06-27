// Recent-chat index parity. The recent-chat cache rebuild previously
// looked up group display names by raw fs.readdir on directories.groups —
// invisible in db modes. Group resolution now goes through
// GroupRepo so the recent-chat cache shows group chats in db modes too.

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as chatsRouter } from '../../../src/endpoints/chats.js';
import { getChatRepo, getGroupRepo } from '../../../src/storage/index.js';

const HEADER = { user_name: 'tester', character_name: '', chat_metadata: { is_group_chat: true } };
const MESSAGES = [
    { name: 'User', is_user: true, mes: 'group hi' },
    { name: 'Bot1', is_user: false, mes: 'group hello' },
];

describe.each(ENDPOINT_HARNESSES)('recent chat index on $name', ({ mode }) => {
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

    test('REGRESSION: /api/chats/recent surfaces group chat whose group lives in GroupRepo', async () => {
        const groupId = 'grp-1';
        const chatId = 'chat-of-grp-1';
        await getGroupRepo().save(harness.handle, groupId, {
            id: groupId,
            name: 'Test Group',
            chats: [chatId],
            chat_id: chatId,
        });
        await getChatRepo().save(harness.handle, '', chatId, HEADER, MESSAGES, null,
            { isGroup: true, groupId: chatId });

        const res = await request(harness.app)
            .post('/api/chats/recent')
            .send({ limit: 20 })
            .expect(200);
        expect(Array.isArray(res.body)).toBe(true);
        const entry = res.body.find(e => e.file_id === chatId);
        expect(entry).toBeDefined();
        expect(entry.group).toBe(groupId);
    });

    test('REGRESSION: solo chat save then /recent shows the chat across all engines', async () => {
        const charDir = 'Alice';
        const name = 'recent-chat-1';
        await getChatRepo().save(harness.handle, charDir, name, {
            user_name: 'tester', character_name: 'Alice', chat_metadata: {},
        }, [
            { name: 'User', is_user: true, mes: 'first message' },
        ], null);

        // Prime the recent-chat index cache. refreshRecentChatIndexEntry is a
        // no-op until the cache exists; the first /recent call lazily builds
        // it via ensureRecentChatIndex.
        await request(harness.app)
            .post('/api/chats/recent')
            .send({ limit: 20 })
            .expect(200);

        // Trigger an /append (which fires refreshRecentChatIndexEntry).
        const fetched = await getChatRepo().get(harness.handle, charDir, name);
        await request(harness.app)
            .post('/api/chats/append')
            .send({
                avatar_url: `${charDir}.png`,
                file_name: name,
                integrity: fetched.integrity,
                messages: [{ name: 'Alice', is_user: false, mes: 'reply' }],
            })
            .expect(200);

        const res = await request(harness.app)
            .post('/api/chats/recent')
            .send({ limit: 20 })
            .expect(200);
        const entry = res.body.find(e => e.file_id === name);
        expect(entry).toBeDefined();
        expect(entry.chat_items).toBe(2);
        expect(entry.avatar).toBe(`${charDir}.png`);
    });
});
