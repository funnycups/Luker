// Contract tests for the ChatRepo filtered-list / info / search / metadata
// helpers added in db-parity Phase 5. Each describe.each(CONTRACT_HARNESSES)
// re-runs against fs, sqlite, mysql, and postgres so the endpoint migrations
// in later phases can rely on identical semantics.

import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { NotFoundError, ConflictError } from '../../../src/storage/errors.js';

const HEADER_BARE = { chat_metadata: {} };

function makeChat(headerExtras = {}, messages = []) {
    return { header: { ...HEADER_BARE, ...headerExtras }, messages };
}

describe.each(CONTRACT_HARNESSES)('ChatRepo.listForCharacter on $name', ({ make }) => {
    let h; let repo;
    beforeEach(async () => {
        h = await make();
        repo = new ChatRepo({ engine: h.engine });
    });
    afterEach(async () => { if (h) await h.cleanup(); });

    test('returns empty array when character has no chats', async () => {
        const out = await repo.listForCharacter(h.handle, 'Alice');
        expect(out).toEqual([]);
    });

    test('lists only the chats for the requested character', async () => {
        const a = makeChat();
        const b = makeChat();
        await repo.save(h.handle, 'Alice', 'chat-1', a.header, a.messages, null);
        await repo.save(h.handle, 'Alice', 'chat-2', b.header, b.messages, null);
        await repo.save(h.handle, 'Bob', 'chat-1', b.header, b.messages, null);

        const alice = await repo.listForCharacter(h.handle, 'Alice');
        const bob = await repo.listForCharacter(h.handle, 'Bob');

        expect(alice.map((c) => c.key.name).sort()).toEqual(['chat-1', 'chat-2']);
        expect(bob.map((c) => c.key.name).sort()).toEqual(['chat-1']);

        // None of the entries can leak group chats.
        for (const entry of [...alice, ...bob]) {
            expect(entry.key.isGroup).toBe(false);
        }
    });

    test('orderBy=name returns alphabetical name order', async () => {
        const c = makeChat();
        await repo.save(h.handle, 'Alice', 'zeta', c.header, c.messages, null);
        await repo.save(h.handle, 'Alice', 'alpha', c.header, c.messages, null);
        await repo.save(h.handle, 'Alice', 'mid', c.header, c.messages, null);

        const out = await repo.listForCharacter(h.handle, 'Alice', { orderBy: 'name' });
        expect(out.map((c) => c.key.name)).toEqual(['alpha', 'mid', 'zeta']);
    });
});

describe.each(CONTRACT_HARNESSES)('ChatRepo.listForGroup / listAllGroupChats on $name', ({ make }) => {
    let h; let repo;
    beforeEach(async () => {
        h = await make();
        repo = new ChatRepo({ engine: h.engine });
    });
    afterEach(async () => { if (h) await h.cleanup(); });

    // In Luker, a group chat's `name` and `groupId` are the same string —
    // the on-disk FS engine stores one .jsonl per group keyed by id, and the
    // endpoint code does {name: safeGroupId, groupId: safeGroupId}. SQL
    // engines store them as separate columns but the runtime always passes
    // the same value, so the contract tests use the same convention.

    test('listForGroup filters by groupId', async () => {
        const c = makeChat();
        await repo.save(h.handle, '', 'grp1', c.header, c.messages, null, { isGroup: true, groupId: 'grp1' });
        await repo.save(h.handle, '', 'grp2', c.header, c.messages, null, { isGroup: true, groupId: 'grp2' });

        const grp1 = await repo.listForGroup(h.handle, 'grp1');
        const grp2 = await repo.listForGroup(h.handle, 'grp2');

        expect(grp1.map((c) => c.key.name)).toEqual(['grp1']);
        expect(grp2.map((c) => c.key.name)).toEqual(['grp2']);
        for (const entry of [...grp1, ...grp2]) {
            expect(entry.key.isGroup).toBe(true);
        }
    });

    test('listAllGroupChats returns every group chat regardless of groupId', async () => {
        const c = makeChat();
        await repo.save(h.handle, '', 'grp1', c.header, c.messages, null, { isGroup: true, groupId: 'grp1' });
        await repo.save(h.handle, '', 'grp2', c.header, c.messages, null, { isGroup: true, groupId: 'grp2' });
        // a non-group chat under a character — must NOT appear.
        await repo.save(h.handle, 'Alice', 'solo', c.header, c.messages, null);

        const all = await repo.listAllGroupChats(h.handle);
        expect(all.map((c) => c.key.name).sort()).toEqual(['grp1', 'grp2']);
    });
});

