// Cross-engine round-trip tests that include MysqlEngine. This is the same
// shape as round-trip.test.js (FS ↔ SQLite) extended with a third engine.
//
// Direction pairs covered per Repo (the omitted MySQL → SQLite pair is
// implicitly covered by SQLite → MySQL → SQLite, which exercises the same
// MySQL → SQLite read path on the way back):
//   - FS     → MySQL  → FS
//   - SQLite → MySQL  → SQLite
//   - MySQL  → FS
//
// We host this in a separate file so the whole suite silently no-ops when the
// local MySQL container is unavailable (set LUKER_DISABLE_MYSQL_TESTS=1). The
// original round-trip.test.js stays stable and engine-agnostic; future engines
// add their own paired file rather than ballooning that one.
//
// IMPORTANT: the MySQL harness cleanup is async (drops the per-test database
// and shuts down the connection pool). FS/SQLite cleanups are sync. Each test
// does `try { ... } finally { fs+sq cleanup; await my.cleanup(); }`.

import fs from 'node:fs';

import {
    makeTempFsEngineHarness,
    makeTempSqliteEngineHarness,
} from './harness/contract-harness.js';
import { makeTempMysqlEngineHarness } from './harness/mysql-harness.js';
import { ChatRepo } from '../../src/storage/repositories/chat-repo.js';
import { GroupRepo } from '../../src/storage/repositories/group-repo.js';
import { PresetRepo } from '../../src/storage/repositories/preset-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { StatsRepo } from '../../src/storage/repositories/stats-repo.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { stripChatEngineMeta } from '../../src/storage/migration/equality.js';

const makeFs = makeTempFsEngineHarness;
const makeSqlite = makeTempSqliteEngineHarness;
const makeMysql = makeTempMysqlEngineHarness;

const skipMysql = !!process.env.LUKER_DISABLE_MYSQL_TESTS;
const describeMysql = skipMysql ? describe.skip : describe;

// ---- Settings ---------------------------------------------------------------

describeMysql('round-trip via MysqlEngine: SettingsRepo', () => {
    test('FS → MySQL → FS preserves the settings doc verbatim', async () => {
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

        const myh = await makeMysql();
        const fsh2 = await makeFs();
        try {
            const myRepo = new SettingsRepo({ engine: myh.engine });
            await myRepo.save(myh.handle, fromFs);
            const fromMysql = await myRepo.get(myh.handle);
            expect(fromMysql).toEqual(original);
            expect(fromMysql).toEqual(fromFs);

            const fs2Repo = new SettingsRepo({ engine: fsh2.engine });
            await fs2Repo.save(fsh2.handle, fromMysql);
            const fromFs2 = await fs2Repo.get(fsh2.handle);
            expect(fromFs2).toEqual(original);
        } finally {
            fsh.cleanup();
            fsh2.cleanup();
            await myh.cleanup();
        }
    });

    test('SQLite → MySQL → SQLite preserves the settings doc verbatim', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new SettingsRepo({ engine: sqh.engine });
        const original = {
            user_avatar: 'b.png',
            power_user: { fast: false },
            list: [1, 'two', null, { deep: true }],
        };
        await sqRepo.save(sqh.handle, original);
        const fromSqlite = await sqRepo.get(sqh.handle);

        const myh = await makeMysql();
        const sqh2 = await makeSqlite();
        try {
            const myRepo = new SettingsRepo({ engine: myh.engine });
            await myRepo.save(myh.handle, fromSqlite);
            const fromMysql = await myRepo.get(myh.handle);
            expect(fromMysql).toEqual(original);

            const sq2Repo = new SettingsRepo({ engine: sqh2.engine });
            await sq2Repo.save(sqh2.handle, fromMysql);
            const fromSqlite2 = await sq2Repo.get(sqh2.handle);
            expect(fromSqlite2).toEqual(original);
        } finally {
            sqh.cleanup();
            sqh2.cleanup();
            await myh.cleanup();
        }
    });

    test('MySQL → FS preserves the settings doc verbatim', async () => {
        const myh = await makeMysql();
        const myRepo = new SettingsRepo({ engine: myh.engine });
        const original = {
            user_avatar: 'c.png',
            power_user: { theme: 'light', density: 'compact' },
            arr: [null, 0, '', false],
        };
        await myRepo.save(myh.handle, original);
        const fromMysql = await myRepo.get(myh.handle);

        const fsh = await makeFs();
        try {
            const fsRepo = new SettingsRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, fromMysql);
            const fromFs = await fsRepo.get(fsh.handle);
            expect(fromFs).toEqual(original);
            expect(fromFs).toEqual(fromMysql);
        } finally {
            fsh.cleanup();
            await myh.cleanup();
        }
    });
});

