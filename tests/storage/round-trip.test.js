// Cross-engine round-trip tests: prove that data written via one engine can
// be read back via the other engine without loss. These are the foundation
// for the storage migration tool — if any of these break, migration will lose
// or corrupt data.
//
// Pattern for each Repo:
//   1. Save a doc via engine A (`makeFs`).
//   2. Read it back via engine A → canonical snapshot.
//   3. Save the snapshot via engine B (`makeSqlite`).
//   4. Read it back via engine B → cross-engine snapshot.
//   5. Assert deep equality of the two snapshots (modulo engine-internal
//      metadata like `integrity`, `updatedAt`, `createdAt`).
//
// We deliberately do NOT round-trip NamedDocRepo: it has no `get`, so a
// post-write read is impossible through the public API. Direct engine peeking
// would couple this file to handler internals and add zero migration safety
// (the handler contract tests already cover that surface).

import fs from 'node:fs';

import { CONTRACT_HARNESSES, makeTempFsEngineHarness, makeTempSqliteEngineHarness } from './harness/contract-harness.js';
import { ChatRepo } from '../../src/storage/repositories/chat-repo.js';
import { GroupRepo } from '../../src/storage/repositories/group-repo.js';
import { PresetRepo } from '../../src/storage/repositories/preset-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { StatsRepo } from '../../src/storage/repositories/stats-repo.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
// `stripChatEngineMeta` lives in src/storage/migration/equality.js because the
// MigrationRunner verification step needs the same chat-tolerance behavior.
// This file consumes it for round-trip parity assertions so the two surfaces
// can't drift apart.
import { stripChatEngineMeta } from '../../src/storage/migration/equality.js';

// `CONTRACT_HARNESSES` is the parameterized list used by contract tests.
// Round-trip needs both engines simultaneously, so we use the per-engine
// factories directly. We keep the import of `CONTRACT_HARNESSES` to fail loud
// if the harness module's export shape ever drifts.
expect(CONTRACT_HARNESSES.length).toBeGreaterThanOrEqual(2);
const makeFs = makeTempFsEngineHarness;
const makeSqlite = makeTempSqliteEngineHarness;

// ---- helpers ----------------------------------------------------------------

// stripChatEngineMeta is imported from src/storage/migration/equality.js (the
// runner uses the same helper to verify migrated chat records).

// ---- Settings ---------------------------------------------------------------

describe('round-trip: SettingsRepo', () => {
    test('FS → SQLite preserves the settings doc verbatim', async () => {
        const fsh = await makeFs();
        const fsRepo = new SettingsRepo({ engine: fsh.engine });
        const original = {
            user_avatar: 'a.png',
            power_user: { fast: true, theme: 'dark' },
            nested: { arr: [1, 2, 3], deep: { x: 'y' } },
        };
        await fsRepo.save(fsh.handle, original);
        const fromFs = await fsRepo.get(fsh.handle);

        const sqh = await makeSqlite();
        try {
            const sqRepo = new SettingsRepo({ engine: sqh.engine });
            await sqRepo.save(sqh.handle, fromFs);
            const fromSqlite = await sqRepo.get(sqh.handle);
            expect(fromSqlite).toEqual(original);
            expect(fromSqlite).toEqual(fromFs);
        } finally {
            fsh.cleanup();
            sqh.cleanup();
        }
    });

    test('SQLite → FS preserves the settings doc verbatim', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new SettingsRepo({ engine: sqh.engine });
        const original = { user_avatar: 'a.png', power_user: { fast: true }, list: [1, 'two', null] };
        await sqRepo.save(sqh.handle, original);
        const fromSqlite = await sqRepo.get(sqh.handle);

        const fsh = await makeFs();
        try {
            const fsRepo = new SettingsRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, fromSqlite);
            const fromFs = await fsRepo.get(fsh.handle);
            expect(fromFs).toEqual(original);
            expect(fromFs).toEqual(fromSqlite);
        } finally {
            sqh.cleanup();
            fsh.cleanup();
        }
    });
});

// ---- Preset (incl. state sidecars) ------------------------------------------

