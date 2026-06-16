// Cross-engine round-trip tests that include PgEngine. This is the same
// shape as round-trip.test.js (FS ↔ SQLite) and round-trip-mysql.test.js,
// extended with the Postgres engine in place of MySQL.
//
// Direction pairs covered per Repo (the omitted Postgres → SQLite pair is
// implicitly covered by SQLite → Postgres → SQLite, which exercises the same
// Postgres → SQLite read path on the way back):
//   - FS     → Postgres → FS
//   - SQLite → Postgres → SQLite
//   - Postgres → FS
//
// We host this in a separate file so the whole suite silently no-ops when the
// local Postgres container is unavailable (set LUKER_DISABLE_POSTGRES_TESTS=1).
// The original round-trip.test.js stays stable and engine-agnostic; future
// engines add their own paired file rather than ballooning that one.
//
// IMPORTANT: the Postgres harness cleanup is async (drops the per-test schema
// CASCADE and shuts down the connection pool). FS/SQLite cleanups are sync.
// Each test does `try { ... } finally { fs+sq cleanup; await pgh.cleanup(); }`.

import fs from 'node:fs';

import {
    makeTempFsEngineHarness,
    makeTempSqliteEngineHarness,
} from './harness/contract-harness.js';
import { makeTempPgEngineHarness } from './harness/pg-harness.js';
import { ChatRepo } from '../../src/storage/repositories/chat-repo.js';
import { GroupRepo } from '../../src/storage/repositories/group-repo.js';
import { PresetRepo } from '../../src/storage/repositories/preset-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { StatsRepo } from '../../src/storage/repositories/stats-repo.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { stripChatEngineMeta } from '../../src/storage/migration/equality.js';

const makeFs = makeTempFsEngineHarness;
const makeSqlite = makeTempSqliteEngineHarness;
const makePg = makeTempPgEngineHarness;

const skipPostgres = !!process.env.LUKER_DISABLE_POSTGRES_TESTS;
const describePostgres = skipPostgres ? describe.skip : describe;

// ---- Settings ---------------------------------------------------------------

describePostgres('round-trip via PgEngine: SettingsRepo', () => {
    test('FS → Postgres → FS preserves the settings doc verbatim', async () => {
        const fsh = await makeFs();
        const fsRepo = new SettingsRepo({ engine: fsh.engine });
        const original = {
            user_avatar: 'a.png',
            power_user: { fast: true, theme: 'dark' },
            nested: { arr: [1, 2, 3], deep: { x: 'y', y: null } },
            unicode: '世界 — résumé',
        };
        await fsRepo.save(fsh.handle, original);
        const fromFs = await fsRepo.get(fsh.handle);

        const pgh = await makePg();
        const fsh2 = await makeFs();
        try {
            const pgRepo = new SettingsRepo({ engine: pgh.engine });
            await pgRepo.save(pgh.handle, fromFs);
            const fromPg = await pgRepo.get(pgh.handle);
            expect(fromPg).toEqual(original);
            expect(fromPg).toEqual(fromFs);

            const fs2Repo = new SettingsRepo({ engine: fsh2.engine });
            await fs2Repo.save(fsh2.handle, fromPg);
            const fromFs2 = await fs2Repo.get(fsh2.handle);
            expect(fromFs2).toEqual(original);
        } finally {
            fsh.cleanup();
            fsh2.cleanup();
            await pgh.cleanup();
        }
    });

    test('SQLite → Postgres → SQLite preserves the settings doc verbatim', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new SettingsRepo({ engine: sqh.engine });
        const original = {
            user_avatar: 'b.png',
            power_user: { fast: false },
            list: [1, 'two', null, { deep: true }],
        };
        await sqRepo.save(sqh.handle, original);
        const fromSqlite = await sqRepo.get(sqh.handle);

        const pgh = await makePg();
        const sqh2 = await makeSqlite();
        try {
            const pgRepo = new SettingsRepo({ engine: pgh.engine });
            await pgRepo.save(pgh.handle, fromSqlite);
            const fromPg = await pgRepo.get(pgh.handle);
            expect(fromPg).toEqual(original);

            const sq2Repo = new SettingsRepo({ engine: sqh2.engine });
            await sq2Repo.save(sqh2.handle, fromPg);
            const fromSqlite2 = await sq2Repo.get(sqh2.handle);
            expect(fromSqlite2).toEqual(original);
        } finally {
            sqh.cleanup();
            sqh2.cleanup();
            await pgh.cleanup();
        }
    });

    test('Postgres → FS preserves the settings doc verbatim', async () => {
        const pgh = await makePg();
        const pgRepo = new SettingsRepo({ engine: pgh.engine });
        const original = {
            user_avatar: 'c.png',
            power_user: { theme: 'light', density: 'compact' },
            arr: [null, 0, '', false],
        };
        await pgRepo.save(pgh.handle, original);
        const fromPg = await pgRepo.get(pgh.handle);

        const fsh = await makeFs();
        try {
            const fsRepo = new SettingsRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, fromPg);
            const fromFs = await fsRepo.get(fsh.handle);
            expect(fromFs).toEqual(original);
            expect(fromFs).toEqual(fromPg);
        } finally {
            fsh.cleanup();
            await pgh.cleanup();
        }
    });
});

