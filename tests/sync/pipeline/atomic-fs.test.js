import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import git from 'isomorphic-git';

import { atomicFs, sweepStaleAtomicTemps } from '../../../src/sync/pipeline/atomic-fs.js';

const CHILD = fileURLToPath(new URL('../_lib/atomic-writer-child.mjs', import.meta.url));
const AUTHOR = { name: 't', email: 't@t' };

describe('atomicFs', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-atomic-fs-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('writeFile replaces the target through a rename and leaves no temp file', async () => {
        const target = path.join(dir, 'file');
        fs.writeFileSync(target, 'old');
        const before = fs.statSync(target).ino;
        await atomicFs.promises.writeFile(target, 'new', 'utf8');
        expect(fs.readFileSync(target, 'utf8')).toBe('new');
        expect(fs.statSync(target).ino).not.toBe(before);
        expect(fs.readdirSync(dir)).toEqual(['file']);
    });

    test('writeFile rejects with ENOENT when the parent is missing so isomorphic-git can mkdir and retry', async () => {
        await expect(atomicFs.promises.writeFile(path.join(dir, 'missing', 'file'), 'x')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('isomorphic-git config, index and ref writes replace files through rename', async () => {
        const workdir = path.join(dir, 'workdir');
        const gitdir = path.join(dir, 'repo.git');
        fs.mkdirSync(workdir);
        await git.init({ fs: atomicFs, dir: workdir, gitdir, defaultBranch: 'main' });
        const ino = rel => fs.statSync(path.join(gitdir, rel)).ino;

        const configBefore = ino('config');
        await git.setConfig({ fs: atomicFs, dir: workdir, gitdir, path: 'user.name', value: 't' });
        expect(ino('config')).not.toBe(configBefore);

        fs.writeFileSync(path.join(workdir, 'a.txt'), '1');
        await git.add({ fs: atomicFs, dir: workdir, gitdir, filepath: 'a.txt' });
        const indexBefore = ino('index');
        fs.writeFileSync(path.join(workdir, 'a.txt'), '2');
        await git.add({ fs: atomicFs, dir: workdir, gitdir, filepath: 'a.txt' });
        expect(ino('index')).not.toBe(indexBefore);

        await git.commit({ fs: atomicFs, dir: workdir, gitdir, message: 'one', author: AUTHOR });
        const refBefore = ino('refs/heads/main');
        const second = await git.commit({ fs: atomicFs, dir: workdir, gitdir, message: 'two', author: AUTHOR });
        expect(ino('refs/heads/main')).not.toBe(refBefore);
        expect(fs.readFileSync(path.join(gitdir, 'refs/heads/main'), 'utf8').trim()).toBe(second);
        expect(fs.readdirSync(path.join(gitdir, 'refs/heads'))).toEqual(['main']);
    });

    test('a SIGKILL during repeated writes leaves either the old or the new content', async () => {
        // A multi-MiB payload keeps each write in flight long enough that the kill
        // lands mid-write in practice; the assertion holds for any size.
        const size = 8 * 1024 * 1024;
        for (let round = 0; round < 3; round++) {
            const target = path.join(dir, `victim-${round}`);
            const child = spawn(process.execPath, [CHILD, target, String(size)], { stdio: ['ignore', 'pipe', 'inherit'] });
            await new Promise(resolve => child.stdout.once('data', resolve));
            await new Promise(resolve => setTimeout(resolve, 20 + round * 15));
            child.kill('SIGKILL');
            await new Promise(resolve => child.once('exit', resolve));
            const content = fs.readFileSync(target);
            expect(content.length).toBe(size);
            expect([0x41, 0x42]).toContain(content[0]);
            expect(content.equals(Buffer.alloc(size, content[0]))).toBe(true);
        }
    }, 60_000);

    test('sweepStaleAtomicTemps removes temp files left by an earlier process and keeps the rest', async () => {
        const gitdir = path.join(dir, 'repo.git');
        const files = {
            'HEAD': 'ref: refs/heads/main\n',
            'refs/heads/main': 'a'.repeat(40) + '\n',
            'refs/heads/main.123456789': 'x',
            'refs/tags/sync-backup-2026-10-12T00-00-00-000Z-abcdef12.42': 'x',
            'refs/heads/main.987': 'fresh',
            'objects/incoming/0123456789abcdef.1': 'x',
        };
        for (const [rel, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(gitdir, rel)), { recursive: true });
            fs.writeFileSync(path.join(gitdir, rel), content);
        }
        const past = (performance.timeOrigin - 60_000) / 1000;
        for (const rel of ['refs/heads/main.123456789', 'refs/tags/sync-backup-2026-10-12T00-00-00-000Z-abcdef12.42', 'objects/incoming/0123456789abcdef.1', 'refs/heads/main']) {
            fs.utimesSync(path.join(gitdir, rel), past, past);
        }
        const removed = await sweepStaleAtomicTemps(gitdir);
        expect(removed.sort()).toEqual(['refs/heads/main.123456789', 'refs/tags/sync-backup-2026-10-12T00-00-00-000Z-abcdef12.42']);
        expect(fs.existsSync(path.join(gitdir, 'refs/heads/main'))).toBe(true);
        expect(fs.existsSync(path.join(gitdir, 'refs/heads/main.987'))).toBe(true);
        expect(fs.existsSync(path.join(gitdir, 'objects/incoming/0123456789abcdef.1'))).toBe(true);
    });

    test('concurrent sweeps of one gitdir tolerate files the other removed', async () => {
        const gitdir = path.join(dir, 'repo.git');
        const names = Array.from({ length: 50 }, (_, i) => `refs/heads/main.${i}`);
        fs.mkdirSync(path.join(gitdir, 'refs/heads'), { recursive: true });
        const past = (performance.timeOrigin - 60_000) / 1000;
        for (const rel of names) {
            fs.writeFileSync(path.join(gitdir, rel), 'x');
            fs.utimesSync(path.join(gitdir, rel), past, past);
        }
        const [first, second] = await Promise.all([sweepStaleAtomicTemps(gitdir), sweepStaleAtomicTemps(gitdir)]);
        expect([...new Set([...first, ...second])].sort()).toEqual([...names].sort());
        expect(fs.readdirSync(path.join(gitdir, 'refs/heads'))).toEqual([]);
    });

    test('sweepStaleAtomicTemps tolerates a missing gitdir', async () => {
        await expect(sweepStaleAtomicTemps(path.join(dir, 'absent'))).resolves.toEqual([]);
    });
});