// ---- Preset -----------------------------------------------------------------

describeMysql('round-trip via MysqlEngine: PresetRepo', () => {
    test('FS → MySQL → FS preserves an OpenAI preset doc', async () => {
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

        const myh = await makeMysql();
        const fsh2 = await makeFs();
        try {
            const myRepo = new PresetRepo({ engine: myh.engine });
            await myRepo.save(myh.handle, 'openai', 'mypreset', fromFs);
            const fromMysql = await myRepo.get(myh.handle, 'openai', 'mypreset');
            expect(fromMysql).toEqual(original);

            const fs2Repo = new PresetRepo({ engine: fsh2.engine });
            await fs2Repo.save(fsh2.handle, 'openai', 'mypreset', fromMysql);
            const fromFs2 = await fs2Repo.get(fsh2.handle, 'openai', 'mypreset');
            expect(fromFs2).toEqual(original);
        } finally {
            fsh.cleanup();
            fsh2.cleanup();
            await myh.cleanup();
        }
    });

    test('SQLite → MySQL → SQLite preserves a textgen preset doc and a state sidecar', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new PresetRepo({ engine: sqh.engine });
        const original = { temperature: 0.5, max_new_tokens: 1024, presets: [{ name: 'x' }] };
        await sqRepo.save(sqh.handle, 'textgenerationwebui', 'mypreset', original);
        const originalState = { iteration_lib: { nodes: ['a', 'b'], cfg: { x: 1, y: null } } };
        await sqRepo.setState(sqh.handle, 'textgenerationwebui', 'mypreset', 'iter_lib', originalState);
        const fromSqlite = await sqRepo.get(sqh.handle, 'textgenerationwebui', 'mypreset');
        const fromSqliteState = await sqRepo.getState(sqh.handle, 'textgenerationwebui', 'mypreset', 'iter_lib');

        const myh = await makeMysql();
        const sqh2 = await makeSqlite();
        try {
            const myRepo = new PresetRepo({ engine: myh.engine });
            await myRepo.save(myh.handle, 'textgenerationwebui', 'mypreset', fromSqlite);
            await myRepo.setState(myh.handle, 'textgenerationwebui', 'mypreset', 'iter_lib', fromSqliteState);
            const fromMysql = await myRepo.get(myh.handle, 'textgenerationwebui', 'mypreset');
            const fromMysqlState = await myRepo.getState(myh.handle, 'textgenerationwebui', 'mypreset', 'iter_lib');
            expect(fromMysql).toEqual(original);
            expect(fromMysqlState).toEqual(originalState);

            const sq2Repo = new PresetRepo({ engine: sqh2.engine });
            await sq2Repo.save(sqh2.handle, 'textgenerationwebui', 'mypreset', fromMysql);
            await sq2Repo.setState(sqh2.handle, 'textgenerationwebui', 'mypreset', 'iter_lib', fromMysqlState);
            expect(await sq2Repo.get(sqh2.handle, 'textgenerationwebui', 'mypreset')).toEqual(original);
            expect(await sq2Repo.getState(sqh2.handle, 'textgenerationwebui', 'mypreset', 'iter_lib'))
                .toEqual(originalState);
        } finally {
            sqh.cleanup();
            sqh2.cleanup();
            await myh.cleanup();
        }
    });

    test('MySQL → FS preserves preset doc plus two state sidecars across namespaces', async () => {
        const myh = await makeMysql();
        const myRepo = new PresetRepo({ engine: myh.engine });
        const original = { temperature: 0.7, top_p: 0.9, mix: { arr: [1, null, 'x'] } };
        await myRepo.save(myh.handle, 'openai', 'mypreset', original);
        const stateA = { iteration_lib: { nodes: ['a', 'b'], cfg: { x: 1 } } };
        const stateB = { agenda: { steps: [{ id: 1 }, { id: 2 }] } };
        await myRepo.setState(myh.handle, 'openai', 'mypreset', 'iter_lib', stateA);
        await myRepo.setState(myh.handle, 'openai', 'mypreset', 'agenda', stateB);
        const fromMysql = await myRepo.get(myh.handle, 'openai', 'mypreset');
        const fromMysqlA = await myRepo.getState(myh.handle, 'openai', 'mypreset', 'iter_lib');
        const fromMysqlB = await myRepo.getState(myh.handle, 'openai', 'mypreset', 'agenda');

        const fsh = await makeFs();
        try {
            const fsRepo = new PresetRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, 'openai', 'mypreset', fromMysql);
            await fsRepo.setState(fsh.handle, 'openai', 'mypreset', 'iter_lib', fromMysqlA);
            await fsRepo.setState(fsh.handle, 'openai', 'mypreset', 'agenda', fromMysqlB);
            expect(await fsRepo.get(fsh.handle, 'openai', 'mypreset')).toEqual(original);
            expect(await fsRepo.getState(fsh.handle, 'openai', 'mypreset', 'iter_lib')).toEqual(stateA);
            expect(await fsRepo.getState(fsh.handle, 'openai', 'mypreset', 'agenda')).toEqual(stateB);
        } finally {
            fsh.cleanup();
            await myh.cleanup();
        }
    });
});