// ---- Preset -----------------------------------------------------------------

describePostgres('round-trip via PgEngine: PresetRepo', () => {
    test('FS → Postgres → FS preserves an OpenAI preset doc', async () => {
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

        const pgh = await makePg();
        const fsh2 = await makeFs();
        try {
            const pgRepo = new PresetRepo({ engine: pgh.engine });
            await pgRepo.save(pgh.handle, 'openai', 'mypreset', fromFs);
            const fromPg = await pgRepo.get(pgh.handle, 'openai', 'mypreset');
            expect(fromPg).toEqual(original);

            const fs2Repo = new PresetRepo({ engine: fsh2.engine });
            await fs2Repo.save(fsh2.handle, 'openai', 'mypreset', fromPg);
            const fromFs2 = await fs2Repo.get(fsh2.handle, 'openai', 'mypreset');
            expect(fromFs2).toEqual(original);
        } finally {
            fsh.cleanup();
            fsh2.cleanup();
            await pgh.cleanup();
        }
    });

    test('SQLite → Postgres → SQLite preserves a textgen preset doc and a state sidecar', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new PresetRepo({ engine: sqh.engine });
        const original = { temperature: 0.5, max_new_tokens: 1024, presets: [{ name: 'x' }] };
        await sqRepo.save(sqh.handle, 'textgenerationwebui', 'mypreset', original);
        const originalState = { iteration_lib: { nodes: ['a', 'b'], cfg: { x: 1, y: null } } };
        await sqRepo.setState(sqh.handle, 'textgenerationwebui', 'mypreset', 'iter_lib', originalState);
        const fromSqlite = await sqRepo.get(sqh.handle, 'textgenerationwebui', 'mypreset');
        const fromSqliteState = await sqRepo.getState(sqh.handle, 'textgenerationwebui', 'mypreset', 'iter_lib');

        const pgh = await makePg();
        const sqh2 = await makeSqlite();
        try {
            const pgRepo = new PresetRepo({ engine: pgh.engine });
            await pgRepo.save(pgh.handle, 'textgenerationwebui', 'mypreset', fromSqlite);
            await pgRepo.setState(pgh.handle, 'textgenerationwebui', 'mypreset', 'iter_lib', fromSqliteState);
            const fromPg = await pgRepo.get(pgh.handle, 'textgenerationwebui', 'mypreset');
            const fromPgState = await pgRepo.getState(pgh.handle, 'textgenerationwebui', 'mypreset', 'iter_lib');
            expect(fromPg).toEqual(original);
            expect(fromPgState).toEqual(originalState);

            const sq2Repo = new PresetRepo({ engine: sqh2.engine });
            await sq2Repo.save(sqh2.handle, 'textgenerationwebui', 'mypreset', fromPg);
            await sq2Repo.setState(sqh2.handle, 'textgenerationwebui', 'mypreset', 'iter_lib', fromPgState);
            expect(await sq2Repo.get(sqh2.handle, 'textgenerationwebui', 'mypreset')).toEqual(original);
            expect(await sq2Repo.getState(sqh2.handle, 'textgenerationwebui', 'mypreset', 'iter_lib'))
                .toEqual(originalState);
        } finally {
            sqh.cleanup();
            sqh2.cleanup();
            await pgh.cleanup();
        }
    });

    test('Postgres → FS preserves preset doc plus two state sidecars across namespaces', async () => {
        const pgh = await makePg();
        const pgRepo = new PresetRepo({ engine: pgh.engine });
        const original = { temperature: 0.7, top_p: 0.9, mix: { arr: [1, null, 'x'] } };
        await pgRepo.save(pgh.handle, 'openai', 'mypreset', original);
        const stateA = { iteration_lib: { nodes: ['a', 'b'], cfg: { x: 1 } } };
        const stateB = { agenda: { steps: [{ id: 1 }, { id: 2 }] } };
        await pgRepo.setState(pgh.handle, 'openai', 'mypreset', 'iter_lib', stateA);
        await pgRepo.setState(pgh.handle, 'openai', 'mypreset', 'agenda', stateB);
        const fromPg = await pgRepo.get(pgh.handle, 'openai', 'mypreset');
        const fromPgA = await pgRepo.getState(pgh.handle, 'openai', 'mypreset', 'iter_lib');
        const fromPgB = await pgRepo.getState(pgh.handle, 'openai', 'mypreset', 'agenda');

        const fsh = await makeFs();
        try {
            const fsRepo = new PresetRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, 'openai', 'mypreset', fromPg);
            await fsRepo.setState(fsh.handle, 'openai', 'mypreset', 'iter_lib', fromPgA);
            await fsRepo.setState(fsh.handle, 'openai', 'mypreset', 'agenda', fromPgB);
            expect(await fsRepo.get(fsh.handle, 'openai', 'mypreset')).toEqual(original);
            expect(await fsRepo.getState(fsh.handle, 'openai', 'mypreset', 'iter_lib')).toEqual(stateA);
            expect(await fsRepo.getState(fsh.handle, 'openai', 'mypreset', 'agenda')).toEqual(stateB);
        } finally {
            fsh.cleanup();
            await pgh.cleanup();
        }
    });
});