describe.each(CONTRACT_HARNESSES)('ChatRepo.listAll on $name', ({ make }) => {
    let h; let repo;
    beforeEach(async () => {
        h = await make();
        repo = new ChatRepo({ engine: h.engine });
    });
    afterEach(async () => { if (h) await h.cleanup(); });

    test('returns BOTH character and group chats', async () => {
        const c = makeChat();
        await repo.save(h.handle, 'Alice', 'one', c.header, c.messages, null);
        await repo.save(h.handle, '', 'grp', c.header, c.messages, null, { isGroup: true, groupId: 'grp' });

        const all = await repo.listAll(h.handle);
        expect(all).toHaveLength(2);
        const names = all.map((e) => e.key.name).sort();
        expect(names).toEqual(['grp', 'one']);
    });
});

describe.each(CONTRACT_HARNESSES)('ChatRepo.getInfo on $name', ({ make }) => {
    let h; let repo;
    beforeEach(async () => {
        h = await make();
        repo = new ChatRepo({ engine: h.engine });
    });
    afterEach(async () => { if (h) await h.cleanup(); });

    test('returns null for missing chat', async () => {
        expect(await repo.getInfo(h.handle, 'Alice', 'absent')).toBeNull();
    });

    test('projects messageCount, lastMessage, chatMetadata', async () => {
        const header = { chat_metadata: { lorebook: 'ALore', custom_flag: true }, user_name: 'tester' };
        const messages = [
            { name: 'User', mes: 'hi' },
            { name: 'Alice', mes: 'hello back' },
            { name: 'User', mes: 'how are you?' },
        ];
        await repo.save(h.handle, 'Alice', 'main', header, messages, null);

        const info = await repo.getInfo(h.handle, 'Alice', 'main');
        expect(info).not.toBeNull();
        expect(info.messageCount).toBe(3);
        expect(info.lastMessage.mes).toBe('how are you?');
        expect(info.chatMetadata.lorebook).toBe('ALore');
        expect(info.chatMetadata.custom_flag).toBe(true);
        // integrity stamp present (rotates on every save), updatedAt > 0.
        expect(typeof info.integrity).toBe('string');
        expect(info.updatedAt).toBeGreaterThan(0);
    });
});

describe.each(CONTRACT_HARNESSES)('ChatRepo.updateChatMetadata on $name', ({ make }) => {
    let h; let repo;
    beforeEach(async () => {
        h = await make();
        repo = new ChatRepo({ engine: h.engine });
    });
    afterEach(async () => { if (h) await h.cleanup(); });

    test('merges metadata patch into existing header without touching body', async () => {
        const header = { chat_metadata: { lorebook: 'A', stale: 1 }, user_name: 'tester' };
        const messages = [{ name: 'User', mes: 'msg' }];
        const saved = await repo.save(h.handle, 'Alice', 'main', header, messages, null);

        const result = await repo.updateChatMetadata(
            h.handle, 'Alice', 'main',
            { lorebook: 'B', new_field: 'x' },
            saved.integrity,
        );
        expect(typeof result.integrity).toBe('string');
        expect(result.integrity).not.toBe(saved.integrity);

        const chat = await repo.get(h.handle, 'Alice', 'main');
        expect(chat.header.chat_metadata.lorebook).toBe('B');
        expect(chat.header.chat_metadata.stale).toBe(1); // preserved
        expect(chat.header.chat_metadata.new_field).toBe('x');
        expect(chat.header.user_name).toBe('tester'); // outside chat_metadata preserved
        expect(chat.body).toEqual(messages);
    });

    test('throws NotFoundError when chat does not exist', async () => {
        await expect(
            repo.updateChatMetadata(h.handle, 'Alice', 'absent', { x: 1 }, null),
        ).rejects.toThrow(NotFoundError);
    });

    test('throws ConflictError on integrity mismatch', async () => {
        const header = { chat_metadata: {} };
        await repo.save(h.handle, 'Alice', 'main', header, [], null);
        await expect(
            repo.updateChatMetadata(h.handle, 'Alice', 'main', { x: 1 }, 'wrong-integrity'),
        ).rejects.toThrow(ConflictError);
    });
});

