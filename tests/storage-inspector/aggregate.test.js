import { makeFixtureUser } from './_fixture-helper.js';
import {
    enumerateAggregateRoot,
    enumerateAggregateCategory,
} from '../../src/storage/inspector.js';

async function makeFixtureCluster() {
    const a = await makeFixtureUser({ worlds: true, chatsRich: true });
    const b = await makeFixtureUser({ worlds: true, vectors: true });
    return {
        users: [
            { handle: 'alice', root: a.userRoot, storageQuotaBytes: -1 },
            { handle: 'bob',   root: b.userRoot, storageQuotaBytes: -1 },
        ],
        cleanup: async () => { await a.cleanup(); await b.cleanup(); },
    };
}

const FAKE_ADMIN = { storage: { defaultUserQuotaBytes: -1 } };

describe('enumerateAggregateRoot · L0', () => {
    test('sums categories across users', async () => {
        const { users, cleanup } = await makeFixtureCluster();
        try {
            const res = await enumerateAggregateRoot(users, FAKE_ADMIN);
            expect(res.target.type).toBe('aggregate');
            expect(res.target.handle).toBeNull();
            expect(res.entries).toHaveLength(10);
            const map = Object.fromEntries(res.entries.map(e => [e.key, e]));
            expect(map.worlds.sizeBytes).toBeGreaterThan(0);   // both users have worlds
            expect(map.chats.sizeBytes).toBeGreaterThan(0);    // only alice
            expect(map.vectors.sizeBytes).toBeGreaterThan(0);  // only bob
            for (const e of res.entries) {
                expect(e.kind).toBe('category');
            }
        } finally { await cleanup(); }
    });

    test('empty cluster returns 10 zero rows (no crash)', async () => {
        const res = await enumerateAggregateRoot([], FAKE_ADMIN);
        expect(res.entries).toHaveLength(10);
        for (const e of res.entries) {
            expect(e.sizeBytes).toBe(0);
            expect(e.canDrill).toBe(false);
        }
    });
});

describe('enumerateAggregateCategory · L1', () => {
    test('worlds category shows both users sorted by size', async () => {
        const { users, cleanup } = await makeFixtureCluster();
        try {
            const res = await enumerateAggregateCategory(users, 'worlds');
            expect(res.path).toEqual(['worlds']);
            expect(res.isLeaf).toBe(false);
            const keys = res.entries.map(e => e.key).sort();
            expect(keys).toEqual(['alice', 'bob']);
            for (const e of res.entries) {
                expect(e.kind).toBe('aggregate-user-row');
                expect(e.canDrill).toBe(true);
                expect(e.sizeBytes).toBeGreaterThan(0);
            }
        } finally { await cleanup(); }
    });

    test('vectors category shows only bob (alice has none, filtered)', async () => {
        const { users, cleanup } = await makeFixtureCluster();
        try {
            const res = await enumerateAggregateCategory(users, 'vectors');
            const keys = res.entries.map(e => e.key);
            expect(keys).toEqual(['bob']);
        } finally { await cleanup(); }
    });

    test('unknown category → E_INVALID_PATH', async () => {
        const { users, cleanup } = await makeFixtureCluster();
        try {
            await expect(enumerateAggregateCategory(users, 'bogus'))
                .rejects.toMatchObject({ code: 'E_INVALID_PATH' });
        } finally { await cleanup(); }
    });

    test('entries sorted desc by size', async () => {
        const { users, cleanup } = await makeFixtureCluster();
        try {
            const res = await enumerateAggregateCategory(users, 'worlds');
            for (let i = 1; i < res.entries.length; i++) {
                expect(res.entries[i - 1].sizeBytes).toBeGreaterThanOrEqual(res.entries[i].sizeBytes);
            }
        } finally { await cleanup(); }
    });
});