// ---- World ------------------------------------------------------------------
//
// Non-ASCII world name exercises the tolerant resolver on each engine. Postgres
// stores text as UTF-8 by default so extended characters round-trip naturally;
// the harness still hits the same code paths as MySQL for parity.

describePostgres('round-trip via PgEngine: WorldInfoRepo', () => {
    test('FS → Postgres → FS preserves a non-ASCII-named world with multiple entries', async () => {
        const fsh = await makeFs();
        fs.mkdirSync(fsh.dirs.worlds, { recursive: true });
        const fsRepo = new WorldInfoRepo({ engine: fsh.engine });
        const worldName = '世界书 — Lore';
        const original = {
            name: worldName,
            entries: {
                '0': { uid: 0, key: ['hello', '你好'], content: 'world', enabled: true },
                '1': { uid: 1, key: ['foo'], content: 'bar', position: 4 },
                '2': { uid: 2, key: [], content: 'always-on résumé', constant: true },
            },
            originalData: { foo: 'bar', nested: [{ a: 1 }] },
        };
        await fsRepo.save(fsh.handle, worldName, original);
        const fromFs = await fsRepo.get(fsh.handle, worldName);

        const pgh = await makePg();
        const fsh2 = await makeFs();
        try {
            const pgRepo = new WorldInfoRepo({ engine: pgh.engine });
            await pgRepo.save(pgh.handle, worldName, fromFs);
            const fromPg = await pgRepo.get(pgh.handle, worldName);
            expect(fromPg).toEqual(original);

            fs.mkdirSync(fsh2.dirs.worlds, { recursive: true });
            const fs2Repo = new WorldInfoRepo({ engine: fsh2.engine });
            await fs2Repo.save(fsh2.handle, worldName, fromPg);
            const fromFs2 = await fs2Repo.get(fsh2.handle, worldName);
            expect(fromFs2).toEqual(original);
        } finally {
            fsh.cleanup();
            fsh2.cleanup();
            await pgh.cleanup();
        }
    });

    test('SQLite → Postgres → SQLite preserves a non-ASCII-named world', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new WorldInfoRepo({ engine: sqh.engine });
        const worldName = 'Café — 北京';
        const original = {
            name: worldName,
            entries: {
                '0': { content: 'a', key: ['α', 'β'] },
                '5': { content: 'b', position: 2 },
            },
        };
        await sqRepo.save(sqh.handle, worldName, original);
        const fromSqlite = await sqRepo.get(sqh.handle, worldName);

        const pgh = await makePg();
        const sqh2 = await makeSqlite();
        try {
            const pgRepo = new WorldInfoRepo({ engine: pgh.engine });
            await pgRepo.save(pgh.handle, worldName, fromSqlite);
            const fromPg = await pgRepo.get(pgh.handle, worldName);
            expect(fromPg).toEqual(original);

            const sq2Repo = new WorldInfoRepo({ engine: sqh2.engine });
            await sq2Repo.save(sqh2.handle, worldName, fromPg);
            const fromSqlite2 = await sq2Repo.get(sqh2.handle, worldName);
            expect(fromSqlite2).toEqual(original);
        } finally {
            sqh.cleanup();
            sqh2.cleanup();
            await pgh.cleanup();
        }
    });

    test('Postgres → FS preserves a non-ASCII-named world', async () => {
        const pgh = await makePg();
        const pgRepo = new WorldInfoRepo({ engine: pgh.engine });
        const worldName = 'Lōre — déjà vu';
        const original = {
            name: worldName,
            entries: {
                '0': { uid: 0, key: ['hello'], content: '世界 says hi', enabled: true },
            },
            originalData: null,
        };
        await pgRepo.save(pgh.handle, worldName, original);
        const fromPg = await pgRepo.get(pgh.handle, worldName);

        const fsh = await makeFs();
        try {
            fs.mkdirSync(fsh.dirs.worlds, { recursive: true });
            const fsRepo = new WorldInfoRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, worldName, fromPg);
            const fromFs = await fsRepo.get(fsh.handle, worldName);
            expect(fromFs).toEqual(original);
        } finally {
            fsh.cleanup();
            await pgh.cleanup();
        }
    });
});

