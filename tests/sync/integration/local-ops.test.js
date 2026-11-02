import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

import { runSyncCycle, commitLocalEdit, MAIN_REF } from '../../../src/sync/pipeline/cycle.js';
import { createConflictPolicy } from '../../../src/sync/pipeline/conflict-policy.js';
import { deviceLabelForCommit } from '../../../src/sync/pipeline/commit-provenance.js';
import { CONFLICTS_PATH, NOTICES_PATH, serializeEntries } from '../../../src/sync/pipeline/conflict-records.js';
import { readPendingState } from '../../../src/sync/pipeline/pending-status.js';
import { applyConflictChoices, dismissNotices, undoLastSync } from '../../../src/sync/pipeline/local-ops.js';
import { blobOidOf, readBlobBytes, readCommitFiles, writeTreeFromFiles } from '../../../src/sync/pipeline/git-tree.js';
import { encodePresetRecordPath } from '../../../src/sync/preset-projection.js';
import { commitFiles } from '../_lib/commits.js';
import { SYNC_AUTHOR } from '../../../src/sync/pipeline/merge.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { readSqlRecordValue, writeSqlRecordValue } from '../../../src/sync/materialize.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { CONTRACT_HARNESSES } from '../_lib/required-engines.js';
import { DirectoryBackend } from '../_lib/directory-backend.js';
import { BACKEND_ID, makeDevice, makeRemote, remoteHead, resolveRefOrNull } from '../_lib/devices.js';
import { orderLocalHead } from '../_lib/merge-roles.js';
import { withNestedDirs } from '../_lib/nested-dirs.js';
import { syncService } from '../../../src/sync/sync-service.js';
import { upsertLanBackend, updateRegistry } from '../../../src/sync/state.js';
import { PAUSEPOINTS } from '../../../src/sync/pipeline/failpoints.js';
import { reviewedChoice, reviewedChoices } from '../_lib/conflict-choices.js';

const oid = content => blobOidOf(Buffer.from(content));
const record = (createdAt, extra = {}) => ({ kept: oid('K'), ours: oid('O'), theirs: oid('T'), oursDevice: 'Desk', theirsDevice: 'Phone', mergeParents: [], createdAt, ...extra });
const withoutBackend = ({ backend, ...ctx }) => ctx;
const mainFiles = async (ctx) => {
    const { gitDir } = getShadowPaths({ userRoot: ctx.userRoot, peerId: ctx.backendId });
    return readCommitFiles({ gitdir: gitDir, commitOid: await resolveRefOrNull(gitDir, MAIN_REF) });
};
const ctxMap = (...entries) => new Map(entries);
// `extra/` is outside every category: it stays in the tree and never reaches live.
const writeTree = (ctx, recordPath, entries, extraFiles = {}) => commitLocalEdit(ctx, async ({ gitdir, files }) => {
    const next = new Map(files);
    next.set(recordPath, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob: serializeEntries(entries) }), mode: '100644' });
    for (const [rel, content] of Object.entries(extraFiles)) next.set(rel, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from(content) }), mode: '100644' });
    return { files: next, message: 'test records' };
});
const writeRecords = (ctx, entries, extraFiles) => writeTree(ctx, CONFLICTS_PATH, entries, extraFiles);
const writeNotices = (ctx, entries) => writeTree(ctx, NOTICES_PATH, entries);