describe('round-trip: PresetRepo', () => {
    test('FS → SQLite preserves an OpenAI preset doc', async () => {
        const fsh = await makeFs();
        const fsRepo = new PresetRepo({ engine: fsh.engine });
        const original = {
            temperature: 0.7,
            top_p: 0.95,
            prompts: [{ name: 'a', content: 'hi' }, { name: 'b', content: 'bye' }],
            extra: { tool_blocks: [{ id: 'x' }] },
        };
        await fsRepo.save(fsh.handle, 'openai', 'mypreset', original);
        const fromFs = await fsRepo.get(fsh.handle, 'openai', 'mypreset');

        const sqh = await makeSqlite();
        try {
            const sqRepo = new PresetRepo({ engine: sqh.engine });
            await sqRepo.save(sqh.handle, 'openai', 'mypreset', fromFs);
            const fromSqlite = await sqRepo.get(sqh.handle, 'openai', 'mypreset');
            expect(fromSqlite).toEqual(original);
        } finally {
            fsh.cleanup();
            sqh.cleanup();
        }
    });

    test('SQLite → FS preserves a textgen preset doc', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new PresetRepo({ engine: sqh.engine });
        const original = { temperature: 0.5, max_new_tokens: 1024, presets: [{ name: 'x' }] };
        await sqRepo.save(sqh.handle, 'textgenerationwebui', 'mypreset', original);
        const fromSqlite = await sqRepo.get(sqh.handle, 'textgenerationwebui', 'mypreset');

        const fsh = await makeFs();
        try {
            const fsRepo = new PresetRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, 'textgenerationwebui', 'mypreset', fromSqlite);
            const fromFs = await fsRepo.get(fsh.handle, 'textgenerationwebui', 'mypreset');
            expect(fromFs).toEqual(original);
        } finally {
            sqh.cleanup();
            fsh.cleanup();
        }
    });

    test('FS → SQLite preserves preset state sidecars across namespaces', async () => {
        const fsh = await makeFs();
        const fsRepo = new PresetRepo({ engine: fsh.engine });
        await fsRepo.save(fsh.handle, 'openai', 'mypreset', { temperature: 0.7 });
        const stateA = { iteration_lib: { nodes: ['a', 'b'], cfg: { x: 1 } } };
        const stateB = { agenda: { steps: [{ id: 1 }, { id: 2 }] } };
        await fsRepo.setState(fsh.handle, 'openai', 'mypreset', 'iter_lib', stateA);
        await fsRepo.setState(fsh.handle, 'openai', 'mypreset', 'agenda', stateB);
        const fromFsA = await fsRepo.getState(fsh.handle, 'openai', 'mypreset', 'iter_lib');
        const fromFsB = await fsRepo.getState(fsh.handle, 'openai', 'mypreset', 'agenda');

        const sqh = await makeSqlite();
        try {
            const sqRepo = new PresetRepo({ engine: sqh.engine });
            await sqRepo.save(sqh.handle, 'openai', 'mypreset', { temperature: 0.7 });
            await sqRepo.setState(sqh.handle, 'openai', 'mypreset', 'iter_lib', fromFsA);
            await sqRepo.setState(sqh.handle, 'openai', 'mypreset', 'agenda', fromFsB);
            expect(await sqRepo.getState(sqh.handle, 'openai', 'mypreset', 'iter_lib')).toEqual(stateA);
            expect(await sqRepo.getState(sqh.handle, 'openai', 'mypreset', 'agenda')).toEqual(stateB);
        } finally {
            fsh.cleanup();
            sqh.cleanup();
        }
    });
});

// ---- World ------------------------------------------------------------------

describe('round-trip: WorldInfoRepo', () => {
    test('FS → SQLite preserves a world with multiple entries and metadata', async () => {
        const fsh = await makeFs();
        fs.mkdirSync(fsh.dirs.worlds, { recursive: true });
        const fsRepo = new WorldInfoRepo({ engine: fsh.engine });
        const original = {
            name: 'MyWorld',
            entries: {
                '0': { uid: 0, key: ['hello'], content: 'world', enabled: true },
                '1': { uid: 1, key: ['foo'], content: 'bar', position: 4 },
                '2': { uid: 2, key: [], content: 'always-on', constant: true },
            },
            originalData: { foo: 'bar' },
        };
        await fsRepo.save(fsh.handle, 'MyWorld', original);
        const fromFs = await fsRepo.get(fsh.handle, 'MyWorld');

        const sqh = await makeSqlite();
        try {
            const sqRepo = new WorldInfoRepo({ engine: sqh.engine });
            await sqRepo.save(sqh.handle, 'MyWorld', fromFs);
            const fromSqlite = await sqRepo.get(sqh.handle, 'MyWorld');
            expect(fromSqlite).toEqual(original);
        } finally {
            fsh.cleanup();
            sqh.cleanup();
        }
    });

    test('SQLite → FS preserves a world doc', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new WorldInfoRepo({ engine: sqh.engine });
        const original = { name: 'W', entries: { '0': { content: 'a' }, '5': { content: 'b' } } };
        await sqRepo.save(sqh.handle, 'W', original);
        const fromSqlite = await sqRepo.get(sqh.handle, 'W');

        const fsh = await makeFs();
        try {
            fs.mkdirSync(fsh.dirs.worlds, { recursive: true });
            const fsRepo = new WorldInfoRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, 'W', fromSqlite);
            const fromFs = await fsRepo.get(fsh.handle, 'W');
            expect(fromFs).toEqual(original);
        } finally {
            sqh.cleanup();
            fsh.cleanup();
        }
    });
});

