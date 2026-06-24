// Cross-engine round-trip matrix for the LAN-sync materializer.
/* eslint-disable jest/expect-expect */ // assertions live inside assertReadback
//
// `materialize.test.js` proves the contract on a single engine (sqlite).
// Spec 11 proves one combo (sqlite → mysql) end-to-end through git. Neither
// covers the architectural promise that the workdir intermediate is engine-
// neutral across every (src, dst) pair the orchestrator can actually pick
// in production: fs, sqlite, mysql, postgres → fs, sqlite, mysql, postgres.
//
// This file matrixes the contract over CONTRACT_HARNESSES × CONTRACT_HARNESSES.
// Each cell runs the same seedPayload (worlds, chats with sidecars, group
// chats, presets with sidecars, named-docs, settings, stats), pushes it
// through materialize → workdir → dematerialize using whichever code path
// the orchestrator would pick for that engine kind, and verifies via the
// destination engine's repository APIs.
//
// The `fs` engine has no materialize/dematerialize of its own — the
// orchestrator skips both calls and the live filesystem tree IS the
// workdir format. To exercise fs as a src/dst in this matrix without
// inventing fake APIs, the helper copies the engine's live tree to/from
// the workdir, matching exactly what `snapshotLiveToShadow` + reconcile
// do at the file-system level. SQL engines route through the real
// materialize/dematerialize calls.
//
// MySQL/Postgres harnesses are gated on LUKER_DISABLE_MYSQL_TESTS /
// LUKER_DISABLE_POSTGRES_TESTS the same way CONTRACT_HARNESSES gates
// them — when the local dev container isn't running, the gated rows of
// the matrix are absent rather than failing. The full matrix is exercised
// in any environment with both DBs available (developer machine, CI).

import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CONTRACT_HARNESSES } from '../storage/harness/contract-harness.js';
import { ChatRepo } from '../../src/storage/repositories/chat-repo.js';
import { GroupRepo } from '../../src/storage/repositories/group-repo.js';
import { NamedDocRepo } from '../../src/storage/repositories/named-doc-repo.js';
import { PresetRepo } from '../../src/storage/repositories/preset-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { StatsRepo } from '../../src/storage/repositories/stats-repo.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { recordsEqual } from '../../src/storage/migration/equality.js';

import {
    materializeUserDataIntoWorkdir,
    dematerializeWorkdirIntoUserData,
} from '../../src/sync/materialize.js';

const SQL_OWNED_CATEGORIES = [
    'chats', 'worlds',
    'openai-presets', 'novelai-presets', 'koboldai-presets', 'textgen-presets',
    'instruct', 'context', 'sysprompt', 'reasoning',
    'themes', 'movingUI', 'quickreplies',
    'settings', 'stats',
];

// Display names for user directories must match production exactly:
// SQL engines store records in DB tables, so their contract harnesses use
// the JS key name as the on-disk path (it's never read). But the materializer
// uses `directories[bucketKey]` to compute the workdir-relative path, and
// the fs engine's repo reads/writes those same path values. Production
// `getUserDirectories(handle)` maps both to the human-readable name from
// USER_DIRECTORY_TEMPLATE. Mirror that mapping here so the matrix sees
// the same layout regardless of which engine produced the workdir.
const USER_DIR_DISPLAY = Object.freeze({
    root: '',
    thumbnails: 'thumbnails',
    thumbnailsBg: 'thumbnails/bg',
    thumbnailsAvatar: 'thumbnails/avatar',
    thumbnailsPersona: 'thumbnails/persona',
    worlds: 'worlds',
    user: 'user',
    avatars: 'User Avatars',
    userImages: 'user/images',
    groups: 'groups',
    groupChats: 'group chats',
    chats: 'chats',
    characters: 'characters',
    backgrounds: 'backgrounds',
    novelAI_Settings: 'NovelAI Settings',
    koboldAI_Settings: 'KoboldAI Settings',
    openAI_Settings: 'OpenAI Settings',
    textGen_Settings: 'TextGen Settings',
    themes: 'themes',
    movingUI: 'movingUI',
    extensions: 'extensions',
    instruct: 'instruct',
    context: 'context',
    quickreplies: 'QuickReplies',
    assets: 'assets',
    comfyWorkflows: 'user/workflows',
    files: 'user/files',
    vectors: 'vectors',
    backups: 'backups',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
    cardApps: 'card-apps',
});

function mkTmpWorkdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'luker-cross-engine-'));
}

// The MySQL/Postgres contract harnesses flatten every USER_DIRS key as a
// sibling under a single stub root because the engine itself never reads
// those paths — the records live in DB tables. The materializer DOES read
// `directories.root` and the per-bucket dirs together: `relUnder(root, bucket)`
// must yield a path UNDER root for `path.join(workdir, rel)` to land inside
// the workdir. So this helper rebuilds `dirs` with the production shape
// (each bucket nested as a child of `root`, using the production display
// names) on a fresh temp tree, leaves the engine untouched, and patches
// `cleanup` to remove both. Sqlite/fs harnesses already use the nested
// production-shape layout; for them this is a no-op pass-through.
function withNestedDirs(harness) {
    const flat = harness.dirs;
    const flatRoot = flat.root;
    const nested = Object.entries(flat).every(([key, abs]) =>
        key === 'root' || (typeof abs === 'string' && abs.startsWith(flatRoot + path.sep)));
    if (nested) return harness;

    const newDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-nested-dirs-'));
    const userDir = path.join(newDataRoot, harness.handle || 'u');
    const dirsOut = { root: userDir };
    for (const key of Object.keys(flat)) {
        if (key === 'root') continue;
        const rel = USER_DIR_DISPLAY[key];
        if (typeof rel !== 'string') {
            // Pass-through anything not in the production template.
            dirsOut[key] = flat[key];
            continue;
        }
        dirsOut[key] = path.join(userDir, rel);
    }
    fs.mkdirSync(userDir, { recursive: true });
    const innerCleanup = harness.cleanup;
    return {
        ...harness,
        dirs: dirsOut,
        cleanup: async () => {
            await innerCleanup();
            fs.rmSync(newDataRoot, { recursive: true, force: true });
        },
    };
}

/**
 * Seed a representative slice of every SQL-owned category on the harness's
 * engine. Returns the canonical-shape expected payload so the assertion
 * pass can compare against it without re-reading the source engine (which
 * could mask "src and dst both look broken in the same way" by reading
 * the broken value from src too).
 */
