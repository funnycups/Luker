import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FsEngine } from '../../../src/storage/engines/fs-engine.js';
import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { reconcileLiveCas } from '../../../src/sync/pipeline/live-cas.js';
import { commitFiles, commitTree, writeBlob, writeRawTree } from '../_lib/commits.js';
import { makeUserDirs } from '../_lib/user-dirs.js';

describe('reconcileLiveCas (fs)', () => {
    let root;
    let dirs;
    let gitdir;
    let engine;
    const live = rel => path.join(root, ...rel.split('/'));
    const write = (rel, content) => { fs.mkdirSync(path.dirname(live(rel)), { recursive: true }); fs.writeFileSync(live(rel), content); };
    const read = rel => (fs.existsSync(live(rel)) ? fs.readFileSync(live(rel), 'utf8') : null);
    const run = (base, target, categories = ['characters', 'worlds']) =>
        reconcileLiveCas({ gitdir, directories: dirs, handle: 'u', categories, engine, base, target });

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-livecas-'));
        dirs = makeUserDirs(root);
        ({ gitDir: gitdir } = await ensureShadowRepo({ userRoot: root, peerId: 'p' }));
        engine = new FsEngine({ directoriesByHandle: () => dirs });
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('a live file that still matches the base is written', async () => {
        const base = await commitFiles(gitdir, { 'characters/a.png': 'L' });
        const target = await commitFiles(gitdir, { 'characters/a.png': 'M' }, [base]);
        write('characters/a.png', 'L');
        const report = await run(base, target);
        expect(report).toEqual({ written: ['characters/a.png'], deleted: [], alreadyApplied: [], skipped: [], ignored: [] });
        expect(read('characters/a.png')).toBe('M');
    });

    test('a live file edited after the base is skipped and left alone', async () => {
        const base = await commitFiles(gitdir, { 'characters/a.png': 'L' });
        const target = await commitFiles(gitdir, { 'characters/a.png': 'M' }, [base]);
        write('characters/a.png', 'USER');
        const report = await run(base, target);
        expect(report.skipped).toEqual(['characters/a.png']);
        expect(read('characters/a.png')).toBe('USER');
    });

    test('a live file already equal to the target counts as applied', async () => {
        const base = await commitFiles(gitdir, { 'characters/a.png': 'L' });
        const target = await commitFiles(gitdir, { 'characters/a.png': 'M' }, [base]);
        write('characters/a.png', 'M');
        expect((await run(base, target)).alreadyApplied).toEqual(['characters/a.png']);
    });

    test('additions write when absent, skip a user-created file and accept an equal one', async () => {
        const base = await commitFiles(gitdir, { 'characters/keep.png': 'K' });
        const target = await commitFiles(gitdir, { 'characters/keep.png': 'K', 'characters/new.png': 'N', 'characters/mine.png': 'N2', 'characters/same.png': 'S' }, [base]);
        write('characters/mine.png', 'USER');
        write('characters/same.png', 'S');
        const report = await run(base, target);
        expect(report.written).toEqual(['characters/new.png']);
        expect(report.skipped).toEqual(['characters/mine.png']);
        expect(report.alreadyApplied).toEqual(['characters/same.png']);
        expect(read('characters/new.png')).toBe('N');
        expect(read('characters/mine.png')).toBe('USER');
    });

    test('deletions remove a matching file and prune empty directories but not the category root', async () => {
        const base = await commitFiles(gitdir, { 'characters/sub/a.png': 'A', 'characters/b.png': 'B', 'characters/c.png': 'C' });
        const target = await commitFiles(gitdir, {}, [base]);
        write('characters/sub/a.png', 'A');
        write('characters/b.png', 'EDITED');
        const report = await run(base, target);
        expect(report.deleted).toEqual(['characters/sub/a.png']);
        expect(report.skipped).toEqual(['characters/b.png']);
        expect(report.alreadyApplied).toEqual(['characters/c.png']);
        expect(fs.existsSync(live('characters/sub'))).toBe(false);
        expect(fs.existsSync(live('characters'))).toBe(true);
    });

    test('a second run over the same pair converges with nothing left to do', async () => {
        const base = await commitFiles(gitdir, { 'characters/a.png': 'L', 'characters/gone.png': 'G' });
        const target = await commitFiles(gitdir, { 'characters/a.png': 'M', 'characters/b.png': 'B' }, [base]);
        write('characters/a.png', 'L');
        write('characters/gone.png', 'G');
        await run(base, target);
        const again = await run(base, target);
        expect(again.written).toEqual([]);
        expect(again.deleted).toEqual([]);
        expect(again.skipped).toEqual([]);
        expect(again.ignored).toEqual([]);
        expect(again.alreadyApplied.sort()).toEqual(['characters/a.png', 'characters/b.png', 'characters/gone.png']);
    });

    test('a null base treats every target path as an addition', async () => {
        const target = await commitFiles(gitdir, { 'characters/a.png': 'A', 'worlds/w.json': '{}' });
        const report = await run(null, target);
        expect(report.written.sort()).toEqual(['characters/a.png', 'worlds/w.json']);
    });

    test('sync metadata, disabled categories and nested .git paths are never touched', async () => {
        const base = await commitFiles(gitdir, { 'characters/a.png': 'A' });
        const target = await commitFiles(gitdir, {
            'characters/a.png': 'A',
            '.luker-sync/conflicts.json': '{}',
            'extensions/ext/index.js': 'x',
            'card-apps/c/.git/HEAD': 'x',
            'characters/.luker-staging-asset-1/partial.png': 'x',
        }, [base]);
        const report = await run(base, target, ['characters', 'worlds', 'card-apps']);
        expect(report).toEqual({ written: [], deleted: [], alreadyApplied: [], skipped: [], ignored: [] });
        expect(fs.existsSync(live('.luker-sync'))).toBe(false);
        expect(fs.existsSync(live('extensions/ext/index.js'))).toBe(false);
        expect(fs.existsSync(live('card-apps/c/.git/HEAD'))).toBe(false);
        expect(fs.existsSync(live('characters/.luker-staging-asset-1'))).toBe(false);
    });

    test('symlinks and directories refusing a regular target path are skipped', async () => {
        const base = await commitFiles(gitdir, { 'characters/keep.png': 'K' });
        const target = await commitFiles(gitdir, { 'characters/keep.png': 'K', 'characters/link.png': 'X', 'characters/dir.png': 'Y' }, [base]);
        fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
        fs.symlinkSync(path.join(root, 'outside.txt'), live('characters/link.png'));
        fs.mkdirSync(live('characters/dir.png'));
        const report = await run(base, target);
        expect(report.skipped.sort()).toEqual(['characters/dir.png', 'characters/link.png']);
        expect(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8')).toBe('outside');
        expect(fs.lstatSync(live('characters/link.png')).isSymbolicLink()).toBe(true);
    });

    test('unsafe tree paths are ignored and nothing lands outside the user root', async () => {
        const blob = await writeBlob(gitdir, 'EVIL');
        const leaf = await writeRawTree(gitdir, [{ mode: '100644', name: 'evil.txt', oid: blob }, { mode: '100644', name: 'HEAD', oid: blob }]);
        const up = await writeRawTree(gitdir, [{ mode: '40000', name: '..', oid: leaf }]);
        const characters = await writeRawTree(gitdir, [
            { mode: '40000', name: '..', oid: up },
            { mode: '40000', name: '.GIT', oid: leaf },
            { mode: '100644', name: 'ok.png', oid: blob },
        ]);
        const target = await commitTree(gitdir, await writeRawTree(gitdir, [{ mode: '40000', name: 'characters', oid: characters }]));
        const report = await run(null, target);
        expect(report.written).toEqual(['characters/ok.png']);
        expect(report.ignored.sort()).toEqual(['characters/..', 'characters/.GIT']);
        expect(fs.existsSync(path.join(root, '..', 'evil.txt'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'evil.txt'))).toBe(false);
        expect(fs.existsSync(live('characters/.GIT'))).toBe(false);
    });

    test('symlink and submodule tree entries are ignored and never created', async () => {
        const blob = await writeBlob(gitdir, '../outside.txt');
        const characters = await writeRawTree(gitdir, [
            { mode: '120000', name: 'link.png', oid: blob },
            { mode: '160000', name: 'module', oid: blob },
            { mode: '100644', name: 'ok.png', oid: blob },
        ]);
        const target = await commitTree(gitdir, await writeRawTree(gitdir, [{ mode: '40000', name: 'characters', oid: characters }]));
        const report = await run(null, target);
        expect(report.written).toEqual(['characters/ok.png']);
        expect(report.ignored.sort()).toEqual(['characters/link.png', 'characters/module']);
        expect(fs.existsSync(live('characters/link.png'))).toBe(false);
        expect(fs.existsSync(live('characters/module'))).toBe(false);
    });

    test('a regular file that becomes a symlink in the target is ignored and kept', async () => {
        const blob = await writeBlob(gitdir, '../outside.txt');
        const base = await commitFiles(gitdir, { 'characters/a.png': 'L', 'characters/sub/x.png': 'X' });
        const target = await commitTree(gitdir, await writeRawTree(gitdir, [{ mode: '40000', name: 'characters', oid: await writeRawTree(gitdir, [
            { mode: '120000', name: 'a.png', oid: blob },
            { mode: '120000', name: 'sub', oid: blob },
        ]) }]), [base]);
        write('characters/a.png', 'L');
        write('characters/sub/x.png', 'X');
        const report = await run(base, target);
        expect(report.deleted).toEqual([]);
        expect(report.ignored.sort()).toEqual(['characters/a.png', 'characters/sub', 'characters/sub/x.png']);
        expect(read('characters/a.png')).toBe('L');
        expect(read('characters/sub/x.png')).toBe('X');
    });

    test('a symlink that becomes a regular file in the target is ignored on every run', async () => {
        const blob = await writeBlob(gitdir, '../outside.txt');
        const base = await commitTree(gitdir, await writeRawTree(gitdir, [{ mode: '40000', name: 'characters', oid: await writeRawTree(gitdir, [
            { mode: '120000', name: 'a.png', oid: blob },
        ]) }]));
        const target = await commitFiles(gitdir, { 'characters/a.png': 'M' }, [base]);
        write('characters/a.png', 'L');
        for (let i = 0; i < 2; i++) {
            const report = await run(base, target);
            expect(report).toEqual({ written: [], deleted: [], alreadyApplied: [], skipped: [], ignored: ['characters/a.png'] });
        }
        expect(read('characters/a.png')).toBe('L');
    });

    test('unchanged rejected entries and rejected entries outside every category are not reported', async () => {
        const blob = await writeBlob(gitdir, 'x');
        const characters = await writeRawTree(gitdir, [{ mode: '120000', name: 'l.png', oid: blob }]);
        const base = await commitTree(gitdir, await writeRawTree(gitdir, [{ mode: '40000', name: 'characters', oid: characters }]));
        const target = await commitTree(gitdir, await writeRawTree(gitdir, [
            { mode: '40000', name: 'characters', oid: characters },
            { mode: '100644', name: '..', oid: blob },
            { mode: '120000', name: 'extensions', oid: blob },
        ]), [base]);
        expect(await run(base, target)).toEqual({ written: [], deleted: [], alreadyApplied: [], skipped: [], ignored: [] });
    });

    test('a symlinked parent directory refusing a regular target is skipped', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-livecas-outside-'));
        try {
            fs.symlinkSync(outside, live('characters/sub'));
            const base = await commitFiles(gitdir, { 'characters/keep.png': 'K' });
            const target = await commitFiles(gitdir, { 'characters/keep.png': 'K', 'characters/sub/x.png': 'X' }, [base]);
            const report = await run(base, target);
            expect(report.skipped).toEqual(['characters/sub/x.png']);
            expect(fs.readdirSync(outside)).toEqual([]);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    test.each(['directory', 'intermediate', 'file'])('a linked %s category root cannot receive writes or deletions', async kind => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-root-link-'));
        try {
            fs.writeFileSync(path.join(outside, 'old.png'), 'ORIGINAL');
            fs.writeFileSync(path.join(outside, 'keep.txt'), 'KEEP');
            let oldPath = 'characters/old.png';
            let newPath = 'characters/new.png';
            let categories = ['characters'];
            if (kind === 'file') {
                oldPath = newPath = 'settings.json';
                categories = ['settings'];
                fs.symlinkSync(path.join(outside, 'old.png'), live('settings.json'));
            } else if (kind === 'intermediate') {
                fs.symlinkSync(outside, live('linked'));
                dirs.characters = live('linked/characters');
                fs.mkdirSync(path.join(outside, 'characters'));
                fs.writeFileSync(path.join(outside, 'characters/old.png'), 'ORIGINAL');
                oldPath = 'linked/characters/old.png';
                newPath = 'linked/characters/new.png';
            } else {
                fs.rmdirSync(dirs.characters);
                fs.symlinkSync(outside, dirs.characters);
            }
            const before = fs.readdirSync(outside, { recursive: true }).sort();
            const base = await commitFiles(gitdir, { [oldPath]: 'ORIGINAL' });
            const target = await commitFiles(gitdir, { [newPath]: 'NEW' }, [base]);
            const report = await run(base, target, categories);
            expect(report.written).toEqual([]);
            expect(report.deleted).toEqual([]);
            expect(report.alreadyApplied).toEqual([]);
            expect(report.ignored).toEqual([]);
            expect(report.skipped.sort()).toEqual([...new Set([oldPath, newPath])].sort());
            expect(fs.readdirSync(outside, { recursive: true }).sort()).toEqual(before);
            expect(fs.readFileSync(path.join(outside, 'old.png'), 'utf8')).toBe('ORIGINAL');
            expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('KEEP');
            const contents = Object.fromEntries(before.filter(entry => fs.statSync(path.join(outside, entry)).isFile()).map(entry => [entry, fs.readFileSync(path.join(outside, entry), 'utf8')]));
            expect(contents).toEqual(kind === 'intermediate'
                ? { 'old.png': 'ORIGINAL', 'keep.txt': 'KEEP', 'characters/old.png': 'ORIGINAL' }
                : { 'old.png': 'ORIGINAL', 'keep.txt': 'KEEP' });
        } finally { fs.rmSync(outside, { recursive: true }); }
    });

    test('a throwpoint aborts reconcile before the matching write and leaves live untouched', async () => {
        process.env.LUKER_SYNC_THROWPOINT = 'reconcile-write';
        process.env.LUKER_SYNC_THROWPOINT_MATCH = 'worlds/w.json';
        try {
            const base = await commitFiles(gitdir, { 'characters/a.png': 'A1', 'worlds/w.json': 'W1' });
            const target = await commitFiles(gitdir, { 'characters/a.png': 'A2', 'worlds/w.json': 'W2' }, [base]);
            write('characters/a.png', 'A1');
            write('worlds/w.json', 'W1');
            await expect(run(base, target)).rejects.toMatchObject({ code: 'THROWPOINT' });
            expect(read('characters/a.png')).toBe('A2');
            expect(read('worlds/w.json')).toBe('W1');
        } finally {
            delete process.env.LUKER_SYNC_THROWPOINT;
            delete process.env.LUKER_SYNC_THROWPOINT_MATCH;
        }
    });
});
