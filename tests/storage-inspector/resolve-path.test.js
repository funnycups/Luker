/* eslint-disable playwright/no-standalone-expect */
// playwright plugin misfires on jest `test.each` (reads as standalone expect).
// Every expect here is inside a jest test block.

import { makeFixtureUser } from './_fixture-helper.js';
import { resolvePath, StorageInspectorError } from '../../src/storage/inspector.js';

const FAKE_USER = { handle: 'default-user', storageQuotaBytes: -1 };
const FAKE_ADMIN = { storage: { defaultUserQuotaBytes: -1 } };
const OPTS = { target: { type: 'self', handle: 'default-user' }, user: FAKE_USER, adminSettings: FAKE_ADMIN };

describe('resolvePath — L0/L1/L2/L3/L4 dispatch', () => {
    test('[] → L0 root(10 categories)', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            const res = await resolvePath(userRoot, [], OPTS);
            expect(res.path).toEqual([]);
            expect(res.entries).toHaveLength(10);
        } finally { await cleanup(); }
    });

    test('["worlds"] → L1 worlds (leaf)', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ worlds: true });
        try {
            const res = await resolvePath(userRoot, ['worlds'], OPTS);
            expect(res.path).toEqual(['worlds']);
            expect(res.isLeaf).toBe(true);
            expect(res.entries.length).toBeGreaterThan(0);
        } finally { await cleanup(); }
    });

    test('["chats", "<char>"] → chat file list', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            const res = await resolvePath(userRoot, ['chats', 'default_Seraphina'], OPTS);
            expect(res.path).toEqual(['chats', 'default_Seraphina']);
            expect(res.entries.every(e => e.kind === 'chat-file')).toBe(true);
        } finally { await cleanup(); }
    });

    test('["chats", "<char>", "<chat.jsonl>"] → L4 metadata/messages/sidecar', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            const res = await resolvePath(userRoot,
                ['chats', 'default_Seraphina', 'Chat 2024-01-15.jsonl'], OPTS);
            expect(res.isLeaf).toBe(true);
            expect(res.entries.some(e => e.kind === 'chat-metadata')).toBe(true);
            expect(res.entries.some(e => e.kind === 'chat-messages')).toBe(true);
        } finally { await cleanup(); }
    });

    test('["chats", "__group_chats__"] → group chat list', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            const res = await resolvePath(userRoot, ['chats', '__group_chats__'], OPTS);
            expect(res.entries.some(e => e.label === 'group_abc.jsonl')).toBe(true);
        } finally { await cleanup(); }
    });

    test('["chats", "__group_chats__", "<file.jsonl>"] → L4 group chat leaf', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            const res = await resolvePath(userRoot,
                ['chats', '__group_chats__', 'group_abc.jsonl'], OPTS);
            expect(res.isLeaf).toBe(true);
            expect(res.entries.some(e => e.kind === 'chat-metadata')).toBe(true);
        } finally { await cleanup(); }
    });

    test('["characters", "<char>"] → L3 leaf(card+sprites+sidecar)', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ charactersRich: true });
        try {
            const res = await resolvePath(userRoot, ['characters', 'default_Seraphina'], OPTS);
            expect(res.isLeaf).toBe(true);
            expect(res.entries.some(e => e.kind === 'character-card')).toBe(true);
        } finally { await cleanup(); }
    });

    test('[groupedKey, subKey] → enumerateSubDir', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ images: true });
        try {
            const res = await resolvePath(userRoot, ['images', 'backgrounds'], OPTS);
            expect(res.path).toEqual(['images', 'backgrounds']);
            expect(res.isLeaf).toBe(true);
        } finally { await cleanup(); }
    });
});

describe('resolvePath — sensitive file interception', () => {
    test('["other"] → L2 shows secrets.json as sensitive-blob (allowed)', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ otherRich: true });
        try {
            const res = await resolvePath(userRoot, ['other'], OPTS);
            const secrets = res.entries.find(e => e.key === 'secrets.json');
            expect(secrets.kind).toBe('sensitive-blob');
        } finally { await cleanup(); }
    });

    test('["other", "secrets.json", "anything"] → E_NOT_INSPECTABLE', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ otherRich: true });
        try {
            const p = resolvePath(userRoot, ['other', 'secrets.json', 'api_key_openai'], OPTS);
            await expect(p).rejects.toThrow(StorageInspectorError);
            await expect(p).rejects.toMatchObject({ code: 'E_NOT_INSPECTABLE' });
        } finally { await cleanup(); }
    });
});

describe('resolvePath — malicious path rejection', () => {
    test.each([
        [['..'], 'traversal'],
        [['chats', '..'], 'nested traversal'],
        [['chats', 'default_Seraphina/../..'], 'slash in segment'],
        [['chats', '\0evil'], 'null byte'],
        [['chats', '/absolute'], 'abs'],
    ])('rejects %j (%s)', async (badPath) => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            await expect(resolvePath(userRoot, badPath, OPTS))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally { await cleanup(); }
    });

    test('unknown category → E_INVALID_PATH', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            await expect(resolvePath(userRoot, ['nonexistent-cat'], OPTS))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally { await cleanup(); }
    });

    test('non-array path → E_INVALID_PATH', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            await expect(resolvePath(userRoot, 'not-an-array', OPTS))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally { await cleanup(); }
    });

    test('null path → E_INVALID_PATH', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            await expect(resolvePath(userRoot, null, OPTS))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally { await cleanup(); }
    });
});

describe('resolvePath — depth limits', () => {
    test('chats path exceeding depth 3 rejects', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            await expect(resolvePath(userRoot,
                ['chats', 'default_Seraphina', 'Chat 2024-01-15.jsonl', 'deeper'], OPTS))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally { await cleanup(); }
    });

    test('characters path exceeding depth 2 rejects', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ charactersRich: true });
        try {
            await expect(resolvePath(userRoot,
                ['characters', 'default_Seraphina', 'extra'], OPTS))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally { await cleanup(); }
    });

    test('other path exceeding depth 1 rejects', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ otherRich: true });
        try {
            // non-sensitive drill; even that is not allowed since other is leaf
            await expect(resolvePath(userRoot, ['other', 'stats.json'], OPTS))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally { await cleanup(); }
    });

    test('grouped path exceeding depth 2 rejects', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ images: true });
        try {
            await expect(resolvePath(userRoot,
                ['images', 'backgrounds', 'city.jpg'], OPTS))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally { await cleanup(); }
    });

    test('simple category exceeding depth 1 rejects', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ worlds: true });
        try {
            await expect(resolvePath(userRoot, ['worlds', 'lorebook_a.json'], OPTS))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally { await cleanup(); }
    });
});

describe('resolvePath — virtual key sanitize exemption', () => {
    test('__group_chats__ passes sanitize and dispatches to group-chats enumerator', async () => {
        // Positive: 只有 __group_chats__ 在正常 drill 路径里出现;若 sanitize
        // 拒 double-underscore key,这里会 E_INVALID_PATH.
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            const res = await resolvePath(userRoot, ['chats', '__group_chats__'], OPTS);
            expect(res.path).toEqual(['chats', '__group_chats__']);
        } finally { await cleanup(); }
    });

    test('rejects malformed virtual key __../__ via sanitize', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            await expect(resolvePath(userRoot, ['chats', '__../__'], OPTS))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally { await cleanup(); }
    });
});
