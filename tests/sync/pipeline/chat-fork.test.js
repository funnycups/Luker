import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { readBlobBytes } from '../../../src/sync/pipeline/git-tree.js';
import { formatForkTimestamp, branchChatBaseName, classifyChatPath, forkChat, listChatOnOwningGroup, MAX_CHAT_NAME_BYTES, MAX_CHAT_NAME_CHARS, MAX_FILE_NAME_BYTES } from '../../../src/sync/pipeline/chat-fork.js';
import { writeBlob } from '../_lib/commits.js';

const layout = { chatsDir: 'chats', groupChatsDir: 'group chats', groupsDir: 'groups' };
const date = new Date(2026, 9, 13, 9, 5);
const header = JSON.stringify({ user_name: 'U', character_name: 'Seraphina', chat_metadata: { integrity: 'old-integrity' } });
const lines = [JSON.stringify({ name: 'U', is_user: true, mes: 'The glade is quiet.' }), JSON.stringify({ name: 'Seraphina', is_user: false, mes: 'Rest, traveler.' })];

describe('branch names', () => {
    test('formatForkTimestamp uses local time', () => {
        expect(formatForkTimestamp(date)).toBe('2026-10-13 09.05');
    });
    test('names follow the sync conflict pattern and stay unique', () => {
        expect(branchChatBaseName({ base: 'Seraphina - 2026-10-01', deviceLabel: 'Laptop', date, taken: new Set() }))
            .toBe('Seraphina - 2026-10-01 - Sync conflict Laptop 2026-10-13 09.05');
        expect(branchChatBaseName({ base: 'S', deviceLabel: 'Laptop', date, taken: new Set(['S - Sync conflict Laptop 2026-10-13 09.05']) }))
            .toBe('S - Sync conflict Laptop 2026-10-13 09.05 (2)');
    });
    test('a taken name differing only in case or normalization form counts as taken', () => {
        expect(branchChatBaseName({ base: 'S', deviceLabel: 'Laptop', date, taken: new Set(['s - sync conflict LAPTOP 2026-10-13 09.05']) }))
            .toBe('S - Sync conflict Laptop 2026-10-13 09.05 (2)');
        const composed = 'Café';
        expect(branchChatBaseName({ base: composed, deviceLabel: 'P', date, taken: new Set([`${composed.normalize('NFD')} - Sync conflict P 2026-10-13 09.05`]) }))
            .toBe(`${composed} - Sync conflict P 2026-10-13 09.05 (2)`);
    });
    test('path separators in the device label are removed', () => {
        expect(branchChatBaseName({ base: 'S', deviceLabel: 'Lap/top', date, taken: new Set() })).toBe('S - Sync conflict Laptop 2026-10-13 09.05');
    });
    test('the state companion infix never appears in a branch name', () => {
        const name = branchChatBaseName({ base: 'a.luker-state.b', deviceLabel: 'Lap.luker-state.top', date, taken: new Set() });
        expect(name).toBe('a b - Sync conflict Lap top 2026-10-13 09.05');
        expect(name.includes('.luker-state.')).toBe(false);
    });
    test('a chat name that cleans to nothing falls back to chat', () => {
        expect(branchChatBaseName({ base: '//', deviceLabel: 'Phone', date, taken: new Set() })).toBe('chat - Sync conflict Phone 2026-10-13 09.05');
    });
    test('a long chat name is shortened to fit the SQL column', () => {
        const name = branchChatBaseName({ base: 'x'.repeat(300), deviceLabel: 'Phone', date, taken: new Set() });
        expect([...name].length).toBeLessThanOrEqual(MAX_CHAT_NAME_CHARS);
        expect(name.endsWith(' - Sync conflict Phone 2026-10-13 09.05')).toBe(true);
    });
    test('a multi-byte chat name is shortened so every companion file name fits', () => {
        const name = branchChatBaseName({ base: '森'.repeat(120), deviceLabel: '电话', date, taken: new Set(), longestNamespace: 'memory_graph' });
        expect([...name].length).toBeLessThanOrEqual(MAX_CHAT_NAME_CHARS);
        expect(Buffer.byteLength(`${name}.luker-state.memory_graph.json`)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
        expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_CHAT_NAME_BYTES);
    });
    test.each([
        ['a CJK label', '电话'.repeat(30)],
        ['an emoji label', '📱'.repeat(30)],
    ])('a multi-byte chat name with %s fits the byte limit save endpoints enforce', (_, deviceLabel) => {
        const name = branchChatBaseName({ base: '森'.repeat(120), deviceLabel, date, taken: new Set() });
        expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_CHAT_NAME_BYTES);
        expect(name.startsWith('森')).toBe(true);
        expect(name.endsWith('2026-10-13 09.05')).toBe(true);
    });
    test('a device label too long to fit is shortened as well', () => {
        const name = branchChatBaseName({ base: 'S', deviceLabel: 'd'.repeat(400), date, taken: new Set() });
        expect([...name].length).toBeLessThanOrEqual(MAX_CHAT_NAME_CHARS);
        expect(name.endsWith('2026-10-13 09.05')).toBe(true);
        expect(name.startsWith('S - Sync conflict d')).toBe(true);
    });
});