// ---- Group ------------------------------------------------------------------

describe('round-trip: GroupRepo', () => {
    test('FS → SQLite preserves a group doc with members and chats', async () => {
        const fsh = await makeFs();
        fs.mkdirSync(fsh.dirs.groups, { recursive: true });
        fs.mkdirSync(fsh.dirs.groupChats, { recursive: true });
        const fsRepo = new GroupRepo({ engine: fsh.engine });
        const original = {
            id: 'grp-1',
            name: 'Crew',
            members: ['alice.png', 'bob.png', 'carol.png'],
            chats: ['chat-a', 'chat-b'],
            metadata: { created_at: 12345, tags: ['x', 'y'] },
        };
        await fsRepo.save(fsh.handle, 'grp-1', original);
        const fromFs = await fsRepo.get(fsh.handle, 'grp-1');
        // fromFs carries the fields the repo actually persists (e.g.
        // GroupRepo.save stamps `date_added` on first write). Round-trip
        // asserts the SQLite side reads back the SAME payload that FS
        // stored — not the pre-save literal, which would silently lose
        // repo-added fields.
        expect(fromFs).toEqual({ ...original, date_added: expect.any(Number) });

        const sqh = await makeSqlite();
        try {
            const sqRepo = new GroupRepo({ engine: sqh.engine });
            await sqRepo.save(sqh.handle, 'grp-1', fromFs);
            const fromSqlite = await sqRepo.get(sqh.handle, 'grp-1');
            expect(fromSqlite).toEqual(fromFs);
        } finally {
            fsh.cleanup();
            sqh.cleanup();
        }
    });
});

// ---- Stats ------------------------------------------------------------------

describe('round-trip: StatsRepo', () => {
    test('FS → SQLite preserves a stats doc', async () => {
        const fsh = await makeFs();
        const fsRepo = new StatsRepo({ engine: fsh.engine });
        const original = {
            'alice.png': { user_msg_count: 5, total_gen_time: 1234 },
            'bob.png': { user_msg_count: 12 },
            timestamp: 1700000000,
        };
        await fsRepo.save(fsh.handle, original);
        const fromFs = await fsRepo.get(fsh.handle);

        const sqh = await makeSqlite();
        try {
            const sqRepo = new StatsRepo({ engine: sqh.engine });
            await sqRepo.save(sqh.handle, fromFs);
            const fromSqlite = await sqRepo.get(sqh.handle);
            expect(fromSqlite).toEqual(original);
        } finally {
            fsh.cleanup();
            sqh.cleanup();
        }
    });
});

// ---- Chat (header + body, modulo integrity) ---------------------------------

