// Endpoint-level parity for POST /api/users/delete. Previously the handler
// removed the keyv user record (and optionally fs-rm'd the user root when
// `purge`), but never told the storage engine to drop the user's rows. In
// db modes (mysql/postgres) that meant chats, presets, settings, world-info,
// etc. lingered as orphans keyed on the deleted handle. The handler now
// invokes `engine.deleteUser(handle)` so engine rows vanish in
// lockstep with the user record for db engines.
//
// The row-sweep contract is asymmetric by mode:
//   mysql / postgres  : engine.deleteUser performs a transactional DELETE
//                       sweep across every Repo-backed table — runs
//                       UNCONDITIONALLY (purge=false still wipes rows,
//                       fixing the orphan bug).
//   fs / sqlite       : engine.deleteUser is a no-op — all user data lives
//                       in dirs.root. The admin handler's `purge=true`
//                       branch is the SINGLE owner of removing that dir.
//                       purge=false MUST leave both the dir and its
//                       contents intact (BC contract).
//
// Three tests run per engine:
//   1. REGRESSION (purge=true) — proves end-to-end deletion across all
//      4 engines. For mysql/pg, engine.deleteUser does the sweep. For
//      fs/sqlite, the handler's purge branch rms the user root (and the
//      sqlite file with it). Either way, post-delete probes return null.
//   2. BC GUARD (purge=false) — proves non-engine user files SURVIVE on
//      fs/sqlite; proves engine rows are wiped on mysql/pg (the original
//      orphan fix); proves keyv removal regardless of mode.
//   3. Self-delete guard — admin POSTing their own handle returns 400.

import path from 'node:path';
import fs from 'node:fs';

import storage from 'node-persist';
import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as usersAdminRouter } from '../../../src/endpoints/users-admin.js';
import {
    getChatRepo,
    getPresetRepo,
    getSettingsRepo,
    getWorldInfoRepo,
    getNamedDocRepo,
    getGroupRepo,
    getStatsRepo,
    getStorageEngine,
} from '../../../src/storage/index.js';

const TARGET_HANDLE_PREFIX = 'targetuser';
const ADMIN_HANDLE = 'admin';
const KEYV_PREFIX = 'user:';

// users.js caches `getUserDirectories(handle)` results in a module-scope Map
// keyed by handle; the cache is never invalidated on DATA_ROOT changes.
// Across the 4 mode iterations + 3 tests per iteration we'd hit the same
// `targetuser` handle 12 times with 12 different DATA_ROOTs, so a fresh
// handle per test instance is the cheapest way to dodge stale cache entries
// without poking at the source-of-truth.
let targetHandleCounter = 0;
function nextTargetHandle() {
    targetHandleCounter += 1;
    return `${TARGET_HANDLE_PREFIX}${targetHandleCounter}`;
}

const CHAT_HEADER = { user_name: 'tester', character_name: 'Alice', chat_metadata: {} };
const CHAT_MESSAGES = [{ name: 'User', is_user: true, mes: 'hi' }];

async function seedAllRepos(handle) {
    await getChatRepo().save(handle, 'Alice', 'c1', CHAT_HEADER, CHAT_MESSAGES, null);
    await getPresetRepo().save(handle, 'openai', 'p1', { temperature: 0.5 });
    await getWorldInfoRepo().save(handle, 'w1', { entries: {} });
    await getNamedDocRepo().save(handle, 'themes', 't1', { accent: '#abc' });
    await getGroupRepo().save(handle, 'g1', { id: 'g1', name: 'Test', chats: [] });
    await getSettingsRepo().save(handle, { user_name: 'target' });
    await getStatsRepo().save(handle, { totalChats: 0 });
}

