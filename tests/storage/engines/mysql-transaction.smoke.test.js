import { makeTempMysqlEngineHarness } from '../harness/mysql-harness.js';
import { NotFoundError } from '../../../src/storage/errors.js';

// Coarse smoke coverage for every kind handler MysqlTransaction registers. The
// full Repo contract suite (Task 4) re-runs every existing behavior via
// describe.each(CONTRACT_HARNESSES) — these tests are just enough to fail
// loud and fast on a missing handler or a per-kind regression while iterating
// on Task 3.

describe('MysqlTransaction handlers (smoke)', () => {
    let harness;
    beforeEach(async () => {
        harness = await makeTempMysqlEngineHarness();
        await harness.engine.ping(harness.handle);
    });
    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    // --- chat ---

    const chatKey = (overrides = {}) => ({
        kind: 'chat',
        handle: harness.handle,
        charDir: 'TestChar',
        name: 'chat1',
        isGroup: false,
        groupId: undefined,
        ...overrides,
    });

    test('chat: put round-trips header + body + integrity, list shows it', async () => {
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(chatKey(), {
                header: { chat_metadata: { foo: 'bar' } },
                body: [{ name: 'User', mes: 'hi' }],
                integrity: 'abc-123',
                updatedAt: 100,
                createdAt: 50,
            });
        });
        const got = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getResource(chatKey()));
        expect(got).not.toBeNull();
        expect(got.header.chat_metadata.foo).toBe('bar');
        expect(got.header.chat_metadata.integrity).toBe('abc-123');
        expect(got.body).toEqual([{ name: 'User', mes: 'hi' }]);
        expect(got.integrity).toBe('abc-123');
        expect(got.updatedAt).toBe(100);
        expect(got.createdAt).toBe(50);

        const list = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listResources({ kind: 'chat', handle: harness.handle }));
        expect(list).toHaveLength(1);
        expect(list[0].key.name).toBe('chat1');
        expect(list[0].updatedAt).toBe(100);
        expect(list[0].createdAt).toBe(50);
        expect(list[0].header).toBeUndefined();
        expect(list[0].body).toBeUndefined();
        expect(list[0].integrity).toBeUndefined();
    });

    test('chat: put preserves created_at on upsert, updates updated_at', async () => {
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [], integrity: 'v1',
                updatedAt: 100, createdAt: 50,
            });
        });
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [{ mes: 'x' }], integrity: 'v2',
                updatedAt: 200,
                // intentionally OMIT createdAt — must fall back to existing row's value
            });
        });
        const got = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getResource(chatKey()));
        expect(got.integrity).toBe('v2');
        expect(got.body).toEqual([{ mes: 'x' }]);
        expect(got.updatedAt).toBe(200);
        expect(got.createdAt).toBe(50);
    });

    test('chat: delete returns boolean, cascades chat_states via FK', async () => {
        const missing = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.deleteResource(chatKey()));
        expect(missing).toBe(false);

        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [], integrity: 'x',
                updatedAt: 1, createdAt: 1,
            });
            await tx.putChatState(chatKey(), 'memory-graph', { items: [1, 2, 3] });
            await tx.putChatState(chatKey(), 'floor-state', { current: 2 });
        });
        const beforeNs = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listChatStateNamespaces(chatKey()));
        expect(beforeNs.sort()).toEqual(['floor-state', 'memory-graph']);

        const present = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.deleteResource(chatKey()));
        expect(present).toBe(true);

        const afterNs = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listChatStateNamespaces(chatKey()));
        expect(afterNs).toEqual([]);
    });

    test('chat state: put on missing parent throws NotFoundError', async () => {
        await expect(
            harness.engine.withTransaction(harness.handle, async (tx) =>
                tx.putChatState(chatKey({ name: 'no-such' }), 'ns', { x: 1 })),
        ).rejects.toBeInstanceOf(NotFoundError);
    });

    test('chat state: put/get/delete round-trips', async () => {
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [], integrity: 'x',
                updatedAt: 1, createdAt: 1,
            });
            await tx.putChatState(chatKey(), 'memory-graph', { nodes: ['a', 'b'] });
        });
        const got = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getChatState(chatKey(), 'memory-graph'));
        expect(got).toEqual({ nodes: ['a', 'b'] });

        const removed = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.deleteChatState(chatKey(), 'memory-graph'));
        expect(removed).toBe(true);

        const after = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getChatState(chatKey(), 'memory-graph'));
        expect(after).toBeNull();
    });

    test('chat: list orderBy=name returns sorted ascending', async () => {
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(chatKey({ name: 'banana' }), {
                header: { chat_metadata: {} }, body: [], integrity: '1',
                updatedAt: 100, createdAt: 100,
            });
            await tx.putResource(chatKey({ name: 'apple' }), {
                header: { chat_metadata: {} }, body: [], integrity: '2',
                updatedAt: 50, createdAt: 50,
            });
        });
        const byName = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listResources({ kind: 'chat', handle: harness.handle, orderBy: 'name' }));
        expect(byName.map((r) => r.key.name)).toEqual(['apple', 'banana']);
        const byUpdated = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listResources({ kind: 'chat', handle: harness.handle }));
        expect(byUpdated.map((r) => r.key.name)).toEqual(['banana', 'apple']);
    });

    // --- settings ---

    test('settings: put/get/delete; list throws', async () => {
        const key = { kind: 'settings', handle: harness.handle };
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(key, { doc: { theme: 'dark', n: 42 } });
        });
        const got = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getResource(key));
        expect(got).toEqual({ theme: 'dark', n: 42 });
        const removed = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.deleteResource(key));
        expect(removed).toBe(true);
        const after = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getResource(key));
        expect(after).toBeNull();
        await expect(harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listResources({ kind: 'settings', handle: harness.handle })),
        ).rejects.toThrow(/singleton/);
    });

    // --- preset ---

    const presetKey = (name) => ({
        kind: 'preset', handle: harness.handle, dirKey: 'KoboldAI', name,
    });

    test('preset: put/get/list/delete', async () => {
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(presetKey('A'), { doc: { temperature: 0.8 } });
            await tx.putResource(presetKey('B'), { doc: { temperature: 0.5 } });
        });
        const got = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getResource(presetKey('A')));
        expect(got).toEqual({ temperature: 0.8 });
        const list = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listResources({ kind: 'preset', handle: harness.handle, dirKey: 'KoboldAI' }));
        expect(list.map((r) => r.key.name).sort()).toEqual(['A', 'B']);
        const removed = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.deleteResource(presetKey('A')));
        expect(removed).toBe(true);
    });

    test('preset state: PERMISSIVE — no parent-exists check', async () => {
        // Note: no preset put first — sidecar must still write cleanly.
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putPresetState(presetKey('Orphan'), 'search-tools', { active: true });
        });
        const got = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getPresetState(presetKey('Orphan'), 'search-tools'));
        expect(got).toEqual({ active: true });

        const list = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listPresetStateNamespaces(presetKey('Orphan')));
        expect(list).toEqual(['search-tools']);

        const removed = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.deletePresetState(presetKey('Orphan'), 'search-tools'));
        expect(removed).toBe(true);
    });

    test('preset: delete cascades preset_states (manual, no FK)', async () => {
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(presetKey('X'), { doc: { temperature: 0.7 } });
            await tx.putPresetState(presetKey('X'), 'ns-a', { v: 1 });
            await tx.putPresetState(presetKey('X'), 'ns-b', { v: 2 });
        });
        await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.deleteResource(presetKey('X')));
        const list = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listPresetStateNamespaces(presetKey('X')));
        expect(list).toEqual([]);
    });

    // --- world ---

    const worldKey = (name) => ({ kind: 'world', handle: harness.handle, name });

    test('world: put, exact and tolerant get', async () => {
        // Variation selector U+FE0F follows the heart. Tolerant resolver
        // should let us match the stored name with a different selector.
        const storedName = 'My❤️World';
        const lookupVariant = 'My❤World'; // no U+FE0F
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(worldKey(storedName), {
                doc: { name: storedName, entries: {}, extensions: { foo: 1 } },
            });
        });
        const exact = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getResource(worldKey(storedName)));
        expect(exact?.name).toBe(storedName);

        const tolerant = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getResource(worldKey(lookupVariant)));
        expect(tolerant?.name).toBe(storedName);

        // resolveWorldName returns '<name>.json' or null
        const resolved = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.resolveWorldName(worldKey(lookupVariant)));
        expect(resolved).toBe(`${storedName}.json`);

        const missing = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.resolveWorldName(worldKey('NoSuchWorld')));
        expect(missing).toBeNull();
    });

    test('world: list returns key/name/extensions tuples', async () => {
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(worldKey('Alpha'), {
                doc: { name: 'Alpha', extensions: { foo: 'bar' } },
            });
            await tx.putResource(worldKey('Beta'), {
                doc: { name: 'Beta' /* no extensions */ },
            });
        });
        const list = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listResources({ kind: 'world', handle: harness.handle }));
        expect(list.map((w) => w.name).sort()).toEqual(['Alpha', 'Beta']);
        const alpha = list.find((w) => w.name === 'Alpha');
        expect(alpha.extensions).toEqual({ foo: 'bar' });
        const beta = list.find((w) => w.name === 'Beta');
        expect(beta.extensions).toEqual({});
    });

    test('world: put with empty name throws', async () => {
        await expect(harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.putResource(worldKey('   '), { doc: { name: 'x' } })),
        ).rejects.toThrow(/world put: invalid name/);
    });

    // --- named-doc ---

    test('named-doc: put/get/delete/list by bucket', async () => {
        const ndKey = (bucket, name) => ({ kind: 'named-doc', handle: harness.handle, bucket, name });
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(ndKey('themes', 'midnight'), { doc: { bg: 'black' } });
            await tx.putResource(ndKey('themes', 'sunrise'), { doc: { bg: 'orange' } });
            await tx.putResource(ndKey('quickReplies', 'wave'), { doc: { msg: 'hi' } });
        });
        const got = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getResource(ndKey('themes', 'midnight')));
        expect(got).toEqual({ bg: 'black' });

        const list = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listResources({ kind: 'named-doc', handle: harness.handle, bucket: 'themes' }));
        expect(list.map((r) => r.key.name).sort()).toEqual(['midnight', 'sunrise']);

        const removed = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.deleteResource(ndKey('themes', 'midnight')));
        expect(removed).toBe(true);
    });

    // --- group ---

    const groupKey = (id) => ({ kind: 'group', handle: harness.handle, id });

    test('group: put/get/list, preserves created_at on upsert', async () => {
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(groupKey('g1'), {
                doc: { id: 'g1', name: 'Squad', members: ['A', 'B'], chats: ['c1'] },
                updatedAt: 100, createdAt: 50,
            });
        });
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(groupKey('g1'), {
                doc: { id: 'g1', name: 'Squad updated', members: ['A', 'B', 'C'], chats: ['c1'] },
                updatedAt: 200,
                // omit createdAt — must preserve 50
            });
        });
        const got = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getResource(groupKey('g1')));
        expect(got.members).toEqual(['A', 'B', 'C']);
        // Check via listGroupsWithChatStats which returns date_added=created_at
        const stats = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listGroupsWithChatStats({ kind: 'group', handle: harness.handle }));
        expect(stats[0].date_added).toBe(50);
    });

    test('group: put with empty id throws', async () => {
        await expect(harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.putResource(groupKey(''), { doc: { id: 'x' } })),
        ).rejects.toThrow(/group put: invalid id/);
    });

    test('group: listGroupsWithChatStats merges group doc with chat stats', async () => {
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(groupKey('g1'), {
                doc: { id: 'g1', name: 'Squad', chats: ['gc1', 'gc2'] },
                updatedAt: 100, createdAt: 50,
            });
            // group chat 1
            await tx.putResource(chatKey({ name: 'gc1', isGroup: true, groupId: 'gc1' }), {
                header: { chat_metadata: {} }, body: [{ mes: 'hello' }], integrity: 'i1',
                updatedAt: 75, createdAt: 60,
            });
            // group chat 2 (more recent)
            await tx.putResource(chatKey({ name: 'gc2', isGroup: true, groupId: 'gc2' }), {
                header: { chat_metadata: {} }, body: [{ mes: 'world' }], integrity: 'i2',
                updatedAt: 95, createdAt: 70,
            });
        });
        const result = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listGroupsWithChatStats({ kind: 'group', handle: harness.handle }));
        expect(result).toHaveLength(1);
        const g = result[0];
        expect(g.id).toBe('g1');
        expect(g.name).toBe('Squad');
        expect(g.date_added).toBe(50);
        expect(g.create_date).toBe(new Date(50).toISOString());
        expect(g.date_last_chat).toBe(95);
        expect(g.chat_size).toBeGreaterThan(0); // rough byte indicator
    });

    // --- stats ---

    test('stats: put/get/delete; list throws', async () => {
        const key = { kind: 'stats', handle: harness.handle };
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource(key, { doc: { totalTokens: 12345 } });
        });
        const got = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getResource(key));
        expect(got).toEqual({ totalTokens: 12345 });
        const removed = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.deleteResource(key));
        expect(removed).toBe(true);
        await expect(harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.listResources({ kind: 'stats', handle: harness.handle })),
        ).rejects.toThrow(/singleton/);
    });

    // --- chat group-key back-fill parity (SqliteTransaction's chatKeyToParams) ---

    test('chat group key: name/groupId back-fill so lookup matches stored row', async () => {
        // Put with only groupId set; FsTransaction-style callers may later look
        // it up with only name set. Back-fill must make both work.
        await harness.engine.withTransaction(harness.handle, async (tx) => {
            await tx.putResource({
                kind: 'chat', handle: harness.handle, charDir: '',
                name: undefined, isGroup: true, groupId: 'group-chat-id',
            }, {
                header: { chat_metadata: {} }, body: [], integrity: 'gc',
                updatedAt: 1, createdAt: 1,
            });
        });
        const byNameOnly = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getResource({
                kind: 'chat', handle: harness.handle, charDir: '',
                name: 'group-chat-id', isGroup: true, groupId: undefined,
            }));
        expect(byNameOnly).not.toBeNull();
        expect(byNameOnly.integrity).toBe('gc');
    });

    // --- putResourceIfMatch (shared method on tx) ---

    test('putResourceIfMatch: integrity-conditional upsert', async () => {
        // first put with no expected — succeeds when row is absent
        const first = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.putResourceIfMatch(chatKey(), null, {
                header: { chat_metadata: {} }, body: [], integrity: 'v1',
                updatedAt: 1, createdAt: 1,
            }));
        expect(first).toEqual({ updated: true });

        // second put with null expected — fails (row exists)
        const second = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.putResourceIfMatch(chatKey(), null, {
                header: { chat_metadata: {} }, body: [], integrity: 'v2',
                updatedAt: 2, createdAt: 1,
            }));
        expect(second).toEqual({ updated: false });

        // wrong integrity — fails
        const wrong = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.putResourceIfMatch(chatKey(), 'wrong', {
                header: { chat_metadata: {} }, body: [], integrity: 'v3',
                updatedAt: 3, createdAt: 1,
            }));
        expect(wrong).toEqual({ updated: false });

        // correct integrity — succeeds
        const right = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.putResourceIfMatch(chatKey(), 'v1', {
                header: { chat_metadata: {} }, body: [{ mes: 'updated' }], integrity: 'v4',
                updatedAt: 4, createdAt: 1,
            }));
        expect(right).toEqual({ updated: true });

        const final = await harness.engine.withTransaction(harness.handle, async (tx) =>
            tx.getResource(chatKey()));
        expect(final.integrity).toBe('v4');
        expect(final.body).toEqual([{ mes: 'updated' }]);
    });
});
