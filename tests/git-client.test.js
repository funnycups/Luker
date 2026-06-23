import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import git from 'isomorphic-git';

import { createGitClient } from '../src/git/client.js';

/**
 * These tests pin down the change-detection contract of the git client wrapper
 * used in src/git/client.js. They exist because isomorphic-git's `statusMatrix`
 * follows the "racy git" stat optimization
 * (kernel.org/pub/software/scm/git/docs/technical/racy-git.txt): when a file's
 * size and second-precision mtime match the index entry, the workdir oid is
 * assumed equal to the staged oid without re-hashing contents. Two writes to
 * the same file within the same wall-clock second (or even back-to-back writes
 * fast enough to share an mtime) can therefore look identical to a stale index.
 *
 * Real users hit this with the CardApp Studio auto-commit flow: two saves to
 * the same file inside a second silently lost the second commit on the builtin
 * backend, even though the file on disk was up to date.
 *
 * commitIfChanged + addAll must NOT depend on statusMatrix for change detection,
 * and both backends (builtin / system) must agree on observable behavior.
 */

function runRaceContract(backendLabel, makeClient) {
    describe(`${backendLabel} backend — same-second double write is detected`, () => {
        let dir;

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), `luker-git-race-${backendLabel}-`));
        });

        afterEach(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        test('commitIfChanged captures a second write of identical size in the same second', async () => {
            const client = makeClient();
            await client.init(dir);
            await client.setConfig(dir, 'user.name', 'test');
            await client.setConfig(dir, 'user.email', 'test@local');

            const filePath = path.join(dir, 'doc.txt');
            fs.writeFileSync(filePath, 'version-1', 'utf8');
            const firstCommitted = await client.commitIfChanged(dir, 'v1');
            expect(firstCommitted).toBe(true);

            // Force the mtime to exactly match the previous write at 1-second
            // granularity — this is the racy-git failure mode. Using utimesSync
            // makes the test deterministic instead of timing-dependent.
            const stat = fs.statSync(filePath);
            fs.writeFileSync(filePath, 'version-2', 'utf8');
            fs.utimesSync(filePath, stat.atime, stat.mtime);
            // Same size (9 bytes vs 9 bytes), same mtime — racy-git skip territory.

            const secondCommitted = await client.commitIfChanged(dir, 'v2');
            expect(secondCommitted).toBe(true);

            const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
            const { blob } = await git.readBlob({ fs, dir, oid: headOid, filepath: 'doc.txt' });
            expect(new TextDecoder().decode(blob)).toBe('version-2');

            const log = await client.log(dir, 5);
            expect(log.map(c => c.message)).toEqual(['v2', 'v1']);
        });

        test('commitIfChanged returns false when contents truly are unchanged', async () => {
            const client = makeClient();
            await client.init(dir);
            await client.setConfig(dir, 'user.name', 'test');
            await client.setConfig(dir, 'user.email', 'test@local');

            const filePath = path.join(dir, 'doc.txt');
            fs.writeFileSync(filePath, 'unchanged', 'utf8');
            expect(await client.commitIfChanged(dir, 'v1')).toBe(true);

            // Touch the mtime but keep the content identical — should NOT commit.
            const now = new Date();
            fs.utimesSync(filePath, now, now);

            const secondCommitted = await client.commitIfChanged(dir, 'noop');
            expect(secondCommitted).toBe(false);

            const log = await client.log(dir, 5);
            expect(log).toHaveLength(1);
        });

        test('commitIfChanged handles deletes alongside same-second rewrites', async () => {
            const client = makeClient();
            await client.init(dir);
            await client.setConfig(dir, 'user.name', 'test');
            await client.setConfig(dir, 'user.email', 'test@local');

            fs.writeFileSync(path.join(dir, 'keep.txt'), 'A', 'utf8');
            fs.writeFileSync(path.join(dir, 'gone.txt'), 'X', 'utf8');
            fs.writeFileSync(path.join(dir, 'edit.txt'), 'first', 'utf8');
            expect(await client.commitIfChanged(dir, 'init')).toBe(true);

            // Same-second-style follow-up: rewrite `edit.txt` keeping size and mtime,
            // delete `gone.txt`, leave `keep.txt` alone.
            const editStat = fs.statSync(path.join(dir, 'edit.txt'));
            fs.writeFileSync(path.join(dir, 'edit.txt'), 'after', 'utf8');
            fs.utimesSync(path.join(dir, 'edit.txt'), editStat.atime, editStat.mtime);
            fs.unlinkSync(path.join(dir, 'gone.txt'));

            expect(await client.commitIfChanged(dir, 'follow-up')).toBe(true);

            const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
            const headFiles = await git.listFiles({ fs, dir, ref: headOid });
            expect(headFiles.sort()).toEqual(['edit.txt', 'keep.txt']);

            const editBlob = await git.readBlob({ fs, dir, oid: headOid, filepath: 'edit.txt' });
            expect(new TextDecoder().decode(editBlob.blob)).toBe('after');
        });

        test('addAll picks up nested directories and prunes vanished files', async () => {
            const client = makeClient();
            await client.init(dir);
            await client.setConfig(dir, 'user.name', 'test');
            await client.setConfig(dir, 'user.email', 'test@local');

            fs.mkdirSync(path.join(dir, 'sub', 'nested'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'A');
            fs.writeFileSync(path.join(dir, 'sub', 'nested', 'b.txt'), 'B');
            expect(await client.commitIfChanged(dir, 'first')).toBe(true);

            fs.unlinkSync(path.join(dir, 'sub', 'a.txt'));
            fs.writeFileSync(path.join(dir, 'sub', 'nested', 'b.txt'), 'B2');
            const bStat = fs.statSync(path.join(dir, 'sub', 'nested', 'b.txt'));
            // Pin mtime to provoke the racy-git case on b.txt for good measure.
            fs.utimesSync(path.join(dir, 'sub', 'nested', 'b.txt'), bStat.atime, bStat.mtime);
            fs.writeFileSync(path.join(dir, 'sub', 'c.txt'), 'C');

            expect(await client.commitIfChanged(dir, 'second')).toBe(true);

            const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
            const headFiles = await git.listFiles({ fs, dir, ref: headOid });
            expect(headFiles.sort()).toEqual(['sub/c.txt', 'sub/nested/b.txt']);

            const bBlob = await git.readBlob({ fs, dir, oid: headOid, filepath: 'sub/nested/b.txt' });
            expect(new TextDecoder().decode(bBlob.blob)).toBe('B2');
        });
    });
}

runRaceContract('builtin', () => createGitClient({ backend: 'builtin' }));
runRaceContract('system', () => createGitClient({ backend: 'system' }));