// ---- World ------------------------------------------------------------------
//
// Non-ASCII world name exercises the tolerant resolver on each engine — MySQL
// in particular needs `utf8mb4_bin` to round-trip extended characters byte-for
// byte (the harness creates the database with that collation explicitly).

describeMysql('round-trip via MysqlEngine: WorldInfoRepo', () => {
    test('FS → MySQL → FS preserves a non-ASCII-named world with multiple entries', async () => {
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

        const myh = await makeMysql();
        const fsh2 = await makeFs();
        try {
            const myRepo = new WorldInfoRepo({ engine: myh.engine });
            await myRepo.save(myh.handle, worldName, fromFs);
            const fromMysql = await myRepo.get(myh.handle, worldName);
            expect(fromMysql).toEqual(original);

            fs.mkdirSync(fsh2.dirs.worlds, { recursive: true });
            const fs2Repo = new WorldInfoRepo({ engine: fsh2.engine });
            await fs2Repo.save(fsh2.handle, worldName, fromMysql);
            const fromFs2 = await fs2Repo.get(fsh2.handle, worldName);
            expect(fromFs2).toEqual(original);
        } finally {
            fsh.cleanup();
            fsh2.cleanup();
            await myh.cleanup();
        }
    });

    test('SQLite → MySQL → SQLite preserves a non-ASCII-named world', async () => {
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

        const myh = await makeMysql();
        const sqh2 = await makeSqlite();
        try {
            const myRepo = new WorldInfoRepo({ engine: myh.engine });
            await myRepo.save(myh.handle, worldName, fromSqlite);
            const fromMysql = await myRepo.get(myh.handle, worldName);
            expect(fromMysql).toEqual(original);

            const sq2Repo = new WorldInfoRepo({ engine: sqh2.engine });
            await sq2Repo.save(sqh2.handle, worldName, fromMysql);
            const fromSqlite2 = await sq2Repo.get(sqh2.handle, worldName);
            expect(fromSqlite2).toEqual(original);
        } finally {
            sqh.cleanup();
            sqh2.cleanup();
            await myh.cleanup();
        }
    });

    test('MySQL → FS preserves a non-ASCII-named world', async () => {
        const myh = await makeMysql();
        const myRepo = new WorldInfoRepo({ engine: myh.engine });
        const worldName = 'Lōre — déjà vu';
        const original = {
            name: worldName,
            entries: {
                '0': { uid: 0, key: ['hello'], content: '世界 says hi', enabled: true },
            },
            originalData: null,
        };
        await myRepo.save(myh.handle, worldName, original);
        const fromMysql = await myRepo.get(myh.handle, worldName);

        const fsh = await makeFs();
        try {
            fs.mkdirSync(fsh.dirs.worlds, { recursive: true });
            const fsRepo = new WorldInfoRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, worldName, fromMysql);
            const fromFs = await fsRepo.get(fsh.handle, worldName);
            expect(fromFs).toEqual(original);
        } finally {
            fsh.cleanup();
            await myh.cleanup();
        }
    });
});