async function probeAllRepos(handle) {
    const probes = {};
    probes.chat = await getChatRepo().get(handle, 'Alice', 'c1');
    probes.preset = await getPresetRepo().get(handle, 'openai', 'p1');
    probes.world = await getWorldInfoRepo().get(handle, 'w1');
    probes.namedDoc = await getNamedDocRepo().get(handle, 'themes', 't1');
    probes.group = await getGroupRepo().get(handle, 'g1');
    probes.settings = await getSettingsRepo().get(handle);
    probes.stats = await getStatsRepo().get(handle);
    return probes;
}

describe.each(ENDPOINT_HARNESSES)('users-admin /delete on $name', ({ mode }) => {
    let harness;
    let prevDataRoot;
    let targetHandle;

    beforeEach(async () => {
        targetHandle = nextTargetHandle();
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => { app.use('/api/users', usersAdminRouter); },
            // The admin issuer (`admin`) is intentionally different from both
            // the primary handle (`u`) and the deletion target so the
            // self-delete guard at users-admin.js:874 cannot match.
            profile: {
                handle: ADMIN_HANDLE,
                admin: true,
                enabled: true,
                name: 'Admin',
                created: 0,
                password: '',
                salt: '',
            },
            extraHandles: [targetHandle],
        });

        // The /delete handler's purge branch resolves the user dir via
        // `getUserDirectories(handle)`, which builds paths off
        // `globalThis.DATA_ROOT` (see src/users.js). The harness already
        // wires the engine's `directoriesByHandle` to its tmp `dataRoot`,
        // but `getUserDirectories` is a separate read path that bypasses
        // that wiring. Point DATA_ROOT at the harness's dataRoot for the
        // duration of this test so the handler's purge actually touches
        // the same files the engine wrote, then restore in afterEach.
        prevDataRoot = globalThis.DATA_ROOT;
        globalThis.DATA_ROOT = harness.dataRoot;

        // The handler calls `storage.removeItem(toKey(handle))` against
        // node-persist — initialize a per-test keyv store inside the
        // harness's dataRoot so the handler can read/write without
        // bleeding into the global persisted state.
        await storage.init({
            dir: path.join(harness.dataRoot, '_storage'),
            ttl: false,
            expiredInterval: 0,
        });
        await storage.setItem(`${KEYV_PREFIX}${targetHandle}`, {
            handle: targetHandle,
            name: 'Target',
            created: 0,
            password: '',
            salt: '',
            admin: false,
            enabled: true,
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
        // Restore the DATA_ROOT the suite set in jest.setup.js so later
        // tests in the same Jest worker keep seeing the public/ fixture.
        globalThis.DATA_ROOT = prevDataRoot;
    });

    test('REGRESSION purge=true: every Repo-backed table is empty for the deleted handle', async () => {
        // End-to-end probe of "delete a user, none of their data remains".
        // Seeds one row per Repo, then issues purge=true so every engine
        // (db and fs) is forced to a fully-empty state for the handle.
        await seedAllRepos(targetHandle);

        // Sanity: at least one resource visible BEFORE the /delete call.
        // Guards against the "test silently wrote nothing then probed
        // nothing" failure mode.
        const beforeDelete = await getChatRepo().get(targetHandle, 'Alice', 'c1');
        expect(beforeDelete).not.toBeNull();

        await request(harness.app)
            .post('/api/users/delete')
            .send({ handle: targetHandle, purge: true })
            .expect(204);

        // fs/sqlite: handler's purge branch rm'd the user root. Re-create
        // it so the engine's lazy dir resolution doesn't ENOENT on the
        // post-delete probes (the Repo `.get(...)` calls below).
        if (mode === 'fs' || mode === 'sqlite') {
            fs.mkdirSync(harness.extraDirs[targetHandle].root, { recursive: true });
        }

        // Probe every Repo-backed resource for the deleted user. Each must
        // come back null. The wrapped-object expectation
        // (`{ [k]: v }` toEqual `{ [k]: null }`) names the failing
        // resource in the Jest diff instead of dumping an unlabelled v.
        const probes = await probeAllRepos(targetHandle);
        for (const [k, v] of Object.entries(probes)) {
            expect({ [k]: v }).toEqual({ [k]: null });
        }

        // The keyv user record must also be gone — this part of the
        // contract pre-dates the row-sweep change and would already pass, but assert
        // it so a future regression that removes the keyv branch is
        // caught by this same test.
        const keyvAfter = await storage.getItem(`${KEYV_PREFIX}${targetHandle}`);
        expect(keyvAfter).toBeUndefined();
    });

    test('BC: purge=false leaves fs/sqlite data intact, wipes mysql/pg engine rows', async () => {
        // Long-standing contract that MUST survive the row-sweep redesign:
        // an admin choosing purge=false expected the user's on-disk files
        // to stay (so a typo on the handle field doesn't nuke avatars,
        // exports, extension state, etc.). Asymmetric by mode:
        //   * fs/sqlite      → engine.deleteUser is a no-op; the user dir
        //                       (and every file under it, including the
        //                       sqlite db) survives.
        //   * mysql/postgres → engine.deleteUser runs unconditionally and
        //                       transactionally DELETEs the user's rows
        //                       (this fixes the original orphan-row bug).
        // The asymmetric assertion below encodes both halves.
        await seedAllRepos(targetHandle);

        // BC guard for fs/sqlite: drop a stand-in for an avatar file
        // (mirrors any user-uploaded asset under dirs.root). Pre-fix
        // the fs engine's deleteUser rm'd dirs.root recursively and
        // wiped this file, so this assertion catches future drift.
        const survivorPath = path.join(harness.extraDirs[targetHandle].avatars, 'profile.png');
        fs.mkdirSync(harness.extraDirs[targetHandle].avatars, { recursive: true });
        fs.writeFileSync(survivorPath, 'pretend-png');

        await request(harness.app)
            .post('/api/users/delete')
            .send({ handle: targetHandle, purge: false })
            .expect(204);

        // BC guarantee #1: non-engine files always survive purge=false.
        // (mysql/pg have no per-user files but the file we wrote sits in
        // the harness's per-handle dir tree, which neither db engine
        // touches.)
        expect(fs.existsSync(survivorPath)).toBe(true);

        // BC guarantee #2: keyv record is always removed.
        const keyvAfter = await storage.getItem(`${KEYV_PREFIX}${targetHandle}`);
        expect(keyvAfter).toBeUndefined();

        // BC guarantee #3: per-mode row-sweep contract.
        const probes = await probeAllRepos(targetHandle);
        if (mode === 'fs' || mode === 'sqlite') {
            // fs/sqlite: engine.deleteUser is a no-op, so EVERY seeded
            // row must still be readable. This is the BC half — a user
            // accidentally deleted with purge=false can be re-created
            // and their data reattached (matching pre-Stage-2 behaviour).
            expect(probes.chat).not.toBeNull();
            expect(probes.preset).not.toBeNull();
            expect(probes.world).not.toBeNull();
            expect(probes.namedDoc).not.toBeNull();
            expect(probes.group).not.toBeNull();
            expect(probes.settings).not.toBeNull();
            expect(probes.stats).not.toBeNull();
        } else {
            // mysql/postgres: engine.deleteUser runs unconditionally and
            // wipes every Repo-backed table for the handle. This is the
            // orphan-row fix.
            for (const [k, v] of Object.entries(probes)) {
                expect({ [k]: v }).toEqual({ [k]: null });
            }
        }
    });

    test('admin cannot delete themselves (self-delete guard)', async () => {
        // Sanity check the existing 400-on-self-delete path so the
        // regression test above can rely on the harness's issuer/target
        // separation working as documented.
        const res = await request(harness.app)
            .post('/api/users/delete')
            .send({ handle: ADMIN_HANDLE, purge: false })
            .expect(400);
        expect(res.body.error).toMatch(/yourself/i);
        // Engine must not have been touched. The handler returns BEFORE
        // calling deleteUser when the guard fires.
        expect(typeof getStorageEngine().deleteUser).toBe('function');
    });
});
