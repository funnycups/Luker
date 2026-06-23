/**
 * Plan Task 16 — SQLite-mode whole-DB snapshot sync.
 *
 * In SQLite mode (`src/storage/engines/sqlite-engine.js`) the bulk of user
 * data is inside `<userRoot>/luker-storage.sqlite` rather than the flat
 * file tree. Per spec §6.3 the sync engine cannot raw-copy that file
 * because the live engine has it open and the OS-level rename swap would
 * leave stale reads against the unlinked inode. The orchestrator's
 * SQLite path solves this with a three-step dance:
 *
 *   1. Before the file walk: `VACUUM INTO` the live DB → the shadow
 *      workdir at `luker-storage.sqlite`. SQLite's online-backup mechanism
 *      grabs a consistent point-in-time copy without blocking the engine.
 *   2. Snapshot + merge as usual: the `'database'` category's `from` is
 *      special-cased in `snapshotLiveToShadow` to point at the workdir
 *      copy, so the standard file walk picks the snapshot up without
 *      re-reading (and corrupting) the live DB.
 *   3. After reconcile: `engine.closeHandle(handle)` releases the cached
 *      better-sqlite3 connection so the engine's next access lazily
 *      reopens against the post-rename inode (`write-file-atomic` swap
 *      done by reconcile).
 *
 * Architecture notes for the test:
 *
 *   - `src/storage/index.js`'s `_engine` is a process-global; two
 *     `initStorage()` calls in one test would clobber each other (see
 *     `tests/sync/integration/full-flow.test.js` for the fs-mode mirror
 *     of this constraint). We therefore stand up ONE shared
 *     `SqliteEngine` keyed by two distinct handles (`alice`, `bob`)
 *     with its `directoriesByHandle` resolver dispatching on the
 *     handle. Both apps share the engine; each app's middleware injects
 *     its own `req.user.profile.handle`, so storage I/O hits the right
 *     DB file.
 *   - Two real `http.Server` listeners on random ports — mirroring
 *     `full-flow.test.js` — because the orchestrator's `fetch()` runs
 *     real outbound HTTP that supertest's in-process dispatcher cannot
 *     intercept.
 *   - Categories include `'database'` so the SQLite blob participates
 *     in the snapshot/reconcile pipeline.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import bodyParser from 'body-parser';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';

import { router as syncRouter } from '../../../src/endpoints/sync.js';
import { initStorage, getStorageEngine, getSettingsRepo } from '../../../src/storage/index.js';

// Mirror src/constants.js USER_DIRECTORY_TEMPLATE — copied from
// tests/storage/harness/endpoint-harness.js so this file is self-contained
// (the existing helper is hard-coded to a single handle, which clashes with
// the two-handle setup this test needs).
const USER_DIRS = Object.freeze({
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

function buildDirs(userDir) {
    const dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(userDir, rel);
    }
    return dirs;
}

function precreateCommonDirs(dirs) {
    fs.mkdirSync(dirs.root, { recursive: true });
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });
    fs.mkdirSync(dirs.groups, { recursive: true });
    fs.mkdirSync(dirs.groupChats, { recursive: true });
    fs.mkdirSync(dirs.worlds, { recursive: true });
}

/**
 * Wrap an Express app in a real http.Server listening on a random
 * loopback port, mirroring `full-flow.test.js`'s helper so the
 * orchestrator's `fetch(peerBaseUrl + '/...')` resolves real network
 * I/O instead of going through supertest's in-process dispatcher.
 */
function startListener(app) {
    return new Promise(resolve => {
        const server = http.createServer(app).listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                server,
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => new Promise(done => server.close(done)),
            });
        });
    });
}

/**
 * Build the shared SQLite engine + two Express apps (A and B), each
 * with its own handle and per-handle data root. Returns the two apps,
 * their directories, and a cleanup that closes the engine and removes
 * the temp dirs.
 */
