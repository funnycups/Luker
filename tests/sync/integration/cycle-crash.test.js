import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import git from 'isomorphic-git';

import { runSyncCycle, readUndoPoint, MAIN_REF } from '../../../src/sync/pipeline/cycle.js';
import { FAILPOINTS, failpointMarker } from '../../../src/sync/pipeline/failpoints.js';
import { readReconcileJournal } from '../../../src/sync/pipeline/reconcile-journal.js';
import { blobOidOf, readBlobBytes, readCommitFiles } from '../../../src/sync/pipeline/git-tree.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { hasObjectLocally } from '../../../src/sync/objects.js';
import { readSnapshotCategories } from '../../../src/sync/pipeline/snapshot-categories.js';
import { CONFLICTS_PATH, readEntries } from '../../../src/sync/pipeline/conflict-records.js';
import { createConflictPolicy } from '../../../src/sync/pipeline/conflict-policy.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { BACKEND_ID, makeDevice, makeRemote, readAllReachable, remoteHead, resolveRefOrNull } from '../_lib/devices.js';

const CHILD = fileURLToPath(new URL('../_lib/cycle-child.mjs', import.meta.url));

function runCycleInChild(device, failpointName, extra = {}) {
    return spawnSync(process.execPath, [CHILD, JSON.stringify({
        userRoot: device.userRoot,
        remoteDir: device.remoteDir,
        categories: device.ctx.categories,
        ...extra,
    })], {
        env: { ...process.env, LUKER_SYNC_FAILPOINT: failpointName },
        encoding: 'utf8',
    });
}

function expectKilledAt(child, failpointName) {
    if (child.signal !== 'SIGKILL' || child.stderr !== failpointMarker(failpointName)) {
        throw new Error(`child was not killed at ${failpointName}: status ${child.status}, signal ${child.signal}\nstdout: ${child.stdout}\nstderr: ${child.stderr}`);
    }
}

/**
 * Read every object reachable from every ref of the repository.
 *
 * @returns {Promise<string[]>} the refs walked, sorted
 */
async function readEveryRef(gitdir) {
    const refs = (await git.listRefs({ fs: atomicFs, gitdir, filepath: 'refs' })).map(name => `refs/${name}`).sort();
    for (const ref of refs) {
        await readAllReachable(gitdir, await git.resolveRef({ fs: atomicFs, gitdir, ref }));
    }
    return refs;
}

async function presentIn(gitdir, oids) {
    const present = [];
    for (const oid of oids) {
        if (await hasObjectLocally({ dir: gitdir, gitdir, oid })) present.push(oid);
    }
    return present;
}

async function fileText(gitdir, commitOid, relPath) {
    const file = (await readCommitFiles({ gitdir, commitOid })).get(relPath);
    return file ? (await readBlobBytes({ gitdir, oid: file.oid })).toString('utf8') : null;
}

// Each test spawns a child Node process and runs several real sync cycles
// on disk; the default Jest timeout is too short for that under load.
const CRASH_TEST_TIMEOUT_MS = 60_000;

const chatText = mes => `${JSON.stringify({ user_name: 'U', character_name: 'Seraphina', chat_metadata: {} })}\n${JSON.stringify({ name: 'Seraphina', is_user: false, mes })}\n`;