describe('forkChat', () => {
    let userRoot;
    let gitdir;
    const blobFile = async content => ({ oid: await writeBlob(gitdir, content), mode: '100644' });
    const text = async file => (await readBlobBytes({ gitdir, oid: file.oid })).toString('utf8');
    const fork = (files, theirsFiles, chatPath) => forkChat({ gitdir, layout, files, theirsFiles, chat: classifyChatPath(layout, chatPath), deviceLabel: 'Phone', date });
    beforeEach(async () => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-fork-'));
        ({ gitDir: gitdir } = await ensureShadowRepo({ userRoot, peerId: 'p' }));
    });
    afterEach(() => fs.rmSync(userRoot, { recursive: true, force: true }));

    test('classifyChatPath recognizes chats, group chats and their companions only', () => {
        expect(classifyChatPath(layout, 'chats/Seraphina/c1.luker-state.mg.json')).toEqual({ kind: 'character', dir: 'chats/Seraphina', base: 'c1', chatPath: 'chats/Seraphina/c1.jsonl', avatarDir: 'Seraphina' });
        expect(classifyChatPath(layout, 'group chats/gc1.jsonl')).toEqual({ kind: 'group', dir: 'group chats', base: 'gc1', chatPath: 'group chats/gc1.jsonl', avatarDir: null });
        expect(classifyChatPath(layout, 'groups/g1.json')).toBeNull();
        expect(classifyChatPath(layout, 'worlds/w.json')).toBeNull();
    });

    test('a character chat fork rewrites main_chat and integrity and copies the companions', async () => {
        const theirsFiles = new Map([
            ['chats/Seraphina/c1.jsonl', await blobFile([header, ...lines].join('\n'))],
            ['chats/Seraphina/c1.luker-state.memory_graph.json', await blobFile('{"nodes":[]}')],
        ]);
        const files = new Map([['chats/Seraphina/c1.jsonl', await blobFile([header, lines[0]].join('\n'))]]);
        const result = await fork(files, theirsFiles, 'chats/Seraphina/c1.jsonl');
        const branch = 'c1 - Sync conflict Phone 2026-10-13 09.05';
        expect(result.branchPath).toBe(`chats/Seraphina/${branch}.jsonl`);
        const [first, ...rest] = (await text(files.get(result.branchPath))).split('\n');
        expect(JSON.parse(first).chat_metadata.main_chat).toBe('c1');
        expect(JSON.parse(first).chat_metadata.integrity).toMatch(/^[0-9a-f-]{36}$/);
        expect(rest).toEqual(lines);
        expect(files.get(`chats/Seraphina/${branch}.luker-state.memory_graph.json`).oid).toBe(theirsFiles.get('chats/Seraphina/c1.luker-state.memory_graph.json').oid);
        expect(result.notice).toEqual({ kind: 'fork', chat: 'chats/Seraphina/c1.jsonl', device: 'Phone', createdAt: date.toISOString(), target: { kind: 'character', avatar: 'Seraphina.png', name: branch } });
    });

    test('the chat sync companion holding the old integrity is not copied', async () => {
        const files = new Map();
        const theirsFiles = new Map([
            ['chats/S/c.jsonl', await blobFile(header)],
            ['chats/S/c.luker-state.chat_sync.json', await blobFile('{"integrity":"old-integrity"}')],
        ]);
        const result = await fork(files, theirsFiles, 'chats/S/c.jsonl');
        expect([...files.keys()]).toEqual([result.branchPath]);
    });

    test('a companion whose namespace exceeds the endpoint limit is skipped when its file name cannot fit', async () => {
        const files = new Map();
        const long = 'n'.repeat(240);
        const theirsFiles = new Map([
            ['chats/S/c.jsonl', await blobFile(header)],
            ['chats/S/c.luker-state.mg.json', await blobFile('{}')],
            [`chats/S/c.luker-state.${long}.json`, await blobFile('{}')],
        ]);
        const result = await fork(files, theirsFiles, 'chats/S/c.jsonl');
        const branch = 'c - Sync conflict Phone 2026-10-13 09.05';
        expect(result.branchPath).toBe(`chats/S/${branch}.jsonl`);
        expect([...files.keys()].sort()).toEqual([result.branchPath, `chats/S/${branch}.luker-state.mg.json`].sort());
    });

    test('a group chat fork appends the branch id to the owning group', async () => {
        const group = { id: 'g1', name: 'Glade Watch', members: ['Seraphina.png'], chat_id: 'gc1', chats: ['gc1'] };
        const files = new Map([['groups/g1.json', await blobFile(JSON.stringify(group, null, 4))], ['group chats/gc1.jsonl', await blobFile(header)]]);
        const theirsFiles = new Map([['group chats/gc1.jsonl', await blobFile([header, ...lines].join('\n'))]]);
        const result = await fork(files, theirsFiles, 'group chats/gc1.jsonl');
        const branch = 'gc1 - Sync conflict Phone 2026-10-13 09.05';
        expect(result.branchPath).toBe(`group chats/${branch}.jsonl`);
        expect(await text(files.get('groups/g1.json'))).toBe(JSON.stringify({ ...group, chats: ['gc1', branch] }, null, 4));
        expect(JSON.parse((await text(files.get(result.branchPath))).split('\n')[0]).chat_metadata.main_chat).toBe('gc1');
        expect(result.notice.target).toEqual({ kind: 'group', groupId: 'g1', name: branch });
    });

    test('a group without a chats list gets its current chat and the branch', async () => {
        const group = { id: 'g1', name: 'Glade Watch', chat_id: 'gc1' };
        const files = new Map([['groups/g1.json', await blobFile(JSON.stringify(group, null, 4))]]);
        const result = await fork(files, new Map([['group chats/gc1.jsonl', await blobFile(header)]]), 'group chats/gc1.jsonl');
        expect(JSON.parse(await text(files.get('groups/g1.json'))).chats).toEqual(['gc1', result.notice.target.name]);
    });

    test('a group chat no group lists gets a null group id', async () => {
        const result = await fork(new Map(), new Map([['group chats/gc9.jsonl', await blobFile(header)]]), 'group chats/gc9.jsonl');
        expect(result.notice.target.groupId).toBeNull();
    });

    test('a restored group chat is listed again on its group in the merged tree', async () => {
        const group = { id: 'g1', name: 'Glade Watch', chat_id: 'gc2', chats: ['gc2'] };
        const groupFile = await blobFile(JSON.stringify(group, null, 4));
        const files = new Map([['groups/g1.json', groupFile]]);
        const ownerFiles = new Map([['groups/g1.json', await blobFile(JSON.stringify({ ...group, chats: ['gc1', 'gc2'] }, null, 4))]]);
        const sides = { baseFiles: ownerFiles, deleterFiles: files };
        expect(await listChatOnOwningGroup({ gitdir, layout, files, ownerFiles, chatId: 'gc1', ...sides })).toEqual({ path: 'groups/g1.json', deleted: false });
        expect(JSON.parse(await text(files.get('groups/g1.json'))).chats).toEqual(['gc2', 'gc1']);
    });

    test('a restored group chat brings back its group file when the merged tree lacks it', async () => {
        const kept = await blobFile(JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1'] }, null, 4));
        const files = new Map();
        const ownerFiles = new Map([['groups/g1.json', kept]]);
        expect(await listChatOnOwningGroup({ gitdir, layout, files, ownerFiles, chatId: 'gc1', baseFiles: ownerFiles, deleterFiles: new Map() })).toEqual({ path: 'groups/g1.json', deleted: true });
        expect(files.get('groups/g1.json')).toEqual(kept);
    });

    test('a group the deleting side lacks counts as deleted when the merged tree already holds it', async () => {
        const kept = await blobFile(JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1'], date_last_chat: 5 }, null, 4));
        const files = new Map([['groups/g1.json', kept]]);
        const baseFiles = new Map([['groups/g1.json', await blobFile(JSON.stringify({ id: 'g1', chats: ['gc1'] }, null, 4))]]);
        expect(await listChatOnOwningGroup({ gitdir, layout, files, ownerFiles: files, chatId: 'gc1', baseFiles, deleterFiles: new Map() })).toEqual({ path: 'groups/g1.json', deleted: true });
        expect(files.get('groups/g1.json')).toEqual(kept);
    });

    test('a restored group chat no group lists on the keeping side stays unlisted', async () => {
        const files = new Map();
        expect(await listChatOnOwningGroup({ gitdir, layout, files, ownerFiles: new Map(), chatId: 'gc1', baseFiles: new Map(), deleterFiles: new Map() })).toBeNull();
        expect(files.size).toBe(0);
    });

    test('no fork when theirs deleted the chat', async () => {
        const files = new Map([['chats/S/c.jsonl', await blobFile(header)]]);
        const before = [...files];
        expect(await fork(files, new Map(), 'chats/S/c.jsonl')).toBeNull();
        expect([...files]).toEqual(before);
    });

    test('a branch of a chat missing from the merged tree has no main chat', async () => {
        const files = new Map();
        const result = await fork(files, new Map([['chats/S/c.jsonl', await blobFile([header, ...lines].join('\n'))]]), 'chats/S/c.jsonl');
        const metadata = JSON.parse((await text(files.get(result.branchPath))).split('\n')[0]).chat_metadata;
        expect(Object.hasOwn(metadata, 'main_chat')).toBe(false);
        expect(metadata.integrity).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('a header line that is not JSON is forked byte for byte', async () => {
        const files = new Map();
        const result = await fork(files, new Map([['chats/S/c.jsonl', await blobFile('not-json\nline')]]), 'chats/S/c.jsonl');
        expect(await text(files.get(result.branchPath))).toBe('not-json\nline');
    });

    test('a name already taken in the merged tree gets a suffix', async () => {
        const files = new Map([['chats/S/c - Sync conflict Phone 2026-10-13 09.05.jsonl', await blobFile(header)]]);
        const result = await fork(files, new Map([['chats/S/c.jsonl', await blobFile(header)]]), 'chats/S/c.jsonl');
        expect(result.branchPath).toBe('chats/S/c - Sync conflict Phone 2026-10-13 09.05 (2).jsonl');
    });

    test('a name held only by a state companion in the merged tree gets a suffix', async () => {
        const files = new Map([['chats/S/c - Sync conflict Phone 2026-10-13 09.05.luker-state.mg.json', await blobFile('{}')]]);
        const result = await fork(files, new Map([['chats/S/c.jsonl', await blobFile(header)]]), 'chats/S/c.jsonl');
        expect(result.branchPath).toBe('chats/S/c - Sync conflict Phone 2026-10-13 09.05 (2).jsonl');
    });
});