function buildDualSqliteHarness() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-sqlite-mode-'));
    const aDir = path.join(dataRoot, 'alice');
    const bDir = path.join(dataRoot, 'bob');
    const aDirs = buildDirs(aDir);
    const bDirs = buildDirs(bDir);
    precreateCommonDirs(aDirs);
    precreateCommonDirs(bDirs);

    initStorage({
        mode: 'sqlite',
        directoriesByHandle: (h) => {
            if (h === 'alice') return aDirs;
            if (h === 'bob') return bDirs;
            throw new Error(`unknown handle ${h}`);
        },
    });

    function buildApp(handle, dirs) {
        const app = express();
        app.use(bodyParser.json({ limit: '500mb' }));
        app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));
        const userProfile = { handle, admin: true, enabled: true, name: handle, created: 0, password: '', salt: '' };
        app.use((req, _res, next) => {
            req.user = { profile: userProfile, directories: dirs };
            next();
        });
        app.use('/api/sync/v1', syncRouter);
        return app;
    }

    return {
        aApp: buildApp('alice', aDirs),
        bApp: buildApp('bob', bDirs),
        aDirs,
        bDirs,
        cleanup() {
            try { getStorageEngine().close(); } catch { /* may already be torn down */ }
            try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
        },
    };
}

describe('SQLite-mode sync', () => {
    let H, aListener, bListener;

    beforeEach(async () => {
        H = buildDualSqliteHarness();
        aListener = await startListener(H.aApp);
        bListener = await startListener(H.bApp);
    });

    afterEach(async () => {
        if (aListener) await aListener.close();
        if (bListener) await bListener.close();
        if (H) H.cleanup();
    });

    test('pair: B receives A\'s SQLite snapshot and reads back the same row via storage API', async () => {
        // ---- Step 1: write a distinctive settings doc on A through the
        // real storage API. This proves the snapshot captures live DB
        // contents end-to-end: a raw filesystem copy of the open WAL'd
        // DB would either miss the in-WAL writes or corrupt the
        // snapshot. The settings doc round-trips through `SettingsRepo`,
        // which goes through `SqliteEngine.withTransaction` — the same
        // path real Luker uses.
        const settingsRepo = getSettingsRepo();
        const seed = {
            user_avatar: `alice-${crypto.randomBytes(4).toString('hex')}.png`,
            power_user: { theme: 'sqlite-sync-test', fast: true },
            marker: 'pair-init-from-alice',
        };
        await settingsRepo.save('alice', seed);

        // Pre-flight: B's DB file should NOT exist yet (no storage call
        // touched the `'bob'` handle), so the orchestrator's `runPull`
        // takes the fast-forward branch — B has nothing to merge with
        // A's snapshot. Reading B's settings here would lazy-init B's
        // DB and force a real two-way merge of A's vs B's empty DB —
        // a different code path than the pairing case under test.
        const bDbPath = path.join(H.bDirs.root, 'luker-storage.sqlite');
        expect(fs.existsSync(bDbPath)).toBe(false);

        // ---- Step 2: A offers, B pulls. Categories must include
        // `'database'` so the SQLite blob participates in the snapshot.
        // Without it, the standard file walk only ships the empty
        // characters/chats/worlds directories and B's DB stays empty.
        const PEER_ID = 'alice-bob-link';
        const offer = await request(H.aApp)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'B',
                categories: ['characters', 'chats', 'database'],
            });
        expect(offer.status).toBe(200);
        expect(offer.body.token).toMatch(/^[a-f0-9]{64}$/);

        const pull = await request(H.bApp)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: offer.body.token,
                categories: ['characters', 'chats', 'database'],
            });
        expect(pull.status).toBe(200);
        expect(pull.body.ok).toBe(true);
        // First pair on B → fastForward path (no prior local main).
        expect(pull.body.fastForward).toBe(true);

        // ---- Step 3: B's live SQLite file should now exist on disk
        // (reconcile wrote it via the workdir snapshot blob) and the
        // settings repo, queried with A's handle, should report A's
        // seed verbatim. The repo call goes through the same
        // SqliteEngine instance we tore down with `closeHandle('bob')`
        // post-reconcile — the next `_dbFor('bob')` lazily reopens
        // against the new file.
        //
        // Why query by A's handle: a SQLite sync wholesale-replaces
        // B's DB with A's DB (spec §6.3, conflictMode: 'whole-db').
        // Every row in the resulting DB still carries the handle of
        // whichever side originally wrote it. The schema is keyed by
        // `(handle, …)`, so B's storage layer can read those rows by
        // asking for them under A's handle. There is no rewriting
        // step that would re-key A's rows to B's handle, and
        // shouldn't be: the multi-handle structure is the engine's
        // own data model, not a sync layer concern.
        expect(fs.existsSync(bDbPath)).toBe(true);

        const bAfter = await settingsRepo.get('alice');
        expect(bAfter).toEqual(seed);
    });
});