describe('sync cycle survives a process kill', () => {
    let remote;
    const devices = [];
    const device = () => {
        const d = makeDevice({ remoteDir: remote.remoteDir });
        devices.push(d);
        return d;
    };

    beforeEach(async () => {
        _resetGateForTests();
        remote = await makeRemote();
    });
    afterEach(() => {
        for (const d of devices.splice(0)) d.cleanup();
        remote.cleanup();
    });

    test('a kill during the snapshot commit leaves the repo intact and the next cycle publishes', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        await runSyncCycle(A.ctx);
        const before = await resolveRefOrNull(A.shadow.gitDir, MAIN_REF);
        A.write('characters/b.png', 'B');

        expectKilledAt(runCycleInChild(A, FAILPOINTS.SNAPSHOT_BEFORE_COMMIT), FAILPOINTS.SNAPSHOT_BEFORE_COMMIT);
        expect(await resolveRefOrNull(A.shadow.gitDir, MAIN_REF)).toBe(before);
        expect(await readEveryRef(A.shadow.gitDir)).toContain(MAIN_REF);

        const outcome = await runSyncCycle(A.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'ahead', pushed: true });
        expect(await remoteHead(remote.remoteDir)).toBe(outcome.localHead);
        expect([...(await readCommitFiles({ gitdir: A.shadow.gitDir, commitOid: outcome.localHead })).keys()].sort()).toEqual(['characters/a.png', 'characters/b.png']);
        expect(await fileText(A.shadow.gitDir, outcome.localHead, 'characters/a.png')).toBe('A');
        expect(await fileText(A.shadow.gitDir, outcome.localHead, 'characters/b.png')).toBe('B');
        expect(await readEveryRef(A.shadow.gitDir)).toContain(MAIN_REF);
        expect(await readEveryRef(remote.remoteDir)).toEqual([MAIN_REF]);
    }, CRASH_TEST_TIMEOUT_MS);

    test('a kill after the first live write is finished by recovery on the next cycle', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        A.write('characters/b.png', 'B');
        A.write('characters/c.png', 'C');
        await runSyncCycle(A.ctx);
        const B = device();

        expectKilledAt(runCycleInChild(B, FAILPOINTS.RECONCILE_AFTER_FIRST_WRITE), FAILPOINTS.RECONCILE_AFTER_FIRST_WRITE);
        expect(readReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID })).toEqual({
            base: null,
            target: await remoteHead(remote.remoteDir),
            categories: B.ctx.categories,
            advanceOnSkip: false,
        });
        const present = ['a', 'b', 'c'].filter(name => B.read(`characters/${name}.png`) !== null);
        expect(present).toHaveLength(1);
        expect(await readEveryRef(B.shadow.gitDir)).not.toContain(MAIN_REF);

        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.status).toBe('synced');
        expect(outcome.recovered.reconcile.alreadyApplied).toEqual([`characters/${present[0]}.png`]);
        expect(outcome.recovered.reconcile.written.sort()).toEqual(['a', 'b', 'c'].filter(n => n !== present[0]).map(n => `characters/${n}.png`));
        expect(readReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID })).toBeNull();
        expect([B.read('characters/a.png'), B.read('characters/b.png'), B.read('characters/c.png')]).toEqual(['A', 'B', 'C']);
        expect(await resolveRefOrNull(B.shadow.gitDir, MAIN_REF)).toBe(await remoteHead(remote.remoteDir));
        await readAllReachable(B.shadow.gitDir, outcome.localHead);
        expect(await readEveryRef(B.shadow.gitDir)).toContain(MAIN_REF);
    }, CRASH_TEST_TIMEOUT_MS);

    test('local edits made around a killed merge reconcile survive recovery and reach the other device', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        A.write('characters/b.png', 'B1');
        A.write('characters/c.png', 'C1');
        await runSyncCycle(A.ctx);
        const B = device();
        expect((await runSyncCycle(B.ctx)).mergeCase).toBe('pairing-pull');
        A.write('characters/a.png', 'A2');
        A.write('characters/b.png', 'B2');
        A.write('characters/c.png', 'C2');
        expect((await runSyncCycle(A.ctx)).pushed).toBe(true);
        B.write('characters/d.png', 'D1');

        expectKilledAt(runCycleInChild(B, FAILPOINTS.RECONCILE_AFTER_FIRST_WRITE), FAILPOINTS.RECONCILE_AFTER_FIRST_WRITE);
        const journal = readReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID });
        expect(journal).not.toBeNull();
        expect(await fileText(B.shadow.gitDir, journal.base, 'characters/d.png')).toBe('D1');
        const updated = ['a', 'b', 'c'].filter(name => B.read(`characters/${name}.png`) === `${name.toUpperCase()}2`);
        expect(updated).toHaveLength(1);
        expect(await readEveryRef(B.shadow.gitDir)).toContain(MAIN_REF);
        B.write('characters/d.png', 'D2');
        B.write('characters/e.png', 'E');

        const outcome = await runSyncCycle(B.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'ahead', pushed: true });
        expect(outcome.recovered.target).toBe(journal.target);
        expect(readReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID })).toBeNull();
        expect(['a', 'b', 'c', 'd', 'e'].map(name => B.read(`characters/${name}.png`))).toEqual(['A2', 'B2', 'C2', 'D2', 'E']);
        const pushed = await remoteHead(remote.remoteDir);
        expect(pushed).toBe(outcome.localHead);
        expect(await fileText(B.shadow.gitDir, pushed, 'characters/d.png')).toBe('D2');
        expect(await fileText(B.shadow.gitDir, pushed, 'characters/e.png')).toBe('E');
        expect(await readEveryRef(B.shadow.gitDir)).toContain(MAIN_REF);
        expect(await readEveryRef(remote.remoteDir)).toEqual([MAIN_REF]);

        expect((await runSyncCycle(A.ctx)).mergeCase).toBe('fast-forward');
        expect(['a', 'b', 'c', 'd', 'e'].map(name => A.read(`characters/${name}.png`))).toEqual(['A2', 'B2', 'C2', 'D2', 'E']);
        expect(await resolveRefOrNull(A.shadow.gitDir, MAIN_REF)).toBe(pushed);
        expect(await readEveryRef(A.shadow.gitDir)).toContain(MAIN_REF);
    }, CRASH_TEST_TIMEOUT_MS);

    test('a kill in the middle of fetching objects leaves the shadow usable for the next cycle', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        A.write('worlds/w.json', '{}');
        await runSyncCycle(A.ctx);
        A.write('characters/a.png', 'A2');
        A.write('characters/sub/b.png', 'B');
        await runSyncCycle(A.ctx);
        const B = device();
        const head = await remoteHead(remote.remoteDir);
        const closure = await readAllReachable(remote.remoteDir, head);

        expectKilledAt(runCycleInChild(B, FAILPOINTS.FETCH_AFTER_FIRST_OBJECT), FAILPOINTS.FETCH_AFTER_FIRST_OBJECT);
        expect(await resolveRefOrNull(B.shadow.gitDir, MAIN_REF)).toBeNull();
        expect(await hasObjectLocally({ dir: B.shadow.gitDir, gitdir: B.shadow.gitDir, oid: head })).toBe(false);
        expect((await presentIn(B.shadow.gitDir, closure)).length).toBeGreaterThan(0);
        expect(await readEveryRef(B.shadow.gitDir)).not.toContain(MAIN_REF);

        const outcome = await runSyncCycle(B.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'pairing-pull' });
        expect([B.read('characters/a.png'), B.read('characters/sub/b.png'), B.read('worlds/w.json')]).toEqual(['A2', 'B', '{}']);
        await readAllReachable(B.shadow.gitDir, outcome.localHead);
        expect(await readEveryRef(B.shadow.gitDir)).toContain(MAIN_REF);
    }, CRASH_TEST_TIMEOUT_MS);

    test('a kill in the middle of uploading objects leaves the remote usable for the next cycle', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        A.write('characters/sub/b.png', 'B');

        expectKilledAt(runCycleInChild(A, FAILPOINTS.FETCH_AFTER_FIRST_OBJECT), FAILPOINTS.FETCH_AFTER_FIRST_OBJECT);
        expect(await remoteHead(remote.remoteDir)).toBeNull();
        const localMain = await resolveRefOrNull(A.shadow.gitDir, MAIN_REF);
        expect(localMain).not.toBeNull();
        expect(await hasObjectLocally({ dir: remote.remoteDir, gitdir: remote.remoteDir, oid: localMain })).toBe(false);
        const closure = await readAllReachable(A.shadow.gitDir, localMain);
        expect((await presentIn(remote.remoteDir, closure)).length).toBeGreaterThan(0);
        expect(await readEveryRef(A.shadow.gitDir)).toContain(MAIN_REF);
        expect(await readEveryRef(remote.remoteDir)).toEqual([]);

        const outcome = await runSyncCycle(A.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'pairing-push', pushed: true, localHead: localMain });
        await readAllReachable(remote.remoteDir, outcome.localHead);
        expect(await readEveryRef(remote.remoteDir)).toEqual([MAIN_REF]);
        const B = device();
        expect((await runSyncCycle(B.ctx)).mergeCase).toBe('pairing-pull');
        expect([B.read('characters/a.png'), B.read('characters/sub/b.png')]).toEqual(['A', 'B']);
        expect(await readEveryRef(B.shadow.gitDir)).toContain(MAIN_REF);
    }, CRASH_TEST_TIMEOUT_MS);

    test('a kill after the object upload and before the head CAS is pushed again by the next cycle', async () => {
        const A = device();
        A.write('characters/a.png', 'A');

        expectKilledAt(runCycleInChild(A, FAILPOINTS.PUSH_BEFORE_CAS), FAILPOINTS.PUSH_BEFORE_CAS);
        const localMain = await resolveRefOrNull(A.shadow.gitDir, MAIN_REF);
        expect(localMain).not.toBeNull();
        expect(await remoteHead(remote.remoteDir)).toBeNull();
        expect(await hasObjectLocally({ dir: remote.remoteDir, gitdir: remote.remoteDir, oid: localMain })).toBe(true);
        expect(await readEveryRef(remote.remoteDir)).toEqual([]);

        const outcome = await runSyncCycle(A.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'pairing-push', pushed: true, localHead: localMain });
        expect(await remoteHead(remote.remoteDir)).toBe(localMain);
        await readAllReachable(remote.remoteDir, localMain);
        expect(await readEveryRef(remote.remoteDir)).toEqual([MAIN_REF]);
        expect(await readEveryRef(A.shadow.gitDir)).toContain(MAIN_REF);
        const B = device();
        expect((await runSyncCycle(B.ctx)).mergeCase).toBe('pairing-pull');
        expect(B.read('characters/a.png')).toBe('A');
        expect(await fileText(B.shadow.gitDir, localMain, 'characters/a.png')).toBe('A');
    }, CRASH_TEST_TIMEOUT_MS);

    for (const point of [FAILPOINTS.SNAPSHOT_BEFORE_COMMIT, FAILPOINTS.SEED_RECORDS_BEFORE_JOURNAL, FAILPOINTS.SEED_RECORDS_AFTER_JOURNAL]) {
        test(`seed conflict records survive a kill at ${point}`, async () => {
            const A = device();
            A.write('characters/a.png', 'A');
            A.write('worlds/w.json', 'A-version');
            await runSyncCycle(A.ctx);
            const B = makeDevice({ remoteDir: remote.remoteDir, categories: ['characters'] });
            devices.push(B);
            await runSyncCycle(B.ctx);
            B.write('worlds/w.json', 'B-version');
            const child = runCycleInChild({ ...B, ctx: { ...B.ctx, categories: ['characters', 'worlds'] } }, point, { policy: true });
            expectKilledAt(child, point);
            B.ctx.categories = ['characters', 'worlds'];
            B.ctx.onConflicts = createConflictPolicy({ directories: B.directories, localDevice: 'B', remoteDevice: 'remote' });
            await runSyncCycle(B.ctx);
            const files = await readCommitFiles({ gitdir: B.shadow.gitDir, commitOid: await resolveRefOrNull(B.shadow.gitDir, MAIN_REF) });
            expect(Object.keys(await readEntries({ gitdir: B.shadow.gitDir, files, path: CONFLICTS_PATH, kind: 'conflicts' }))).toEqual(['worlds/w.json']);
            expect(readSnapshotCategories({ userRoot: B.userRoot, backendId: BACKEND_ID }).categories).toEqual(['characters', 'worlds']);
            expect(await resolveRefOrNull(B.shadow.gitDir, 'refs/sync/seed-theirs')).toBeNull();
            expect(B.read('worlds/w.json')).toBe('B-version');
        }, CRASH_TEST_TIMEOUT_MS);
    }

    test('a live edit made after a kill at seed-records-after-journal is skipped by recovery and the records stay in main', async () => {
        const all = ['characters', 'worlds', 'chats'];
        const A = makeDevice({ remoteDir: remote.remoteDir, categories: all });
        devices.push(A);
        A.write('characters/a.png', 'A');
        A.write('worlds/w.json', 'A-version');
        A.write('chats/Seraphina/s.jsonl', chatText('A'));
        await runSyncCycle(A.ctx);
        const B = makeDevice({ remoteDir: remote.remoteDir, categories: ['characters'] });
        devices.push(B);
        await runSyncCycle(B.ctx);
        B.write('worlds/w.json', 'B-version');
        B.write('chats/Seraphina/s.jsonl', chatText('B'));
        const point = FAILPOINTS.SEED_RECORDS_AFTER_JOURNAL;
        expectKilledAt(runCycleInChild({ ...B, ctx: { ...B.ctx, categories: all } }, point, { policy: true }), point);
        const journal = readReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID });
        expect(journal.advanceOnSkip).toBe(true);
        const branchPath = [...(await readCommitFiles({ gitdir: B.shadow.gitDir, commitOid: journal.target })).keys()].find(k => k.includes('Sync conflict'));
        B.write(branchPath, 'LIVE-EDIT');

        B.ctx.categories = all;
        B.ctx.onConflicts = createConflictPolicy({ directories: B.directories, localDevice: 'B', remoteDevice: 'remote' });
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.recovered.reconcile.skipped).toEqual([branchPath]);
        const files = await readCommitFiles({ gitdir: B.shadow.gitDir, commitOid: await resolveRefOrNull(B.shadow.gitDir, MAIN_REF) });
        expect(Object.keys(await readEntries({ gitdir: B.shadow.gitDir, files, path: CONFLICTS_PATH, kind: 'conflicts' }))).toEqual(['worlds/w.json']);
        expect(files.get(branchPath).oid).toBe(blobOidOf(Buffer.from('LIVE-EDIT')));
        expect(B.read(branchPath)).toBe('LIVE-EDIT');
        expect(B.read('worlds/w.json')).toBe('B-version');
        expect(await resolveRefOrNull(B.shadow.gitDir, 'refs/sync/seed-theirs')).toBeNull();
    }, CRASH_TEST_TIMEOUT_MS);

    for (const localEditFirst of [true, false]) {
        test(`a kill between the backup tag and the undo target keeps the previous undo point${localEditFirst ? '' : ' when the new base equals the previous target'}`, async () => {
            const A = device();
            A.write('characters/x.png', 'V1');
            await runSyncCycle(A.ctx);
            const B = device();
            await runSyncCycle(B.ctx);
            A.write('characters/x.png', 'V2');
            await runSyncCycle(A.ctx);
            const L1 = await resolveRefOrNull(B.shadow.gitDir, MAIN_REF);
            const M1 = (await runSyncCycle(B.ctx)).localHead;
            expect(await readUndoPoint(B.shadow.gitDir)).toMatchObject({ base: L1, target: M1 });
            A.write('characters/x.png', 'V3');
            await runSyncCycle(A.ctx);
            if (localEditFirst) B.write('characters/b.png', 'B-local');

            const point = FAILPOINTS.BACKUP_TAG_BEFORE_TARGET;
            expectKilledAt(runCycleInChild(B, point), point);
            const L2 = await resolveRefOrNull(B.shadow.gitDir, MAIN_REF);
            expect(L2 === M1).toBe(!localEditFirst);
            expect(await readUndoPoint(B.shadow.gitDir)).toMatchObject({ base: L1, target: M1 });

            const outcome = await runSyncCycle(B.ctx);
            expect(outcome.status).toBe('synced');
            const undo = await readUndoPoint(B.shadow.gitDir);
            expect(undo.target).toBe(outcome.localHead);
            expect(await git.isDescendent({ fs: atomicFs, gitdir: B.shadow.gitDir, oid: undo.target, ancestor: undo.base })).toBe(true);
        }, CRASH_TEST_TIMEOUT_MS);
    }

    const localEdit = { path: 'characters/edit.png', content: 'EDIT' };

    test('a kill after the local edit journal is finished by recovery on the next cycle', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        await runSyncCycle(A.ctx);
        const point = FAILPOINTS.LOCAL_EDIT_AFTER_JOURNAL;
        expectKilledAt(runCycleInChild(A, point, { localEdit }), point);
        const journal = readReconcileJournal({ userRoot: A.userRoot, backendId: BACKEND_ID });
        expect(journal.base).toBe(await resolveRefOrNull(A.shadow.gitDir, MAIN_REF));
        expect(A.read(localEdit.path)).toBeNull();

        const outcome = await runSyncCycle(A.ctx);
        expect(outcome.recovered).toMatchObject({ target: journal.target });
        expect(outcome.recovered.reconcile.written).toEqual([localEdit.path]);
        expect(A.read(localEdit.path)).toBe('EDIT');
        expect(readReconcileJournal({ userRoot: A.userRoot, backendId: BACKEND_ID })).toBeNull();
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'ahead', pushed: true });
        expect(await fileText(A.shadow.gitDir, await remoteHead(remote.remoteDir), localEdit.path)).toBe('EDIT');
        const { commit } = await git.readCommit({ fs: atomicFs, gitdir: A.shadow.gitDir, oid: journal.target });
        expect(commit.message.trim()).toBe('local edit');
    }, CRASH_TEST_TIMEOUT_MS);

    test('a kill before the local edit journal leaves live and main without the edit', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        await runSyncCycle(A.ctx);
        const point = FAILPOINTS.LOCAL_EDIT_BEFORE_JOURNAL;
        expectKilledAt(runCycleInChild(A, point, { localEdit }), point);
        expect(readReconcileJournal({ userRoot: A.userRoot, backendId: BACKEND_ID })).toBeNull();
        expect(A.read(localEdit.path)).toBeNull();
        expect(await fileText(A.shadow.gitDir, await resolveRefOrNull(A.shadow.gitDir, MAIN_REF), localEdit.path)).toBeNull();

        A.write('characters/b.png', 'B');
        const outcome = await runSyncCycle(A.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'ahead', pushed: true, recovered: null });
        expect([...(await readCommitFiles({ gitdir: A.shadow.gitDir, commitOid: outcome.localHead })).keys()].sort()).toEqual(['characters/a.png', 'characters/b.png']);
        expect(A.read(localEdit.path)).toBeNull();
        expect(await readEveryRef(A.shadow.gitDir)).toContain(MAIN_REF);
    }, CRASH_TEST_TIMEOUT_MS);
});