describe.each(CONTRACT_HARNESSES)('ChatRepo.renameCharDir on $name', ({ make }) => {
    let h; let repo;
    beforeEach(async () => {
        h = await make();
        repo = new ChatRepo({ engine: h.engine });
    });
    afterEach(async () => { if (h) await h.cleanup(); });

    test('returns 0 when source character has no chats', async () => {
        expect(await repo.renameCharDir(h.handle, 'Empty', 'EmptyRenamed')).toBe(0);
    });

    test('moves every chat to the new charDir, preserving body + state sidecars', async () => {
        const c = makeChat();
        const cA = await repo.save(h.handle, 'Alice', 'c1', c.header, c.messages, null);
        await repo.save(h.handle, 'Alice', 'c2', c.header, c.messages, null);

        // Attach a state sidecar to c1.
        await repo.setState(h.handle, 'Alice', 'c1', 'tunes', { v: 1, marker: 'before-rename' });

        const moved = await repo.renameCharDir(h.handle, 'Alice', 'AliceRenamed');
        expect(moved).toBe(2);

        // Old name has nothing.
        expect(await repo.listForCharacter(h.handle, 'Alice')).toEqual([]);
        // New name has both.
        const after = await repo.listForCharacter(h.handle, 'AliceRenamed');
        expect(after.map((e) => e.key.name).sort()).toEqual(['c1', 'c2']);
        // Body survives.
        const c1Body = await repo.get(h.handle, 'AliceRenamed', 'c1');
        expect(c1Body).not.toBeNull();
        // State sidecar survives.
        const sidecar = await repo.getState(h.handle, 'AliceRenamed', 'c1', 'tunes');
        expect(sidecar).not.toBeNull();
        expect(sidecar.marker).toBe('before-rename');
        void cA;
    });

    test('does not touch group chats under any charDir', async () => {
        const c = makeChat();
        await repo.save(h.handle, 'Alice', 'c1', c.header, c.messages, null);
        await repo.save(h.handle, '', 'grp', c.header, c.messages, null, { isGroup: true, groupId: 'grp' });

        await repo.renameCharDir(h.handle, 'Alice', 'AliceRenamed');

        const grp = await repo.listAllGroupChats(h.handle);
        expect(grp.map((e) => e.key.name)).toEqual(['grp']);
    });
});