// ---- Group ------------------------------------------------------------------

describePostgres('round-trip via PgEngine: GroupRepo', () => {
    test('FS → Postgres → FS preserves a group doc with members and chats', async () => {
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

        const pgh = await makePg();
        const fsh2 = await makeFs();
        try {
            const pgRepo = new GroupRepo({ engine: pgh.engine });
            await pgRepo.save(pgh.handle, 'grp-1', fromFs);
            const fromPg = await pgRepo.get(pgh.handle, 'grp-1');
            expect(fromPg).toEqual(original);

            fs.mkdirSync(fsh2.dirs.groups, { recursive: true });
            fs.mkdirSync(fsh2.dirs.groupChats, { recursive: true });
            const fs2Repo = new GroupRepo({ engine: fsh2.engine });
            await fs2Repo.save(fsh2.handle, 'grp-1', fromPg);
            expect(await fs2Repo.get(fsh2.handle, 'grp-1')).toEqual(original);
        } finally {
            fsh.cleanup();
            fsh2.cleanup();
            await pgh.cleanup();
        }
    });

    test('SQLite → Postgres → SQLite preserves a group doc', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new GroupRepo({ engine: sqh.engine });
        const original = {
            id: 'grp-2',
            name: '剧组',
            members: ['x.png', 'y.png'],
            chats: ['gc-1'],
            metadata: { tags: ['α'], extra: { nested: { a: 1, b: null } } },
        };
        await sqRepo.save(sqh.handle, 'grp-2', original);
        const fromSqlite = await sqRepo.get(sqh.handle, 'grp-2');

        const pgh = await makePg();
        const sqh2 = await makeSqlite();
        try {
            const pgRepo = new GroupRepo({ engine: pgh.engine });
            await pgRepo.save(pgh.handle, 'grp-2', fromSqlite);
            const fromPg = await pgRepo.get(pgh.handle, 'grp-2');
            expect(fromPg).toEqual(original);

            const sq2Repo = new GroupRepo({ engine: sqh2.engine });
            await sq2Repo.save(sqh2.handle, 'grp-2', fromPg);
            expect(await sq2Repo.get(sqh2.handle, 'grp-2')).toEqual(original);
        } finally {
            sqh.cleanup();
            sqh2.cleanup();
            await pgh.cleanup();
        }
    });

    test('Postgres → FS preserves a group doc', async () => {
        const pgh = await makePg();
        const pgRepo = new GroupRepo({ engine: pgh.engine });
        const original = {
            id: 'grp-3',
            name: 'Trio',
            members: ['m1.png', 'm2.png', 'm3.png'],
            chats: [],
            metadata: { created_at: 9999, tags: [] },
        };
        await pgRepo.save(pgh.handle, 'grp-3', original);
        const fromPg = await pgRepo.get(pgh.handle, 'grp-3');

        const fsh = await makeFs();
        try {
            fs.mkdirSync(fsh.dirs.groups, { recursive: true });
            fs.mkdirSync(fsh.dirs.groupChats, { recursive: true });
            const fsRepo = new GroupRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, 'grp-3', fromPg);
            expect(await fsRepo.get(fsh.handle, 'grp-3')).toEqual(original);
        } finally {
            fsh.cleanup();
            await pgh.cleanup();
        }
    });
});

