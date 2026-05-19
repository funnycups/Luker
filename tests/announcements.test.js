import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import {
    ANNOUNCEMENTS_STORAGE_KEY,
    ANNOUNCEMENT_BODY_MAX,
    ANNOUNCEMENT_TITLE_MAX,
    ValidationError,
    createAnnouncement,
    deleteAnnouncement,
    listAnnouncements,
    listForUser,
    mergeReadIds,
    updateAnnouncement,
} from '../src/announcements.js';

function memoryStore(initial) {
    const data = new Map();
    if (initial) data.set(ANNOUNCEMENTS_STORAGE_KEY, initial);
    return {
        getItem: async (key) => data.get(key),
        setItem: async (key, value) => {
            data.set(key, value);
        },
        _data: data,
    };
}

let now = 1_700_000_000_000;
let counter = 0;
function nextNow() { now += 1; return now; }
function nextId() { counter += 1; return `id-${counter}`; }

beforeEach(() => {
    now = 1_700_000_000_000;
    counter = 0;
});

describe('createAnnouncement', () => {
    test('creates and returns the new item with server-assigned fields', async () => {
        const store = memoryStore();
        const item = await createAnnouncement({
            store, now: nextNow, id: nextId,
            level: 'info', title: 'Hi', body: 'World', createdBy: 'admin',
        });
        expect(item).toMatchObject({
            id: 'id-1',
            level: 'info',
            title: 'Hi',
            body: 'World',
            createdBy: 'admin',
        });
        expect(item.createdAt).toBe(1_700_000_000_001);
        const items = await listAnnouncements({ store });
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe('id-1');
    });

    test('trims title and body', async () => {
        const store = memoryStore();
        const item = await createAnnouncement({
            store, now: nextNow, id: nextId,
            level: 'info', title: '  Hi  ', body: '  World  ', createdBy: 'admin',
        });
        expect(item.title).toBe('Hi');
        expect(item.body).toBe('World');
    });

    test('rejects empty title', async () => {
        const store = memoryStore();
        await expect(createAnnouncement({
            store, now: nextNow, id: nextId,
            level: 'info', title: '   ', body: 'x', createdBy: 'admin',
        })).rejects.toBeInstanceOf(ValidationError);
    });

    test('rejects empty body', async () => {
        const store = memoryStore();
        await expect(createAnnouncement({
            store, now: nextNow, id: nextId,
            level: 'info', title: 'x', body: '   ', createdBy: 'admin',
        })).rejects.toBeInstanceOf(ValidationError);
    });

    test('rejects bad level', async () => {
        const store = memoryStore();
        await expect(createAnnouncement({
            store, now: nextNow, id: nextId,
            level: 'urgent', title: 'x', body: 'y', createdBy: 'admin',
        })).rejects.toBeInstanceOf(ValidationError);
    });

    test('rejects overlong title', async () => {
        const store = memoryStore();
        await expect(createAnnouncement({
            store, now: nextNow, id: nextId,
            level: 'info', title: 'a'.repeat(ANNOUNCEMENT_TITLE_MAX + 1), body: 'y', createdBy: 'admin',
        })).rejects.toBeInstanceOf(ValidationError);
    });

    test('rejects overlong body', async () => {
        const store = memoryStore();
        await expect(createAnnouncement({
            store, now: nextNow, id: nextId,
            level: 'info', title: 'a', body: 'b'.repeat(ANNOUNCEMENT_BODY_MAX + 1), createdBy: 'admin',
        })).rejects.toBeInstanceOf(ValidationError);
    });
});

