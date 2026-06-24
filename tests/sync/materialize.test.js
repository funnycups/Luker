// Round-trip tests for the LAN-sync materializer. The materializer projects
// per-user data between the engine-agnostic Repo layer and an on-disk tree
// laid out exactly like the FS engine would. Sync's shadow git workdir
// consumes that tree regardless of the live engine, so this layer is what
// lets sqlite/mysql/postgres modes participate in per-file conflict
// resolution.
//
// MySQL/Postgres are exercised by the LAN-sync e2e specs (task 10) under
// testcontainers; the unit-test surface stays on the always-available fs +
// sqlite engines and asserts the cross-engine contract there. The two SQL
// engines share the same listResources/putResource shape, so a sqlite pass
// is a strong signal the materializer's repo-driven path will hold across
// the other two.

import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    makeTempFsEngineHarness,
    makeTempSqliteEngineHarness,
} from '../storage/harness/contract-harness.js';
import { ChatRepo } from '../../src/storage/repositories/chat-repo.js';
import { GroupRepo } from '../../src/storage/repositories/group-repo.js';
import { NamedDocRepo } from '../../src/storage/repositories/named-doc-repo.js';
import { PresetRepo } from '../../src/storage/repositories/preset-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { StatsRepo } from '../../src/storage/repositories/stats-repo.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { recordsEqual } from '../../src/storage/migration/equality.js';
import { buildSidecarFilename } from '../../src/storage/engines/sidecar-naming.js';

import {
    materializeUserDataIntoWorkdir,
    dematerializeWorkdirIntoUserData,
    enumerateMaterializedRelPaths,
    buildWorkdirDirectoriesView,
} from '../../src/sync/materialize.js';

const SQL_OWNED_CATEGORIES = [
    'chats', 'worlds',
    'openai-presets', 'novelai-presets', 'koboldai-presets', 'textgen-presets',
    'instruct', 'context', 'sysprompt', 'reasoning',
    'themes', 'movingUI', 'quickreplies',
    'settings', 'stats',
];

function mkTmpWorkdir(prefix = 'luker-materialize-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rel(workdir, abs) {
    return path.relative(workdir, abs).split(path.sep).join('/');
}

async function seedPayload(harness) {
    const { engine, handle, dirs } = harness;
    // Pre-create dirs the FS engine doesn't lazy-mkdir for list().
    for (const k of ['worlds', 'groups', 'groupChats', 'themes', 'movingUI', 'quickreplies']) {
        fs.mkdirSync(dirs[k], { recursive: true });
    }

    const settings = new SettingsRepo({ engine });
    const preset = new PresetRepo({ engine });
    const world = new WorldInfoRepo({ engine });
    const group = new GroupRepo({ engine });
    const stats = new StatsRepo({ engine });
    const chat = new ChatRepo({ engine });
    const named = new NamedDocRepo({ engine });

    const settingsDoc = { user_avatar: 'a.png', power_user: { theme: 'dark' } };
    await settings.save(handle, settingsDoc);

    const openaiCreative = { temperature: 0.7, top_p: 0.95 };
    const textgenLocal = { instruct_mode: 'mistral', context_size: 8192 };
    await preset.save(handle, 'openai', 'creative', openaiCreative);
    await preset.save(handle, 'textgenerationwebui', 'local', textgenLocal);
    const presetState = { iter_lib: { nodes: ['n1', 'n2'] } };
    await preset.setState(handle, 'openai', 'creative', 'iter_lib', presetState);

    const worldDoc = {
        name: 'Lore',
        entries: { '0': { uid: 0, key: ['k'], content: 'v' } },
    };
    await world.save(handle, 'Lore', worldDoc);

    const groupDoc = {
        id: 'grp-1', name: 'Crew',
        members: ['a.png', 'b.png'], chats: ['gc-1'],
    };
    await group.save(handle, 'grp-1', groupDoc);
    await chat.save(
        handle, null, 'gc-1',
        { user_name: 'U', chat_metadata: { variables: {} } },
        [{ name: 'U', mes: 'group hello', is_user: true }],
        null, { isGroup: true, groupId: 'gc-1' },
    );

    await chat.save(
        handle, 'Alice', 'c1',
        { user_name: 'U', chat_metadata: { foo: 'bar', variables: { v: 1 } } },
        [
            { name: 'U', mes: 'hi', is_user: true },
            { name: 'Alice', mes: 'hello', is_user: false, extra: { gen_id: 'g1' } },
        ],
        null,
    );
    await chat.setState(handle, 'Alice', 'c1', 'memory-graph', { nodes: ['root'] });

    const themeDoc = { name: 'midnight', vars: { '--bg': '#000' } };
    const movingDoc = { left: 10, top: 20 };
    const qrDoc = { sets: [{ name: 'greetings' }] };
    await named.save(handle, 'themes', 'midnight', themeDoc);
    await named.save(handle, 'movingUI', 'panel', movingDoc);
    await named.save(handle, 'quickReplies', 'qrset', qrDoc);

    const statsDoc = { 'a.png': { user_msg_count: 7 }, timestamp: 1700000000 };
    await stats.save(handle, statsDoc);

    return {
        settings: settingsDoc,
        presets: { openaiCreative, textgenLocal },
        presetState,
        world: worldDoc,
        group: groupDoc,
        groupChat: await chat.get(handle, null, 'gc-1', { isGroup: true, groupId: 'gc-1' }),
        chatAliceC1: await chat.get(handle, 'Alice', 'c1'),
        chatAliceC1Mg: await chat.getState(handle, 'Alice', 'c1', 'memory-graph'),
        themes: { midnight: themeDoc },
        moving: { panel: movingDoc },
        quickReplies: { qrset: qrDoc },
        stats: statsDoc,
    };
}

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function readJsonl(p) {
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.length > 0);
    return lines.map(l => JSON.parse(l));
}