describe('local sync operations', () => {
    let remote;
    const devices = [];
    const device = (options = {}) => {
        const d = makeDevice({ remoteDir: remote.remoteDir, categories: ['characters', 'worlds', 'chats'], ...options });
        d.ctx.onConflicts = createConflictPolicy({ directories: d.directories, localDevice: `dev-${devices.length}`, remoteDevice: 'remote' });
        const label = `dev-${devices.length}`;
        d.ctx.getDeviceLabel = async () => label;
        devices.push(d);
        return d;
    };
    async function conflictOnB() {
        const A = device();
        A.write('worlds/w.json', 'A0');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.write('worlds/w.json', 'A1');
        await runSyncCycle(A.ctx);
        B.write('worlds/w.json', 'B1');
        await orderLocalHead(B.ctx, await remoteHead(remote.remoteDir), true);
        await runSyncCycle(B.ctx);
        return { A, B };
    }

    async function expectLocalProvenance(ctx, label) {
        const gitdir = getShadowPaths({ userRoot: ctx.userRoot, peerId: ctx.backendId }).gitDir;
        const head = await resolveRefOrNull(gitdir, MAIN_REF);
        expect(await deviceLabelForCommit({ gitdir, oid: head })).toBe(label);
        const { commit } = await git.readCommit({ fs: atomicFs, gitdir, oid: head });
        expect(commit.committer).toEqual({ ...SYNC_AUTHOR, timestamp: commit.author.timestamp, timezoneOffset: commit.author.timezoneOffset });
    }

    beforeEach(async () => {
        _resetGateForTests();
        remote = await makeRemote();
    });
    afterEach(() => {
        for (const d of devices.splice(0)) d.cleanup();
        remote.cleanup();
    });

    test('a merge conflict shows up as one pending entry', async () => {
        const { B } = await conflictOnB();
        const { conflicts } = await readPendingState(ctxMap([BACKEND_ID, withoutBackend(B.ctx)]));
        expect(conflicts).toEqual([expect.objectContaining({ path: 'worlds/w.json', backendId: BACKEND_ID, backends: [BACKEND_ID], kept: oid('B1'), ours: oid('B1'), theirs: oid('A1'), current: oid('B1'), stale: false })]);
    });

    test('pending state groups one path reported by two backends', async () => {
        const B = device();
        B.write('worlds/w.json', 'K');
        const r1 = { ...withoutBackend(B.ctx), backendId: 'r1' };
        const r2 = { ...withoutBackend(B.ctx), backendId: 'r2' };
        await writeRecords(r1, { 'worlds/w.json': record('2026-10-13T10:00:00.000Z') });
        await writeRecords(r2, { 'worlds/w.json': record('2026-10-13T11:00:00.000Z', { theirs: oid('T2') }) });
        const { conflicts } = await readPendingState(ctxMap(['r1', r1], ['r2', r2]));
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]).toMatchObject({ path: 'worlds/w.json', backendId: 'r2', backends: ['r1', 'r2'], theirs: oid('T2'), stale: false });
    });

    test('a backend whose records cannot be read reports a failure without hiding readable backends', async () => {
        const B = device();
        B.write('worlds/w.json', 'K');
        const r1 = { ...withoutBackend(B.ctx), backendId: 'r1' };
        const r2 = { ...withoutBackend(B.ctx), backendId: 'r2' };
        await commitLocalEdit(r1, async ({ files }) => ({ files: new Map(files).set(CONFLICTS_PATH, { oid: oid('a blob this repo never stored'), mode: '100644' }), message: 'dangling records' }));
        await writeRecords(r2, { 'worlds/w.json': record('1') });
        const { conflicts, errors } = await readPendingState(ctxMap(['r1', r1], ['r2', r2]));
        expect(conflicts).toEqual([expect.objectContaining({ path: 'worlds/w.json', backends: ['r2'] })]);
        expect(errors).toEqual({ r1: expect.objectContaining({ code: 'PENDING_READ_FAILED' }) });
    });

    test('admitted grouped choices preserve corrupt-backend errors and readable record versions', async () => {
        const B = device(); B.write('worlds/w.json', 'K');
        const r1 = { ...withoutBackend(B.ctx), backendId: 'r1' };
        const r2 = { ...withoutBackend(B.ctx), backendId: 'r2' };
        await writeRecords(r1, { 'worlds/w.json': record('1') });
        B.write('worlds/w.json', 'DISPLAYED_CURRENT');
        await writeRecords(r2, { 'worlds/w.json': record('2', { kept: oid('DISPLAYED_CURRENT'), ours: oid('DISPLAYED_CURRENT') }) });
        const [shown] = (await readPendingState(ctxMap(['r1', r1], ['r2', r2]))).conflicts;
        const choice = reviewedChoice(shown, 'current');
        expect(choice.review.currentVersions).toEqual({ r1: oid('K'), r2: oid('DISPLAYED_CURRENT') });
        expect(choice.review.backendId).toBe('r2');
        const metadata = (await mainFiles(r2)).get(CONFLICTS_PATH).oid;
        const object = path.join(getShadowPaths({ userRoot: B.userRoot, peerId: 'r2' }).gitDir, 'objects', metadata.slice(0, 2), metadata.slice(2));
        const original = fs.readFileSync(object); fs.writeFileSync(object, 'unreadable preview-source metadata');
        for (const id of ['r1', 'r2']) await upsertLanBackend({ userRoot: B.userRoot, backendId: id, label: id, categories: B.ctx.categories });
        const owner = { ...B.ctx, userRoot: B.userRoot };
        try {
            await syncService.withLocalMutationContexts(owner, ['r1', 'r2'], async contexts => {
                const pending = await readPendingState(contexts);
                expect(pending.conflicts[0].recordVersions).toEqual({ r1: expect.any(String) });
                expect(pending.errors.r2.code).toBe('PENDING_READ_FAILED');
                const results = await applyConflictChoices(contexts, [choice]);
                expect(results).toEqual([{ path: 'worlds/w.json', backends: ['r1'], committedBackends: ['r1'], applied: false, errors: pending.errors }]);
            });
        } finally { fs.writeFileSync(object, original); }
        expect(B.read('worlds/w.json')).toBe('DISPLAYED_CURRENT');
        expect((await readPendingState(ctxMap(['r1', r1], ['r2', r2]))).conflicts).toEqual([expect.objectContaining({ path: 'worlds/w.json', backends: ['r2'] })]);
    });

    test('production read contexts admit a fresh mutation context before ensureShadowRepo', async () => {
        const B = device();
        await upsertLanBackend({ userRoot: B.userRoot, backendId: BACKEND_ID, label: 'remote', categories: B.ctx.categories });
        const owner = { ...B.ctx, userRoot: B.userRoot };
        const context = await syncService.contextFor(owner, BACKEND_ID);
        await syncService.removeBackend(owner, BACKEND_ID);
        await expect(commitLocalEdit(context, async () => null)).rejects.toMatchObject({ code: 'UNKNOWN_BACKEND' });
        await expect(undoLastSync(context)).rejects.toMatchObject({ code: 'UNKNOWN_BACKEND' });
        expect(fs.existsSync(B.shadow.peerDir)).toBe(false);
    });

    test('production local edits read the current device label rather than the context creation label', async () => {
        const B = device();
        await upsertLanBackend({ userRoot: B.userRoot, backendId: BACKEND_ID, label: 'Backend display label', categories: B.ctx.categories });
        await updateRegistry({ userRoot: B.userRoot }, registry => { registry.device.label = 'Old device'; });
        const ctx = await syncService.contextFor({ ...B.ctx, userRoot: B.userRoot }, BACKEND_ID);
        await updateRegistry({ userRoot: B.userRoot }, registry => { registry.device.label = 'Current device'; });
        B.write('worlds/w.json', 'new edit');
        await commitLocalEdit(ctx, async () => null);
        await expectLocalProvenance(B.ctx, 'Current device');
        const before = await resolveRefOrNull(B.shadow.gitDir, MAIN_REF);
        await updateRegistry({ userRoot: B.userRoot }, registry => { registry.device.label = 'Relabeled device'; });
        expect((await commitLocalEdit(ctx, async () => null)).head).toBe(before);
        await expectLocalProvenance(B.ctx, 'Current device');
    });

    test('an entry is stale when HEAD no longer holds kept', async () => {
        const { B } = await conflictOnB();
        B.write('worlds/w.json', 'B2');
        await commitLocalEdit(withoutBackend(B.ctx), async () => null);
        const [entry] = (await readPendingState(ctxMap([BACKEND_ID, withoutBackend(B.ctx)]))).conflicts;
        expect(entry).toMatchObject({ stale: true, current: oid('B2'), kept: oid('B1') });
    });

    test('choosing theirs writes that blob into live, removes the entry and keeps the old version in history', async () => {
        const { B } = await conflictOnB();
        const map = ctxMap([BACKEND_ID, withoutBackend(B.ctx)]);
        expect(await applyConflictChoices(map, await reviewedChoices(map, [{ path: 'worlds/w.json', choice: 'theirs' }]))).toEqual([{ path: 'worlds/w.json', backends: [BACKEND_ID], committedBackends: [BACKEND_ID], applied: true }]);
        expect(B.read('worlds/w.json')).toBe('A1');
        expect((await readPendingState(map)).conflicts).toEqual([]);
        await expectLocalProvenance(B.ctx, 'dev-1');
        const log = await git.log({ fs: atomicFs, gitdir: B.shadow.gitDir, ref: MAIN_REF });
        const older = await readCommitFiles({ gitdir: B.shadow.gitDir, commitOid: log[1].oid });
        expect(older.get('worlds/w.json').oid).toBe(oid('B1'));
    });

    test('keeping the current version only removes the entry', async () => {
        const { B } = await conflictOnB();
        const map = ctxMap([BACKEND_ID, withoutBackend(B.ctx)]);
        await applyConflictChoices(map, await reviewedChoices(map, [{ path: 'worlds/w.json', choice: 'current' }]));
        expect(B.read('worlds/w.json')).toBe('B1');
        expect((await readPendingState(map)).conflicts).toEqual([]);
    });

    test('reviewed choices preserve a live edit made before Apply and require its refreshed evidence', async () => {
        const { B } = await conflictOnB();
        const map = ctxMap([BACKEND_ID, withoutBackend(B.ctx)]);
        const [shown] = (await readPendingState(map)).conflicts;
        const submitted = reviewedChoice(shown, 'theirs');
        B.write(shown.path, 'LIVE_EDIT_BEFORE_APPLY');
        expect(await applyConflictChoices(map, [submitted])).toEqual([expect.objectContaining({ applied: false, committedBackends: [] })]);
        expect(B.read(shown.path)).toBe('LIVE_EDIT_BEFORE_APPLY');
        const [refreshed] = (await readPendingState(map)).conflicts;
        expect(refreshed).toMatchObject({ current: oid('LIVE_EDIT_BEFORE_APPLY'), stale: true, recordVersions: shown.recordVersions });
        expect(refreshed.currentVersions).toEqual({ [BACKEND_ID]: oid('LIVE_EDIT_BEFORE_APPLY') });
        expect(await applyConflictChoices(map, [reviewedChoice(refreshed, 'theirs')])).toEqual([expect.objectContaining({ applied: true, committedBackends: [BACKEND_ID] })]);
        expect(B.read(shown.path)).toBe('A1');
        const log = await git.log({ fs: atomicFs, gitdir: B.shadow.gitDir, ref: MAIN_REF });
        expect((await readCommitFiles({ gitdir: B.shadow.gitDir, commitOid: log[1].oid })).get(shown.path).oid).toBe(oid('LIVE_EDIT_BEFORE_APPLY'));
        expect((await readPendingState(map)).conflicts).toEqual([]);
    });

    test('a reviewed choice cannot select an unseen same-path replacement', async () => {
        const { B } = await conflictOnB();
        const ctx = withoutBackend(B.ctx), map = ctxMap([BACKEND_ID, ctx]);
        const [shown] = (await readPendingState(map)).conflicts;
        const submitted = reviewedChoice(shown, 'theirs');
        await writeRecords(ctx, { [shown.path]: record('replacement', { kept: shown.current, ours: shown.current, theirs: oid('UNSEEN_REPLACEMENT') }) }, { 'extra/replacement': 'UNSEEN_REPLACEMENT' });
        expect(await applyConflictChoices(map, [submitted])).toEqual([expect.objectContaining({ applied: false, committedBackends: [] })]);
        expect(B.read(shown.path)).toBe('B1');
        expect((await readPendingState(map)).conflicts).toEqual([expect.objectContaining({ path: shown.path, theirs: oid('UNSEEN_REPLACEMENT') })]);
    });

    test('grouped choices retain completed outcomes through later repository and selected-blob failures', async () => {
        const B = device(); B.write('worlds/first.json', 'K'); B.write('worlds/last.json', 'K');
        const contexts = ['good-before', 'broken', 'good-after'].map(backendId => ({ ...withoutBackend(B.ctx), backendId }));
        for (const ctx of contexts) await writeRecords(ctx, {
            'worlds/first.json': record('1'),
            'worlds/missing.json': record('1', { kept: null, ours: null, theirs: oid('MISSING_SELECTED_BLOB') }),
            'worlds/last.json': record('1'),
        });
        const map = ctxMap(...contexts.map(ctx => [ctx.backendId, ctx]));
        const shown = (await readPendingState(map)).conflicts;
        const choices = [['worlds/first.json', 'current'], ['worlds/missing.json', 'theirs'], ['worlds/last.json', 'current']].map(([rel, choice]) => reviewedChoice(shown.find(entry => entry.path === rel), choice));
        const objects = path.join(getShadowPaths({ userRoot: B.userRoot, peerId: 'broken' }).gitDir, 'objects');
        contexts[1].lockShadow = async fn => {
            fs.chmodSync(objects, 0o000);
            try { return await fn(); } finally { fs.chmodSync(objects, 0o700); }
        };
        expect(await applyConflictChoices(map, choices)).toEqual([
            { path: 'worlds/first.json', backends: ['good-before', 'broken', 'good-after'], committedBackends: ['good-before', 'good-after'], applied: false, errors: { broken: expect.objectContaining({ code: 'CONFLICT_COMMIT_FAILED' }) } },
            { path: 'worlds/missing.json', backends: ['good-before', 'broken', 'good-after'], committedBackends: [], applied: false, errors: { 'good-before': expect.objectContaining({ code: 'CONFLICT_BLOB_READ_FAILED' }) } },
            { path: 'worlds/last.json', backends: ['good-before', 'broken', 'good-after'], committedBackends: ['good-before', 'good-after'], applied: false, errors: { broken: expect.objectContaining({ code: 'CONFLICT_COMMIT_FAILED' }) } },
        ]);
        expect((await readPendingState(map)).conflicts.map(({ path, backends }) => ({ path, backends }))).toEqual([
            { path: 'worlds/first.json', backends: ['broken'] },
            { path: 'worlds/last.json', backends: ['broken'] },
            { path: 'worlds/missing.json', backends: ['good-before', 'broken', 'good-after'] },
        ]);
        expect([B.read('worlds/first.json'), B.read('worlds/last.json')]).toEqual(['K', 'K']);
    });

    test.each(['removed', 'replaced'])('a queued choice revalidates a %s record under its edit lock', async (change) => {
        const { B } = await conflictOnB();
        const ctx = withoutBackend(B.ctx);
        let admitted;
        let release;
        const arrived = new Promise(resolve => { admitted = resolve; });
        const barrier = new Promise(resolve => { release = resolve; });
        const map = ctxMap([BACKEND_ID, { ...ctx, lockShadow: async fn => { admitted(); await barrier; return fn(); } }]);
        const queued = applyConflictChoices(map, await reviewedChoices(map, [{ path: 'worlds/w.json', choice: 'theirs' }]));
        await arrived;
        if (change === 'removed') await applyConflictChoices(ctxMap([BACKEND_ID, ctx]), await reviewedChoices(ctxMap([BACKEND_ID, ctx]), [{ path: 'worlds/w.json', choice: 'current' }]));
        else await writeRecords(ctx, { 'worlds/w.json': record('replacement', { kept: oid('B1'), ours: oid('B1'), theirs: oid('A1') }) });
        release();
        expect(await queued).toEqual([expect.objectContaining({ applied: false, committedBackends: [] })]);
        expect(B.read('worlds/w.json')).toBe('B1');
        expect((await readPendingState(ctxMap([BACKEND_ID, ctx]))).conflicts).toHaveLength(change === 'removed' ? 0 : 1);
    });

    test.each(['directory', 'symlink'])('a regular choice refused by a live %s stays pending', async (obstruction) => {
        const { B } = await conflictOnB();
        const file = path.join(B.directories.worlds, 'w.json');
        fs.unlinkSync(file);
        if (obstruction === 'directory') fs.mkdirSync(file);
        else fs.symlinkSync(path.join(B.directories.root, 'outside'), file);
        const map = ctxMap([BACKEND_ID, withoutBackend(B.ctx)]);
        expect(await applyConflictChoices(map, await reviewedChoices(map, [{ path: 'worlds/w.json', choice: 'theirs' }]))).toEqual([expect.objectContaining({ applied: false, committedBackends: [] })]);
        expect((await readPendingState(map)).conflicts).toHaveLength(1);
        expect(fs.lstatSync(file).isSymbolicLink()).toBe(obstruction === 'symlink');
    });

    test('an unknown choice is rejected before any choice is applied', async () => {
        const { B } = await conflictOnB();
        const map = ctxMap([BACKEND_ID, withoutBackend(B.ctx)]);
        await expect(applyConflictChoices(map, await reviewedChoices(map, [{ path: 'worlds/w.json', choice: 'theirs' }, { path: 'worlds/w.json', choice: 'mine' }]))).rejects.toMatchObject({ code: 'INVALID_CHOICE' });
        expect(B.read('worlds/w.json')).toBe('B1');
        expect((await readPendingState(map)).conflicts).toHaveLength(1);
    });

    test.each(['ours', 'theirs'])('choosing a side that deleted the file toward %s deletes it and removes the entry', async (choice) => {
        const B = device();
        B.write('worlds/w.json', 'K');
        const ctx = withoutBackend(B.ctx);
        const map = ctxMap([BACKEND_ID, ctx]);
        await writeRecords(ctx, { 'worlds/w.json': record('1', { kept: oid('K'), [choice]: null }) });
        expect(await applyConflictChoices(map, await reviewedChoices(map, [{ path: 'worlds/w.json', choice }]))).toEqual([expect.objectContaining({ path: 'worlds/w.json', applied: true })]);
        expect(B.read('worlds/w.json')).toBeNull();
        expect((await readPendingState(map)).conflicts).toEqual([]);
        expect((await mainFiles(ctx)).has('worlds/w.json')).toBe(false);
    });

    test('a choice on a grouped path is applied on every backend', async () => {
        const B = device();
        B.write('worlds/w.json', 'K');
        const r1 = { ...withoutBackend(B.ctx), backendId: 'r1' };
        const r2 = { ...withoutBackend(B.ctx), backendId: 'r2' };
        await writeRecords(r1, { 'worlds/w.json': record('2', { theirs: oid('T') }) }, { 'extra/source.bin': 'T' });
        await writeRecords(r2, { 'worlds/w.json': record('2', { theirs: oid('T') }) }, { 'extra/source.bin': 'T' });
        const map = ctxMap(['r1', r1], ['r2', r2]);
        const choices = await reviewedChoices(ctxMap(['r2', r2], ['r1', r1]), [{ path: 'worlds/w.json', choice: 'theirs' }]);
        expect(choices[0].review.backendId).toBe('r2');
        const [result] = await applyConflictChoices(map, choices);
        expect(result).toEqual({ path: 'worlds/w.json', backends: ['r1', 'r2'], committedBackends: ['r1', 'r2'], applied: true });
        expect(B.read('worlds/w.json')).toBe('T');
        for (const ctx of [r1, r2]) {
            const files = await mainFiles(ctx);
            expect(files.get('worlds/w.json').oid).toBe(oid('T'));
            expect(files.has(CONFLICTS_PATH)).toBe(false);
        }
    });

    test.each(['ours', 'theirs'])('resolving a group file toward %s keeps the branch chats the fork appended', async (choice) => {
        const B = device();
        const branch = 'gc1 - Sync conflict Phone 2026-10-13 09.05';
        const group = chats => JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats }, null, 4);
        B.write('groups/g1.json', group(['gc1', branch]));
        B.write('group chats/gc1.jsonl', '{}');
        B.write(`group chats/${branch}.jsonl`, '{}');
        const ctx = withoutBackend(B.ctx);
        await writeRecords(ctx, { 'groups/g1.json': record('1', { kept: oid(group(['gc1', branch])), [choice]: oid(group(['gc1'])) }) }, { 'extra/side-group.json': group(['gc1']) });
        await applyConflictChoices(ctxMap([BACKEND_ID, ctx]), await reviewedChoices(ctxMap([BACKEND_ID, ctx]), [{ path: 'groups/g1.json', choice }]));
        expect(JSON.parse(B.read('groups/g1.json')).chats).toEqual(['gc1', branch]);
        expect((await readPendingState(ctxMap([BACKEND_ID, ctx]))).conflicts).toEqual([]);
    });

    test('resolving a group file drops a chat id whose chat file is gone', async () => {
        const B = device();
        const group = chats => JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats }, null, 4);
        B.write('groups/g1.json', group(['gc1', 'gone']));
        B.write('group chats/gc1.jsonl', '{}');
        const ctx = withoutBackend(B.ctx);
        await writeRecords(ctx, { 'groups/g1.json': record('1', { kept: oid(group(['gc1', 'gone'])), theirs: oid(group(['gc1'])) }) }, { 'extra/side-group.json': group(['gc1']) });
        await applyConflictChoices(ctxMap([BACKEND_ID, ctx]), await reviewedChoices(ctxMap([BACKEND_ID, ctx]), [{ path: 'groups/g1.json', choice: 'theirs' }]));
        expect(JSON.parse(B.read('groups/g1.json')).chats).toEqual(['gc1']);
    });

    test('a companion chosen while its parent path is a directory leaves the directory alone', async () => {
        const B = device();
        B.write('chats/S/c1.jsonl/notes.txt', 'N');
        const ctx = withoutBackend(B.ctx);
        await commitLocalEdit(ctx, async () => null);
        expect((await mainFiles(ctx)).has('chats/S/c1.jsonl/notes.txt')).toBe(true);
        const statePath = 'chats/S/c1.luker-state.mg.json';
        await commitLocalEdit(ctx, async ({ gitdir, files }) => {
            const blob = content => git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from(content) });
            const tree = await writeTreeFromFiles({ gitdir, files: new Map([['chats/S/c1.jsonl', { oid: await blob('{}'), mode: '100644' }]]) });
            const theirsCommit = await git.commit({ fs: atomicFs, gitdir, message: 'theirs', author: SYNC_AUTHOR, tree, parent: [], noUpdateBranch: true });
            const next = new Map(files);
            await blob('{"v":1}');
            next.set(CONFLICTS_PATH, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob: serializeEntries({ [statePath]: record('1', { kept: null, ours: null, theirs: oid('{"v":1}'), mergeParents: [theirsCommit, theirsCommit] }) }) }), mode: '100644' });
            return { files: next, message: 'test records' };
        });
        const map = ctxMap([BACKEND_ID, ctx]);
        expect(await applyConflictChoices(map, await reviewedChoices(map, [{ path: statePath, choice: 'theirs' }]))).toEqual([expect.objectContaining({ applied: true })]);
        expect((await mainFiles(ctx)).has('chats/S/c1.jsonl')).toBe(false);
        expect(B.read('chats/S/c1.jsonl/notes.txt')).toBe('N');
        expect(B.read(statePath)).toBe('{"v":1}');
    });

    test('pending notices carry their kind', async () => {
        const B = device();
        B.write('worlds/x.json', 'X');
        const target = { kind: 'character', avatar: 'S.png', name: 'n' };
        const ctx = withoutBackend(B.ctx);
        await writeNotices(ctx, {
            'chats/S/branch.jsonl': { chat: 'chats/S/c.jsonl', device: 'Phone', createdAt: '1', target },
            'chats/S/kept.jsonl': { kind: 'restored', device: 'Phone', createdAt: '1', target },
        });
        const { notices } = await readPendingState(ctxMap([BACKEND_ID, ctx]));
        expect(notices).toEqual([
            expect.objectContaining({ path: 'chats/S/branch.jsonl', kind: 'fork', chat: 'chats/S/c.jsonl' }),
            expect.objectContaining({ path: 'chats/S/kept.jsonl', kind: 'restored' }),
        ]);
    });

    test('dismissing a notice removes it on every backend that lists it', async () => {
        const B = device();
        B.write('worlds/x.json', 'X');
        const notice = { chat: 'chats/S/c.jsonl', device: 'Phone', createdAt: '1', target: { kind: 'character', avatar: 'S.png', name: 'n' } };
        const r1 = { ...withoutBackend(B.ctx), backendId: 'r1' };
        const r2 = { ...withoutBackend(B.ctx), backendId: 'r2' };
        await writeNotices(r1, { 'chats/S/n.jsonl': notice });
        await writeNotices(r2, { 'chats/S/n.jsonl': notice });
        const map = ctxMap(['r1', r1], ['r2', r2]);
        expect((await readPendingState(map)).notices).toEqual([expect.objectContaining({ path: 'chats/S/n.jsonl', backends: ['r1', 'r2'] })]);
        expect(await dismissNotices(map, ['chats/S/n.jsonl'])).toEqual([{ path: 'chats/S/n.jsonl', backends: ['r1', 'r2'], committedBackends: ['r1', 'r2'], applied: true }]);
        expect((await readPendingState(map)).notices).toEqual([]);
        await expectLocalProvenance(r1, 'dev-0');
        await expectLocalProvenance(r2, 'dev-0');
    });

    test('dismissing an authoritatively absent notice is an idempotent success without a new commitment', async () => {
        const B = device();
        const context = withoutBackend(B.ctx);
        await commitLocalEdit(context, async () => null);
        const before = await resolveRefOrNull(B.shadow.gitDir, MAIN_REF);
        expect(await dismissNotices(ctxMap([BACKEND_ID, context]), ['group chats/absent.jsonl'])).toEqual([{ path: 'group chats/absent.jsonl', backends: [], committedBackends: [], applied: true }]);
        expect(await resolveRefOrNull(B.shadow.gitDir, MAIN_REF)).toBe(before);
    });

    test('grouped notice dismissal commits readable work while an unreadable backend remains unresolved through exact recovery', async () => {
        const B = device();
        const notice = { kind: 'restored', device: 'Phone', createdAt: '1', target: { kind: 'group', groupId: null, name: 'kept' } };
        const r1 = { ...withoutBackend(B.ctx), backendId: 'r1' };
        const r2 = { ...withoutBackend(B.ctx), backendId: 'r2' };
        for (const context of [r1, r2]) {
            await writeNotices(context, { 'group chats/kept.jsonl': notice });
            await upsertLanBackend({ userRoot: B.userRoot, backendId: context.backendId, categories: B.ctx.categories });
        }
        const gitdir = getShadowPaths({ userRoot: B.userRoot, peerId: 'r1' }).gitDir;
        const original = await resolveRefOrNull(gitdir, MAIN_REF);
        const entry = (await mainFiles(r1)).get(NOTICES_PATH);
        const file = path.join(gitdir, 'objects', entry.oid.slice(0, 2), entry.oid.slice(2));
        const bytes = fs.readFileSync(file);
        fs.writeFileSync(file, 'unreadable notice object');
        const owner = { ...B.ctx, userRoot: B.userRoot };
        try {
            const results = await syncService.withLocalMutationContexts(owner, ['r1', 'r2'], contexts => dismissNotices(contexts, ['group chats/kept.jsonl']), { allowPreparationErrors: true });
            expect(results).toEqual([{ path: 'group chats/kept.jsonl', backends: ['r2'], committedBackends: ['r2'], applied: false, errors: { r1: expect.objectContaining({ code: 'PENDING_READ_FAILED' }) } }]);
            expect(await resolveRefOrNull(gitdir, MAIN_REF)).toBe(original);
            expect((await mainFiles(r2)).has(NOTICES_PATH)).toBe(false);
        } finally { fs.writeFileSync(file, bytes); }
        const contexts = ctxMap(['r1', r1], ['r2', r2]);
        expect((await readPendingState(contexts)).notices).toEqual([expect.objectContaining({ path: 'group chats/kept.jsonl', backends: ['r1'], ...notice })]);
        expect(await dismissNotices(contexts, ['group chats/kept.jsonl'])).toEqual([{ path: 'group chats/kept.jsonl', backends: ['r1'], committedBackends: ['r1'], applied: true }]);
        expect((await readPendingState(contexts)).notices).toEqual([]);
    });

    test('a real filesystem failure committing one notice does not discard another backend commitment', async () => {
        const B = device();
        const rel = 'group chats/kept.jsonl';
        const notice = { kind: 'restored', device: 'Phone', createdAt: '1', target: { kind: 'group', groupId: null, name: 'kept' } };
        const r1 = { ...withoutBackend(B.ctx), backendId: 'r1' };
        const r2 = { ...withoutBackend(B.ctx), backendId: 'r2' };
        await writeNotices(r1, { [rel]: notice }); await writeNotices(r2, { [rel]: notice });
        const objects = path.join(getShadowPaths({ userRoot: B.userRoot, peerId: 'r1' }).gitDir, 'objects');
        r1.lockShadow = async fn => {
            fs.chmodSync(objects, 0o000);
            try { return await fn(); } finally { fs.chmodSync(objects, 0o700); }
        };
        expect(await dismissNotices(ctxMap(['r1', r1], ['r2', r2]), [rel])).toEqual([{ path: rel, backends: ['r1', 'r2'], committedBackends: ['r2'], applied: false, errors: { r1: expect.objectContaining({ code: 'NOTICE_DISMISS_FAILED' }) } }]);
        expect((await readPendingState(ctxMap(['r1', r1], ['r2', r2]))).notices).toEqual([expect.objectContaining({ path: rel, backends: ['r1'] })]);
    });

    test('undo reverts what the last sync brought in and keeps later edits', async () => {
        const A = device();
        A.write('worlds/a.json', 'A0');
        A.write('worlds/b.json', 'B0');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.write('worlds/a.json', 'A1');
        A.write('worlds/b.json', 'B1');
        A.write('worlds/new.json', 'N');
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        B.write('worlds/b.json', 'B-later');
        const result = await undoLastSync(withoutBackend(B.ctx));
        expect(result).toMatchObject({ committed: true, reverted: ['worlds/a.json', 'worlds/new.json'], keptEdited: ['worlds/b.json'] });
        expect(result.restoredTag.startsWith('sync-backup-')).toBe(true);
        expect([B.read('worlds/a.json'), B.read('worlds/b.json'), B.read('worlds/new.json')]).toEqual(['A0', 'B-later', null]);
        const { commit } = await git.readCommit({ fs: atomicFs, gitdir: B.shadow.gitDir, oid: result.head });
        expect(commit.message.trim()).toBe(`undo sync ${result.restoredTag}`);
        await expectLocalProvenance(B.ctx, 'dev-1');
        await expect(undoLastSync(withoutBackend(B.ctx))).rejects.toMatchObject({ code: 'NO_BACKUP_TAG' });
        expect((await runSyncCycle(B.ctx)).pushed).toBe(true);
        await runSyncCycle(A.ctx);
        expect([A.read('worlds/a.json'), A.read('worlds/b.json'), A.read('worlds/new.json')]).toEqual(['A0', 'B-later', null]);
    });

    test('an undo whose live write is skipped reports nothing reverted and keeps the undo point', async () => {
        const A = device();
        A.write('worlds/d/x.json', 'X');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.remove('worlds/d/x.json');
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        expect(B.read('worlds/d/x.json')).toBeNull();
        B.write('worlds/d', 'a file where the directory was');
        const result = await undoLastSync(withoutBackend(B.ctx));
        expect(result).toMatchObject({ committed: false, reverted: [] });
        expect(B.read('worlds/d')).toBe('a file where the directory was');
        expect((await undoLastSync(withoutBackend(B.ctx))).restoredTag).toBe(result.restoredTag);
    });

    test('all-kept Undo commits the unchanged snapshot tree and consumes its matching point', async () => {
        const A = device(); A.write('worlds/w.json', 'before'); await runSyncCycle(A.ctx);
        const B = device(); await runSyncCycle(B.ctx);
        A.write('worlds/w.json', 'incoming'); await runSyncCycle(A.ctx); await runSyncCycle(B.ctx);
        B.write('worlds/w.json', 'later retained edit');
        const result = await undoLastSync(withoutBackend(B.ctx));
        expect(result).toMatchObject({ committed: true, reverted: [], keptEdited: ['worlds/w.json'] });
        expect(B.read('worlds/w.json')).toBe('later retained edit');
        const { commit } = await git.readCommit({ fs: atomicFs, gitdir: B.shadow.gitDir, oid: result.head });
        const { commit: parent } = await git.readCommit({ fs: atomicFs, gitdir: B.shadow.gitDir, oid: commit.parent[0] });
        expect(commit.tree).toBe(parent.tree);
        expect(commit.message.trim()).toBe(`undo sync ${result.restoredTag}`);
        await expect(undoLastSync(withoutBackend(B.ctx))).rejects.toMatchObject({ code: 'NO_BACKUP_TAG' });
    });

    test('admitted undo counts its ref cleanup while maintenance is pending', async () => {
        expect(PAUSEPOINTS.UNDO_BEFORE_CLEANUP).toBe('undo-before-cleanup');
        const A = device(); A.write('worlds/w.json', 'before'); await runSyncCycle(A.ctx);
        const B = device(); await runSyncCycle(B.ctx);
        A.write('worlds/w.json', 'after'); await runSyncCycle(A.ctx); await runSyncCycle(B.ctx);
        await upsertLanBackend({ userRoot: B.userRoot, backendId: BACKEND_ID, label: 'remote', categories: B.ctx.categories });
        const owner = { ...B.ctx, userRoot: B.userRoot };
        const name = PAUSEPOINTS.UNDO_BEFORE_CLEANUP;
        const dir = path.join(B.userRoot, 'barriers'); fs.mkdirSync(dir);
        process.env.LUKER_SYNC_PAUSEPOINT = name; process.env.LUKER_SYNC_PAUSE_DIR = dir;
        fs.writeFileSync(path.join(dir, `${name}.arm`), '');
        try {
            const arrived = new Promise(resolve => {
                const watcher = fs.watch(dir);
                const check = () => { if (fs.existsSync(path.join(dir, `${name}.reached`))) { watcher.close(); resolve(); } };
                watcher.on('change', check); check();
            });
            const undo = syncService.withLocalMutationContexts(owner, [BACKEND_ID], contexts => undoLastSync(contexts.get(BACKEND_ID)));
            await arrived;
            let maintained = false;
            const maintenance = syncService.withBackendMaintenance(owner, BACKEND_ID, async () => { maintained = true; });
            expect(maintained).toBe(false);
            fs.writeFileSync(path.join(dir, `${name}.release`), '');
            expect(await undo).toMatchObject({ committed: true, reverted: ['worlds/w.json'] });
            await maintenance;
            expect(B.read('worlds/w.json')).toBe('before');
            await expect(syncService.withLocalMutationContexts(owner, [BACKEND_ID], contexts => undoLastSync(contexts.get(BACKEND_ID)))).rejects.toMatchObject({ code: 'NO_BACKUP_TAG' });
        } finally {
            delete process.env.LUKER_SYNC_PAUSEPOINT; delete process.env.LUKER_SYNC_PAUSE_DIR;
            fs.writeFileSync(path.join(dir, `${name}.release`), '');
        }
    });

    // Runs `before` once, outside every lock, ahead of the shadow lock section numbered `call`.
    const lockShadowRunning = (call, before) => {
        let calls = 0;
        return async (fn) => {
            calls++;
            if (calls === call) await before();
            return fn();
        };
    };
    async function twoSyncsOnB() {
        const A = device();
        A.write('worlds/a.json', 'A0');
        A.write('worlds/b.json', 'B0');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.write('worlds/a.json', 'A1');
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        A.write('worlds/b.json', 'B1');
        await runSyncCycle(A.ctx);
        return { A, B };
    }

    test('undo reverts a sync that lands before it takes the shadow lock', async () => {
        const { B } = await twoSyncsOnB();
        const result = await undoLastSync({ ...withoutBackend(B.ctx), lockShadow: lockShadowRunning(1, () => runSyncCycle(B.ctx)) });
        expect(result).toMatchObject({ committed: true, reverted: ['worlds/b.json'] });
        expect([B.read('worlds/a.json'), B.read('worlds/b.json')]).toEqual(['A1', 'B0']);
    });

    test('undo keeps the undo point of a sync that lands before the point is cleared', async () => {
        const { B } = await twoSyncsOnB();
        const first = await undoLastSync({ ...withoutBackend(B.ctx), lockShadow: lockShadowRunning(2, () => runSyncCycle(B.ctx)) });
        expect(first).toMatchObject({ committed: true, reverted: ['worlds/a.json'] });
        expect([B.read('worlds/a.json'), B.read('worlds/b.json')]).toEqual(['A0', 'B1']);
        const second = await undoLastSync(withoutBackend(B.ctx));
        expect(second).toMatchObject({ committed: true, reverted: ['worlds/b.json'] });
        expect(second.restoredTag).not.toBe(first.restoredTag);
        expect([B.read('worlds/a.json'), B.read('worlds/b.json')]).toEqual(['A0', 'B0']);
    });

    test('undo without a backup tag throws NO_BACKUP_TAG', async () => {
        const A = device();
        A.write('worlds/a.json', 'A0');
        await runSyncCycle(A.ctx);
        await expect(undoLastSync(withoutBackend(A.ctx))).rejects.toMatchObject({ code: 'NO_BACKUP_TAG' });
    });

    test.each([false, true])('undo retains ownership of an edited group chat with an existing group: %s', async (existing) => {
        const A = device();
        A.write('worlds/base.json', 'base');
        const group = chats => JSON.stringify({ id: 'g', name: 'group', chats, chat_id: chats.at(-1) }, null, 4);
        if (existing) A.write('groups/g.json', group(['old']));
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.write('groups/g.json', group(existing ? ['old', 'c'] : ['c']));
        A.write('group chats/c.jsonl', '{}\n');
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        B.write('group chats/c.jsonl', '{}\n{"mes":"later"}\n');
        await undoLastSync(withoutBackend(B.ctx));
        expect(JSON.parse(B.read('groups/g.json'))).toMatchObject({ chats: existing ? ['old', 'c'] : ['c'], chat_id: 'c' });
        await runSyncCycle(B.ctx);
        await runSyncCycle(A.ctx);
        expect(JSON.parse(A.read('groups/g.json')).chats).toContain('c');
        expect(A.read('group chats/c.jsonl')).toContain('later');
    });
});