async function seedPayload(harness) {
    const { engine, handle, dirs } = harness;
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

    const settingsDoc = {
        user_avatar: 'a.png',
        power_user: { theme: 'dark', font_scale: 1.1 },
    };
    await settings.save(handle, settingsDoc);

    const openaiCreative = { temperature: 0.7, top_p: 0.95, freq_penalty: 0.1 };
    const textgenLocal = { instruct_mode: 'mistral', context_size: 8192 };
    const instructProfile = { name: 'Roleplay', wrap: true, input_sequence: '### Instruction:' };
    await preset.save(handle, 'openai', 'creative', openaiCreative);
    await preset.save(handle, 'textgenerationwebui', 'local', textgenLocal);
    await preset.save(handle, 'instruct', 'roleplay', instructProfile);
    const presetState = { iter_lib: { nodes: ['n1', 'n2'], cursor: 1 } };
    await preset.setState(handle, 'openai', 'creative', 'iter_lib', presetState);

    const worldDoc = {
        name: 'Lore',
        entries: {
            '0': {
                uid: 0,
                key: ['lore key'],
                keysecondary: [],
                content: 'matrix verifies cross-engine round-trip',
                constant: false,
                order: 100,
                position: 0,
                disable: false,
            },
        },
    };
    await world.save(handle, 'Lore', worldDoc);

    const groupDoc = {
        id: 'grp-1',
        name: 'Crew',
        members: ['alice.png', 'bob.png'],
        chats: ['gc-1'],
        chat_metadata: { variables: { round: 0 } },
    };
    await group.save(handle, 'grp-1', groupDoc);
    await chat.save(
        handle, null, 'gc-1',
        { user_name: 'U', chat_metadata: { variables: { round: 0 } } },
        [
            { name: 'U', mes: 'group hello', is_user: true },
            { name: 'Alice', mes: 'reply from alice', is_user: false },
        ],
        null,
        { isGroup: true, groupId: 'gc-1' },
    );

    await chat.save(
        handle, 'Alice', 'c1',
        {
            user_name: 'U',
            chat_metadata: { foo: 'bar', variables: { score: 42 } },
        },
        [
            { name: 'U', mes: 'hi', is_user: true },
            { name: 'Alice', mes: 'hello', is_user: false, extra: { gen_id: 'g1', model: 'opus' } },
        ],
        null,
    );
    await chat.setState(handle, 'Alice', 'c1', 'memory-graph', {
        nodes: ['root', 'child'],
        edges: [{ from: 'root', to: 'child' }],
    });
    await chat.setState(handle, 'Alice', 'c1', 'iter_studio', {
        sessions: [{ id: 's1', label: 'attempt 1' }],
    });

    const themeDoc = { name: 'midnight', vars: { '--bg': '#000', '--fg': '#fff' } };
    const movingDoc = { left: 10, top: 20, width: 400 };
    const qrDoc = { sets: [{ name: 'greetings', items: ['hi', 'hello'] }] };
    await named.save(handle, 'themes', 'midnight', themeDoc);
    await named.save(handle, 'movingUI', 'panel', movingDoc);
    await named.save(handle, 'quickReplies', 'qrset', qrDoc);

    const statsDoc = {
        'alice.png': { user_msg_count: 7, total_tokens: 1234 },
        timestamp: 1700000000,
    };
    await stats.save(handle, statsDoc);

    // Snapshot via the source engine's own reads so chat integrity tokens
    // reflect what landed; non-chat reads are byte-equal to the input.
    return {
        settings: settingsDoc,
        presets: { openaiCreative, textgenLocal, instructProfile },
        presetState,
        world: worldDoc,
        group: groupDoc,
        groupChat: await chat.get(handle, null, 'gc-1', { isGroup: true, groupId: 'gc-1' }),
        chatAliceC1: await chat.get(handle, 'Alice', 'c1'),
        chatAliceC1Mg: await chat.getState(handle, 'Alice', 'c1', 'memory-graph'),
        chatAliceC1Iter: await chat.getState(handle, 'Alice', 'c1', 'iter_studio'),
        themes: { midnight: themeDoc },
        moving: { panel: movingDoc },
        quickReplies: { qrset: qrDoc },
        stats: statsDoc,
    };
}

/**
 * For fs engines the orchestrator passes `liveRoot: dirs.root` directly to
 * `snapshotLiveToShadow`; the workdir is THEN populated by the snapshot
 * walker. This helper mirrors that step at the file-system level so the
 * matrix can treat fs and SQL engines symmetrically.
 */
function copyTree(src, dst) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyTree(s, d);
        } else if (entry.isFile()) {
            fs.copyFileSync(s, d);
        }
    }
}

async function materializeForKind(harness, workdir, categories) {
    if (harness.kind === 'fs') {
        // Same path the orchestrator takes: live tree IS the workdir layout.
        copyTree(harness.dirs.root, workdir);
        return;
    }
    await materializeUserDataIntoWorkdir({
        handle: harness.handle,
        directories: harness.dirs,
        categories,
        workdir,
        engine: harness.engine,
    });
}

