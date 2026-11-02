import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

import { runSyncCycle, commitLocalEdit, readUndoPoint, clearUndoPoint, MAIN_REF, PENDING_REF, BACKUP_TAG_PREFIX, UNDO_TARGET_REF, _sweptGitdirsForTests } from '../../../src/sync/pipeline/cycle.js';
import { journalPath, readReconcileJournal, writeReconcileJournal } from '../../../src/sync/pipeline/reconcile-journal.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { blobOidOf, readCommitFiles } from '../../../src/sync/pipeline/git-tree.js';
import { getGateState, _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { createConflictPolicy } from '../../../src/sync/pipeline/conflict-policy.js';
import { deviceLabelForCommit } from '../../../src/sync/pipeline/commit-provenance.js';
import { CONFLICTS_PATH, NOTICES_PATH, readEntries, serializeEntries } from '../../../src/sync/pipeline/conflict-records.js';
import { commitFiles } from '../_lib/commits.js';
import { readBlobBytes } from '../../../src/sync/pipeline/git-tree.js';
import { BACKEND_ID, makeDevice, makeRemote, remoteHead, resolveRefOrNull } from '../_lib/devices.js';
import { orderLocalHead } from '../_lib/merge-roles.js';

const IDLE_GATE = { readers: 0, writerHeld: false, waitingReaders: 0, waitingWriters: 0 };
const oid = content => blobOidOf(Buffer.from(content));

describe('runSyncCycle against a directory remote', () => {
    let remote;
    const devices = [];
    const device = (options = {}) => {
        const d = makeDevice({ remoteDir: remote.remoteDir, ...options });
        devices.push(d);
        return d;
    };
    const mainOf = d => resolveRefOrNull(d.shadow.gitDir, MAIN_REF);
    const head = () => remoteHead(remote.remoteDir);

    beforeEach(async () => {
        _resetGateForTests();
        remote = await makeRemote();
    });
    afterEach(() => {
        for (const d of devices.splice(0)) d.cleanup();
        remote.cleanup();
    });

    test('both sides empty: nothing to do', async () => {
        const A = device();
        expect(await runSyncCycle(A.ctx)).toEqual({
            status: 'synced', reason: null, mergeCase: 'none', localHead: null, remoteHead: null, remoteEtag: null,
            pushed: false, conflicts: [], reconcile: null, recovered: null, seeded: null, notifyError: null,
        });
        expect(await head()).toBeNull();
    });

    test('the first device publishes its snapshot', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        const outcome = await runSyncCycle(A.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'pairing-push', pushed: true });
        expect(outcome.localHead).toBe(await mainOf(A));
        expect(outcome.remoteHead).toBe(outcome.localHead);
        expect(await head()).toBe(outcome.localHead);
        expect(getGateState(A.userRoot)).toEqual(IDLE_GATE);
    });

    test('an empty device adopts the remote head into live', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        await runSyncCycle(A.ctx);
        const B = device();
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'pairing-pull', pushed: false });
        expect(outcome.reconcile.written).toEqual(['characters/a.png']);
        expect(B.read('characters/a.png')).toBe('A1');
        expect(await mainOf(B)).toBe(await head());
        expect(await resolveRefOrNull(B.shadow.gitDir, PENDING_REF)).toBeNull();
        expect(readReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID })).toBeNull();
    });

    test('equal heads do nothing', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        const before = await head();
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'equal', pushed: false, reconcile: null });
        expect(await head()).toBe(before);
    });

    test.each(['conflicts', 'notices'].flatMap(kind => ['{PRIVATE_PENDING_MARKER', '{"entries":[]}', 'null'].map(invalid => [kind, invalid])))('a malformed %s envelope %s cannot remove preserved pending entries', async (kind, invalid) => {
        const A = device();
        const metadataPath = kind === 'conflicts' ? CONFLICTS_PATH : NOTICES_PATH;
        const pending = kind === 'conflicts'
            ? { kept: null, ours: null, theirs: null, oursDevice: 'Desk', theirsDevice: 'Phone', mergeParents: [], createdAt: '2026-10-01' }
            : { kind: 'restored', device: 'Desk', target: { kind: 'group', groupId: null, name: 'kept' }, createdAt: '2026-10-01' };
        const kept = { 'worlds/P.json': pending, 'worlds/Q.json': { ...pending, createdAt: '2026-10-02' } };
        const base = await commitFiles(remote.remoteDir, { [metadataPath]: serializeEntries({ 'worlds/P.json': pending }) });
        const ours = await commitFiles(remote.remoteDir, { [metadataPath]: serializeEntries(kept) }, [base]);
        const theirs = await commitFiles(remote.remoteDir, { [metadataPath]: invalid }, [base]);
        await A.ctx.backend.fetchInto([ours]);
        await git.writeRef({ fs, gitdir: A.shadow.gitDir, ref: MAIN_REF, value: ours, force: true });
        await git.writeRef({ fs, gitdir: remote.remoteDir, ref: MAIN_REF, value: theirs, force: true });
        const context = { ...A.ctx, onConflicts: createConflictPolicy({ directories: A.directories }) };
        await expect(runSyncCycle(context)).rejects.toMatchObject({ code: 'PENDING_DOCUMENT_INVALID', message: expect.stringContaining(metadataPath) });
        expect(await mainOf(A)).toBe(ours);
        expect(await head()).toBe(theirs);
        const files = await readCommitFiles({ gitdir: A.shadow.gitDir, commitOid: ours });
        expect(await readEntries({ gitdir: A.shadow.gitDir, files, path: metadataPath, kind })).toEqual(kept);
        const invalidFile = (await readCommitFiles({ gitdir: A.shadow.gitDir, commitOid: theirs })).get(metadataPath);
        expect((await readBlobBytes({ gitdir: A.shadow.gitDir, oid: invalidFile.oid })).toString('utf8')).toBe(invalid);
        expect(getGateState(A.userRoot)).toEqual(IDLE_GATE);
    });

    test('a linked category root fails a production cycle before publishing outside content', async () => {
        const A = device();
        A.write('characters/a.png', 'SAFE');
        await runSyncCycle(A.ctx);
        const original = await mainOf(A);
        A.write('outside/private.png', 'PRIVATE_OUTSIDE_BYTES');
        A.remove('characters/a.png');
        fs.rmdirSync(A.directories.characters);
        fs.symlinkSync(path.join(A.userRoot, 'outside'), A.directories.characters);
        await expect(runSyncCycle(A.ctx)).rejects.toMatchObject({ code: 'SYNC_UNSAFE_LIVE_PATH' });
        expect(await mainOf(A)).toBe(original);
        expect(await head()).toBe(original);
        expect([...(await readCommitFiles({ gitdir: A.shadow.gitDir, commitOid: original })).keys()]).toEqual(['characters/a.png']);
        expect(fs.readdirSync(path.join(A.userRoot, 'outside'))).toEqual(['private.png']);
        expect(A.read('outside/private.png')).toBe('PRIVATE_OUTSIDE_BYTES');
        expect(getGateState(A.userRoot)).toEqual(IDLE_GATE);
    });

    test('a fast-forward applies remote edits and tags a backup of the previous head', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        const previous = await mainOf(B);
        A.write('characters/a.png', 'A2');
        expect((await runSyncCycle(A.ctx)).mergeCase).toBe('ahead');
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'fast-forward', pushed: false });
        expect(B.read('characters/a.png')).toBe('A2');
        const tags = (await git.listTags({ fs: atomicFs, gitdir: B.shadow.gitDir })).filter(t => t.startsWith(BACKUP_TAG_PREFIX));
        expect(tags).toHaveLength(1);
        expect(await git.resolveRef({ fs: atomicFs, gitdir: B.shadow.gitDir, ref: tags[0] })).toBe(previous);
    });

    test('diverged edits merge cleanly into a two-parent commit', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.write('characters/fromA.png', 'FA');
        await runSyncCycle(A.ctx);
        const aHead = await head();
        B.write('characters/fromB.png', 'FB');
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'merged', pushed: true, conflicts: [] });
        const { commit } = await git.readCommit({ fs: atomicFs, gitdir: B.shadow.gitDir, oid: outcome.localHead });
        expect(commit.parent).toHaveLength(2);
        expect(commit.parent).toContain(aHead);
        const bParent = commit.parent.find(oid => oid !== aHead);
        expect([...(await readCommitFiles({ gitdir: B.shadow.gitDir, commitOid: bParent })).keys()]).toContain('characters/fromB.png');
        expect(B.read('characters/fromA.png')).toBe('FA');
        expect(await head()).toBe(outcome.localHead);
        expect((await runSyncCycle(A.ctx)).mergeCase).toBe('fast-forward');
        expect(A.read('characters/fromB.png')).toBe('FB');
    });

    test.each([
        ['the local head orders first', true],
        ['the remote head orders first', false],
    ])('a diverged conflict keeps the side with the smaller head when %s', async (_name, localFirst) => {
        const A = device();
        A.write('characters/x.png', 'A0');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.write('characters/x.png', 'A1');
        await runSyncCycle(A.ctx);
        const aHead = await head();
        B.write('characters/x.png', 'B1');
        const bHead = await orderLocalHead(B.ctx, aHead, localFirst);
        const seen = [];
        B.ctx.onConflicts = async (input) => {
            seen.push(input);
            return input.files;
        };
        const outcome = await runSyncCycle(B.ctx);
        const [kept, other] = localFirst ? ['B1', 'A1'] : ['A1', 'B1'];
        const expected = [{ filepath: 'characters/x.png', kind: 'bothModified', oursOid: oid(kept), theirsOid: oid(other) }];
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'merged', pushed: true });
        expect(outcome.conflicts).toEqual(expected);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ conflicts: expected, gitdir: B.shadow.gitDir, oursIsLocal: localFirst, ours: localFirst ? bHead : aHead, theirs: localFirst ? aHead : bHead });
        expect(seen[0].files.get('characters/x.png').oid).toBe(oid(kept));
        expect(B.read('characters/x.png')).toBe(kept);
    });

    test('the onConflicts result becomes the merge tree', async () => {
        const A = device();
        A.write('characters/x.png', 'A0');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.write('characters/x.png', 'A1');
        await runSyncCycle(A.ctx);
        B.write('characters/x.png', 'B1');
        B.ctx.onConflicts = async ({ gitdir, files }) => {
            const resolution = await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from('R') });
            return new Map([...files, ['characters/resolution.png', { oid: resolution, mode: '100644' }]]);
        };
        const outcome = await runSyncCycle(B.ctx);
        expect(B.read('characters/resolution.png')).toBe('R');
        expect((await readCommitFiles({ gitdir: B.shadow.gitDir, commitOid: outcome.localHead })).get('characters/resolution.png').oid).toBe(oid('R'));
    });

    test('unrelated histories merge as a union and conflict only on differing files', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        A.write('characters/same.png', 'S');
        A.write('characters/diff.png', 'DA');
        await runSyncCycle(A.ctx);
        const B = device();
        B.write('characters/b.png', 'B');
        B.write('characters/same.png', 'S');
        B.write('characters/diff.png', 'DB');
        await orderLocalHead(B.ctx, await head(), true);
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'merged-unrelated', pushed: true });
        expect(outcome.conflicts).toEqual([{ filepath: 'characters/diff.png', kind: 'bothModified', oursOid: oid('DB'), theirsOid: oid('DA') }]);
        expect([B.read('characters/a.png'), B.read('characters/b.png'), B.read('characters/same.png'), B.read('characters/diff.png')]).toEqual(['A', 'B', 'S', 'DB']);
    });

    test('a live edit made after the snapshot is skipped and the cycle asks for a rerun', async () => {
        const A = device();
        A.write('characters/x.png', 'V1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.write('characters/x.png', 'V2');
        await runSyncCycle(A.ctx);
        const before = await mainOf(B);
        B.hooks.afterReadHead = async () => { B.write('characters/x.png', 'USER'); };
        const first = await runSyncCycle(B.ctx);
        expect(first).toMatchObject({ status: 'rerun', reason: 'live-changed', mergeCase: 'fast-forward', localHead: before, pushed: false });
        expect(first.reconcile.skipped).toEqual(['characters/x.png']);
        expect(await mainOf(B)).toBe(before);
        expect(await resolveRefOrNull(B.shadow.gitDir, PENDING_REF)).toBeNull();
        expect(readReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID })).toBeNull();
        expect(B.read('characters/x.png')).toBe('USER');

        await orderLocalHead(B.ctx, await head(), true);
        const second = await runSyncCycle(B.ctx);
        expect(second).toMatchObject({ status: 'synced', mergeCase: 'merged', pushed: true });
        expect(second.conflicts.map(c => c.filepath)).toEqual(['characters/x.png']);
        expect(B.read('characters/x.png')).toBe('USER');
        expect(await head()).toBe(second.localHead);
    });

    test('a rerun from the same local head does not tag it again', async () => {
        const A = device();
        A.write('characters/x.png', 'V1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.write('characters/x.png', 'V2');
        await runSyncCycle(A.ctx);
        const before = await mainOf(B);
        B.hooks.afterReadHead = async () => { B.write('characters/x.png', 'USER'); };
        expect((await runSyncCycle(B.ctx)).status).toBe('rerun');
        B.write('characters/x.png', 'V1');
        B.hooks.afterReadHead = async () => { B.write('characters/x.png', 'USER'); };
        const again = await runSyncCycle(B.ctx);
        expect(again).toMatchObject({ status: 'rerun', mergeCase: 'fast-forward', localHead: before });
        const tags = (await git.listTags({ fs: atomicFs, gitdir: B.shadow.gitDir })).filter(t => t.startsWith(BACKUP_TAG_PREFIX));
        expect(tags.filter(t => t.endsWith(`-${before.slice(0, 8)}`))).toHaveLength(1);
    });

    test('a remote that moves before the head CAS asks for a rerun', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        await runSyncCycle(A.ctx);
        const B = device();
        const C = device();
        await runSyncCycle(B.ctx);
        await runSyncCycle(C.ctx);
        B.write('characters/b.png', 'B');
        C.write('characters/c.png', 'C');
        B.hooks.beforeCasHead = async () => {
            const fromC = await runSyncCycle(C.ctx);
            expect(fromC.pushed).toBe(true);
        };
        const first = await runSyncCycle(B.ctx);
        expect(first).toMatchObject({ status: 'rerun', reason: 'remote-moved', mergeCase: 'ahead', pushed: false });
        expect(await head()).toBe(await mainOf(C));
        const second = await runSyncCycle(B.ctx);
        expect(second).toMatchObject({ status: 'synced', mergeCase: 'merged', pushed: true, conflicts: [] });
        expect(B.read('characters/c.png')).toBe('C');
    });

    test('a leftover journal is recovered before the cycle continues', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        const base = await mainOf(B);
        A.write('characters/a.png', 'A2');
        A.write('characters/c.png', 'C');
        await runSyncCycle(A.ctx);
        const target = await head();
        await B.backend.fetchInto([target], [base]);
        await writeReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID, base, target, categories: B.ctx.categories });
        B.write('characters/a.png', 'A2');
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.recovered).toEqual({
            base, target,
            reconcile: { written: ['characters/c.png'], deleted: [], alreadyApplied: ['characters/a.png'], skipped: [], ignored: [] },
        });
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'equal', localHead: target });
        expect(readReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID })).toBeNull();
        expect(B.read('characters/c.png')).toBe('C');
    });

    test('recovery reconciles the categories recorded in the journal', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        A.write('worlds/w.json', 'W1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        const base = await mainOf(B);
        A.write('worlds/w.json', 'W2');
        await runSyncCycle(A.ctx);
        const target = await head();
        await B.backend.fetchInto([target], [base]);
        await writeReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID, base, target, categories: ['characters', 'worlds'] });
        B.ctx.categories = ['characters'];
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.recovered.reconcile.written).toEqual(['worlds/w.json']);
        expect(B.read('worlds/w.json')).toBe('W2');
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'equal', localHead: target });
    });

    test('a journal without categories recovers the current categories', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        A.write('worlds/w.json', 'W1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        const base = await mainOf(B);
        A.write('characters/a.png', 'A2');
        A.write('worlds/w.json', 'W2');
        await runSyncCycle(A.ctx);
        const target = await head();
        await B.backend.fetchInto([target], [base]);
        fs.writeFileSync(journalPath({ userRoot: B.userRoot, backendId: BACKEND_ID }), JSON.stringify({ version: 1, base, target }));
        B.ctx.categories = ['characters'];
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.recovered.reconcile.written).toEqual(['characters/a.png']);
        expect(B.read('characters/a.png')).toBe('A2');
        expect(B.read('worlds/w.json')).toBe('W1');
    });

    test('a recovery that skips a path still moves the sync point of its categories', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        A.write('worlds/w.json', 'W1');
        A.write('worlds/v.json', 'V1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        const base = await mainOf(B);
        A.write('worlds/w.json', 'W2');
        A.write('worlds/v.json', 'V2');
        await runSyncCycle(A.ctx);
        const target = await head();
        await B.backend.fetchInto([target], [base]);
        await writeReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID, base, target, categories: ['characters', 'worlds'] });
        B.write('worlds/v.json', 'LOCAL');

        B.ctx.categories = ['characters'];
        const restarted = await runSyncCycle(B.ctx);
        expect(restarted.recovered.reconcile).toMatchObject({ written: ['worlds/w.json'], skipped: ['worlds/v.json'] });
        expect(B.read('worlds/w.json')).toBe('W2');

        A.write('worlds/w.json', 'W3');
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        B.ctx.categories = ['characters', 'worlds'];
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.seeded).toEqual({ written: ['worlds/w.json'], deleted: [], alreadyApplied: [], skipped: [], ignored: [] });
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'ahead', pushed: true });
        expect(B.read('worlds/w.json')).toBe('W3');
        expect(B.read('worlds/v.json')).toBe('LOCAL');
        const remoteFiles = await readCommitFiles({ gitdir: remote.remoteDir, commitOid: await head() });
        expect(remoteFiles.get('worlds/w.json').oid).toBe(oid('W3'));
        expect(remoteFiles.get('worlds/v.json').oid).toBe(oid('LOCAL'));
    });

    test('a pending ref left without a journal is removed', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        await git.writeRef({ fs: atomicFs, gitdir: B.shadow.gitDir, ref: PENDING_REF, value: await mainOf(B), force: true });
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'equal', recovered: null });
        expect(await resolveRefOrNull(B.shadow.gitDir, PENDING_REF)).toBeNull();
    });

    test('deletions propagate', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        A.write('characters/b.png', 'B');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.remove('characters/b.png');
        await runSyncCycle(A.ctx);
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.reconcile.deleted).toEqual(['characters/b.png']);
        expect(B.read('characters/b.png')).toBeNull();
    });

    test('categories a device does not sync are neither reconciled nor deleted remotely', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        A.write('worlds/w.json', '{}');
        await runSyncCycle(A.ctx);
        const B = device({ categories: ['characters'] });
        B.write('worlds/local.json', 'L');
        await runSyncCycle(B.ctx);
        expect(B.read('worlds/w.json')).toBeNull();
        expect(B.read('worlds/local.json')).toBe('L');
        B.write('characters/b.png', 'B');
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome).toMatchObject({ mergeCase: 'ahead', pushed: true });
        const remoteFiles = await readCommitFiles({ gitdir: remote.remoteDir, commitOid: await head() });
        expect(remoteFiles.has('worlds/w.json')).toBe(true);
        expect(remoteFiles.has('worlds/local.json')).toBe(false);
    });

    test('enabling a category seeds its remote files into live instead of deleting them', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        A.write('worlds/remote.json', '{"from":"A"}');
        await runSyncCycle(A.ctx);
        const B = device({ categories: ['characters'] });
        await runSyncCycle(B.ctx);
        expect(B.read('worlds/remote.json')).toBeNull();

        B.ctx.categories = ['characters', 'worlds'];
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.seeded).toEqual({ written: ['worlds/remote.json'], deleted: [], alreadyApplied: [], skipped: [], ignored: [] });
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'equal', pushed: false });
        expect(B.read('worlds/remote.json')).toBe('{"from":"A"}');
        expect((await readCommitFiles({ gitdir: remote.remoteDir, commitOid: await head() })).has('worlds/remote.json')).toBe(true);
        expect((await runSyncCycle(A.ctx)).mergeCase).toBe('equal');
        expect(A.read('worlds/remote.json')).toBe('{"from":"A"}');
        expect((await runSyncCycle(B.ctx)).seeded).toBeNull();
    });

    test('re-enabling a category applies remote edits made while it was disabled', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        A.write('worlds/w.json', 'W1');
        A.write('worlds/gone.json', 'G');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        expect(B.read('worlds/w.json')).toBe('W1');

        B.ctx.categories = ['characters'];
        await runSyncCycle(B.ctx);
        A.write('worlds/w.json', 'W2');
        A.remove('worlds/gone.json');
        await runSyncCycle(A.ctx);
        expect((await runSyncCycle(B.ctx)).mergeCase).toBe('fast-forward');
        expect(B.read('worlds/w.json')).toBe('W1');

        B.ctx.categories = ['characters', 'worlds'];
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.seeded).toEqual({ written: ['worlds/w.json'], deleted: ['worlds/gone.json'], alreadyApplied: [], skipped: [], ignored: [] });
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'equal', pushed: false });
        expect(B.read('worlds/w.json')).toBe('W2');
        expect(B.read('worlds/gone.json')).toBeNull();
        const remoteFiles = await readCommitFiles({ gitdir: remote.remoteDir, commitOid: await head() });
        expect(remoteFiles.get('worlds/w.json').oid).toBe(oid('W2'));
        expect(remoteFiles.has('worlds/gone.json')).toBe(false);
    });

    test('re-enabling a category keeps a file edited while it was disabled', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        A.write('worlds/w.json', 'W1');
        A.write('worlds/other.json', 'O1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        B.ctx.categories = ['characters'];
        await runSyncCycle(B.ctx);
        A.write('worlds/other.json', 'O2');
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        B.write('worlds/w.json', 'B-edit');

        B.ctx.categories = ['characters', 'worlds'];
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.seeded).toEqual({ written: ['worlds/other.json'], deleted: [], alreadyApplied: [], skipped: [], ignored: [] });
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'ahead', pushed: true });
        expect(B.read('worlds/w.json')).toBe('B-edit');
        expect(B.read('worlds/other.json')).toBe('O2');
        expect((await runSyncCycle(A.ctx)).mergeCase).toBe('fast-forward');
        expect(A.read('worlds/w.json')).toBe('B-edit');
    });

    test('enabling a category keeps a different local file and syncs it as a local edit', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        A.write('worlds/w.json', 'A-version');
        await runSyncCycle(A.ctx);
        const B = device({ categories: ['characters'] });
        await runSyncCycle(B.ctx);
        B.write('worlds/w.json', 'B-version');

        B.ctx.categories = ['characters', 'worlds'];
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.seeded.skipped).toEqual(['worlds/w.json']);
        expect(outcome.seeded.written).toEqual([]);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'ahead', pushed: true });
        expect(outcome.conflicts).toEqual([{ filepath: 'worlds/w.json', kind: 'bothModified', oursOid: oid('B-version'), theirsOid: oid('A-version') }]);
        expect(B.read('worlds/w.json')).toBe('B-version');
        expect((await runSyncCycle(A.ctx)).mergeCase).toBe('fast-forward');
        expect(A.read('worlds/w.json')).toBe('B-version');
    });

    test('a file edited on both sides while its category was disabled is reported as a conflict', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        A.write('worlds/w.json', 'W1');
        A.write('worlds/gone.json', 'G1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        B.ctx.categories = ['characters'];
        await runSyncCycle(B.ctx);
        A.write('worlds/w.json', 'A-edit');
        A.write('worlds/gone.json', 'G2');
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        B.write('worlds/w.json', 'B-edit');
        B.remove('worlds/gone.json');

        B.ctx.categories = ['characters', 'worlds'];
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.seeded.skipped).toEqual(['worlds/gone.json', 'worlds/w.json']);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'ahead', pushed: true });
        expect(outcome.conflicts).toEqual([
            { filepath: 'worlds/gone.json', kind: 'deleteByUs', oursOid: null, theirsOid: oid('G2') },
            { filepath: 'worlds/w.json', kind: 'bothModified', oursOid: oid('B-edit'), theirsOid: oid('A-edit') },
        ]);
        expect(B.read('worlds/w.json')).toBe('B-edit');
        const remoteFiles = await readCommitFiles({ gitdir: remote.remoteDir, commitOid: await head() });
        expect(remoteFiles.get('worlds/w.json').oid).toBe(oid('B-edit'));
        expect(remoteFiles.has('worlds/gone.json')).toBe(false);
    });

    test('rejects a backend whose id differs from the backend id', async () => {
        const A = device();
        await expect(runSyncCycle({ ...A.ctx, backendId: 'other' })).rejects.toThrow(/does not match/);
    });

    test('main moving between snapshot and reconcile asks for a local-moved rerun', async () => {
        const A = device();
        A.write('characters/x.png', 'V1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.write('characters/x.png', 'V2');
        await runSyncCycle(A.ctx);
        B.hooks.afterReadHead = async () => {
            B.write('characters/y.png', 'LOCAL');
            await runSyncCycle({ ...B.ctx, backend: { ...B.backend, id: BACKEND_ID, kind: 'directory',
                readHead: async () => null, fetchInto: async () => {}, pushObjects: async () => {}, casHead: async () => ({ ok: true }) } });
        };
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome).toMatchObject({ status: 'rerun', reason: 'local-moved' });
        expect(await resolveRefOrNull(B.shadow.gitDir, PENDING_REF)).toBeNull();
        expect(B.read('characters/x.png')).toBe('V1');
        expect((await runSyncCycle(B.ctx)).status).toBe('synced');
        expect(B.read('characters/x.png')).toBe('V2');
        expect(B.read('characters/y.png')).toBe('LOCAL');
    });

    test('lockShadow guards repository preparation, snapshot, merge and reconcile without holding network', async () => {
        const A = device();
        A.write('characters/x.png', 'V1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.write('characters/x.png', 'V2');
        await runSyncCycle(A.ctx);
        const sections = [];
        B.ctx.lockShadow = async fn => {
            sections.push('enter');
            try { return await fn(); } finally { sections.push('exit'); }
        };
        B.hooks.afterReadHead = async () => { sections.push('network'); };
        expect((await runSyncCycle(B.ctx)).mergeCase).toBe('fast-forward');
        expect(sections).toEqual(['enter', 'exit', 'enter', 'exit', 'network', 'enter', 'exit', 'enter', 'exit']);
    });

    test('a merge pushes after leaving the reconcile section', async () => {
        const A = device();
        A.write('characters/x.png', 'V1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        A.write('characters/fromA.png', 'FA');
        await runSyncCycle(A.ctx);
        B.write('characters/fromB.png', 'FB');
        const sections = [];
        B.ctx.lockShadow = async fn => {
            sections.push('enter');
            try { return await fn(); } finally { sections.push('exit'); }
        };
        B.hooks.afterReadHead = async () => { sections.push('network'); };
        B.hooks.beforePushObjects = async () => { sections.push('push'); };
        expect((await runSyncCycle(B.ctx)).mergeCase).toBe('merged');
        expect(sections).toEqual(['enter', 'exit', 'enter', 'exit', 'network', 'enter', 'exit', 'enter', 'exit', 'push']);
    });

    test('beforeSnapshot runs first and onLiveApplied runs inside the writer lock with the report', async () => {
        const A = device();
        A.write('characters/x.png', 'V1');
        await runSyncCycle(A.ctx);
        const B = device();
        const seen = [];
        B.ctx.lockShadow = async fn => {
            seen.push(['enter']);
            try { return await fn(); } finally { seen.push(['exit']); }
        };
        B.ctx.beforeSnapshot = async () => { seen.push(['before', getGateState(B.userRoot).writerHeld]); };
        B.ctx.onLiveApplied = async report => { seen.push(['applied', getGateState(B.userRoot).writerHeld, report.written]); };
        await runSyncCycle(B.ctx);
        expect(seen).toEqual([['before', false], ['enter'], ['exit'], ['enter'], ['exit'], ['enter'], ['exit'], ['enter'], ['applied', true, ['characters/x.png']], ['exit']]);
    });

    test('recovery reports its reconcile through onLiveApplied', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        const base = await mainOf(B);
        A.write('characters/c.png', 'C');
        await runSyncCycle(A.ctx);
        const target = await head();
        await B.backend.fetchInto([target], [base]);
        await writeReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID, base, target, categories: B.ctx.categories });
        const reports = [];
        B.ctx.onLiveApplied = async report => { reports.push(report.written); };
        await runSyncCycle(B.ctx);
        expect(reports).toEqual([['characters/c.png']]);
    });

    test('a throwing onLiveApplied is logged and the cycle still syncs', async () => {
        const A = device();
        A.write('characters/x.png', 'V1');
        await runSyncCycle(A.ctx);
        const B = device();
        B.ctx.onLiveApplied = async () => { throw new Error('listener broke'); };
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const outcome = await runSyncCycle(B.ctx);
            expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'pairing-pull' });
            expect(logged.mock.calls.flat().map(String).join(' ')).toContain('listener broke');
        } finally {
            logged.mockRestore();
        }
        expect(B.read('characters/x.png')).toBe('V1');
        expect(getGateState(B.userRoot)).toEqual(IDLE_GATE);
    });

    test('a throwing onLiveApplied during recovery is logged and the cycle still syncs', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        const base = await mainOf(B);
        A.write('characters/c.png', 'C');
        await runSyncCycle(A.ctx);
        const target = await head();
        await B.backend.fetchInto([target], [base]);
        await writeReconcileJournal({ userRoot: B.userRoot, backendId: BACKEND_ID, base, target, categories: B.ctx.categories });
        B.ctx.onLiveApplied = async () => { throw new Error('listener broke'); };
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const outcome = await runSyncCycle(B.ctx);
            expect(outcome.status).toBe('synced');
            expect(outcome.recovered.reconcile.written).toEqual(['characters/c.png']);
            expect(logged).toHaveBeenCalled();
        } finally {
            logged.mockRestore();
        }
    });

    test('stale temps are swept once per repository per process', async () => {
        const A = device();
        A.write('characters/a.png', 'A1');
        await runSyncCycle(A.ctx);
        expect(_sweptGitdirsForTests()).toContain(A.shadow.gitDir);
        const stale = path.join(A.shadow.gitDir, 'stale.123');
        fs.writeFileSync(stale, 'x');
        const past = (performance.timeOrigin - 60_000) / 1000;
        fs.utimesSync(stale, past, past);
        A.write('characters/a.png', 'A2');
        await runSyncCycle(A.ctx);
        expect(fs.existsSync(stale)).toBe(true);
    });

    const seedConflictDevices = async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        A.write('worlds/w.json', 'A-version');
        await runSyncCycle(A.ctx);
        const B = device({ categories: ['characters'] });
        await runSyncCycle(B.ctx);
        B.write('worlds/w.json', 'B-version');
        B.ctx.categories = ['characters', 'worlds'];
        return { A, B };
    };

    test('seeding conflicts pass through the policy and the records are committed', async () => {
        const { B } = await seedConflictDevices();
        B.ctx.onConflicts = createConflictPolicy({ directories: B.directories, localDevice: 'B', remoteDevice: 'remote' });
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.conflicts.map(c => c.filepath)).toEqual(['worlds/w.json']);
        const files = await readCommitFiles({ gitdir: B.shadow.gitDir, commitOid: await mainOf(B) });
        expect(Object.keys(await readEntries({ gitdir: B.shadow.gitDir, files, path: CONFLICTS_PATH, kind: 'conflicts' }))).toEqual(['worlds/w.json']);
        expect(B.read('worlds/w.json')).toBe('B-version');
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'ahead', pushed: true });
    });

    test('seed conflicts read immutable labels before a remote head read and bookkeeping remains generic', async () => {
        const A = device();
        A.ctx.getDeviceLabel = async () => 'Original A';
        A.write('characters/a.png', 'A');
        A.write('worlds/w.json', 'A-version');
        await runSyncCycle(A.ctx);
        const inherited = await mainOf(A);
        const C = device({ categories: ['characters'] });
        C.ctx.getDeviceLabel = async () => 'Inheritor C';
        await runSyncCycle(C.ctx);
        C.ctx.categories = ['characters', 'worlds'];
        expect((await commitLocalEdit(C.ctx, async () => null)).head).toBe(inherited);
        expect(await deviceLabelForCommit({ gitdir: C.shadow.gitDir, oid: inherited })).toBe('Original A');
        const B = device({ categories: ['characters'] });
        B.ctx.getDeviceLabel = async () => 'Original B';
        await runSyncCycle(B.ctx);
        B.write('worlds/w.json', 'B-version');
        B.ctx.categories = ['characters', 'worlds'];
        let headRead = false;
        B.hooks.afterReadHead = async () => { headRead = true; };
        const policy = createConflictPolicy({ directories: B.directories });
        B.ctx.onConflicts = async input => {
            expect(headRead).toBe(false);
            const out = await policy(input);
            const records = await readEntries({ gitdir: input.gitdir, files: out.files, path: CONFLICTS_PATH, kind: 'conflicts' });
            expect(records['worlds/w.json']).toMatchObject({ oursDevice: 'Original B', theirsDevice: 'Original A', mergeParents: [input.ours, inherited] });
            return out;
        };
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.conflicts.map(c => c.filepath)).toEqual(['worlds/w.json']);
        expect(await deviceLabelForCommit({ gitdir: B.shadow.gitDir, oid: outcome.localHead })).toBe('Luker Sync');
    });

    test('the conflict list returned by the hook replaces the seed list', async () => {
        const { B } = await seedConflictDevices();
        B.ctx.onConflicts = async ({ files }) => ({ files, conflicts: [] });
        expect((await runSyncCycle(B.ctx)).conflicts).toEqual([]);
    });

    test('a reconciling cycle records the undo point and keeps only the newest backup tag', async () => {
        const A = device();
        A.write('characters/x.png', 'V1');
        await runSyncCycle(A.ctx);
        const B = device();
        await runSyncCycle(B.ctx);
        for (const value of ['V2', 'V3']) {
            A.write('characters/x.png', value);
            await runSyncCycle(A.ctx);
            const before = await mainOf(B);
            const outcome = await runSyncCycle(B.ctx);
            expect(await readUndoPoint(B.shadow.gitDir)).toMatchObject({ base: before, target: outcome.localHead });
        }
        const tags = (await git.listTags({ fs: atomicFs, gitdir: B.shadow.gitDir })).filter(t => t.startsWith(BACKUP_TAG_PREFIX));
        expect(tags).toHaveLength(1);
        await clearUndoPoint(B.shadow.gitDir);
        expect(await readUndoPoint(B.shadow.gitDir)).toBeNull();
        expect(await resolveRefOrNull(B.shadow.gitDir, UNDO_TARGET_REF)).toBeNull();
    });

    test('commitLocalEdit snapshots live first and reconciles the edit into live', async () => {
        const A = device();
        A.write('characters/a.png', 'OLD');
        await runSyncCycle(A.ctx);
        A.write('characters/a.png', 'LIVE');
        const result = await commitLocalEdit(A.ctx, async ({ files, gitdir }) => {
            const b = await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from('EDIT') });
            return { files: new Map([...files, ['characters/b.png', { oid: b, mode: '100644' }]]), message: 'local edit' };
        });
        expect(result.committed).toBe(true);
        expect(A.read('characters/b.png')).toBe('EDIT');
        expect(await mainOf(A)).toBe(result.head);
        const files = await readCommitFiles({ gitdir: A.shadow.gitDir, commitOid: result.head });
        expect(files.get('characters/a.png').oid).toBe(oid('LIVE'));
        const { commit } = await git.readCommit({ fs: atomicFs, gitdir: A.shadow.gitDir, oid: result.head });
        expect(commit.message.trim()).toBe('local edit');
        expect(readReconcileJournal({ userRoot: A.userRoot, backendId: BACKEND_ID })).toBeNull();
    });

    test('commitLocalEdit returning null commits nothing beyond the snapshot', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        await runSyncCycle(A.ctx);
        A.write('characters/a.png', 'A2');
        const result = await commitLocalEdit(A.ctx, async () => null);
        expect(result).toMatchObject({ committed: false, reconcile: null });
        const files = await readCommitFiles({ gitdir: A.shadow.gitDir, commitOid: await mainOf(A) });
        expect(files.get('characters/a.png').oid).toBe(oid('A2'));
    });

    test('commitLocalEdit takes the shadow lock once', async () => {
        const A = device();
        A.write('characters/a.png', 'A');
        let entered = 0;
        A.ctx.lockShadow = async fn => { entered += 1; return fn(); };
        await commitLocalEdit(A.ctx, async () => null);
        expect(entered).toBe(1);
    });

    test('a live edit skipped by the seed records reconcile keeps the records in main and is synced next', async () => {
        const all = ['characters', 'worlds', 'chats'];
        const chatText = mes => `${JSON.stringify({ user_name: 'U', character_name: 'Seraphina', chat_metadata: {} })}\n${JSON.stringify({ name: 'Seraphina', is_user: false, mes })}\n`;
        const A = device({ categories: all });
        A.write('characters/a.png', 'A');
        A.write('worlds/w.json', 'A-version');
        A.write('chats/Seraphina/s.jsonl', chatText('A'));
        await runSyncCycle(A.ctx);
        const B = device({ categories: ['characters'] });
        await runSyncCycle(B.ctx);
        B.write('worlds/w.json', 'B-version');
        B.write('chats/Seraphina/s.jsonl', chatText('B'));
        B.ctx.categories = all;
        const policy = createConflictPolicy({ directories: B.directories, localDevice: 'B', remoteDevice: 'remote' });
        let branchPath = null;
        B.ctx.onConflicts = async input => {
            const result = await policy(input);
            branchPath = [...result.files.keys()].find(k => k.includes('Sync conflict'));
            B.write(branchPath, 'LIVE-EDIT');
            return result;
        };
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.seeded).not.toBeNull();
        const recordsOf = async commitOid => Object.keys(await readEntries({ gitdir: B.shadow.gitDir, files: await readCommitFiles({ gitdir: B.shadow.gitDir, commitOid }), path: CONFLICTS_PATH, kind: 'conflicts' }));
        expect(outcome.localHead).toBe(await mainOf(B));
        expect(await recordsOf(await mainOf(B))).toEqual(['worlds/w.json']);
        expect(B.read(branchPath)).toBe('LIVE-EDIT');
        expect(await resolveRefOrNull(B.shadow.gitDir, 'refs/sync/seed-theirs')).toBeNull();

        B.ctx.onConflicts = policy;
        await runSyncCycle(B.ctx);
        const files = await readCommitFiles({ gitdir: B.shadow.gitDir, commitOid: await mainOf(B) });
        expect(files.get(branchPath).oid).toBe(oid('LIVE-EDIT'));
        expect(await recordsOf(await mainOf(B))).toEqual(['worlds/w.json']);
        expect(B.read(branchPath)).toBe('LIVE-EDIT');
    });

    test('commitLocalEdit returns the conflicts of seeding newly enabled categories', async () => {
        const { B } = await seedConflictDevices();
        B.ctx.onConflicts = createConflictPolicy({ directories: B.directories, localDevice: 'B', remoteDevice: 'remote' });
        const result = await commitLocalEdit(B.ctx, async () => null);
        expect(result.seededConflicts.map(c => c.filepath)).toEqual(['worlds/w.json']);
        expect((await commitLocalEdit(B.ctx, async () => null)).seededConflicts).toEqual([]);
    });
});
