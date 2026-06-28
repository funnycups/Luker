import fs from 'node:fs';
import path from 'node:path';
import { CONTRACT_HARNESSES, makeTempFsEngineHarness } from '../harness/contract-harness.js';
import { GroupRepo } from '../../../src/storage/repositories/group-repo.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';

describe.each(CONTRACT_HARNESSES)('GroupRepo on $name', ({ make }) => {
    let h, repo, chatRepo;
    beforeEach(async () => {
        h = await make();
        fs.mkdirSync(h.dirs.groups, { recursive: true });
        fs.mkdirSync(h.dirs.groupChats, { recursive: true });
        repo = new GroupRepo({ engine: h.engine });
        chatRepo = new ChatRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('get returns null when missing', async () => {
        expect(await repo.get(h.handle, 'ghost')).toBeNull();
    });

    test('save round-trips', async () => {
        const doc = { id: 'grp-1', name: 'Crew', members: ['a', 'b'], chats: ['c-1'] };
        await repo.save(h.handle, 'grp-1', doc);
        const got = await repo.get(h.handle, 'grp-1');
        // GroupRepo.save stamps doc.date_added on first write so the value
        // survives FS↔DB migration. Strip it before comparing user fields.
        expect(typeof got.date_added).toBe('number');
        const { date_added: _da, ...gotRest } = got;
        expect(gotRest).toEqual(doc);
    });

    test('save overwrites existing group', async () => {
        await repo.save(h.handle, 'grp-1', { id: 'grp-1', name: 'old' });
        await repo.save(h.handle, 'grp-1', { id: 'grp-1', name: 'new' });
        const got = await repo.get(h.handle, 'grp-1');
        expect(got.name).toBe('new');
    });

    test('save preserves existing date_added on overwrite', async () => {
        await repo.save(h.handle, 'grp-1', { id: 'grp-1', name: 'old' });
        const firstDate = (await repo.get(h.handle, 'grp-1')).date_added;
        // Force a different wall-clock so a fresh stamp would obviously diverge.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await repo.save(h.handle, 'grp-1', { id: 'grp-1', name: 'new' });
        const got = await repo.get(h.handle, 'grp-1');
        expect(got.date_added).toBe(firstDate);
    });

    test('save honors caller-supplied date_added', async () => {
        await repo.save(h.handle, 'grp-1', { id: 'grp-1', name: 'g', date_added: 1700000000000 });
        const got = await repo.get(h.handle, 'grp-1');
        expect(got.date_added).toBe(1700000000000);
    });

    test('save coerces non-string id', async () => {
        await repo.save(h.handle, 12345, { id: '12345' });
        const got = await repo.get(h.handle, '12345');
        expect(typeof got.date_added).toBe('number');
        const { date_added: _da, ...gotRest } = got;
        expect(gotRest).toEqual({ id: '12345' });
        const got2 = await repo.get(h.handle, 12345);
        const { date_added: _da2, ...got2Rest } = got2;
        expect(got2Rest).toEqual({ id: '12345' });
    });

    test('delete returns {deleted:false,chatsDeleted:0} when group missing', async () => {
        const result = await repo.delete(h.handle, 'ghost');
        expect(result).toEqual({ deleted: false, chatsDeleted: 0 });
    });

    test('delete returns {deleted:true,chatsDeleted:0} when group has no chats array', async () => {
        await repo.save(h.handle, 'grp-1', { id: 'grp-1' });
        const result = await repo.delete(h.handle, 'grp-1');
        expect(result).toEqual({ deleted: true, chatsDeleted: 0 });
        expect(await repo.get(h.handle, 'grp-1')).toBeNull();
    });

    test('delete returns {deleted:true,chatsDeleted:0} when group has empty chats array', async () => {
        await repo.save(h.handle, 'grp-1', { id: 'grp-1', chats: [] });
        const result = await repo.delete(h.handle, 'grp-1');
        expect(result).toEqual({ deleted: true, chatsDeleted: 0 });
    });

    test('delete cascades to existing member chats', async () => {
        // Save group + create two real chats referenced by it (verified via chat repo, not fs).
        await chatRepo.save(h.handle, null, 'chat-a', { user_name: 'U' }, [{ mes: 'hi' }], null, { isGroup: true, groupId: 'chat-a' });
        await chatRepo.save(h.handle, null, 'chat-b', { user_name: 'U' }, [{ mes: 'hi2' }], null, { isGroup: true, groupId: 'chat-b' });
        await repo.save(h.handle, 'grp-1', { id: 'grp-1', chats: ['chat-a', 'chat-b'] });

        expect(await chatRepo.get(h.handle, null, 'chat-a', { isGroup: true, groupId: 'chat-a' })).not.toBeNull();
        expect(await chatRepo.get(h.handle, null, 'chat-b', { isGroup: true, groupId: 'chat-b' })).not.toBeNull();

        const result = await repo.delete(h.handle, 'grp-1');
        expect(result).toEqual({ deleted: true, chatsDeleted: 2 });
        expect(await chatRepo.get(h.handle, null, 'chat-a', { isGroup: true, groupId: 'chat-a' })).toBeNull();
        expect(await chatRepo.get(h.handle, null, 'chat-b', { isGroup: true, groupId: 'chat-b' })).toBeNull();
        expect(await repo.get(h.handle, 'grp-1')).toBeNull();
    });

    test('delete counts only chats that actually existed', async () => {
        // Group references three chats but only one exists.
        await chatRepo.save(h.handle, null, 'real', { user_name: 'U' }, [], null, { isGroup: true, groupId: 'real' });
        await repo.save(h.handle, 'grp-1', { id: 'grp-1', chats: ['real', 'ghost-1', 'ghost-2'] });
        const result = await repo.delete(h.handle, 'grp-1');
        expect(result.deleted).toBe(true);
        expect(result.chatsDeleted).toBe(1);
    });

    test('delete cascades chat sidecars along with chat data', async () => {
        await chatRepo.save(h.handle, null, 'chat-a', { user_name: 'U' }, [], null, { isGroup: true, groupId: 'chat-a' });
        await chatRepo.setState(h.handle, null, 'chat-a', 'ns_x', { v: 1 }, { isGroup: true, groupId: 'chat-a' });
        expect(await chatRepo.getState(h.handle, null, 'chat-a', 'ns_x', { isGroup: true, groupId: 'chat-a' })).toEqual({ v: 1 });
        await repo.save(h.handle, 'grp-1', { id: 'grp-1', chats: ['chat-a'] });

        await repo.delete(h.handle, 'grp-1');
        expect(await chatRepo.getState(h.handle, null, 'chat-a', 'ns_x', { isGroup: true, groupId: 'chat-a' })).toBeNull();
    });

    test('list returns sorted by id', async () => {
        await repo.save(h.handle, 'zeta', { id: 'zeta' });
        await repo.save(h.handle, 'alpha', { id: 'alpha' });
        await repo.save(h.handle, 'mid', { id: 'mid' });
        const listed = await repo.list(h.handle);
        expect(listed.map((e) => e.key.id)).toEqual(['alpha', 'mid', 'zeta']);
    });

    test('listWithChatStats populates date_added, chat_size, date_last_chat', async () => {
        await chatRepo.save(h.handle, null, 'chat-a', { user_name: 'U' }, [{ mes: 'hi' }], null, { isGroup: true, groupId: 'chat-a' });
        await repo.save(h.handle, 'grp-1', { id: 'grp-1', name: 'Crew', chats: ['chat-a'] });

        const groups = await repo.listWithChatStats(h.handle);
        expect(groups).toHaveLength(1);
        const g = groups[0];
        expect(g.id).toBe('grp-1');
        expect(g.name).toBe('Crew');
        expect(g.chat_size).toBeGreaterThan(0);
        expect(g.date_last_chat).toBeGreaterThan(0);
        expect(typeof g.date_added).toBe('number');
        expect(typeof g.create_date).toBe('string');
    });
});

describe('GroupRepo — FS-only on-disk verification', () => {
    // Cross-checks that the cascade actually removes the .jsonl + sidecar files on disk,
    // not just that get() returns null. SqliteEngine uses FK CASCADE on chat_states and
    // direct DELETE on chats, so the contract test above already covers that path.
    let h, repo, chatRepo;
    beforeEach(async () => {
        h = await makeTempFsEngineHarness();
        fs.mkdirSync(h.dirs.groups, { recursive: true });
        fs.mkdirSync(h.dirs.groupChats, { recursive: true });
        repo = new GroupRepo({ engine: h.engine });
        chatRepo = new ChatRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('delete cascade removes the .jsonl chat files', async () => {
        await chatRepo.save(h.handle, null, 'chat-a', { user_name: 'U' }, [], null, { isGroup: true, groupId: 'chat-a' });
        await chatRepo.save(h.handle, null, 'chat-b', { user_name: 'U' }, [], null, { isGroup: true, groupId: 'chat-b' });
        await repo.save(h.handle, 'grp-1', { id: 'grp-1', chats: ['chat-a', 'chat-b'] });

        const chatAPath = path.join(h.dirs.groupChats, 'chat-a.jsonl');
        const chatBPath = path.join(h.dirs.groupChats, 'chat-b.jsonl');
        expect(fs.existsSync(chatAPath)).toBe(true);
        expect(fs.existsSync(chatBPath)).toBe(true);

        await repo.delete(h.handle, 'grp-1');
        expect(fs.existsSync(chatAPath)).toBe(false);
        expect(fs.existsSync(chatBPath)).toBe(false);
    });

    test('delete cascade removes chat sidecar files alongside the .jsonl', async () => {
        await chatRepo.save(h.handle, null, 'chat-a', { user_name: 'U' }, [], null, { isGroup: true, groupId: 'chat-a' });
        await chatRepo.setState(h.handle, null, 'chat-a', 'ns_x', { v: 1 }, { isGroup: true, groupId: 'chat-a' });
        await repo.save(h.handle, 'grp-1', { id: 'grp-1', chats: ['chat-a'] });

        const sidecar = path.join(h.dirs.groupChats, 'chat-a.luker-state.ns_x.json');
        expect(fs.existsSync(sidecar)).toBe(true);

        await repo.delete(h.handle, 'grp-1');
        expect(fs.existsSync(sidecar)).toBe(false);
    });
});