describe('updateAnnouncement', () => {
    test('updates fields and sets updatedAt', async () => {
        const store = memoryStore();
        const created = await createAnnouncement({
            store, now: nextNow, id: nextId,
            level: 'info', title: 'A', body: 'B', createdBy: 'admin',
        });
        const updated = await updateAnnouncement({
            store, now: nextNow,
            id: created.id, title: 'A2', level: 'warning',
        });
        expect(updated).not.toBeNull();
        expect(updated.title).toBe('A2');
        expect(updated.body).toBe('B');
        expect(updated.level).toBe('warning');
        expect(updated.updatedAt).toBeGreaterThan(created.createdAt);
    });

    test('returns null on unknown id', async () => {
        const store = memoryStore();
        const result = await updateAnnouncement({ store, id: 'nope', title: 'x' });
        expect(result).toBeNull();
    });

    test('validates on update', async () => {
        const store = memoryStore();
        const created = await createAnnouncement({
            store, now: nextNow, id: nextId,
            level: 'info', title: 'A', body: 'B', createdBy: 'admin',
        });
        await expect(updateAnnouncement({
            store, id: created.id, level: 'urgent',
        })).rejects.toBeInstanceOf(ValidationError);
    });
});

describe('deleteAnnouncement', () => {
    test('returns true and removes the item', async () => {
        const store = memoryStore();
        const created = await createAnnouncement({
            store, now: nextNow, id: nextId,
            level: 'info', title: 'A', body: 'B', createdBy: 'admin',
        });
        const ok = await deleteAnnouncement({ store, id: created.id });
        expect(ok).toBe(true);
        const items = await listAnnouncements({ store });
        expect(items).toHaveLength(0);
    });

    test('returns false on unknown id', async () => {
        const store = memoryStore();
        const ok = await deleteAnnouncement({ store, id: 'nope' });
        expect(ok).toBe(false);
    });
});

describe('listAnnouncements', () => {
    test('returns items ordered by createdAt desc', async () => {
        const store = memoryStore();
        const a = await createAnnouncement({ store, now: nextNow, id: nextId, level: 'info', title: 'A', body: 'a', createdBy: 'x' });
        const b = await createAnnouncement({ store, now: nextNow, id: nextId, level: 'info', title: 'B', body: 'b', createdBy: 'x' });
        const c = await createAnnouncement({ store, now: nextNow, id: nextId, level: 'info', title: 'C', body: 'c', createdBy: 'x' });
        const list = await listAnnouncements({ store });
        expect(list.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    });

    test('returns empty when store is empty', async () => {
        const store = memoryStore();
        expect(await listAnnouncements({ store })).toEqual([]);
    });
});

describe('listForUser', () => {
    test('intersects readIds with live item ids (filters orphans)', async () => {
        const store = memoryStore();
        const a = await createAnnouncement({ store, now: nextNow, id: nextId, level: 'info', title: 'A', body: 'a', createdBy: 'x' });
        const result = await listForUser({ store, readIds: [a.id, 'orphan-id'] });
        expect(result.items.map((x) => x.id)).toEqual([a.id]);
        expect(result.readIds).toEqual([a.id]);
    });

    test('handles missing / non-array readIds gracefully', async () => {
        const store = memoryStore();
        await createAnnouncement({ store, now: nextNow, id: nextId, level: 'info', title: 'A', body: 'a', createdBy: 'x' });
        const result = await listForUser({ store, readIds: undefined });
        expect(result.readIds).toEqual([]);
    });
});

describe('mergeReadIds', () => {
    test('unions and dedupes', () => {
        const out = mergeReadIds({ existing: ['a', 'b'], ids: ['b', 'c'] });
        expect(new Set(out)).toEqual(new Set(['a', 'b', 'c']));
    });

    test('ignores non-string and empty ids', () => {
        const out = mergeReadIds({ existing: ['a'], ids: [null, '', undefined, 'b', 42] });
        expect(new Set(out)).toEqual(new Set(['a', 'b']));
    });

    test('tolerates missing inputs', () => {
        expect(mergeReadIds({})).toEqual([]);
    });
});

describe('serialization queue', () => {
    test('two concurrent creates do not lose data', async () => {
        const store = memoryStore();
        await Promise.all([
            createAnnouncement({ store, now: nextNow, id: nextId, level: 'info', title: 'A', body: 'a', createdBy: 'x' }),
            createAnnouncement({ store, now: nextNow, id: nextId, level: 'info', title: 'B', body: 'b', createdBy: 'x' }),
        ]);
        const list = await listAnnouncements({ store });
        expect(list).toHaveLength(2);
    });
});