describe.each(CONTRACT_HARNESSES.filter(h => h.name !== 'FsEngine'))('resolving a state companion conflict — $name', ({ make }) => {
    let remote;
    const harnesses = [];

    async function device(label) {
        const h = withNestedDirs(await make());
        harnesses.push(h);
        fs.mkdirSync(h.dirs.openAI_Settings, { recursive: true });
        fs.mkdirSync(h.dirs.chats, { recursive: true });
        const userRoot = h.dirs.root;
        const ctx = {
            userRoot,
            handle: h.handle,
            directories: h.dirs,
            backendId: BACKEND_ID,
            categories: ['openai-presets', 'chats'],
            engine: h.engine,
            backend: new DirectoryBackend({ id: BACKEND_ID, remoteDir: remote.remoteDir, userRoot }),
            onConflicts: createConflictPolicy({ directories: h.dirs, localDevice: label, remoteDevice: 'remote' }),
        };
        const write = (rec, value) => h.engine.withTransaction(h.handle, tx => writeSqlRecordValue(tx, h.handle, rec, value));
        const read = rec => h.engine.withTransaction(h.handle, tx => readSqlRecordValue(tx, h.handle, rec));
        const rel = abs => path.relative(h.dirs.root, abs).split(path.sep).join('/');
        return { h, ctx, write, read, rel };
    }
    const chat = { kind: 'chat', charDir: 'Seraphina', name: 'c1', isGroup: false };
    const chatState = { ...chat, kind: 'chat-state', namespace: 'mg' };
    const chatValue = { header: { user_name: 'U', character_name: 'Seraphina', chat_metadata: {} }, body: [{ name: 'U', is_user: true, mes: 'hi' }] };

    beforeEach(async () => {
        _resetGateForTests();
        remote = await makeRemote();
    });
    afterEach(async () => {
        for (const h of harnesses.splice(0)) await h.cleanup();
        remote.cleanup();
    });

    test('legacy state choices retain their original keys through canonical snapshots and forward undo without changing an independent delimiter document', async () => {
        const A = await device('Desk');
        const doc = { kind: 'preset', dirKey: 'openAI_Settings', name: 'A.luker-state.n' };
        const counter = { kind: 'preset', dirKey: 'openAI_Settings', name: 'Counter' };
        const short = { kind: 'preset-state', dirKey: 'openAI_Settings', name: 'A', namespace: 'n' };
        const long = { kind: 'preset-state', dirKey: 'openAI_Settings', name: 'é'.repeat(100), namespace: 'x'.repeat(100) };
        const independent = { prompts: [{ content: 'INDEPENDENT_PRESET' }], temperature: 0.31 };
        await A.write(doc, independent);
        await A.write(counter, { counter: 1 });
        await A.write(short, { value: 'BEFORE_SHORT' });
        await A.write(long, { value: 'KEPT_LONG' });
        await runSyncCycle(A.ctx);
        const B = await device('Tablet');
        await runSyncCycle(B.ctx);
        await A.write(counter, { counter: 2 });
        await A.write(short, { value: 'KEPT_SHORT' });
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        const ctx = withoutBackend(B.ctx);
        const { gitDir: gitdir } = getShadowPaths({ userRoot: ctx.userRoot, peerId: BACKEND_ID });
        const original = await resolveRefOrNull(gitdir, MAIN_REF);
        const current = await readCommitFiles({ gitdir, commitOid: original });
        const prefix = B.rel(B.h.dirs.openAI_Settings);
        const shortPath = `${prefix}/A.luker-state.n.json`;
        const longPath = `${prefix}/${long.name}.luker-state.${long.namespace}.json`;
        const chosenShort = '{"value":"CHOSEN_SHORT"}';
        const chosenLong = '{"value":"CHOSEN_LONG"}';
        const theirsShort = await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from(chosenShort) });
        const theirsLong = await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from(chosenLong) });
        const longBytes = '{"value":"KEPT_LONG"}';
        const records = {
            [shortPath]: record('2026-10-01T00:00:00.000Z', { kept: current.get(shortPath).oid, ours: current.get(shortPath).oid, theirs: theirsShort, mergeParents: [original, original] }),
            [longPath]: record('2026-10-01T00:00:00.000Z', { kept: oid(longBytes), ours: oid(longBytes), theirs: theirsLong, mergeParents: [original, original] }),
        };
        const payload = Object.fromEntries(await Promise.all([...current].map(async ([name, entry]) => [name, (await readBlobBytes({ gitdir, oid: entry.oid })).toString('utf8')])));
        delete payload[encodePresetRecordPath(B.h.dirs, long)];
        payload[longPath] = longBytes;
        payload[CONFLICTS_PATH] = serializeEntries(records).toString('utf8');
        const legacyHead = await commitFiles(gitdir, payload, [original]);
        await git.writeRef({ fs: atomicFs, gitdir, ref: MAIN_REF, value: legacyHead, force: true });
        const map = new Map([[BACKEND_ID, ctx]]);
        const before = await readPendingState(map);
        expect(before.conflicts.map(entry => entry.path).sort()).toEqual([shortPath, longPath].sort());
        await commitLocalEdit(ctx, async () => null);
        const afterSnapshot = await readPendingState(map);
        expect(afterSnapshot.conflicts.map(entry => ({ path: entry.path, current: entry.current, kept: entry.kept, recordVersions: entry.recordVersions }))).toEqual(before.conflicts.map(entry => ({ path: entry.path, current: entry.current, kept: entry.kept, recordVersions: entry.recordVersions })));
        expect(await applyConflictChoices(map, await reviewedChoices(map, [{ path: shortPath, choice: 'theirs' }, { path: longPath, choice: 'theirs' }]))).toEqual([
            expect.objectContaining({ path: shortPath, applied: true }), expect.objectContaining({ path: longPath, applied: true }),
        ]);
        expect(await B.read(doc)).toEqual(independent);
        expect(await B.read(short)).toEqual({ value: 'CHOSEN_SHORT' });
        expect(await B.read(long)).toEqual({ value: 'CHOSEN_LONG' });
        expect((await readPendingState(map)).conflicts).toEqual([]);
        expect(await undoLastSync(ctx)).toMatchObject({ committed: true });
        expect(await B.read(counter)).toEqual({ counter: 1 });
        expect(await B.read(doc)).toEqual(independent);
        expect(await B.read(short)).toEqual({ value: 'CHOSEN_SHORT' });
        await runSyncCycle(B.ctx);
        await runSyncCycle(A.ctx);
        await runSyncCycle(A.ctx);
        for (const d of [A, B]) {
            expect(await d.read(doc)).toEqual(independent);
            expect(await d.read(short)).toEqual({ value: 'CHOSEN_SHORT' });
            expect(await d.read(long)).toEqual({ value: 'CHOSEN_LONG' });
            expect(await d.read(counter)).toEqual({ counter: 1 });
        }
        const oldEntry = (await readCommitFiles({ gitdir, commitOid: legacyHead })).get(longPath);
        expect(oldEntry.oid).toBe(oid(longBytes));
        expect((await readBlobBytes({ gitdir, oid: oldEntry.oid })).toString('utf8')).toBe(longBytes);
        expect(await git.isDescendent({ fs: atomicFs, gitdir, oid: await resolveRefOrNull(gitdir, MAIN_REF), ancestor: legacyHead })).toBe(true);
    }, 90_000);

    test('choosing theirs for the companion of a deleted preset restores the preset with it', async () => {
        const preset = { kind: 'preset', dirKey: 'openAI_Settings', name: 'creative' };
        const state = { kind: 'preset-state', dirKey: 'openAI_Settings', name: 'creative', namespace: 'iter' };
        const A = await device('Desk');
        await A.write(preset, { temperature: 0.7 });
        await A.write(state, { n: 0 });
        await runSyncCycle(A.ctx);
        const B = await device('Phone');
        await runSyncCycle(B.ctx);
        await B.write(state, null);
        await B.write(preset, null);
        await A.write(state, { n: 1 });
        await runSyncCycle(A.ctx);
        await orderLocalHead(B.ctx, await remoteHead(remote.remoteDir), true);
        expect(await runSyncCycle(B.ctx)).toMatchObject({ status: 'synced', mergeCase: 'merged' });

        const statePath = `${path.relative(B.h.dirs.root, B.h.dirs.openAI_Settings).split(path.sep).join('/')}/creative.luker-state.iter.json`;
        const presetPath = statePath.replace('.luker-state.iter.json', '.json');
        const map = new Map([[BACKEND_ID, withoutBackend(B.ctx)]]);
        const { conflicts } = await readPendingState(map);
        expect(conflicts).toEqual([expect.objectContaining({ path: statePath, kept: null, ours: null, current: null })]);
        expect((await mainFiles(B.ctx)).has(presetPath)).toBe(false);

        expect(await applyConflictChoices(map, await reviewedChoices(map, [{ path: statePath, choice: 'theirs' }]))).toEqual([{ path: statePath, backends: [BACKEND_ID], committedBackends: [BACKEND_ID], applied: true }]);
        expect(await B.read(preset)).toEqual({ temperature: 0.7 });
        expect(await B.read(state)).toEqual({ n: 1 });
        expect((await readPendingState(map)).conflicts).toEqual([]);
        expect(await runSyncCycle(B.ctx)).toMatchObject({ status: 'synced', pushed: true });
        expect(await runSyncCycle(A.ctx)).toMatchObject({ status: 'synced' });
        expect(await A.read(preset)).toEqual({ temperature: 0.7 });
        expect(await A.read(state)).toEqual({ n: 1 });
    }, 60_000);

    test('a choice whose live write is skipped stays pending and names no committed backend', async () => {
        const B = await device('Phone');
        const ctx = withoutBackend(B.ctx);
        const statePath = `${B.rel(B.h.dirs.chats)}/Seraphina/c1.luker-state.mg.json`;
        const theirs = JSON.stringify({ v: 1 });
        await writeRecords(ctx, { [statePath]: record('1', { kept: null, ours: null, theirs: oid(theirs) }) }, { 'extra/state.json': theirs });
        const map = new Map([[BACKEND_ID, ctx]]);
        expect(await applyConflictChoices(map, await reviewedChoices(map, [{ path: statePath, choice: 'theirs' }]))).toEqual([{ path: statePath, backends: [BACKEND_ID], committedBackends: [], applied: false }]);
        expect(await B.read(chatState)).toBeNull();
        expect((await readPendingState(map)).conflicts).toEqual([expect.objectContaining({ path: statePath })]);
    }, 60_000);

    test('an unrepresentable SQL regular choice stays pending without advancing its choice', async () => {
        const B = await device('Phone');
        const ctx = withoutBackend(B.ctx);
        const relPath = `${B.rel(B.h.dirs.openAI_Settings)}/nested/unrepresentable.json`;
        const bytes = '{"temperature":0.9}';
        await writeRecords(ctx, { [relPath]: record('1', { kept: null, ours: null, theirs: oid(bytes) }) }, { 'extra/value.json': bytes });
        const map = new Map([[BACKEND_ID, ctx]]);
        expect(await applyConflictChoices(map, await reviewedChoices(map, [{ path: relPath, choice: 'theirs' }]))).toEqual([expect.objectContaining({ applied: false, committedBackends: [] })]);
        expect((await readPendingState(map)).conflicts).toEqual([expect.objectContaining({ path: relPath })]);
        expect((await mainFiles(ctx)).has(relPath)).toBe(false);
    }, 60_000);

    test('a chosen orphan preset state survives a fresh snapshot and propagation without a parent', async () => {
        const B = await device('Phone');
        const ctx = withoutBackend(B.ctx);
        const relPath = `${B.rel(B.h.dirs.openAI_Settings)}/missing.luker-state.notes.json`;
        const bytes = '{"recoverable":true}';
        await writeRecords(ctx, { [relPath]: record('1', { kept: null, ours: null, theirs: oid(bytes) }) }, { 'extra/value.json': bytes });
        const map = new Map([[BACKEND_ID, ctx]]);
        expect(await applyConflictChoices(map, await reviewedChoices(map, [{ path: relPath, choice: 'theirs' }]))).toEqual([expect.objectContaining({ applied: true })]);
        await runSyncCycle(B.ctx);
        const A = await device('Desk');
        await runSyncCycle(A.ctx);
        await runSyncCycle(A.ctx);
        for (const d of [A, B]) {
            expect(await d.read({ kind: 'preset-state', dirKey: 'openAI_Settings', name: 'missing', namespace: 'notes' })).toEqual({ recoverable: true });
            expect(await d.read({ kind: 'preset', dirKey: 'openAI_Settings', name: 'missing' })).toBeNull();
        }
    }, 60_000);

    test('choosing a side that deleted a chat deletes its state companions too', async () => {
        const B = await device('Phone');
        await B.write(chat, chatValue);
        await B.write(chatState, { v: 0 });
        const ctx = withoutBackend(B.ctx);
        const chatPath = `${B.rel(B.h.dirs.chats)}/Seraphina/c1.jsonl`;
        const statePath = `${B.rel(B.h.dirs.chats)}/Seraphina/c1.luker-state.mg.json`;
        await writeRecords(ctx, { [chatPath]: record('1', { theirs: null }), [statePath]: record('1', { ours: null, theirs: null }) });
        const map = new Map([[BACKEND_ID, ctx]]);
        expect(await applyConflictChoices(map, await reviewedChoices(map, [{ path: chatPath, choice: 'theirs' }]))).toEqual([expect.objectContaining({ path: chatPath, applied: true })]);
        expect(await B.read(chat)).toBeNull();
        expect(await B.read(chatState)).toBeNull();
        expect((await readPendingState(map)).conflicts).toEqual([]);
        expect([...(await mainFiles(ctx)).keys()].filter(p => p.startsWith(`${B.rel(B.h.dirs.chats)}/`))).toEqual([]);
    }, 60_000);

    // B pulls a first sync so the sync it undoes starts from a commit.
    async function pairedDevices() {
        const preset = { kind: 'preset', dirKey: 'openAI_Settings', name: 'creative' };
        const A = await device('Desk');
        await A.write(preset, { temperature: 0.7 });
        await runSyncCycle(A.ctx);
        const B = await device('Phone');
        await runSyncCycle(B.ctx);
        return { A, B, preset };
    }

    test('undo keeps a chat the sync brought in while its later edited companion stays', async () => {
        const { A, B, preset } = await pairedDevices();
        await A.write(chat, chatValue);
        await A.write(chatState, { v: 0 });
        await A.write(preset, { temperature: 0.9 });
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        await B.write(chatState, { v: 5 });
        const chatPath = `${B.rel(B.h.dirs.chats)}/Seraphina/c1.jsonl`;
        const result = await undoLastSync(withoutBackend(B.ctx));
        expect(result).toMatchObject({
            committed: true,
            reverted: [`${B.rel(B.h.dirs.openAI_Settings)}/creative.json`],
            keptEdited: [chatPath, `${B.rel(B.h.dirs.chats)}/Seraphina/c1.luker-state.mg.json`],
        });
        expect(await B.read(chat)).not.toBeNull();
        expect(await B.read(chatState)).toEqual({ v: 5 });
        expect(await B.read(preset)).toEqual({ temperature: 0.7 });
    }, 60_000);

    test('undo leaves a companion deleted when the chat it belongs to was deleted later', async () => {
        const { A, B, preset } = await pairedDevices();
        await A.write(chat, chatValue);
        await A.write(chatState, { v: 0 });
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        await A.write(chatState, null);
        await A.write(chat, { ...chatValue, body: [...chatValue.body, { name: 'S', is_user: false, mes: 'hello' }] });
        await A.write(preset, { temperature: 0.9 });
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        await B.write(chat, null);
        const chatsDir = B.rel(B.h.dirs.chats);
        const result = await undoLastSync(withoutBackend(B.ctx));
        expect(result).toMatchObject({
            committed: true,
            reverted: [`${B.rel(B.h.dirs.openAI_Settings)}/creative.json`],
            keptEdited: [`${chatsDir}/Seraphina/c1.jsonl`, `${chatsDir}/Seraphina/c1.luker-state.mg.json`],
        });
        expect(await B.read(chat)).toBeNull();
        expect(await B.read(chatState)).toBeNull();
        expect(await B.read(preset)).toEqual({ temperature: 0.7 });
    }, 60_000);

    test.each([false, true])('undo preserves edited group chat ownership through the next SQL snapshot with existing group: %s', async (existing) => {
        const { A, B } = await pairedDevices();
        const group = { kind: 'group', id: 'g' };
        const groupChat = { kind: 'chat', name: 'c', charDir: null, isGroup: true, groupId: 'c' };
        const doc = chats => ({ id: 'g', name: 'group', chats, chat_id: chats.at(-1), date_added: 1 });
        if (existing) {
            await A.write(group, doc(['old']));
            await runSyncCycle(A.ctx);
            await runSyncCycle(B.ctx);
        }
        await A.write(group, doc(existing ? ['old', 'c'] : ['c']));
        await A.write(groupChat, chatValue);
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        const edited = { ...chatValue, body: [...chatValue.body, { mes: 'later', name: 'U', is_user: true }] };
        await B.write(groupChat, edited);
        await undoLastSync(withoutBackend(B.ctx));
        expect(await B.read(group)).toMatchObject({ chats: existing ? ['old', 'c'] : ['c'], chat_id: 'c' });
        await runSyncCycle(B.ctx);
        expect((await mainFiles(B.ctx)).has(`${B.rel(B.h.dirs.groupChats)}/c.jsonl`)).toBe(true);
        await runSyncCycle(A.ctx);
        expect(await A.read(group)).toMatchObject({ chats: existing ? ['old', 'c'] : ['c'], chat_id: 'c' });
        expect((await A.read(groupChat)).body).toEqual(edited.body);
    }, 60_000);
});