describe.each(CONTRACT_HARNESSES)('ChatRepo.deleteAllForCharacter on $name', ({ make }) => {
    let h; let repo;
    beforeEach(async () => {
        h = await make();
        repo = new ChatRepo({ engine: h.engine });
    });
    afterEach(async () => { if (h) await h.cleanup(); });

    test('removes every chat for the character + cascaded state sidecars', async () => {
        const c = makeChat();
        await repo.save(h.handle, 'Alice', 'c1', c.header, c.messages, null);
        await repo.save(h.handle, 'Alice', 'c2', c.header, c.messages, null);
        await repo.setState(h.handle, 'Alice', 'c1', 'ns', { x: 1 });

        const removed = await repo.deleteAllForCharacter(h.handle, 'Alice');
        expect(removed).toBe(2);
        expect(await repo.listForCharacter(h.handle, 'Alice')).toEqual([]);
        expect(await repo.getState(h.handle, 'Alice', 'c1', 'ns')).toBeNull();
    });

    test('does not touch other characters or group chats', async () => {
        const c = makeChat();
        await repo.save(h.handle, 'Alice', 'c1', c.header, c.messages, null);
        await repo.save(h.handle, 'Bob', 'c1', c.header, c.messages, null);
        await repo.save(h.handle, '', 'grp', c.header, c.messages, null, { isGroup: true, groupId: 'grp' });

        await repo.deleteAllForCharacter(h.handle, 'Alice');
        expect(await repo.listForCharacter(h.handle, 'Bob')).toHaveLength(1);
        expect(await repo.listAllGroupChats(h.handle)).toHaveLength(1);
    });
});

describe.each(CONTRACT_HARNESSES)('ChatRepo.searchByContent on $name', ({ make }) => {
    let h; let repo;
    beforeEach(async () => {
        h = await make();
        repo = new ChatRepo({ engine: h.engine });
    });
    afterEach(async () => { if (h) await h.cleanup(); });

    test('returns empty array for empty query', async () => {
        expect(await repo.searchByContent(h.handle, '')).toEqual([]);
    });

    test('matches across messages, case-insensitive, returning hit indexes', async () => {
        await repo.save(h.handle, 'Alice', 'chat-1', HEADER_BARE, [
            { name: 'User', mes: 'do you like elephants?' },
            { name: 'Alice', mes: 'they are wonderful' },
        ], null);
        await repo.save(h.handle, 'Alice', 'chat-2', HEADER_BARE, [
            { name: 'User', mes: 'no elephants here' },
        ], null);
        await repo.save(h.handle, 'Bob', 'chat-1', HEADER_BARE, [
            { name: 'User', mes: 'tigers are cool' },
        ], null);

        const out = await repo.searchByContent(h.handle, 'ELEphants');
        expect(out).toHaveLength(2);
        const names = out.map((e) => `${e.charDir}:${e.name}`).sort();
        expect(names).toEqual(['Alice:chat-1', 'Alice:chat-2']);

        const aliceHit = out.find((e) => e.name === 'chat-1');
        expect(aliceHit.snippets[0].messageIndex).toBe(0);
        expect(aliceHit.snippets[0].text).toContain('elephants');
    });

    test('respects charDir filter', async () => {
        await repo.save(h.handle, 'Alice', 'c1', HEADER_BARE, [{ mes: 'cats and dogs' }], null);
        await repo.save(h.handle, 'Bob', 'c2', HEADER_BARE, [{ mes: 'cats and tigers' }], null);

        const aliceOnly = await repo.searchByContent(h.handle, 'cats', { charDir: 'Alice' });
        expect(aliceOnly).toHaveLength(1);
        expect(aliceOnly[0].charDir).toBe('Alice');
    });

    test('respects groupId filter (only group chats)', async () => {
        await repo.save(h.handle, '', 'g1', HEADER_BARE, [{ mes: 'unique-token-XYZ' }], null,
            { isGroup: true, groupId: 'g1' });
        await repo.save(h.handle, '', 'g2', HEADER_BARE, [{ mes: 'unique-token-XYZ' }], null,
            { isGroup: true, groupId: 'g2' });
        await repo.save(h.handle, 'Alice', 'solo', HEADER_BARE, [{ mes: 'unique-token-XYZ' }], null);

        const g1 = await repo.searchByContent(h.handle, 'unique-token-XYZ', { groupId: 'g1' });
        expect(g1).toHaveLength(1);
        expect(g1[0].groupId).toBe('g1');
        expect(g1[0].isGroup).toBe(true);
    });
});