// ---- Group ------------------------------------------------------------------

describeMysql('round-trip via MysqlEngine: GroupRepo', () => {
    test('FS → MySQL → FS preserves a group doc with members and chats', async () => {
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

        const myh = await makeMysql();
        const fsh2 = await makeFs();
        try {
            const myRepo = new GroupRepo({ engine: myh.engine });
            await myRepo.save(myh.handle, 'grp-1', fromFs);
            const fromMysql = await myRepo.get(myh.handle, 'grp-1');
            expect(fromMysql).toEqual(original);

            fs.mkdirSync(fsh2.dirs.groups, { recursive: true });
            fs.mkdirSync(fsh2.dirs.groupChats, { recursive: true });
            const fs2Repo = new GroupRepo({ engine: fsh2.engine });
            await fs2Repo.save(fsh2.handle, 'grp-1', fromMysql);
            expect(await fs2Repo.get(fsh2.handle, 'grp-1')).toEqual(original);
        } finally {
            fsh.cleanup();
            fsh2.cleanup();
            await myh.cleanup();
        }
    });

    test('SQLite → MySQL → SQLite preserves a group doc', async () => {
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

        const myh = await makeMysql();
        const sqh2 = await makeSqlite();
        try {
            const myRepo = new GroupRepo({ engine: myh.engine });
            await myRepo.save(myh.handle, 'grp-2', fromSqlite);
            const fromMysql = await myRepo.get(myh.handle, 'grp-2');
            expect(fromMysql).toEqual(original);

            const sq2Repo = new GroupRepo({ engine: sqh2.engine });
            await sq2Repo.save(sqh2.handle, 'grp-2', fromMysql);
            expect(await sq2Repo.get(sqh2.handle, 'grp-2')).toEqual(original);
        } finally {
            sqh.cleanup();
            sqh2.cleanup();
            await myh.cleanup();
        }
    });

    test('MySQL → FS preserves a group doc', async () => {
        const myh = await makeMysql();
        const myRepo = new GroupRepo({ engine: myh.engine });
        const original = {
            id: 'grp-3',
            name: 'Trio',
            members: ['m1.png', 'm2.png', 'm3.png'],
            chats: [],
            metadata: { created_at: 9999, tags: [] },
        };
        await myRepo.save(myh.handle, 'grp-3', original);
        const fromMysql = await myRepo.get(myh.handle, 'grp-3');

        const fsh = await makeFs();
        try {
            fs.mkdirSync(fsh.dirs.groups, { recursive: true });
            fs.mkdirSync(fsh.dirs.groupChats, { recursive: true });
            const fsRepo = new GroupRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, 'grp-3', fromMysql);
            expect(await fsRepo.get(fsh.handle, 'grp-3')).toEqual(original);
        } finally {
            fsh.cleanup();
            await myh.cleanup();
        }
    });
});

// ---- Stats ------------------------------------------------------------------

