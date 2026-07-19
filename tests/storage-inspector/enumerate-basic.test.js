/* eslint-disable playwright/no-standalone-expect */
// playwright plugin misfires on jest `test.each` (reads as standalone expect).
// Every expect here is inside a jest test block.

import { makeFixtureUser } from './_fixture-helper.js';
import {
    walkDirSize,
    enumerateRoot,
    enumerateCategory,
    enumerateSubDir,
    computeCategorySizeWithTimeout,
    CATEGORY_WALK_SOFT_TIMEOUT_MS,
} from '../../src/storage/inspector.js';

// 用 fake user + adminSettings 让 quota 计算不炸
const FAKE_USER = { handle: 'default-user', storageQuotaBytes: -1 };
const FAKE_ADMIN_SETTINGS = { storage: { defaultUserQuotaBytes: -1 } };

describe('walkDirSize', () => {
    test('empty dir returns 0/0', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            const r = await walkDirSize(userRoot);
            expect(r.sizeBytes).toBe(0);
            expect(r.childCount).toBe(0);
        } finally {
            await cleanup();
        }
    });

    test('non-existent dir returns 0/0 without throw', async () => {
        const r = await walkDirSize('/tmp/nonexistent-storage-inspector-x9y7z');
        expect(r.sizeBytes).toBe(0);
        expect(r.childCount).toBe(0);
    });

    test('populated dir returns cumulative size + top-level child count', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chats: true, worlds: true });
        try {
            const r = await walkDirSize(userRoot);
            expect(r.sizeBytes).toBeGreaterThan(0);
            // top-level = chats/ + group chats/ + worlds/
            expect(r.childCount).toBeGreaterThanOrEqual(3);
        } finally {
            await cleanup();
        }
    });
});

describe('enumerateRoot', () => {
    test('empty user returns all 10 categories with 0 size', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            const res = await enumerateRoot(userRoot, FAKE_USER, FAKE_ADMIN_SETTINGS);
            expect(res.path).toEqual([]);
            expect(res.isLeaf).toBe(false);
            expect(res.entries).toHaveLength(10);
            for (const e of res.entries) {
                expect(e.sizeBytes).toBe(0);
                expect(e.kind).toBe('category');
                expect(e.canDrill).toBe(true);
            }
            expect(res.quota.usedBytes).toBe(0);
            expect(res.quota.quotaBytes).toBeNull();
            expect(res.quota.over).toBe(false);
        } finally {
            await cleanup();
        }
    });

    test('populated user has non-zero sizes on relevant categories', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({
            worlds: true, extensions: true, vectors: true,
        });
        try {
            const res = await enumerateRoot(userRoot, FAKE_USER, FAKE_ADMIN_SETTINGS);
            const map = Object.fromEntries(res.entries.map(e => [e.key, e]));
            expect(map.worlds.sizeBytes).toBeGreaterThan(0);
            expect(map.extensions.sizeBytes).toBeGreaterThan(0);
            expect(map.vectors.sizeBytes).toBeGreaterThan(0);
            expect(map.chats.sizeBytes).toBe(0);
            expect(res.quota.usedBytes).toBeGreaterThan(0);
        } finally {
            await cleanup();
        }
    });

    test('quotaBytes populated when user has quota', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            const user = { handle: 'x', storageQuotaBytes: 100_000_000 };
            const res = await enumerateRoot(userRoot, user, FAKE_ADMIN_SETTINGS);
            expect(res.quota.quotaBytes).toBe(100_000_000);
            expect(res.quota.over).toBe(false);
        } finally {
            await cleanup();
        }
    });

    test('over quota flag when used > quota', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ vectors: true });
        try {
            const user = { handle: 'x', storageQuotaBytes: 100 };  // 100 bytes
            const res = await enumerateRoot(userRoot, user, FAKE_ADMIN_SETTINGS);
            expect(res.quota.over).toBe(true);
        } finally {
            await cleanup();
        }
    });
});