// ---- Stats ------------------------------------------------------------------

describePostgres('round-trip via PgEngine: StatsRepo', () => {
    test('FS → Postgres → FS preserves a stats doc', async () => {
        const fsh = await makeFs();
        const fsRepo = new StatsRepo({ engine: fsh.engine });
        const original = {
            'alice.png': { user_msg_count: 5, total_gen_time: 1234 },
            'bob.png': { user_msg_count: 12 },
            timestamp: 1700000000,
        };
        await fsRepo.save(fsh.handle, original);
        const fromFs = await fsRepo.get(fsh.handle);

        const pgh = await makePg();
        const fsh2 = await makeFs();
        try {
            const pgRepo = new StatsRepo({ engine: pgh.engine });
            await pgRepo.save(pgh.handle, fromFs);
            const fromPg = await pgRepo.get(pgh.handle);
            expect(fromPg).toEqual(original);

            const fs2Repo = new StatsRepo({ engine: fsh2.engine });
            await fs2Repo.save(fsh2.handle, fromPg);
            expect(await fs2Repo.get(fsh2.handle)).toEqual(original);
        } finally {
            fsh.cleanup();
            fsh2.cleanup();
            await pgh.cleanup();
        }
    });

    test('SQLite → Postgres → SQLite preserves a stats doc with nested values', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new StatsRepo({ engine: sqh.engine });
        const original = {
            'char-α.png': { user_msg_count: 3, total_gen_time: 4567, sessions: [{ id: 1 }, { id: 2 }] },
            '世界.png': { user_msg_count: 7, last_chat: null },
            timestamp: 1710000000,
        };
        await sqRepo.save(sqh.handle, original);
        const fromSqlite = await sqRepo.get(sqh.handle);

        const pgh = await makePg();
        const sqh2 = await makeSqlite();
        try {
            const pgRepo = new StatsRepo({ engine: pgh.engine });
            await pgRepo.save(pgh.handle, fromSqlite);
            const fromPg = await pgRepo.get(pgh.handle);
            expect(fromPg).toEqual(original);

            const sq2Repo = new StatsRepo({ engine: sqh2.engine });
            await sq2Repo.save(sqh2.handle, fromPg);
            expect(await sq2Repo.get(sqh2.handle)).toEqual(original);
        } finally {
            sqh.cleanup();
            sqh2.cleanup();
            await pgh.cleanup();
        }
    });

    test('Postgres → FS preserves a stats doc', async () => {
        const pgh = await makePg();
        const pgRepo = new StatsRepo({ engine: pgh.engine });
        const original = {
            'alice.png': { user_msg_count: 2 },
            timestamp: 1720000000,
            notes: null,
        };
        await pgRepo.save(pgh.handle, original);
        const fromPg = await pgRepo.get(pgh.handle);

        const fsh = await makeFs();
        try {
            const fsRepo = new StatsRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, fromPg);
            expect(await fsRepo.get(fsh.handle)).toEqual(original);
        } finally {
            fsh.cleanup();
            await pgh.cleanup();
        }
    });
});