describeMysql('round-trip via MysqlEngine: StatsRepo', () => {
    test('FS → MySQL → FS preserves a stats doc', async () => {
        const fsh = await makeFs();
        const fsRepo = new StatsRepo({ engine: fsh.engine });
        const original = {
            'alice.png': { user_msg_count: 5, total_gen_time: 1234 },
            'bob.png': { user_msg_count: 12 },
            timestamp: 1700000000,
        };
        await fsRepo.save(fsh.handle, original);
        const fromFs = await fsRepo.get(fsh.handle);

        const myh = await makeMysql();
        const fsh2 = await makeFs();
        try {
            const myRepo = new StatsRepo({ engine: myh.engine });
            await myRepo.save(myh.handle, fromFs);
            const fromMysql = await myRepo.get(myh.handle);
            expect(fromMysql).toEqual(original);

            const fs2Repo = new StatsRepo({ engine: fsh2.engine });
            await fs2Repo.save(fsh2.handle, fromMysql);
            expect(await fs2Repo.get(fsh2.handle)).toEqual(original);
        } finally {
            fsh.cleanup();
            fsh2.cleanup();
            await myh.cleanup();
        }
    });

    test('SQLite → MySQL → SQLite preserves a stats doc with nested values', async () => {
        const sqh = await makeSqlite();
        const sqRepo = new StatsRepo({ engine: sqh.engine });
        const original = {
            'char-α.png': { user_msg_count: 3, total_gen_time: 4567, sessions: [{ id: 1 }, { id: 2 }] },
            '世界.png': { user_msg_count: 7, last_chat: null },
            timestamp: 1710000000,
        };
        await sqRepo.save(sqh.handle, original);
        const fromSqlite = await sqRepo.get(sqh.handle);

        const myh = await makeMysql();
        const sqh2 = await makeSqlite();
        try {
            const myRepo = new StatsRepo({ engine: myh.engine });
            await myRepo.save(myh.handle, fromSqlite);
            const fromMysql = await myRepo.get(myh.handle);
            expect(fromMysql).toEqual(original);

            const sq2Repo = new StatsRepo({ engine: sqh2.engine });
            await sq2Repo.save(sqh2.handle, fromMysql);
            expect(await sq2Repo.get(sqh2.handle)).toEqual(original);
        } finally {
            sqh.cleanup();
            sqh2.cleanup();
            await myh.cleanup();
        }
    });

    test('MySQL → FS preserves a stats doc', async () => {
        const myh = await makeMysql();
        const myRepo = new StatsRepo({ engine: myh.engine });
        const original = {
            'alice.png': { user_msg_count: 2 },
            timestamp: 1720000000,
            notes: null,
        };
        await myRepo.save(myh.handle, original);
        const fromMysql = await myRepo.get(myh.handle);

        const fsh = await makeFs();
        try {
            const fsRepo = new StatsRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, fromMysql);
            expect(await fsRepo.get(fsh.handle)).toEqual(original);
        } finally {
            fsh.cleanup();
            await myh.cleanup();
        }
    });
});

// ---- Chat (header + body, modulo integrity) ---------------------------------
//
// Chat records carry an engine-rotated `integrity` field (both at top level and
// embedded in `header.chat_metadata.integrity`). Each engine re-issues it on
// save, so cross-engine equality must strip it out via `stripChatEngineMeta` —
// same contract as the FS↔SQLite round-trip.