describe('enumerateCategory — simple (worlds / extensions / vectors)', () => {
    test('worlds → each json file one entry', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ worlds: true });
        try {
            const res = await enumerateCategory(userRoot, 'worlds');
            expect(res.path).toEqual(['worlds']);
            expect(res.isLeaf).toBe(true);
            const labels = res.entries.map(e => e.label).sort();
            expect(labels).toEqual(['lorebook_a.json', 'lorebook_b.json']);
            for (const e of res.entries) {
                expect(e.kind).toBe('file');
                expect(e.canDrill).toBe(false);
                expect(e.sizeBytes).toBeGreaterThan(0);
            }
        } finally {
            await cleanup();
        }
    });

    test('extensions → each subdir one entry', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ extensions: true });
        try {
            const res = await enumerateCategory(userRoot, 'extensions');
            const labels = res.entries.map(e => e.label);
            expect(labels).toContain('foo');
            const foo = res.entries.find(e => e.label === 'foo');
            expect(foo.kind).toBe('directory');
            expect(foo.canDrill).toBe(true);
        } finally {
            await cleanup();
        }
    });

    test('missing category dir returns empty entries · not error', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            const res = await enumerateCategory(userRoot, 'vectors');
            expect(res.entries).toEqual([]);
        } finally {
            await cleanup();
        }
    });
});

describe('enumerateCategory — grouped (images / attachments / presets / backups)', () => {
    test('images → 3 sub-categories', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ images: true });
        try {
            const res = await enumerateCategory(userRoot, 'images');
            expect(res.isLeaf).toBe(false);
            const keys = res.entries.map(e => e.key).sort();
            expect(keys).toEqual(['backgrounds', 'user-avatars', 'user-images']);
            for (const e of res.entries) {
                expect(e.kind).toBe('sub-dir');
                expect(e.canDrill).toBe(true);
                expect(e.sizeBytes).toBeGreaterThan(0);
            }
        } finally {
            await cleanup();
        }
    });

    test('presets → 4 sub-categories (api / ui / instruct / main)', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ presets: true });
        try {
            const res = await enumerateCategory(userRoot, 'presets');
            const keys = res.entries.map(e => e.key).sort();
            expect(keys).toEqual(['api-presets', 'instruct-templates', 'main-settings', 'ui-elements']);
        } finally {
            await cleanup();
        }
    });
});

describe('enumerateSubDir — grouped category L3 leaves', () => {
    test('images/backgrounds lists each file', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ images: true });
        try {
            const res = await enumerateSubDir(userRoot, 'images', 'backgrounds');
            expect(res.path).toEqual(['images', 'backgrounds']);
            expect(res.isLeaf).toBe(true);
            expect(res.entries.some(e => e.label === 'city.jpg')).toBe(true);
        } finally {
            await cleanup();
        }
    });

    test('unknown subKey throws E_INVALID_PATH', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ images: true });
        try {
            await expect(enumerateSubDir(userRoot, 'images', 'bogus'))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally {
            await cleanup();
        }
    });

    test('category without grouped subs throws E_INVALID_PATH', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            await expect(enumerateSubDir(userRoot, 'worlds', 'anything'))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally {
            await cleanup();
        }
    });
});

describe('enumerateCategory — unknown category', () => {
    test('throws E_INVALID_PATH', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            await expect(enumerateCategory(userRoot, 'bogus'))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally {
            await cleanup();
        }
    });
});

describe('computeCategorySizeWithTimeout — 30s soft timeout', () => {
    test('default constant is 30 seconds', () => {
        expect(CATEGORY_WALK_SOFT_TIMEOUT_MS).toBe(30_000);
    });

    test('returns walk result normally when walk finishes in time', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ worlds: true });
        try {
            const worldsCat = { key: 'worlds', includes: [{ kind: 'dir', rel: 'worlds' }] };
            const r = await computeCategorySizeWithTimeout(userRoot, worldsCat);
            expect(r.sizeBytes).toBeGreaterThan(0);
            expect(r.error).toBeUndefined();
        } finally {
            await cleanup();
        }
    });
});