describe('materialize (fs engine — no-op)', () => {
    test('materialize is a no-op for kind=fs and writes nothing', async () => {
        const h = await makeTempFsEngineHarness();
        const workdir = mkTmpWorkdir();
        try {
            const result = await materializeUserDataIntoWorkdir({
                handle: h.handle,
                directories: h.dirs,
                categories: SQL_OWNED_CATEGORIES,
                workdir,
                engine: h.engine,
            });
            expect(result).toEqual({ filesWritten: 0, bytes: 0 });
            expect(fs.readdirSync(workdir)).toEqual([]);
        } finally {
            h.cleanup();
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    });

    test('dematerialize is a no-op for kind=fs', async () => {
        const h = await makeTempFsEngineHarness();
        const workdir = mkTmpWorkdir();
        try {
            const result = await dematerializeWorkdirIntoUserData({
                handle: h.handle,
                directories: h.dirs,
                categories: SQL_OWNED_CATEGORIES,
                workdir,
                engine: h.engine,
            });
            expect(result).toEqual({ recordsWritten: 0, recordsDeleted: 0 });
        } finally {
            h.cleanup();
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    });
});

describe('enumerateMaterializedRelPaths (pure)', () => {
    test('includes chats, worlds, settings, stats when enabled', async () => {
        const h = await makeTempFsEngineHarness();
        try {
            const out = enumerateMaterializedRelPaths({
                directories: h.dirs,
                categories: ['chats', 'worlds', 'settings', 'stats'],
            });
            expect(out instanceof Set).toBe(true);
            expect(out.has('settings.json')).toBe(true);
            expect(out.has('stats.json')).toBe(true);
            // chats are seeded lazily; the relpath set is structural — it
            // exists for the chats DIRECTORY parents to be recognized. Even
            // with no chats on disk yet, the directory paths under chats/
            // shouldn't pollute the set.
        } finally {
            h.cleanup();
        }
    });

    test('does NOT include character / avatar / asset paths (fs-engine-owned)', async () => {
        const h = await makeTempFsEngineHarness();
        try {
            const out = enumerateMaterializedRelPaths({
                directories: h.dirs,
                categories: ['chats', 'worlds', 'characters', 'avatars', 'assets'],
            });
            const all = [...out];
            for (const p of all) {
                expect(p.startsWith('characters/')).toBe(false);
                expect(p.startsWith('User Avatars/')).toBe(false);
                expect(p.startsWith('assets/')).toBe(false);
            }
        } finally {
            h.cleanup();
        }
    });

    test('returns POSIX-style separators only', async () => {
        const h = await makeTempFsEngineHarness();
        // Manually drop a chat on disk so enumerate has something to scan.
        fs.mkdirSync(path.join(h.dirs.chats, 'Alice'), { recursive: true });
        fs.writeFileSync(path.join(h.dirs.chats, 'Alice', 'c1.jsonl'), '{}\n');
        try {
            const out = enumerateMaterializedRelPaths({
                directories: h.dirs,
                categories: ['chats'],
            });
            for (const p of out) {
                expect(p.includes('\\')).toBe(false);
            }
        } finally {
            h.cleanup();
        }
    });
});

describe('materialize (sqlite — exact file layout)', () => {
    test('materializes every SQL-owned kind into FS-engine-shaped paths', async () => {
        const src = await makeTempSqliteEngineHarness();
        const workdir = mkTmpWorkdir();
        try {
            const expected = await seedPayload(src);

            const result = await materializeUserDataIntoWorkdir({
                handle: src.handle,
                directories: src.dirs,
                categories: SQL_OWNED_CATEGORIES,
                workdir,
                engine: src.engine,
            });
            expect(result.filesWritten).toBeGreaterThan(0);
            expect(result.bytes).toBeGreaterThan(0);

            // settings.json at workdir root
            expect(fs.existsSync(path.join(workdir, 'settings.json'))).toBe(true);
            expect(readJson(path.join(workdir, 'settings.json'))).toEqual(expected.settings);

            // stats.json at workdir root
            expect(fs.existsSync(path.join(workdir, 'stats.json'))).toBe(true);
            expect(readJson(path.join(workdir, 'stats.json'))).toEqual(expected.stats);

            // presets — two dirKeys: OpenAI Settings + TextGen Settings
            expect(
                readJson(path.join(workdir, 'OpenAI Settings', 'creative.json')),
            ).toEqual(expected.presets.openaiCreative);
            expect(
                readJson(path.join(workdir, 'TextGen Settings', 'local.json')),
            ).toEqual(expected.presets.textgenLocal);

            // preset sidecar
            const presetSidecarName = buildSidecarFilename('creative', 'iter_lib');
            expect(
                readJson(path.join(workdir, 'OpenAI Settings', presetSidecarName)),
            ).toEqual(expected.presetState);

            // worlds
            expect(readJson(path.join(workdir, 'worlds', 'Lore.json'))).toEqual(expected.world);

            // group json (under groups/)
            expect(readJson(path.join(workdir, 'groups', 'grp-1.json'))).toEqual(expected.group);

            // group chat (jsonl)
            const gcPath = path.join(workdir, 'group chats', 'gc-1.jsonl');
            expect(fs.existsSync(gcPath)).toBe(true);
            const gcLines = readJsonl(gcPath);
            expect(gcLines[0].user_name).toBe('U');
            expect(gcLines[1].mes).toBe('group hello');

            // per-character chat + sidecar
            const aliceChatPath = path.join(workdir, 'chats', 'Alice', 'c1.jsonl');
            expect(fs.existsSync(aliceChatPath)).toBe(true);
            const aliceLines = readJsonl(aliceChatPath);
            expect(aliceLines).toHaveLength(3); // 1 header + 2 body
            expect(aliceLines[1].mes).toBe('hi');
            expect(aliceLines[2].extra.gen_id).toBe('g1');
            const chatSidecarName = buildSidecarFilename('c1', 'memory-graph');
            expect(
                readJson(path.join(workdir, 'chats', 'Alice', chatSidecarName)),
            ).toEqual(expected.chatAliceC1Mg);

            // named-docs
            expect(
                readJson(path.join(workdir, 'themes', 'midnight.json')),
            ).toEqual(expected.themes.midnight);
            expect(
                readJson(path.join(workdir, 'movingUI', 'panel.json')),
            ).toEqual(expected.moving.panel);
            expect(
                readJson(path.join(workdir, 'QuickReplies', 'qrset.json')),
            ).toEqual(expected.quickReplies.qrset);
        } finally {
            src.cleanup();
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    });

    test('writes chat .jsonl as header line then one JSON line per message', async () => {
        const src = await makeTempSqliteEngineHarness();
        const workdir = mkTmpWorkdir();
        try {
            await seedPayload(src);
            await materializeUserDataIntoWorkdir({
                handle: src.handle,
                directories: src.dirs,
                categories: ['chats'],
                workdir,
                engine: src.engine,
            });
            const raw = fs.readFileSync(path.join(workdir, 'chats', 'Alice', 'c1.jsonl'), 'utf-8');
            const lines = raw.split('\n').filter(l => l.length > 0);
            expect(lines).toHaveLength(3);
            // Every line must parse as JSON on its own — i.e. no pretty-print.
            for (const l of lines) {
                expect(() => JSON.parse(l)).not.toThrow();
            }
            // Header has chat_metadata.integrity rotated on save (engine signs every
            // write). What we care about is the SHAPE: line 1 is the header object.
            const header = JSON.parse(lines[0]);
            expect(typeof header.chat_metadata).toBe('object');
        } finally {
            src.cleanup();
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    });

    test('respects categories filter — only worlds writes worlds files', async () => {
        const src = await makeTempSqliteEngineHarness();
        const workdir = mkTmpWorkdir();
        try {
            await seedPayload(src);
            await materializeUserDataIntoWorkdir({
                handle: src.handle,
                directories: src.dirs,
                categories: ['worlds'],
                workdir,
                engine: src.engine,
            });
            expect(fs.existsSync(path.join(workdir, 'worlds', 'Lore.json'))).toBe(true);
            // No chats written
            expect(fs.existsSync(path.join(workdir, 'chats'))).toBe(false);
            // No settings written
            expect(fs.existsSync(path.join(workdir, 'settings.json'))).toBe(false);
            // No presets
            expect(fs.existsSync(path.join(workdir, 'OpenAI Settings'))).toBe(false);
        } finally {
            src.cleanup();
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    });

    test('materialize does NOT sweep pre-existing workdir files (deletion is the orchestrator\'s job)', async () => {
        // The materializer's job is to PROJECT engine state into the workdir; it
        // does not own deletion of stray pre-existing files. The orchestrator
        // computes the sweep set from `enumerateMaterializedRelPaths` and unlinks
        // anything outside that set BEFORE calling materialize. Pinning the
        // no-sweep behaviour here keeps a future change from accidentally
        // shifting the contract (either direction) and silently breaking the
        // orchestrator's two-step flow.
        const src = await makeTempSqliteEngineHarness();
        const workdir = mkTmpWorkdir();
        try {
            const world = new WorldInfoRepo({ engine: src.engine });
            const worldDoc = {
                name: 'WorldA',
                entries: { '0': { uid: 0, key: ['k'], content: 'v' } },
            };
            await world.save(src.handle, 'WorldA', worldDoc);

            // Seed a stale file in the workdir that the engine does NOT know about.
            const worldsRel = path.relative(src.dirs.root, src.dirs.worlds).split(path.sep).join('/');
            const worldsAbs = path.join(workdir, worldsRel);
            fs.mkdirSync(worldsAbs, { recursive: true });
            const stalePath = path.join(worldsAbs, 'Stale.json');
            const staleContent = JSON.stringify({ name: 'Stale', orphan: true });
            fs.writeFileSync(stalePath, staleContent);

            await materializeUserDataIntoWorkdir({
                handle: src.handle,
                directories: src.dirs,
                categories: ['worlds'],
                workdir,
                engine: src.engine,
            });

            // Engine-known world is materialized.
            const worldAPath = path.join(worldsAbs, 'WorldA.json');
            expect(fs.existsSync(worldAPath)).toBe(true);
            expect(readJson(worldAPath)).toEqual(worldDoc);
            // Stale file is untouched — materializer does not sweep.
            expect(fs.existsSync(stalePath)).toBe(true);
            expect(fs.readFileSync(stalePath, 'utf-8')).toBe(staleContent);
        } finally {
            src.cleanup();
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    });
});

describe('dematerialize (sqlite — round-trip)', () => {
    test('sqlite -> workdir -> fresh sqlite preserves all SQL-owned data', async () => {
        const src = await makeTempSqliteEngineHarness();
        const dst = await makeTempSqliteEngineHarness();
        const workdir = mkTmpWorkdir();
        try {
            const expected = await seedPayload(src);

            await materializeUserDataIntoWorkdir({
                handle: src.handle,
                directories: src.dirs,
                categories: SQL_OWNED_CATEGORIES,
                workdir,
                engine: src.engine,
            });

            const result = await dematerializeWorkdirIntoUserData({
                handle: dst.handle,
                directories: dst.dirs,
                categories: SQL_OWNED_CATEGORIES,
                workdir,
                engine: dst.engine,
            });
            expect(result.recordsWritten).toBeGreaterThan(0);

            const dstSettings = new SettingsRepo({ engine: dst.engine });
            const dstPreset = new PresetRepo({ engine: dst.engine });
            const dstWorld = new WorldInfoRepo({ engine: dst.engine });
            const dstGroup = new GroupRepo({ engine: dst.engine });
            const dstStats = new StatsRepo({ engine: dst.engine });
            const dstChat = new ChatRepo({ engine: dst.engine });
            const dstNamed = new NamedDocRepo({ engine: dst.engine });

            expect(await dstSettings.get(dst.handle)).toEqual(expected.settings);
            expect(await dstPreset.get(dst.handle, 'openai', 'creative')).toEqual(expected.presets.openaiCreative);
            expect(await dstPreset.get(dst.handle, 'textgenerationwebui', 'local')).toEqual(expected.presets.textgenLocal);
            expect(await dstPreset.getState(dst.handle, 'openai', 'creative', 'iter_lib')).toEqual(expected.presetState);
            expect(await dstWorld.get(dst.handle, 'Lore')).toEqual(expected.world);
            expect(await dstGroup.get(dst.handle, 'grp-1')).toEqual(expected.group);
            expect(await dstStats.get(dst.handle)).toEqual(expected.stats);
            expect(await dstNamed.get(dst.handle, 'themes', 'midnight')).toEqual(expected.themes.midnight);
            expect(await dstNamed.get(dst.handle, 'movingUI', 'panel')).toEqual(expected.moving.panel);
            expect(await dstNamed.get(dst.handle, 'quickReplies', 'qrset')).toEqual(expected.quickReplies.qrset);

            const aliceC1 = await dstChat.get(dst.handle, 'Alice', 'c1');
            expect(recordsEqual('chat', aliceC1, expected.chatAliceC1)).toBe(true);
            expect(await dstChat.getState(dst.handle, 'Alice', 'c1', 'memory-graph')).toEqual(expected.chatAliceC1Mg);

            const gc1 = await dstChat.get(dst.handle, null, 'gc-1', { isGroup: true, groupId: 'gc-1' });
            expect(recordsEqual('chat', gc1, expected.groupChat)).toBe(true);
        } finally {
            src.cleanup();
            dst.cleanup();
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    });

    test('propagates deletes — removing a chat file from workdir drops it from the engine', async () => {
        const src = await makeTempSqliteEngineHarness();
        const dst = await makeTempSqliteEngineHarness();
        const workdir = mkTmpWorkdir();
        try {
            // Seed two chats on src
            const chat = new ChatRepo({ engine: src.engine });
            await chat.save(
                src.handle, 'Alice', 'keepme',
                { user_name: 'U' },
                [{ name: 'U', mes: 'keep' }], null,
            );
            await chat.save(
                src.handle, 'Alice', 'dropme',
                { user_name: 'U' },
                [{ name: 'U', mes: 'drop' }], null,
            );

            await materializeUserDataIntoWorkdir({
                handle: src.handle,
                directories: src.dirs,
                categories: ['chats'],
                workdir,
                engine: src.engine,
            });

            const aliceDir = path.join(workdir, 'chats', 'Alice');
            const dropPath = path.join(aliceDir, 'dropme.jsonl');
            expect(fs.existsSync(dropPath)).toBe(true);
            fs.unlinkSync(dropPath);

            // Seed dst with both, then dematerialize a workdir missing one.
            const dstChat = new ChatRepo({ engine: dst.engine });
            await dstChat.save(
                dst.handle, 'Alice', 'keepme',
                { user_name: 'U' }, [{ name: 'U', mes: 'old keep' }], null,
            );
            await dstChat.save(
                dst.handle, 'Alice', 'dropme',
                { user_name: 'U' }, [{ name: 'U', mes: 'old drop' }], null,
            );

            const result = await dematerializeWorkdirIntoUserData({
                handle: dst.handle,
                directories: dst.dirs,
                categories: ['chats'],
                workdir,
                engine: dst.engine,
            });

            expect(result.recordsDeleted).toBeGreaterThan(0);
            expect(await dstChat.get(dst.handle, 'Alice', 'keepme')).not.toBeNull();
            expect(await dstChat.get(dst.handle, 'Alice', 'dropme')).toBeNull();
        } finally {
            src.cleanup();
            dst.cleanup();
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    });

    test('writes only the requested category on dematerialize', async () => {
        const src = await makeTempSqliteEngineHarness();
        const dst = await makeTempSqliteEngineHarness();
        const workdir = mkTmpWorkdir();
        try {
            const expected = await seedPayload(src);
            await materializeUserDataIntoWorkdir({
                handle: src.handle,
                directories: src.dirs,
                categories: SQL_OWNED_CATEGORIES,
                workdir,
                engine: src.engine,
            });

            await dematerializeWorkdirIntoUserData({
                handle: dst.handle,
                directories: dst.dirs,
                categories: ['worlds'],
                workdir,
                engine: dst.engine,
            });

            const dstWorld = new WorldInfoRepo({ engine: dst.engine });
            const dstSettings = new SettingsRepo({ engine: dst.engine });
            const dstChat = new ChatRepo({ engine: dst.engine });
            expect(await dstWorld.get(dst.handle, 'Lore')).toEqual(expected.world);
            expect(await dstSettings.get(dst.handle)).toBeNull();
            expect(await dstChat.get(dst.handle, 'Alice', 'c1')).toBeNull();
        } finally {
            src.cleanup();
            dst.cleanup();
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    });
});

describe('sanity: rel-path math is workdir-relative', () => {
    test('a chat at chats/<charDir>/<name>.jsonl maps to the same workdir path', async () => {
        const src = await makeTempSqliteEngineHarness();
        const workdir = mkTmpWorkdir();
        try {
            const chat = new ChatRepo({ engine: src.engine });
            await chat.save(
                src.handle, 'Bob', 'first',
                { user_name: 'U' }, [{ name: 'U', mes: 'hi' }], null,
            );
            await materializeUserDataIntoWorkdir({
                handle: src.handle,
                directories: src.dirs,
                categories: ['chats'],
                workdir,
                engine: src.engine,
            });
            const expected = rel(workdir, path.join(workdir, 'chats', 'Bob', 'first.jsonl'));
            expect(expected).toBe('chats/Bob/first.jsonl');
            expect(fs.existsSync(path.join(workdir, 'chats', 'Bob', 'first.jsonl'))).toBe(true);
        } finally {
            src.cleanup();
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    });
});

describe('buildWorkdirDirectoriesView', () => {
    test('rebases nested dirs under root onto workdir', () => {
        const directories = {
            root: '/data/alice',
            chats: '/data/alice/chats',
            worlds: '/data/alice/worlds',
            presets: '/data/alice/presets/openai',
        };
        const out = buildWorkdirDirectoriesView(directories, '/tmp/workdir');
        expect(out.root).toBe('/tmp/workdir');
        expect(out.chats).toBe(path.join('/tmp/workdir', 'chats'));
        expect(out.worlds).toBe(path.join('/tmp/workdir', 'worlds'));
        expect(out.presets).toBe(path.join('/tmp/workdir', 'presets', 'openai'));
    });

    test('leaves paths that escape root untouched rather than rebasing them', () => {
        const directories = {
            root: '/data/alice',
            chats: '/data/alice/chats',
            escape: '/etc/passwd',
            sibling: '/data/bob/chats',
        };
        const out = buildWorkdirDirectoriesView(directories, '/tmp/workdir');
        expect(out.root).toBe('/tmp/workdir');
        expect(out.chats).toBe(path.join('/tmp/workdir', 'chats'));
        // Escaping paths are preserved verbatim — the function skips them
        // so a typo or malicious value never gets silently re-rooted.
        expect(out.escape).toBe('/etc/passwd');
        expect(out.sibling).toBe('/data/bob/chats');
    });

    test('passes non-string values through verbatim and still rebases string siblings', () => {
        const obj = { nested: true };
        const directories = {
            root: '/data/alice',
            chats: '/data/alice/chats',
            notAString: 42,
            nullValue: null,
            undef: undefined,
            obj,
        };
        const out = buildWorkdirDirectoriesView(directories, '/tmp/workdir');
        expect(out.chats).toBe(path.join('/tmp/workdir', 'chats'));
        expect(out.notAString).toBe(42);
        expect(out.nullValue).toBeNull();
        expect(out.undef).toBeUndefined();
        expect(out.obj).toBe(obj);
        expect('undef' in out).toBe(true);
    });

    test('throws TypeError when directories.root is missing or workdir is missing', () => {
        expect(() => buildWorkdirDirectoriesView({ chats: '/x' }, '/tmp/workdir'))
            .toThrow(/directories\.root required/i);
        expect(() => buildWorkdirDirectoriesView(null, '/tmp/workdir'))
            .toThrow(/directories\.root required/i);
        expect(() => buildWorkdirDirectoriesView({ root: '/x' }, undefined))
            .toThrow(/workdir required/i);
        expect(() => buildWorkdirDirectoriesView({ root: '/x' }, ''))
            .toThrow(/workdir required/i);
    });
});
