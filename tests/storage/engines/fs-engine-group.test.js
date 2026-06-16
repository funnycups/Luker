import fs from 'node:fs';
import path from 'node:path';
import { makeTempFsEngine } from '../harness/fs-harness.js';

describe('FsEngine group handler', () => {
    let h;
    beforeEach(async () => {
        h = await makeTempFsEngine();
        fs.mkdirSync(h.dirs.groups, { recursive: true });
        fs.mkdirSync(h.dirs.groupChats, { recursive: true });
    });
    afterEach(() => h.cleanup());

    const groupKey = (id = 'grp-1') => ({ kind: 'group', handle: h.handle, id });

    test('put writes pretty-printed JSON', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(groupKey('grp-1'), { doc: { id: 'grp-1', name: 'Crew', members: ['a'] } }));
        const fp = path.join(h.dirs.groups, 'grp-1.json');
        const raw = fs.readFileSync(fp, 'utf-8');
        expect(raw).toContain('\n    "name"');
        const parsed = JSON.parse(raw);
        expect(parsed.id).toBe('grp-1');
        expect(parsed.members).toEqual(['a']);
    });

    test('get returns null when file missing', async () => {
        const out = await h.engine.withTransaction(h.handle, (tx) => tx.getResource(groupKey('nope')));
        expect(out).toBeNull();
    });

    test('get returns null when file is unparsable', async () => {
        const fp = path.join(h.dirs.groups, 'broken.json');
        fs.writeFileSync(fp, '{not valid json');
        const out = await h.engine.withTransaction(h.handle, (tx) => tx.getResource(groupKey('broken')));
        expect(out).toBeNull();
    });

    test('get returns null when file is an array (not object)', async () => {
        const fp = path.join(h.dirs.groups, 'arr.json');
        fs.writeFileSync(fp, '[1,2,3]');
        const out = await h.engine.withTransaction(h.handle, (tx) => tx.getResource(groupKey('arr')));
        expect(out).toBeNull();
    });

    test('delete returns boolean', async () => {
        const missing = await h.engine.withTransaction(h.handle, (tx) => tx.deleteResource(groupKey('nope')));
        expect(missing).toBe(false);
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(groupKey('grp-x'), { doc: { id: 'grp-x' } }));
        const present = await h.engine.withTransaction(h.handle, (tx) => tx.deleteResource(groupKey('grp-x')));
        expect(present).toBe(true);
        expect(fs.existsSync(path.join(h.dirs.groups, 'grp-x.json'))).toBe(false);
    });

    test('list excludes non-json files and sorts by id', async () => {
        fs.writeFileSync(path.join(h.dirs.groups, 'readme.txt'), 'ignore');
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(groupKey('zeta'), { doc: { id: 'zeta' } }));
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(groupKey('alpha'), { doc: { id: 'alpha' } }));
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(groupKey('mid'), { doc: { id: 'mid' } }));
        const listed = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'group', handle: h.handle }));
        const ids = listed.map((e) => e.key.id);
        expect(ids).toEqual(['alpha', 'mid', 'zeta']);
    });

    test('listGroupsWithChatStats joins group with member chat file sizes', async () => {
        // Group references two chats — one exists, one is missing.
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(groupKey('grp-1'), {
                doc: { id: 'grp-1', name: 'Crew', chats: ['chat-a', 'chat-missing'] },
            }));
        const chatAPath = path.join(h.dirs.groupChats, 'chat-a.jsonl');
        const chatAContents = '{"header":1}\n{"msg":"hi"}\n';
        fs.writeFileSync(chatAPath, chatAContents);
        // Unrelated chat that should NOT contribute to the stats.
        fs.writeFileSync(path.join(h.dirs.groupChats, 'unrelated.jsonl'), '{"x":1}\n');

        const groups = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listGroupsWithChatStats({ kind: 'group', handle: h.handle }));
        expect(groups).toHaveLength(1);
        expect(groups[0].id).toBe('grp-1');
        expect(groups[0].chat_size).toBe(Buffer.byteLength(chatAContents));
        expect(groups[0].date_last_chat).toBeGreaterThan(0);
        expect(typeof groups[0].date_added).toBe('number');
        expect(typeof groups[0].create_date).toBe('string');
    });

    test('listGroupsWithChatStats returns zero stats for group with no chats array', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(groupKey('grp-empty'), { doc: { id: 'grp-empty' } }));
        const groups = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listGroupsWithChatStats({ kind: 'group', handle: h.handle }));
        expect(groups).toHaveLength(1);
        expect(groups[0].chat_size).toBe(0);
        expect(groups[0].date_last_chat).toBe(0);
    });

    test('listGroupsWithChatStats creates groups dir lazily when missing', async () => {
        fs.rmSync(h.dirs.groups, { recursive: true, force: true });
        const groups = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listGroupsWithChatStats({ kind: 'group', handle: h.handle }));
        expect(groups).toEqual([]);
        expect(fs.existsSync(h.dirs.groups)).toBe(true);
    });

    test('listGroupsWithChatStats tolerates missing groupChats dir', async () => {
        fs.rmSync(h.dirs.groupChats, { recursive: true, force: true });
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(groupKey('grp-1'), { doc: { id: 'grp-1', chats: ['x'] } }));
        const groups = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listGroupsWithChatStats({ kind: 'group', handle: h.handle }));
        expect(groups).toHaveLength(1);
        expect(groups[0].chat_size).toBe(0);
    });

    test('put rejects empty id', async () => {
        await expect(h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'group', handle: h.handle, id: '' }, { doc: { id: '' } }),
        )).rejects.toThrow(/invalid id/);
    });
});