describeMysql('round-trip via MysqlEngine: ChatRepo', () => {
    test('FS → MySQL → FS preserves chat header and body', async () => {
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

        const myh = await makeMysql();
        const fsh2 = await makeFs();
        try {
            const myRepo = new ChatRepo({ engine: myh.engine });
            await myRepo.save(myh.handle, 'TestChar', 'chat1', fromFs.header, fromFs.body, null);
            const fromMysql = await myRepo.get(myh.handle, 'TestChar', 'chat1');
            expect(fromMysql.body).toEqual(body);
            expect(typeof fromMysql.integrity).toBe('string');
            expect(fromMysql.integrity.length).toBeGreaterThan(0);
            expect(stripChatEngineMeta(fromMysql)).toEqual(stripChatEngineMeta(fromFs));

            const fs2Repo = new ChatRepo({ engine: fsh2.engine });
            await fs2Repo.save(fsh2.handle, 'TestChar', 'chat1', fromMysql.header, fromMysql.body, null);
            const fromFs2 = await fs2Repo.get(fsh2.handle, 'TestChar', 'chat1');
            expect(fromFs2.body).toEqual(body);
            expect(stripChatEngineMeta(fromFs2)).toEqual(stripChatEngineMeta(fromFs));
        } finally {
            fsh.cleanup();
            fsh2.cleanup();
            await myh.cleanup();
        }
    });

    test('SQLite → MySQL → SQLite preserves chat header and body plus state sidecars', async () => {
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

        const myh = await makeMysql();
        const sqh2 = await makeSqlite();
        try {
            const myRepo = new ChatRepo({ engine: myh.engine });
            await myRepo.save(myh.handle, 'Char', 'c1', fromSqlite.header, fromSqlite.body, null);
            await myRepo.setState(myh.handle, 'Char', 'c1', 'memory-graph', fromSqliteMg);
            await myRepo.setState(myh.handle, 'Char', 'c1', 'floor-state', fromSqliteFloor);
            const fromMysql = await myRepo.get(myh.handle, 'Char', 'c1');
            expect(fromMysql.body).toEqual(body);
            expect(stripChatEngineMeta(fromMysql)).toEqual(stripChatEngineMeta(fromSqlite));
            expect(await myRepo.getState(myh.handle, 'Char', 'c1', 'memory-graph')).toEqual(mgDoc);
            expect(await myRepo.getState(myh.handle, 'Char', 'c1', 'floor-state')).toEqual(floorDoc);

            const sq2Repo = new ChatRepo({ engine: sqh2.engine });
            await sq2Repo.save(sqh2.handle, 'Char', 'c1', fromMysql.header, fromMysql.body, null);
            await sq2Repo.setState(sqh2.handle, 'Char', 'c1', 'memory-graph',
                await myRepo.getState(myh.handle, 'Char', 'c1', 'memory-graph'));
            await sq2Repo.setState(sqh2.handle, 'Char', 'c1', 'floor-state',
                await myRepo.getState(myh.handle, 'Char', 'c1', 'floor-state'));
            const fromSqlite2 = await sq2Repo.get(sqh2.handle, 'Char', 'c1');
            expect(fromSqlite2.body).toEqual(body);
            expect(stripChatEngineMeta(fromSqlite2)).toEqual(stripChatEngineMeta(fromSqlite));
            expect(await sq2Repo.getState(sqh2.handle, 'Char', 'c1', 'memory-graph')).toEqual(mgDoc);
            expect(await sq2Repo.getState(sqh2.handle, 'Char', 'c1', 'floor-state')).toEqual(floorDoc);
        } finally {
            sqh.cleanup();
            sqh2.cleanup();
            await myh.cleanup();
        }
    });

    test('MySQL → FS preserves chat header, body, and a group-chat record', async () => {
        const myh = await makeMysql();
        const myRepo = new ChatRepo({ engine: myh.engine });
        // Per-char chat
        const header = { user_name: 'User', chat_metadata: { foo: 'bar' } };
        const body = [
            { name: 'User', mes: 'first', is_user: true },
            { name: 'Char', mes: 'reply 世界', is_user: false },
        ];
        await myRepo.save(myh.handle, 'Char', 'c1', header, body, null);
        const fromMysql = await myRepo.get(myh.handle, 'Char', 'c1');
        // Group chat
        const groupHeader = { user_name: 'User', chat_metadata: { gc: true } };
        const groupBody = [{ name: 'User', mes: 'gm1' }];
        await myRepo.save(myh.handle, null, 'gc-1', groupHeader, groupBody, null, { isGroup: true, groupId: 'gc-1' });
        const fromMysqlGc = await myRepo.get(myh.handle, null, 'gc-1', { isGroup: true, groupId: 'gc-1' });

        const fsh = await makeFs();
        try {
            const fsRepo = new ChatRepo({ engine: fsh.engine });
            await fsRepo.save(fsh.handle, 'Char', 'c1', fromMysql.header, fromMysql.body, null);
            const fromFs = await fsRepo.get(fsh.handle, 'Char', 'c1');
            expect(fromFs.body).toEqual(body);
            expect(stripChatEngineMeta(fromFs)).toEqual(stripChatEngineMeta(fromMysql));

            fs.mkdirSync(fsh.dirs.groupChats, { recursive: true });
            await fsRepo.save(fsh.handle, null, 'gc-1', fromMysqlGc.header, fromMysqlGc.body, null,
                { isGroup: true, groupId: 'gc-1' });
            const fromFsGc = await fsRepo.get(fsh.handle, null, 'gc-1', { isGroup: true, groupId: 'gc-1' });
            expect(fromFsGc.body).toEqual(groupBody);
            expect(stripChatEngineMeta(fromFsGc)).toEqual(stripChatEngineMeta(fromMysqlGc));
        } finally {
            fsh.cleanup();
            await myh.cleanup();
        }
    });
});