async function dematerializeForKind(harness, workdir, categories) {
    if (harness.kind === 'fs') {
        // Same path the orchestrator takes for fs: reconcile blits the
        // workdir tree into the live root. Mirror that here so the
        // engine's repo APIs find the records on read.
        copyTree(workdir, harness.dirs.root);
        return;
    }
    await dematerializeWorkdirIntoUserData({
        handle: harness.handle,
        directories: harness.dirs,
        categories,
        workdir,
        engine: harness.engine,
    });
}

/**
 * Assert the destination engine — after the round-trip — returns the
 * expected payload through its public repo APIs. Reading through the
 * repo (not poking the engine's internal table) is what proves the
 * dematerialize landed in storage the engine considers real.
 */
async function assertReadback(dst, expected) {
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
    expect(await dstPreset.get(dst.handle, 'instruct', 'roleplay')).toEqual(expected.presets.instructProfile);
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
    expect(await dstChat.getState(dst.handle, 'Alice', 'c1', 'iter_studio')).toEqual(expected.chatAliceC1Iter);

    const gc1 = await dstChat.get(dst.handle, null, 'gc-1', { isGroup: true, groupId: 'gc-1' });
    expect(recordsEqual('chat', gc1, expected.groupChat)).toBe(true);

    // Generated columns / extracted-field indices: chats use header.chat_metadata.integrity
    // as a GENERATED column on MySQL / Postgres (and json_extract on SQLite). If the engine
    // can't parse the JSON shape this side wrote, listAll's filter by that index returns the
    // wrong set. Sweeping listAll exercises that index for the chat we just wrote.
    const allChats = await dstChat.listAll(dst.handle);
    const aliceKey = allChats.find(e => e.key.charDir === 'Alice' && e.key.name === 'c1');
    expect(aliceKey).toBeDefined();
    const groupKey = allChats.find(e => e.key.isGroup && e.key.name === 'gc-1');
    expect(groupKey).toBeDefined();

    // Verify listNames on worlds + list on groups reach the same records,
    // catching any per-engine list-vs-get split brain. GroupRepo.list
    // returns `[{key: {id}, ...}]` — its row shape mirrors the underlying
    // listResources contract, not the doc shape.
    const worldNames = await dstWorld.listNames(dst.handle);
    expect(worldNames).toContain('Lore');
    const groupAll = await dstGroup.list(dst.handle);
    expect(groupAll.find(g => g?.key?.id === 'grp-1')).toBeDefined();
}

// Matrix dispatch: every (src, dst) pair across CONTRACT_HARNESSES. The
// outer describe.each runs once per source engine; the inner one runs once
// per destination engine. Each cell gets a fresh src+dst harness pair so a
// crash in one cell doesn't leak engine state into the next.
describe.each(CONTRACT_HARNESSES)('cross-engine round-trip — src=$name', ({ name: srcName, make: makeSrc }) => {
    describe.each(CONTRACT_HARNESSES)('dst=$name', ({ name: dstName, make: makeDst }) => {
        // The (fs, fs) cell is uninteresting (file copy in, file copy out)
        // and doesn't exercise materialize/dematerialize at all. It's still
        // included for matrix completeness — if fs ever stops being a pure
        // pass-through, the cell will catch the regression.
        test(`seed on ${srcName}, materialize → workdir → dematerialize into ${dstName}, read back via repo APIs`, async () => {
            const src = withNestedDirs(await makeSrc());
            const dst = withNestedDirs(await makeDst());
            const workdir = mkTmpWorkdir();
            try {
                const expected = await seedPayload(src);
                await materializeForKind(src, workdir, SQL_OWNED_CATEGORIES);
                await dematerializeForKind(dst, workdir, SQL_OWNED_CATEGORIES);
                await assertReadback(dst, expected);
            } finally {
                await src.cleanup();
                await dst.cleanup();
                fs.rmSync(workdir, { recursive: true, force: true });
            }
        }, 60_000);
    });
});