// ---- Chat (header + body, modulo integrity) ---------------------------------
//
// Chat records carry an engine-rotated `integrity` field (both at top level and
// embedded in `header.chat_metadata.integrity`). Each engine re-issues it on
// save, so cross-engine equality must strip it out via `stripChatEngineMeta` —
// same contract as the FS↔SQLite round-trip.

describePostgres('round-trip via PgEngine: ChatRepo', () => {
    test('FS → Postgres → FS preserves chat header and body', async () => {
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
        expect(typeof fromFs.integrity).toBe('string');
        expect(fromFs.integrity.length).toBeGreaterThan(0);

        const pgh = await makePg();
        const fsh2 = await makeFs();
        try {
            const pgRepo = new ChatRepo({ engine: pgh.engine });
            await pgRepo.save(pgh.handle, 'TestChar', 'chat1', fromFs.header, fromFs.body, null);
            const fromPg = await pgRepo.get(pgh.handle, 'TestChar', 'chat1');
            expect(fromPg.body).toEqual(body);
            expect(typeof fromPg.integrity).toBe('string');
            expect(fromPg.integrity.length).toBeGreaterThan(0);
            expect(stripChatEngineMeta(fromPg)).toEqual(stripChatEngineMeta(fromFs));

            const fs2Repo = new ChatRepo({ engine: fsh2.engine });
            await fs2Repo.save(fsh2.handle, 'TestChar', 'chat1', fromPg.header, fromPg.body, null);
            const fromFs2 = await fs2Repo.get(fsh2.handle, 'TestChar', 'chat1');
            expect(fromFs2.body).toEqual(body);
            expect(stripChatEngineMeta(fromFs2)).toEqual(stripChatEngineMeta(fromFs));
        } finally {
            fsh.cleanup();
            fsh2.cleanup();
            await pgh.cleanup();
        }
    });

    test('SQLite → Postgres → SQLite preserves chat header and body plus state sidecars', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new ChatRepo({ engine: sqh.engine });
        const header = { user_name: 'U', chat_metadata: { x: 1, note: '剧本' } };
        const body = [
            { name: 'U', mes: 'hi' },
            { name: 'C', mes: 'hello', extra: { future: { tool: 'x' } } },
        ];
        await sqRepo.save(sqh.handle, 'Char', 'c1', header, body, null);
        const mgDoc = { nodes: ['a', 'b'], anchors: [1, 2], meta: { last_floor: 3 } };
        const floorDoc = { current: 2, history: [{ id: 1 }, { id: 2 }] };
        await sqRepo.setState(sqh.handle, 'Char', 'c1', 'memory-graph', mgDoc);
        await sqRepo.setState(sqh.handle, 'Char', 'c1', 'floor-state', floorDoc);
        const fromSqlite = await sqRepo.get(sqh.handle, 'Char', 'c1');
        const fromSqliteMg = await sqRepo.getState(sqh.handle, 'Char', 'c1', 'memory-graph');
        const fromSqliteFloor = await sqRepo.getState(sqh.handle, 'Char', 'c1', 'floor-state');

        const pgh = await makePg();
        const sqh2 = await makeSqlite();
        try {
            const pgRepo = new ChatRepo({ engine: pgh.engine });
            await pgRepo.save(pgh.handle, 'Char', 'c1', fromSqlite.header, fromSqlite.body, null);
            await pgRepo.setState(pgh.handle, 'Char', 'c1', 'memory-graph', fromSqliteMg);
            await pgRepo.setState(pgh.handle, 'Char', 'c1', 'floor-state', fromSqliteFloor);
            const fromPg = await pgRepo.get(pgh.handle, 'Char', 'c1');
            expect(fromPg.body).toEqual(body);
            expect(stripChatEngineMeta(fromPg)).toEqual(stripChatEngineMeta(fromSqlite));
            expect(await pgRepo.getState(pgh.handle, 'Char', 'c1', 'memory-graph')).toEqual(mgDoc);
            expect(await pgRepo.getState(pgh.handle, 'Char', 'c1', 'floor-state')).toEqual(floorDoc);

            const sq2Repo = new ChatRepo({ engine: sqh2.engine });
            await sq2Repo.save(sqh2.handle, 'Char', 'c1', fromPg.header, fromPg.body, null);
            await sq2Repo.setState(sqh2.handle, 'Char', 'c1', 'memory-graph',
                await pgRepo.getState(pgh.handle, 'Char', 'c1', 'memory-graph'));
            await sq2Repo.setState(sqh2.handle, 'Char', 'c1', 'floor-state',
                await pgRepo.getState(pgh.handle, 'Char', 'c1', 'floor-state'));
            const fromSqlite2 = await sq2Repo.get(sqh2.handle, 'Char', 'c1');
            expect(fromSqlite2.body).toEqual(body);
            expect(stripChatEngineMeta(fromSqlite2)).toEqual(stripChatEngineMeta(fromSqlite));
            expect(await sq2Repo.getState(sqh2.handle, 'Char', 'c1', 'memory-graph')).toEqual(mgDoc);
            expect(await sq2Repo.getState(sqh2.handle, 'Char', 'c1', 'floor-state')).toEqual(floorDoc);
        } finally {
            sqh.cleanup();
            sqh2.cleanup();
            await pgh.cleanup();
        }
    });

    test('Postgres → FS preserves chat header, body, and a group-chat record', async () => {
        const pgh = await makePg();
        const pgRepo = new ChatRepo({ engine: pgh.engine });
        // Per-char chat
        const header = { user_name: 'User', chat_metadata: { foo: 'bar' } };
        const body = [
            { name: 'User', mes: 'first', is_user: true },
            { name: 'Char', mes: 'reply 世界', is_user: false },
        ];
        await pgRepo.save(pgh.handle, 'Char', 'c1', header, body, null);
        const fromPg = await pgRepo.get(pgh.handle, 'Char', 'c1');
        // Group chat
        const groupHeader = { user_name: 'User', chat_metadata: { gc: true } };
        const groupBody = [{ name: 'User', mes: 'gm1' }];
        await pgRepo.save(pgh.handle, null, 'gc-1', groupHeader, groupBody, null, { isGroup: true, groupId: 'gc-1' });
        const fromPgGc = await pgRepo.get(pgh.handle, null, 'gc-1', { isGroup: true, groupId: 'gc-1' });

        const fsh = await makeFs();
        try {
            const fsRepo = new ChatRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, 'Char', 'c1', fromPg.header, fromPg.body, null);
            const fromFs = await fsRepo.get(fsh.handle, 'Char', 'c1');
            expect(fromFs.body).toEqual(body);
            expect(stripChatEngineMeta(fromFs)).toEqual(stripChatEngineMeta(fromPg));

            fs.mkdirSync(fsh.dirs.groupChats, { recursive: true });
            await fsRepo.save(fsh.handle, null, 'gc-1', fromPgGc.header, fromPgGc.body, null,
                { isGroup: true, groupId: 'gc-1' });
            const fromFsGc = await fsRepo.get(fsh.handle, null, 'gc-1', { isGroup: true, groupId: 'gc-1' });
            expect(fromFsGc.body).toEqual(groupBody);
            expect(stripChatEngineMeta(fromFsGc)).toEqual(stripChatEngineMeta(fromPgGc));
        } finally {
            fsh.cleanup();
            await pgh.cleanup();
        }
    });
});
