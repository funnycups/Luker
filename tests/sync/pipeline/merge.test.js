import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import git from 'isomorphic-git';

import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { blobOidOf, readCommitFiles, readCommitEntries, isRejectedPath, isUnsafeTreePath, resolveTreePathUnder } from '../../../src/sync/pipeline/git-tree.js';
import { findMergeBaseOrNull, mergeCommitTrees, writeMergeCommit } from '../../../src/sync/pipeline/merge.js';
import { commitFiles, commitTree, writeBlob, writeRawTree } from '../_lib/commits.js';
import { makeUserDirs } from '../_lib/user-dirs.js';
import { describeSqlRecordPath, parseSqlRecordBlob, subRecordParentPath } from '../../../src/sync/materialize.js';

const oid = content => blobOidOf(Buffer.from(content));
const contents = files => Object.fromEntries([...files].map(([p, f]) => [p, f.oid]));

describe('object-store merge', () => {
    let userRoot;
    let gitdir;
    beforeEach(async () => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-merge-'));
        ({ gitDir: gitdir } = await ensureShadowRepo({ userRoot, peerId: 'p' }));
    });
    afterEach(() => fs.rmSync(userRoot, { recursive: true, force: true }));

    async function merge(baseFiles, oursFiles, theirsFiles) {
        const base = baseFiles ? await commitFiles(gitdir, baseFiles) : null;
        const ours = await commitFiles(gitdir, oursFiles, base ? [base] : []);
        const theirs = await commitFiles(gitdir, theirsFiles, base ? [base] : []);
        const found = await findMergeBaseOrNull({ gitdir, ours, theirs });
        expect(found).toBe(base);
        return mergeCommitTrees({ gitdir, base: found, ours, theirs });
    }

    test('blobOidOf matches the oid git assigns', async () => {
        expect(blobOidOf(Buffer.from('hello'))).toBe(await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from('hello') }));
    });

    test('readCommitFiles of null is empty', async () => {
        expect((await readCommitFiles({ gitdir, commitOid: null })).size).toBe(0);
    });

    test('readCommitFiles skips and reports unsafe tree paths', async () => {
        const blob = await writeBlob(gitdir, 'x');
        const inner = await writeRawTree(gitdir, [{ mode: '100644', name: 'settings.json', oid: blob }]);
        const characters = await writeRawTree(gitdir, [
            { mode: '100644', name: 'ok.png', oid: blob },
            { mode: '40000', name: '..', oid: inner },
            { mode: '40000', name: '.', oid: inner },
            { mode: '40000', name: '.GIT', oid: inner },
        ]);
        const root = await writeRawTree(gitdir, [
            { mode: '40000', name: 'characters', oid: characters },
            { mode: '40000', name: '..', oid: inner },
        ]);
        const commit = await commitTree(gitdir, root);
        const unsafe = [];
        const files = await readCommitFiles({ gitdir, commitOid: commit, unsafe });
        expect([...files.keys()]).toEqual(['characters/ok.png']);
        expect(unsafe.sort()).toEqual(['..', 'characters/.', 'characters/..', 'characters/.GIT']);
    });

    test('readCommitFiles reports symlink and submodule entries as unsafe', async () => {
        const blob = await writeBlob(gitdir, '../../outside.txt');
        const characters = await writeRawTree(gitdir, [
            { mode: '100644', name: 'ok.png', oid: blob },
            { mode: '120000', name: 'link.png', oid: blob },
            { mode: '160000', name: 'module', oid: blob },
        ]);
        const commit = await commitTree(gitdir, await writeRawTree(gitdir, [{ mode: '40000', name: 'characters', oid: characters }]));
        const unsafe = [];
        const files = await readCommitFiles({ gitdir, commitOid: commit, unsafe });
        expect([...files.keys()]).toEqual(['characters/ok.png']);
        expect(unsafe.sort()).toEqual(['characters/link.png', 'characters/module']);
    });

    test('mergeCommitTrees reports unsafe paths from ours and theirs', async () => {
        const blob = await writeBlob(gitdir, 'x');
        const rawCommit = async entries => commitTree(gitdir, await writeRawTree(gitdir, entries));
        const ours = await rawCommit([{ mode: '100644', name: 'a', oid: blob }, { mode: '120000', name: 'ours-link', oid: blob }]);
        const theirs = await rawCommit([{ mode: '100644', name: 'a', oid: blob }, { mode: '120000', name: 'theirs-link', oid: blob }]);
        const unsafe = [];
        const result = await mergeCommitTrees({ gitdir, base: null, ours, theirs, unsafe });
        expect(contents(result.files)).toEqual({ a: blob });
        expect(unsafe.sort()).toEqual(['ours-link', 'theirs-link']);
    });

    test('readCommitEntries returns rejected entries with their oid and mode', async () => {
        const blob = await writeBlob(gitdir, 'target');
        const characters = await writeRawTree(gitdir, [
            { mode: '100644', name: 'ok.png', oid: blob },
            { mode: '120000', name: 'link.png', oid: blob },
        ]);
        const commit = await commitTree(gitdir, await writeRawTree(gitdir, [{ mode: '40000', name: 'characters', oid: characters }]));
        const { files, rejected } = await readCommitEntries({ gitdir, commitOid: commit });
        expect([...files.keys()]).toEqual(['characters/ok.png']);
        expect(Object.fromEntries(rejected)).toEqual({ 'characters/link.png': { oid: blob, mode: '120000' } });
        expect(isRejectedPath(rejected, 'characters/link.png')).toBe(true);
        expect(isRejectedPath(rejected, 'characters/link.png/inner')).toBe(true);
        expect(isRejectedPath(rejected, 'characters/ok.png')).toBe(false);
    });

    test('a theirs symlink over an ours regular file keeps ours without a conflict', async () => {
        const blob = await writeBlob(gitdir, 'x');
        const base = await commitFiles(gitdir, { a: '1', 'd/x': '1' });
        const ours = await commitFiles(gitdir, { a: '1', 'd/x': '1' }, [base]);
        const oursChanged = await commitFiles(gitdir, { a: '2', 'd/x': '1' }, [base]);
        const theirs = await commitTree(gitdir, await writeRawTree(gitdir, [
            { mode: '120000', name: 'a', oid: blob },
            { mode: '120000', name: 'd', oid: blob },
        ]), [base]);
        const unsafe = [];
        const same = await mergeCommitTrees({ gitdir, base, ours, theirs, unsafe });
        expect(contents(same.files)).toEqual({ a: oid('1'), 'd/x': oid('1') });
        expect(same.conflicts).toEqual([]);
        expect(unsafe.sort()).toEqual(['a', 'd']);
        const changed = await mergeCommitTrees({ gitdir, base, ours: oursChanged, theirs });
        expect(contents(changed.files)).toEqual({ a: oid('2'), 'd/x': oid('1') });
        expect(changed.conflicts).toEqual([]);
    });

    test('a symlink on ours leaves the path to theirs', async () => {
        const blob = await writeBlob(gitdir, 'x');
        const base = await commitFiles(gitdir, { a: '1' });
        const ours = await commitTree(gitdir, await writeRawTree(gitdir, [{ mode: '120000', name: 'a', oid: blob }]), [base]);
        const theirs = await commitFiles(gitdir, { a: '2' }, [base]);
        const result = await mergeCommitTrees({ gitdir, base, ours, theirs });
        expect(contents(result.files)).toEqual({ a: oid('2') });
        expect(result.conflicts).toEqual([]);
    });

    test('isUnsafeTreePath and resolveTreePathUnder refuse escapes', () => {
        for (const p of ['..', 'a/../b', 'a//b', './a', 'a/.git/x', 'a/.Git', '']) expect(isUnsafeTreePath(p)).toBe(true);
        for (const p of ['a', 'a/b.png', '.luker-sync/conflicts.json', 'a/.gitignore']) expect(isUnsafeTreePath(p)).toBe(false);
        expect(resolveTreePathUnder(userRoot, 'characters/a.png')).toBe(path.join(userRoot, 'characters', 'a.png'));
        expect(() => resolveTreePathUnder(userRoot, 'characters/../../x')).toThrow(/unsafe/);
    });

    test('merge base retains a shared merge parent instead of its older parent', async () => {
        const base = await commitFiles(gitdir, { a: 'base' });
        const tip = await commitFiles(gitdir, { a: 'tip' }, [base]);
        const { commit } = await git.readCommit({ fs: atomicFs, gitdir, oid: tip });
        const merged = await commitTree(gitdir, commit.tree, [base, tip]);
        expect(await findMergeBaseOrNull({ gitdir, ours: tip, theirs: merged })).toBe(tip);
        expect(await findMergeBaseOrNull({ gitdir, ours: merged, theirs: tip })).toBe(tip);
    });

    test('merge base ignores a shorter path to an older common ancestor', async () => {
        const base = await commitFiles(gitdir, { a: 'base' });
        const shared = await commitFiles(gitdir, { a: 'shared' }, [base]);
        const first = await commitFiles(gitdir, { a: 'first' }, [shared]);
        const second = await commitFiles(gitdir, { a: 'second' }, [first]);
        const ours = await commitFiles(gitdir, { a: 'ours' }, [base, second]);
        const theirs = await commitFiles(gitdir, { a: 'theirs' }, [shared]);
        expect(await findMergeBaseOrNull({ gitdir, ours, theirs })).toBe(shared);
        expect(await findMergeBaseOrNull({ gitdir, ours: theirs, theirs: ours })).toBe(shared);
    });

    test('merge base chooses the same incomparable shared ancestor in either direction', async () => {
        const base = await commitFiles(gitdir, { a: 'base' });
        const left = await commitFiles(gitdir, { a: 'left' }, [base]);
        const right = await commitFiles(gitdir, { a: 'right' }, [base]);
        const ours = await commitFiles(gitdir, { a: 'ours' }, [left, right]);
        const theirs = await commitFiles(gitdir, { a: 'theirs' }, [right, left]);
        const selected = await findMergeBaseOrNull({ gitdir, ours, theirs });
        expect([left, right]).toContain(selected);
        expect(await findMergeBaseOrNull({ gitdir, ours: theirs, theirs: ours })).toBe(selected);
    });

    test('merge base exposes an unreadable referenced commit before selecting it', async () => {
        const base = await commitFiles(gitdir, { a: 'base' });
        const ours = await commitFiles(gitdir, { a: 'ours' }, [base]);
        const theirs = await commitFiles(gitdir, { a: 'theirs' }, [base]);
        fs.unlinkSync(path.join(gitdir, 'objects', base.slice(0, 2), base.slice(2)));
        await expect(findMergeBaseOrNull({ gitdir, ours, theirs })).rejects.toThrow(base);
    });

    test('clean three-way merge takes each side change', async () => {
        const result = await merge({ 'a': '1', 'b': '1', 'd/x': '1' }, { 'a': '2', 'b': '1', 'd/x': '1' }, { 'a': '1', 'b': '2', 'c': '3' });
        expect(result.conflicts).toEqual([]);
        expect(contents(result.files)).toEqual({ a: oid('2'), b: oid('2'), c: oid('3') });
    });

    test('both modified keeps ours and reports the conflict', async () => {
        const result = await merge({ a: '1' }, { a: 'O' }, { a: 'T' });
        expect(contents(result.files)).toEqual({ a: oid('O') });
        expect(result.conflicts).toEqual([{ filepath: 'a', kind: 'bothModified', oursOid: oid('O'), theirsOid: oid('T') }]);
    });

    test('delete against modify reports the side that deleted', async () => {
        const byUs = await merge({ a: '1' }, {}, { a: 'T' });
        expect(byUs.files.has('a')).toBe(false);
        expect(byUs.conflicts).toEqual([{ filepath: 'a', kind: 'deleteByUs', oursOid: null, theirsOid: oid('T') }]);
        const byTheirs = await merge({ a: '1' }, { a: 'O' }, {});
        expect(contents(byTheirs.files)).toEqual({ a: oid('O') });
        expect(byTheirs.conflicts).toEqual([{ filepath: 'a', kind: 'deleteByTheirs', oursOid: oid('O'), theirsOid: null }]);
    });

    test('an unchanged file deleted on one side is deleted', async () => {
        const result = await merge({ a: '1', b: '1' }, { a: '1', b: '1' }, { b: '1' });
        expect(contents(result.files)).toEqual({ b: oid('1') });
        expect(result.conflicts).toEqual([]);
    });

    test('unrelated histories merge as a union with conflicts only on differing files', async () => {
        const result = await merge(null, { a: 'A', same: 'S', diff: 'DO' }, { b: 'B', same: 'S', diff: 'DT' });
        expect(contents(result.files)).toEqual({ a: oid('A'), b: oid('B'), same: oid('S'), diff: oid('DO') });
        expect(result.conflicts).toEqual([{ filepath: 'diff', kind: 'bothModified', oursOid: oid('DO'), theirsOid: oid('DT') }]);
    });

    test('a file and directory collision keeps ours', async () => {
        const result = await merge({ k: '1' }, { k: '1', x: 'file' }, { k: '1', 'x/y': 'nested' });
        expect(contents(result.files)).toEqual({ k: oid('1'), x: oid('file') });
        expect(result.conflicts).toEqual([{ filepath: 'x/y', kind: 'deleteByUs', oursOid: null, theirsOid: oid('nested') }]);
    });

    test('writeMergeCommit records both parents and moves no ref', async () => {
        const result = await merge({ a: '1' }, { a: '2' }, { a: '1', b: '1' });
        const ours = await commitFiles(gitdir, { z: 'ours' });
        const theirs = await commitFiles(gitdir, { z: 'theirs' });
        const refsBefore = await git.listBranches({ fs: atomicFs, gitdir });
        const mergeOid = await writeMergeCommit({ gitdir, files: result.files, parents: [ours, theirs] });
        const { commit } = await git.readCommit({ fs: atomicFs, gitdir, oid: mergeOid });
        expect(commit.parent).toEqual([ours, theirs].sort());
        expect(contents(await readCommitFiles({ gitdir, commitOid: mergeOid }))).toEqual({ a: oid('2'), b: oid('1') });
        expect(await git.listBranches({ fs: atomicFs, gitdir })).toEqual(refsBefore);
    });

    test('two devices merging the same heads write the same commit', async () => {
        const result = await merge({ a: '1' }, { a: '2' }, { a: '1', b: '1' });
        const tree = await git.writeTree({ fs: atomicFs, gitdir, tree: [] });
        const at = (message, timestamp) => git.commit({
            fs: atomicFs, gitdir, message, author: { name: 't', email: 't@t', timestamp, timezoneOffset: -480 }, tree, parent: [], noUpdateBranch: true,
        });
        const ours = await at('ours', 1_700_000_000);
        const theirs = await at('theirs', 1_700_000_500);
        const first = await writeMergeCommit({ gitdir, files: result.files, parents: [ours, theirs] });
        expect(await writeMergeCommit({ gitdir, files: result.files, parents: [theirs, ours] })).toBe(first);
        const { commit } = await git.readCommit({ fs: atomicFs, gitdir, oid: first });
        for (const signature of [commit.author, commit.committer]) {
            expect(signature).toMatchObject({ timestamp: 1_700_000_500, timezoneOffset: 0 });
        }
    });

    async function mergeWithParents(baseFiles, oursFiles, theirsFiles) {
        const directories = makeUserDirs(userRoot);
        const base = await commitFiles(gitdir, baseFiles);
        const ours = await commitFiles(gitdir, oursFiles, [base]);
        const theirs = await commitFiles(gitdir, theirsFiles, [base]);
        return mergeCommitTrees({ gitdir, base, ours, theirs, parentOfSubRecord: rel => subRecordParentPath(directories, rel) });
    }

    test('a surviving chat state companion keeps its parent chat', async () => {
        const { files, conflicts } = await mergeWithParents(
            { 'chats/Seraphina/c1.jsonl': 'A', 'chats/Seraphina/c1.luker-state.mg.json': 'S0' },
            { 'chats/Seraphina/c1.jsonl': 'A', 'chats/Seraphina/c1.luker-state.mg.json': 'S1' },
            {},
        );
        expect(contents(files)).toEqual({ 'chats/Seraphina/c1.jsonl': oid('A'), 'chats/Seraphina/c1.luker-state.mg.json': oid('S1') });
        expect(conflicts).toEqual([
            { filepath: 'chats/Seraphina/c1.luker-state.mg.json', kind: 'deleteByTheirs', oursOid: oid('S1'), theirsOid: null },
            { filepath: 'chats/Seraphina/c1.jsonl', kind: 'deleteByTheirs', oursOid: oid('A'), theirsOid: null },
        ]);
    });

    test('a surviving group chat companion keeps its parent', async () => {
        const { files } = await mergeWithParents(
            { 'group chats/g1.jsonl': 'G', 'group chats/g1.luker-state.mg.json': 'S0' },
            { 'group chats/g1.jsonl': 'G', 'group chats/g1.luker-state.mg.json': 'S1' },
            {},
        );
        expect(files.get('group chats/g1.jsonl').oid).toBe(oid('G'));
    });

    test('a surviving preset companion keeps its json parent', async () => {
        const { files } = await mergeWithParents(
            { 'OpenAI Settings/p.json': 'P', 'OpenAI Settings/p.luker-state.ns.json': 'S0' },
            { 'OpenAI Settings/p.json': 'P', 'OpenAI Settings/p.luker-state.ns.json': 'S1' },
            {},
        );
        expect(files.get('OpenAI Settings/p.json').oid).toBe(oid('P'));
    });

    test('a parent kept only by theirs is restored as deleteByUs', async () => {
        const { files, conflicts } = await mergeWithParents(
            { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S0' },
            { 'chats/S/c.luker-state.mg.json': 'S1' },
            { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S0' },
        );
        expect(files.get('chats/S/c.jsonl').oid).toBe(oid('A'));
        expect(conflicts).toContainEqual({ filepath: 'chats/S/c.jsonl', kind: 'deleteByUs', oursOid: null, theirsOid: oid('A') });
    });

    test('a companion-named file outside chat and preset folders is not given a parent', async () => {
        const { files } = await mergeWithParents(
            { 'worlds/w.json': 'W', 'worlds/w.luker-state.ns.json': 'S0' },
            { 'worlds/w.json': 'W', 'worlds/w.luker-state.ns.json': 'S1' },
            {},
        );
        expect(files.has('worlds/w.json')).toBe(false);
    });

    test('a restored parent already reported as a conflict is reported once', async () => {
        const { conflicts } = await mergeWithParents(
            { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S0' },
            { 'chats/S/c.luker-state.mg.json': 'S1' },
            { 'chats/S/c.jsonl': 'A2', 'chats/S/c.luker-state.mg.json': 'S0' },
        );
        expect(conflicts.filter(c => c.filepath === 'chats/S/c.jsonl')).toHaveLength(1);
    });

    test('a parent whose path holds a directory in the merge is not restored', async () => {
        const { files, conflicts } = await mergeWithParents(
            { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S0' },
            { 'chats/S/c.jsonl/x': 'X', 'chats/S/c.luker-state.mg.json': 'S1' },
            { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S0' },
        );
        expect(files.has('chats/S/c.jsonl')).toBe(false);
        expect(files.get('chats/S/c.jsonl/x').oid).toBe(oid('X'));
        expect(conflicts.some(c => c.filepath === 'chats/S/c.jsonl')).toBe(false);
    });

    test('a companion both deleted by ours and changed by theirs restores no parent', async () => {
        const { files, conflicts } = await mergeWithParents(
            { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S0' },
            {},
            { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S1' },
        );
        expect(files.size).toBe(0);
        expect(conflicts).toEqual([
            { filepath: 'chats/S/c.luker-state.mg.json', kind: 'deleteByUs', oursOid: null, theirsOid: oid('S1') },
        ]);
    });

    test('a chat ours edited and theirs deleted keeps the companions theirs deleted with it', async () => {
        const { files, conflicts } = await mergeWithParents(
            { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S0', 'chats/S/c.luker-state.ns.json': 'N0' },
            { 'chats/S/c.jsonl': 'A2', 'chats/S/c.luker-state.mg.json': 'S0', 'chats/S/c.luker-state.ns.json': 'N0' },
            {},
        );
        expect(contents(files)).toEqual({ 'chats/S/c.jsonl': oid('A2'), 'chats/S/c.luker-state.mg.json': oid('S0'), 'chats/S/c.luker-state.ns.json': oid('N0') });
        expect(conflicts).toEqual([
            { filepath: 'chats/S/c.jsonl', kind: 'deleteByTheirs', oursOid: oid('A2'), theirsOid: null },
            { filepath: 'chats/S/c.luker-state.mg.json', kind: 'deleteByTheirs', oursOid: oid('S0'), theirsOid: null },
            { filepath: 'chats/S/c.luker-state.ns.json', kind: 'deleteByTheirs', oursOid: oid('N0'), theirsOid: null },
        ]);
    });

    test('a preset ours edited and theirs deleted keeps the companions theirs deleted with it', async () => {
        const { files } = await mergeWithParents(
            { 'OpenAI Settings/p.json': 'P', 'OpenAI Settings/p.luker-state.ns.json': 'S0' },
            { 'OpenAI Settings/p.json': 'P2', 'OpenAI Settings/p.luker-state.ns.json': 'S0' },
            {},
        );
        expect(files.get('OpenAI Settings/p.luker-state.ns.json').oid).toBe(oid('S0'));
    });

    test('a chat theirs deleted and ours left alone is deleted with its companions', async () => {
        const { files, conflicts } = await mergeWithParents(
            { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S0' },
            { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S0' },
            {},
        );
        expect(files.size).toBe(0);
        expect(conflicts).toEqual([]);
    });

    test('a companion theirs deleted while both edited the chat stays deleted', async () => {
        const { files } = await mergeWithParents(
            { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S0' },
            { 'chats/S/c.jsonl': 'A2', 'chats/S/c.luker-state.mg.json': 'S0' },
            { 'chats/S/c.jsonl': 'A3' },
        );
        expect(files.has('chats/S/c.luker-state.mg.json')).toBe(false);
    });

    test('a world theirs deleted keeps no companion-named file', async () => {
        const { files } = await mergeWithParents(
            { 'worlds/w.json': 'W', 'worlds/w.luker-state.ns.json': 'S0' },
            { 'worlds/w.json': 'W2', 'worlds/w.luker-state.ns.json': 'S0' },
            {},
        );
        expect(files.has('worlds/w.luker-state.ns.json')).toBe(false);
    });

    test('without a resolver the merge keeps today\'s result', async () => {
        const base = await commitFiles(gitdir, { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S0' });
        const ours = await commitFiles(gitdir, { 'chats/S/c.jsonl': 'A', 'chats/S/c.luker-state.mg.json': 'S1' }, [base]);
        const theirs = await commitFiles(gitdir, {}, [base]);
        const { files } = await mergeCommitTrees({ gitdir, base, ours, theirs });
        expect(files.has('chats/S/c.jsonl')).toBe(false);
    });

    async function mergeParsed(baseFiles, oursFiles, theirsFiles) {
        const directories = makeUserDirs(userRoot);
        const base = baseFiles ? await commitFiles(gitdir, baseFiles) : null;
        const ours = await commitFiles(gitdir, oursFiles, base ? [base] : []);
        const theirs = await commitFiles(gitdir, theirsFiles, base ? [base] : []);
        return mergeCommitTrees({
            gitdir, base, ours, theirs,
            parentOfSubRecord: rel => subRecordParentPath(directories, rel),
            parseRecord: (rel) => {
                const record = describeSqlRecordPath(directories, rel);
                return record ? bytes => parseSqlRecordBlob(record, bytes) : null;
            },
        });
    }

    const world = '{"name":"W","entries":{"0":{"uid":0,"key":["k"]}}}';
    const worldReordered = '{\n    "entries": {"0": {"key": ["k"], "uid": 0}},\n    "name": "W"\n}';
    const chat = '{"user_name":"U","chat_metadata":{"integrity":"i"}}\n{"name":"U","mes":"hi"}\n';
    const chatReordered = '{"chat_metadata":{"integrity":"i"},"user_name":"U"}\n{"mes":"hi","name":"U"}\n';

    test('records added on both sides with parse-equal bytes merge to ours without a conflict', async () => {
        const result = await mergeParsed(null, { 'worlds/W.json': world, 'chats/S/c.jsonl': chat }, { 'worlds/W.json': worldReordered, 'chats/S/c.jsonl': chatReordered });
        expect(result.conflicts).toEqual([]);
        expect(contents(result.files)).toEqual({ 'worlds/W.json': oid(world), 'chats/S/c.jsonl': oid(chat) });
    });

    test('a side that only rewrote a record in another key order counts as unchanged', async () => {
        const theirsEdit = '{"name":"W","entries":{}}';
        const takesTheirs = await mergeParsed({ 'worlds/W.json': world }, { 'worlds/W.json': worldReordered }, { 'worlds/W.json': theirsEdit });
        expect(takesTheirs.conflicts).toEqual([]);
        expect(contents(takesTheirs.files)).toEqual({ 'worlds/W.json': oid(theirsEdit) });
        const keepsOurs = await mergeParsed({ 'worlds/W.json': world }, { 'worlds/W.json': theirsEdit }, { 'worlds/W.json': worldReordered });
        expect(keepsOurs.conflicts).toEqual([]);
        expect(contents(keepsOurs.files)).toEqual({ 'worlds/W.json': oid(theirsEdit) });
    });

    test('parse-equal content outside record paths and unparseable records compare by bytes', async () => {
        const result = await mergeParsed(null, { 'characters/x.json': world, 'worlds/Bad.json': '{bad' }, { 'characters/x.json': worldReordered, 'worlds/Bad.json': '{bad ' });
        expect(result.conflicts.map(c => c.filepath).sort()).toEqual(['characters/x.json', 'worlds/Bad.json']);
    });

    test('different values in record paths still conflict', async () => {
        const result = await mergeParsed(null, { 'worlds/W.json': world }, { 'worlds/W.json': '{"name":"W","entries":{}}' });
        expect(result.conflicts).toEqual([expect.objectContaining({ filepath: 'worlds/W.json', kind: 'bothModified' })]);
    });

    test('every combination of absent, reordered and changed records picks by the three-way rule on values', async () => {
        const variants = [undefined, world, worldReordered, '{"name":"W","entries":{}}'];
        const same = (a, b) => (a === undefined || b === undefined ? a === b : isDeepStrictEqual(JSON.parse(a), JSON.parse(b)));
        const at = content => (content === undefined ? {} : { 'worlds/W.json': content });
        for (const b of variants) {
            for (const o of variants) {
                for (const t of variants) {
                    const picked = !same(o, t) && same(o, b) ? t : o;
                    const conflict = !same(o, t) && !same(o, b) && !same(t, b);
                    const result = await mergeParsed(b === undefined ? null : at(b), at(o), at(t));
                    expect({ b, o, t, picked: result.files.get('worlds/W.json')?.oid, conflicts: result.conflicts.length })
                        .toEqual({ b, o, t, picked: picked === undefined ? undefined : oid(picked), conflicts: conflict ? 1 : 0 });
                }
            }
        }
    });
});
