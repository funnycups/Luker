import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { attemptMerge, applyResolutions } from '../../src/sync/conflicts.js';

const AUTHOR = { name: 't', email: 't@t' };

async function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-conf-'));
    await git.init({ fs, dir, defaultBranch: 'main' });
    return dir;
}
async function commit(dir, branch, files, parent) {
    if (parent) await git.branch({ fs, dir, ref: branch, object: parent, force: true });
    await git.checkout({ fs, dir, ref: branch, force: true });
    for (const [p, content] of Object.entries(files)) {
        const abs = path.join(dir, p);
        if (content === null) {
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
        } else {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content);
        }
    }
    for (const p of Object.keys(files)) {
        if (files[p] === null) {
            try { await git.remove({ fs, dir, filepath: p }); } catch {}
        } else {
            await git.add({ fs, dir, filepath: p });
        }
    }
    return git.commit({ fs, dir, message: branch, author: AUTHOR });
}

describe('attemptMerge + applyResolutions', () => {
    let dir;
    beforeEach(async () => { dir = await makeRepo(); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('returns success=true with no conflicts for disjoint changes', async () => {
        fs.writeFileSync(path.join(dir, 'base.txt'), 'b');
        await git.add({ fs, dir, filepath: 'base.txt' });
        const base = await git.commit({ fs, dir, message: 'base', author: AUTHOR });
        await commit(dir, 'a', { 'a-only.txt': 'A' }, base);
        await commit(dir, 'b', { 'b-only.txt': 'B' }, base);

        const result = await attemptMerge({ dir, ours: 'a', theirs: 'b', author: AUTHOR });
        expect(result.success).toBe(true);
        expect(result.conflicts).toEqual([]);
        expect(result.mergeOid).toBeTruthy();
    });

    test('returns success=false with conflict set for overlapping edits', async () => {
        fs.writeFileSync(path.join(dir, 'shared.txt'), 'BASE_LINE');
        await git.add({ fs, dir, filepath: 'shared.txt' });
        const base = await git.commit({ fs, dir, message: 'base', author: AUTHOR });
        await commit(dir, 'a', { 'shared.txt': 'A_LINE' }, base);
        await commit(dir, 'b', { 'shared.txt': 'B_LINE' }, base);

        const result = await attemptMerge({ dir, ours: 'a', theirs: 'b', author: AUTHOR });
        expect(result.success).toBe(false);
        expect(result.conflicts).toEqual([
            expect.objectContaining({ filepath: 'shared.txt', kind: 'bothModified' }),
        ]);
        expect(result.conflicts[0].oursOid).toBeTruthy();
        expect(result.conflicts[0].theirsOid).toBeTruthy();
    });

    test('classifies deleteByUs / deleteByTheirs correctly', async () => {
        fs.writeFileSync(path.join(dir, 'doomed.txt'), 'BASE');
        await git.add({ fs, dir, filepath: 'doomed.txt' });
        const base = await git.commit({ fs, dir, message: 'base', author: AUTHOR });
        await commit(dir, 'a', { 'doomed.txt': null }, base);
        await commit(dir, 'b', { 'doomed.txt': 'B_EDITED' }, base);

        const result = await attemptMerge({ dir, ours: 'a', theirs: 'b', author: AUTHOR });
        expect(result.success).toBe(false);
        expect(result.conflicts).toEqual([
            expect.objectContaining({ filepath: 'doomed.txt', kind: 'deleteByUs' }),
        ]);
        expect(result.conflicts[0].oursOid).toBeNull();
        expect(result.conflicts[0].theirsOid).toBeTruthy();
    });

    test('applyResolutions writes chosen blobs and produces a two-parent commit', async () => {
        fs.writeFileSync(path.join(dir, 'shared.txt'), 'BASE');
        await git.add({ fs, dir, filepath: 'shared.txt' });
        const base = await git.commit({ fs, dir, message: 'base', author: AUTHOR });
        await commit(dir, 'a', { 'shared.txt': 'A_LINE' }, base);
        await commit(dir, 'b', { 'shared.txt': 'B_LINE' }, base);

        const mergeAttempt = await attemptMerge({ dir, ours: 'a', theirs: 'b', author: AUTHOR });
        expect(mergeAttempt.success).toBe(false);

        const mergeOid = await applyResolutions({
            dir,
            ours: 'a',
            theirs: 'b',
            author: AUTHOR,
            picks: { 'shared.txt': 'theirs' },
        });

        const merged = await git.readCommit({ fs, dir, oid: mergeOid });
        expect(merged.commit.parent).toHaveLength(2);

        expect(fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8')).toBe('B_LINE');

        await git.writeRef({ fs, dir, ref: 'refs/heads/a', value: mergeOid, force: true });
        const reMerge = await git.merge({ fs, dir, ours: 'a', theirs: 'b', author: AUTHOR, abortOnConflict: false });
        expect(reMerge.alreadyMerged).toBe(true);
    });

    test('applyResolutions handles delete-vs-modify by removing the file when "ours" was the deletion', async () => {
        fs.writeFileSync(path.join(dir, 'doomed.txt'), 'BASE');
        await git.add({ fs, dir, filepath: 'doomed.txt' });
        const base = await git.commit({ fs, dir, message: 'base', author: AUTHOR });
        await commit(dir, 'a', { 'doomed.txt': null }, base);
        await commit(dir, 'b', { 'doomed.txt': 'B_EDITED' }, base);

        await attemptMerge({ dir, ours: 'a', theirs: 'b', author: AUTHOR });
        const mergeOid = await applyResolutions({
            dir, ours: 'a', theirs: 'b', author: AUTHOR,
            picks: { 'doomed.txt': 'ours' },
        });
        expect(fs.existsSync(path.join(dir, 'doomed.txt'))).toBe(false);

        const merged = await git.readCommit({ fs, dir, oid: mergeOid });
        expect(merged.commit.parent).toHaveLength(2);
    });

    test('applyResolutions preserves files unique to either side of the merge', async () => {
        fs.writeFileSync(path.join(dir, 'shared.txt'), 'BASE');
        fs.writeFileSync(path.join(dir, 'base-keep.txt'), 'KEEP');
        await git.add({ fs, dir, filepath: 'shared.txt' });
        await git.add({ fs, dir, filepath: 'base-keep.txt' });
        const base = await git.commit({ fs, dir, message: 'base', author: AUTHOR });

        await commit(dir, 'a', { 'shared.txt': 'A_LINE', 'a-only.txt': 'A_NEW' }, base);
        await commit(dir, 'b', { 'shared.txt': 'B_LINE', 'b-only.txt': 'B_NEW' }, base);

        await attemptMerge({ dir, ours: 'a', theirs: 'b', author: AUTHOR });
        const mergeOid = await applyResolutions({
            dir, ours: 'a', theirs: 'b', author: AUTHOR,
            picks: { 'shared.txt': 'theirs' },
        });

        const files = await git.listFiles({ fs, dir, ref: mergeOid });
        expect(files.sort()).toEqual(['a-only.txt', 'b-only.txt', 'base-keep.txt', 'shared.txt'].sort());

        const sharedBlob = await git.readBlob({ fs, dir, oid: mergeOid, filepath: 'shared.txt' });
        expect(new TextDecoder().decode(sharedBlob.blob)).toBe('B_LINE');
        const aOnlyBlob = await git.readBlob({ fs, dir, oid: mergeOid, filepath: 'a-only.txt' });
        expect(new TextDecoder().decode(aOnlyBlob.blob)).toBe('A_NEW');
        const bOnlyBlob = await git.readBlob({ fs, dir, oid: mergeOid, filepath: 'b-only.txt' });
        expect(new TextDecoder().decode(bOnlyBlob.blob)).toBe('B_NEW');
    });

    test('applyResolutions throws if a bothModified file is not in picks', async () => {
        fs.writeFileSync(path.join(dir, 'shared.txt'), 'BASE');
        await git.add({ fs, dir, filepath: 'shared.txt' });
        const base = await git.commit({ fs, dir, message: 'base', author: AUTHOR });
        await commit(dir, 'a', { 'shared.txt': 'A_LINE' }, base);
        await commit(dir, 'b', { 'shared.txt': 'B_LINE' }, base);

        await attemptMerge({ dir, ours: 'a', theirs: 'b', author: AUTHOR });
        await expect(applyResolutions({
            dir, ours: 'a', theirs: 'b', author: AUTHOR, picks: {},
        })).rejects.toThrow(/[Uu]nresolved/);
    });
});