describe('round-trip: ChatRepo', () => {
    test('FS → SQLite preserves chat header and body (engine re-issues integrity)', async () => {
        const fsh = await makeFs();
        const fsRepo = new ChatRepo({ engine: fsh.engine });
        const header = {
            user_name: 'User',
            chat_metadata: { foo: 'bar', variables: { v: 1 } },
            character_name: 'TestChar',
            future_field_xyz: { nested: [1, 2, 3] },
        };
        const body = [
            { name: 'User', mes: 'hi', is_user: true },
            { name: 'TestChar', mes: 'hello', is_user: false, extra: { gen_id: 'g1' } },
        ];
        await fsRepo.save(fsh.handle, 'TestChar', 'chat1', header, body, null);
        const fromFs = await fsRepo.get(fsh.handle, 'TestChar', 'chat1');

        // Both engines must produce some integrity string.
        expect(typeof fromFs.integrity).toBe('string');
        expect(fromFs.integrity.length).toBeGreaterThan(0);

        const sqh = await makeSqlite();
        try {
            const sqRepo = new ChatRepo({ engine: sqh.engine });
            await sqRepo.save(sqh.handle, 'TestChar', 'chat1', fromFs.header, fromFs.body, null);
            const fromSqlite = await sqRepo.get(sqh.handle, 'TestChar', 'chat1');

            // body is verbatim across engines
            expect(fromSqlite.body).toEqual(fromFs.body);
            expect(fromSqlite.body).toEqual(body);
            // header is verbatim across engines (after stripping the
            // engine-rotated chat_metadata.integrity)
            expect(stripChatEngineMeta(fromSqlite).header).toEqual(stripChatEngineMeta(fromFs).header);
            // each engine assigns its own integrity on save — cross-check that
            // it exists, but don't require parity
            expect(typeof fromSqlite.integrity).toBe('string');
            expect(fromSqlite.integrity.length).toBeGreaterThan(0);
            // After dropping engine-internal metadata, the records are equal.
            expect(stripChatEngineMeta(fromSqlite)).toEqual(stripChatEngineMeta(fromFs));
        } finally {
            fsh.cleanup();
            sqh.cleanup();
        }
    });

    test('SQLite → FS preserves chat header and body', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new ChatRepo({ engine: sqh.engine });
        const header = { user_name: 'U', chat_metadata: { x: 1 } };
        const body = [{ name: 'U', mes: 'hi' }, { name: 'C', mes: 'hello', extra: { future: { tool: 'x' } } }];
        await sqRepo.save(sqh.handle, 'Char', 'c1', header, body, null);
        const fromSqlite = await sqRepo.get(sqh.handle, 'Char', 'c1');

        const fsh = await makeFs();
        try {
            const fsRepo = new ChatRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, 'Char', 'c1', fromSqlite.header, fromSqlite.body, null);
            const fromFs = await fsRepo.get(fsh.handle, 'Char', 'c1');
            expect(fromFs.body).toEqual(body);
            expect(stripChatEngineMeta(fromFs).header).toEqual(stripChatEngineMeta(fromSqlite).header);
            expect(stripChatEngineMeta(fromFs)).toEqual(stripChatEngineMeta(fromSqlite));
        } finally {
            sqh.cleanup();
            fsh.cleanup();
        }
    });

    test('FS → SQLite preserves chat state sidecars per namespace', async () => {
        const fsh = await makeFs();
        const fsRepo = new ChatRepo({ engine: fsh.engine });
        await fsRepo.save(fsh.handle, 'TestChar', 'chat1', { chat_metadata: {}, user_name: 'U' }, [], null);
        const mgDoc = { nodes: ['a', 'b'], anchors: [1, 2], meta: { last_floor: 3 } };
        const floorDoc = { current: 2, history: [{ id: 1 }, { id: 2 }] };
        await fsRepo.setState(fsh.handle, 'TestChar', 'chat1', 'memory-graph', mgDoc);
        await fsRepo.setState(fsh.handle, 'TestChar', 'chat1', 'floor-state', floorDoc);

        const fromFsMg = await fsRepo.getState(fsh.handle, 'TestChar', 'chat1', 'memory-graph');
        const fromFsFloor = await fsRepo.getState(fsh.handle, 'TestChar', 'chat1', 'floor-state');

        const sqh = await makeSqlite();
        try {
            const sqRepo = new ChatRepo({ engine: sqh.engine });
            await sqRepo.save(sqh.handle, 'TestChar', 'chat1', { chat_metadata: {}, user_name: 'U' }, [], null);
            await sqRepo.setState(sqh.handle, 'TestChar', 'chat1', 'memory-graph', fromFsMg);
            await sqRepo.setState(sqh.handle, 'TestChar', 'chat1', 'floor-state', fromFsFloor);

            expect(await sqRepo.getState(sqh.handle, 'TestChar', 'chat1', 'memory-graph')).toEqual(mgDoc);
            expect(await sqRepo.getState(sqh.handle, 'TestChar', 'chat1', 'floor-state')).toEqual(floorDoc);
        } finally {
            fsh.cleanup();
            sqh.cleanup();
        }
    });
});

// ---- Bulk fixture: full per-user payload ------------------------------------

describe('round-trip: bulk fixture', () => {
    test('full per-user payload (chats+state, settings, presets, world, group, stats) FS → SQLite', async () => {
        // ---- populate FS ----
        const fsh = await makeFs();
        fs.mkdirSync(fsh.dirs.worlds, { recursive: true });
        fs.mkdirSync(fsh.dirs.groups, { recursive: true });
        fs.mkdirSync(fsh.dirs.groupChats, { recursive: true });

        const fsSettings = new SettingsRepo({ engine: fsh.engine });
        const fsPreset = new PresetRepo({ engine: fsh.engine });
        const fsWorld = new WorldInfoRepo({ engine: fsh.engine });
        const fsGroup = new GroupRepo({ engine: fsh.engine });
        const fsStats = new StatsRepo({ engine: fsh.engine });
        const fsChat = new ChatRepo({ engine: fsh.engine });

        // Settings
        const settingsDoc = { user_avatar: 'a.png', power_user: { theme: 'dark' } };
        await fsSettings.save(fsh.handle, settingsDoc);

        // Presets across two dirKeys
        const presetA = { temperature: 0.7, top_p: 0.95 };
        const presetB = { temperature: 0.3, max_tokens: 4096 };
        const presetC = { instruct_mode: 'mistral', context_size: 8192 };
        await fsPreset.save(fsh.handle, 'openai', 'creative', presetA);
        await fsPreset.save(fsh.handle, 'openai', 'precise', presetB);
        await fsPreset.save(fsh.handle, 'textgenerationwebui', 'local', presetC);
        // Preset state sidecar
        const presetStateDoc = { iter_lib: { nodes: ['n1'] } };
        await fsPreset.setState(fsh.handle, 'openai', 'creative', 'iter_lib', presetStateDoc);

        // World
        const worldDoc = {
            name: 'Lore',
            entries: { '0': { uid: 0, key: ['x'], content: 'y' } },
        };
        await fsWorld.save(fsh.handle, 'Lore', worldDoc);

        // Group + member chats
        const groupDoc = { id: 'grp-1', name: 'Crew', members: ['a.png', 'b.png'], chats: ['gc-1', 'gc-2'] };
        await fsGroup.save(fsh.handle, 'grp-1', groupDoc);
        await fsChat.save(fsh.handle, null, 'gc-1', { user_name: 'U' }, [{ mes: 'gm1', name: 'U' }], null, { isGroup: true, groupId: 'gc-1' });
        await fsChat.save(fsh.handle, null, 'gc-2', { user_name: 'U' }, [{ mes: 'gm2', name: 'U' }], null, { isGroup: true, groupId: 'gc-2' });

        // Per-char chats + state sidecars
        await fsChat.save(fsh.handle, 'Alice', 'c1', { user_name: 'U', chat_metadata: { foo: 'bar' } }, [
            { mes: 'hi', name: 'U', is_user: true },
            { mes: 'hello', name: 'Alice', is_user: false },
        ], null);
        await fsChat.setState(fsh.handle, 'Alice', 'c1', 'memory-graph', { nodes: ['root'] });
        await fsChat.save(fsh.handle, 'Alice', 'c2', { user_name: 'U' }, [{ mes: 'two', name: 'U' }], null);

        // Stats
        const statsDoc = { 'alice.png': { user_msg_count: 5 }, timestamp: 1700000000 };
        await fsStats.save(fsh.handle, statsDoc);

        // ---- snapshot the canonical FS state ----
        const snapshot = {
            settings: await fsSettings.get(fsh.handle),
            presets: {
                openaiCreative: await fsPreset.get(fsh.handle, 'openai', 'creative'),
                openaiPrecise: await fsPreset.get(fsh.handle, 'openai', 'precise'),
                textgenLocal: await fsPreset.get(fsh.handle, 'textgenerationwebui', 'local'),
            },
            presetState: await fsPreset.getState(fsh.handle, 'openai', 'creative', 'iter_lib'),
            world: await fsWorld.get(fsh.handle, 'Lore'),
            group: await fsGroup.get(fsh.handle, 'grp-1'),
            stats: await fsStats.get(fsh.handle),
            chatAliceC1: await fsChat.get(fsh.handle, 'Alice', 'c1'),
            chatAliceC1Mg: await fsChat.getState(fsh.handle, 'Alice', 'c1', 'memory-graph'),
            chatAliceC2: await fsChat.get(fsh.handle, 'Alice', 'c2'),
            groupChatGc1: await fsChat.get(fsh.handle, null, 'gc-1', { isGroup: true, groupId: 'gc-1' }),
            groupChatGc2: await fsChat.get(fsh.handle, null, 'gc-2', { isGroup: true, groupId: 'gc-2' }),
        };

        // ---- replay everything into SQLite ----
        const sqh = await makeSqlite();
        try {
            const sqSettings = new SettingsRepo({ engine: sqh.engine });
            const sqPreset = new PresetRepo({ engine: sqh.engine });
            const sqWorld = new WorldInfoRepo({ engine: sqh.engine });
            const sqGroup = new GroupRepo({ engine: sqh.engine });
            const sqStats = new StatsRepo({ engine: sqh.engine });
            const sqChat = new ChatRepo({ engine: sqh.engine });

            await sqSettings.save(sqh.handle, snapshot.settings);
            await sqPreset.save(sqh.handle, 'openai', 'creative', snapshot.presets.openaiCreative);
            await sqPreset.save(sqh.handle, 'openai', 'precise', snapshot.presets.openaiPrecise);
            await sqPreset.save(sqh.handle, 'textgenerationwebui', 'local', snapshot.presets.textgenLocal);
            await sqPreset.setState(sqh.handle, 'openai', 'creative', 'iter_lib', snapshot.presetState);
            await sqWorld.save(sqh.handle, 'Lore', snapshot.world);
            await sqGroup.save(sqh.handle, 'grp-1', snapshot.group);
            await sqStats.save(sqh.handle, snapshot.stats);

            await sqChat.save(sqh.handle, 'Alice', 'c1', snapshot.chatAliceC1.header, snapshot.chatAliceC1.body, null);
            await sqChat.setState(sqh.handle, 'Alice', 'c1', 'memory-graph', snapshot.chatAliceC1Mg);
            await sqChat.save(sqh.handle, 'Alice', 'c2', snapshot.chatAliceC2.header, snapshot.chatAliceC2.body, null);
            await sqChat.save(sqh.handle, null, 'gc-1', snapshot.groupChatGc1.header, snapshot.groupChatGc1.body, null, { isGroup: true, groupId: 'gc-1' });
            await sqChat.save(sqh.handle, null, 'gc-2', snapshot.groupChatGc2.header, snapshot.groupChatGc2.body, null, { isGroup: true, groupId: 'gc-2' });

            // ---- read everything back ----
            expect(await sqSettings.get(sqh.handle)).toEqual(snapshot.settings);
            expect(await sqPreset.get(sqh.handle, 'openai', 'creative')).toEqual(snapshot.presets.openaiCreative);
            expect(await sqPreset.get(sqh.handle, 'openai', 'precise')).toEqual(snapshot.presets.openaiPrecise);
            expect(await sqPreset.get(sqh.handle, 'textgenerationwebui', 'local')).toEqual(snapshot.presets.textgenLocal);
            expect(await sqPreset.getState(sqh.handle, 'openai', 'creative', 'iter_lib')).toEqual(snapshot.presetState);
            expect(await sqWorld.get(sqh.handle, 'Lore')).toEqual(snapshot.world);
            expect(await sqGroup.get(sqh.handle, 'grp-1')).toEqual(snapshot.group);
            expect(await sqStats.get(sqh.handle)).toEqual(snapshot.stats);

            // Chats: compare modulo engine-internal metadata.
            const sqAliceC1 = await sqChat.get(sqh.handle, 'Alice', 'c1');
            expect(sqAliceC1.body).toEqual(snapshot.chatAliceC1.body);
            expect(stripChatEngineMeta(sqAliceC1).header).toEqual(stripChatEngineMeta(snapshot.chatAliceC1).header);
            expect(stripChatEngineMeta(sqAliceC1)).toEqual(stripChatEngineMeta(snapshot.chatAliceC1));
            expect(await sqChat.getState(sqh.handle, 'Alice', 'c1', 'memory-graph')).toEqual(snapshot.chatAliceC1Mg);

            const sqAliceC2 = await sqChat.get(sqh.handle, 'Alice', 'c2');
            expect(stripChatEngineMeta(sqAliceC2)).toEqual(stripChatEngineMeta(snapshot.chatAliceC2));

            const sqGc1 = await sqChat.get(sqh.handle, null, 'gc-1', { isGroup: true, groupId: 'gc-1' });
            expect(stripChatEngineMeta(sqGc1)).toEqual(stripChatEngineMeta(snapshot.groupChatGc1));
            const sqGc2 = await sqChat.get(sqh.handle, null, 'gc-2', { isGroup: true, groupId: 'gc-2' });
            expect(stripChatEngineMeta(sqGc2)).toEqual(stripChatEngineMeta(snapshot.groupChatGc2));
        } finally {
            fsh.cleanup();
            sqh.cleanup();
        }
    });
});
