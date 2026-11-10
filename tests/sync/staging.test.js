import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import git from 'isomorphic-git';
import { spawnSync } from 'node:child_process';

import { STAGING_PREFIX, isStagingEntryName, sweepStaleStaging, makeStagingPath, swapDirectoryInto, fingerprintDirectory } from '../../src/sync/staging.js';
import { atomicFs } from '../../src/sync/pipeline/atomic-fs.js';
import { ensureShadowRepo, snapshotLiveToShadow, reconcileShadowToLive } from '../../src/sync/shadow.js';
import { deviceLabelForCommit } from '../../src/sync/pipeline/commit-provenance.js';
import { makeUserDirs } from './_lib/user-dirs.js';
import { commitFiles } from './_lib/commits.js';
import { makeRemote, openDevice, BACKEND_ID, remoteHead } from './_lib/devices.js';
import { runSyncCycle, MAIN_REF } from '../../src/sync/pipeline/cycle.js';
import { readBlobBytes, readCommitFiles } from '../../src/sync/pipeline/git-tree.js';
import { ChatRepo } from '../../src/storage/repositories/chat-repo.js';
import { makeTempSqliteEngineHarness } from '../storage/harness/contract-harness.js';
import { DirectoryBackend } from './_lib/directory-backend.js';

describe('sync staging helpers', () => {
    let root;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-staging-test-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    const makeOld = (abs) => {
        const past = (performance.timeOrigin - 60_000) / 1000;
        fs.utimesSync(abs, past, past);
    };

    test('makeStagingPath creates distinct hidden siblings of the target', async () => {
        const target = path.join(root, 'extensions', 'ext');
        const a = await makeStagingPath(target, 'extension');
        const b = await makeStagingPath(target, 'extension');
        expect(a).not.toBe(b);
        expect(path.dirname(a)).toBe(path.join(root, 'extensions'));
        expect(path.basename(a).startsWith(`${STAGING_PREFIX}extension-`)).toBe(true);
        expect(isStagingEntryName(path.basename(a))).toBe(true);
        expect(isStagingEntryName('ext')).toBe(false);
        expect(fs.statSync(a).isDirectory()).toBe(true);
    });

    test('concurrent makeStagingPath calls tolerate entries that vanish during the sweep', async () => {
        const target = path.join(root, 'extensions', 'ext');
        const worker = async () => {
            for (let i = 0; i < 200; i++) {
                await fs.promises.rmdir(await makeStagingPath(target, 'extension'));
            }
        };
        await expect(Promise.all(Array.from({ length: 16 }, worker))).resolves.toBeDefined();
    });

    test('concurrent swaps in one parent tolerate journals another recovery already consumed', async () => {
        const parent = path.join(root, 'extensions');
        const worker = async (n) => {
            const target = path.join(parent, `ext-${n}`);
            for (let i = 0; i < 50; i++) {
                const staging = await makeStagingPath(target, 'extension');
                fs.writeFileSync(path.join(staging, 'v.txt'), String(i));
                await swapDirectoryInto(staging, target);
            }
        };
        await expect(Promise.all(Array.from({ length: 16 }, (_, n) => worker(n)))).resolves.toBeDefined();
        expect(fs.readdirSync(parent).filter(isStagingEntryName)).toEqual([]);
    });

    test('sweepStaleStaging removes staging entries left by an earlier process and keeps the rest', async () => {
        const parent = path.join(root, 'extensions');
        fs.mkdirSync(path.join(parent, `${STAGING_PREFIX}extension-old`, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(parent, `${STAGING_PREFIX}extension-old`, 'nested', 'f.js'), 'x');
        makeOld(path.join(parent, `${STAGING_PREFIX}extension-old`));
        fs.mkdirSync(path.join(parent, `${STAGING_PREFIX}extension-fresh`));
        fs.mkdirSync(path.join(parent, 'ext'));
        makeOld(path.join(parent, 'ext'));
        expect(await sweepStaleStaging(parent)).toEqual([`${STAGING_PREFIX}extension-old`]);
        expect(fs.readdirSync(parent).sort()).toEqual([`${STAGING_PREFIX}extension-fresh`, 'ext']);
        expect(await sweepStaleStaging(path.join(root, 'missing'))).toEqual([]);
    });

    test('makeStagingPath sweeps stale siblings before creating a new one', async () => {
        const parent = path.join(root, 'assets', 'bgm');
        fs.mkdirSync(path.join(parent, `${STAGING_PREFIX}asset-old`), { recursive: true });
        makeOld(path.join(parent, `${STAGING_PREFIX}asset-old`));
        const fresh = await makeStagingPath(path.join(parent, 'song.mp3'), 'asset');
        expect(fs.readdirSync(parent)).toEqual([path.basename(fresh)]);
    });

    test('swapDirectoryInto replaces an existing directory and leaves nothing parked', async () => {
        const target = path.join(root, 'extensions', 'ext');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'old.js'), 'old');
        const staged = await makeStagingPath(target, 'extension');
        fs.writeFileSync(path.join(staged, 'new.js'), 'new');
        await swapDirectoryInto(staged, target);
        expect(fs.readdirSync(target)).toEqual(['new.js']);
        expect(fs.readdirSync(path.join(root, 'extensions'))).toEqual(['ext']);
    });

    test('swapDirectoryInto creates a missing target', async () => {
        const target = path.join(root, 'extensions', 'fresh');
        const staged = await makeStagingPath(target, 'extension');
        fs.writeFileSync(path.join(staged, 'a.js'), 'a');
        await swapDirectoryInto(staged, target);
        expect(fs.readFileSync(path.join(target, 'a.js'), 'utf8')).toBe('a');
    });

    test('a failed replacement restores complete original bytes', async () => {
        const target = path.join(root, 'extensions', 'ext');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'local.js'), 'local edits');
        await expect(swapDirectoryInto(path.join(root, 'missing-source'), target)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(fs.readFileSync(path.join(target, 'local.js'), 'utf8')).toBe('local edits');
        expect(fs.readdirSync(path.dirname(target))).toEqual(['ext']);
    });

    test('overlapping same-target replacements serialize complete directories', async () => {
        const target = path.join(root, 'extensions', 'ext');
        const a = await makeStagingPath(target, 'extension');
        const b = await makeStagingPath(target, 'extension');
        fs.writeFileSync(path.join(a, 'a.js'), 'A');
        fs.writeFileSync(path.join(b, 'b.js'), 'B');
        await Promise.all([swapDirectoryInto(a, target), swapDirectoryInto(b, target)]);
        expect(fs.readdirSync(target)).toEqual(['b.js']);
        expect(fs.readdirSync(path.dirname(target))).toEqual(['ext']);
    });

    test('overlapping updates recheck their original fingerprint inside target serialization', async () => {
        const target = path.join(root, 'extensions', 'ext');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'local.js'), 'local edits');
        const expectedFingerprint = await fingerprintDirectory(target);
        const a = await makeStagingPath(target, 'extension');
        const b = await makeStagingPath(target, 'extension');
        fs.writeFileSync(path.join(a, 'a.js'), 'A');
        fs.writeFileSync(path.join(b, 'b.js'), 'B');
        const results = await Promise.allSettled([swapDirectoryInto(a, target, { expectedFingerprint }), swapDirectoryInto(b, target, { expectedFingerprint })]);
        expect(results[0].status).toBe('fulfilled');
        expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'EXTENSION_CHANGED_DURING_UPDATE' } });
        expect(fs.readFileSync(path.join(target, 'a.js'), 'utf8')).toBe('A');
    });

    test('SIGKILL after parking recovers before snapshot and stale sweeping', async () => {
        const target = path.join(root, 'extensions', 'ext');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'local.js'), 'local edits');
        const args = { userRoot: root, peerId: 'p', directories: { root, extensions: path.dirname(target) }, enabledCategoryIds: ['extensions'] };
        const original = await snapshotLiveToShadow({ ...args, deviceLabel: 'Original device' });
        const source = await makeStagingPath(target, 'extension');
        fs.writeFileSync(path.join(source, 'new.js'), 'new bytes');
        const module = new URL('../../src/sync/staging.js', import.meta.url).href;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {swapDirectoryInto} from ${JSON.stringify(module)}; await swapDirectoryInto(${JSON.stringify(source)}, ${JSON.stringify(target)});`], {
            env: { ...process.env, LUKER_SYNC_FAILPOINT: 'staging-after-park' }, encoding: 'utf8',
        });
        expect(child.signal).toBe('SIGKILL');
        const snapshot = await snapshotLiveToShadow({ ...args, deviceLabel: 'Relabeled inheritor' });
        const shadow = await ensureShadowRepo({ userRoot: root, peerId: 'p' });
        expect(snapshot).toEqual({ committed: false, oid: original.oid });
        expect(await deviceLabelForCommit({ gitdir: shadow.gitDir, oid: snapshot.oid })).toBe('Original device');
        expect(await git.listFiles({ fs: atomicFs, gitdir: shadow.gitDir, ref: snapshot.oid })).toEqual(['extensions/ext/local.js']);
        await sweepStaleStaging(path.dirname(target));
        expect(fs.readFileSync(path.join(target, 'local.js'), 'utf8')).toBe('local edits');
    });

    test('fingerprintDirectory changes with content but ignores nested .git and staging entries', async () => {
        const dir = path.join(root, 'ext');
        fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'a.js'), 'a');
        const first = await fingerprintDirectory(dir);
        fs.writeFileSync(path.join(dir, '.git', 'FETCH_HEAD'), 'x');
        fs.mkdirSync(path.join(dir, `${STAGING_PREFIX}asset-1`));
        expect(await fingerprintDirectory(dir)).toBe(first);
        fs.writeFileSync(path.join(dir, 'b.js'), 'b');
        expect(await fingerprintDirectory(dir)).not.toBe(first);
        expect(await fingerprintDirectory(path.join(root, 'missing'))).toBe('absent');
    });

    test('snapshots never include staging entries and reconcile never deletes them', async () => {
        const dirs = { root, characters: path.join(root, 'characters') };
        fs.mkdirSync(dirs.characters);
        fs.writeFileSync(path.join(dirs.characters, 'a.png'), 'A');
        const staging = path.join(dirs.characters, `${STAGING_PREFIX}asset-1`);
        fs.mkdirSync(staging);
        fs.writeFileSync(path.join(staging, 'partial.png'), 'PART');
        const result = await snapshotLiveToShadow({ userRoot: root, peerId: 'p', directories: dirs, enabledCategoryIds: ['characters'] });
        const shadow = await ensureShadowRepo({ userRoot: root, peerId: 'p' });
        expect(await git.listFiles({ fs: atomicFs, gitdir: shadow.gitDir, ref: result.oid })).toEqual(['characters/a.png']);
        await reconcileShadowToLive({ userRoot: root, peerId: 'p', directories: dirs, enabledCategoryIds: ['characters'] });
        expect(fs.readFileSync(path.join(staging, 'partial.png'), 'utf8')).toBe('PART');
    });

    test('snapshot enumeration excludes exact chat publication artifacts while preserving neighboring user entries', async () => {
        const dirs = makeUserDirs(root);
        const name = '.chat-create-12345678-1234-4123-8123-123456789abc';
        const artifacts = [`chats/S/${name}`, `group chats/${name}`];
        const neighbors = [`chats/S/${name}.jsonl`, 'chats/S/.chat-create-user-note', `worlds/${name}`, `chats/S/nested/${name}`];
        for (const rel of [...artifacts, ...neighbors]) {
            fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
            fs.writeFileSync(path.join(root, rel), `retained ${rel}`);
        }
        const shadow = await ensureShadowRepo({ userRoot: root, peerId: 'p' });
        const old = await commitFiles(shadow.gitDir, Object.fromEntries([...artifacts, ...neighbors].map(rel => [rel, `retained ${rel}`])));
        await git.writeRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: 'refs/heads/main', value: old, force: true });
        const staging = path.join(shadow.workdir, 'chats/S/.luker-staging-chat-create-active');
        fs.mkdirSync(path.dirname(staging), { recursive: true }); fs.writeFileSync(staging, 'incomplete');
        const snapshot = await snapshotLiveToShadow({ userRoot: root, peerId: 'p', directories: dirs, enabledCategoryIds: ['worlds', 'chats'] });
        expect(await git.listFiles({ fs: atomicFs, gitdir: shadow.gitDir, ref: snapshot.oid })).toEqual(neighbors.sort());
        expect(await git.listFiles({ fs: atomicFs, gitdir: shadow.gitDir, ref: old })).toEqual([...artifacts, ...neighbors].sort());
        await reconcileShadowToLive({ userRoot: root, peerId: 'p', directories: dirs, enabledCategoryIds: ['worlds', 'chats'] });
        for (const rel of [...artifacts, ...neighbors]) expect(fs.readFileSync(path.join(root, rel), 'utf8')).toBe(`retained ${rel}`);
    });

    test('interrupted owned chat publication preserves its source and converges FS to SQL without temporary records', async () => {
        const remote = await makeRemote();
        const sql = await makeTempSqliteEngineHarness();
        try {
            const source = openDevice({ userRoot: root, remoteDir: remote.remoteDir, categories: ['chats'] });
            const repo = new ChatRepo({ engine: source.ctx.engine });
            const header = { user_name: 'U', character_name: 'S', chat_metadata: { integrity: 'owned-source' }, retained: { nested: ['complete'] } };
            const body = [{ name: 'U', is_user: true, mes: 'complete original conversation' }];
            const state = { nodes: [{ id: 'owned', text: 'complete companion' }] };
            await repo.save('u', 'S', 'source', header, body, null);
            await repo.setState('u', 'S', 'source', 'notes', state);
            const original = source.read('chats/S/source.jsonl');
            const engineModule = new URL('../../src/storage/engines/fs-engine.js', import.meta.url).href;
            const repoModule = new URL('../../src/storage/repositories/chat-repo.js', import.meta.url).href;
            const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
                import { FsEngine } from ${JSON.stringify(engineModule)};
                import { ChatRepo } from ${JSON.stringify(repoModule)};
                const engine = new FsEngine({ directoriesByHandle: () => (${JSON.stringify(source.directories)}) });
                await new ChatRepo({ engine }).rename('u', 'S', 'source', 'published');
            `], { env: { ...process.env, LUKER_SYNC_FAILPOINT: 'chat-publication-before-link' }, encoding: 'utf8' });
            expect({ status: child.status, signal: child.signal, marker: child.stderr.includes('luker-sync-failpoint: chat-publication-before-link') }).toEqual({ status: null, signal: 'SIGKILL', marker: true });
            const remnants = fs.readdirSync(path.join(root, 'chats/S')).filter(name => name.startsWith('.luker-staging-chat-create-'));
            expect(remnants).toHaveLength(1);
            const remnant = path.join(root, 'chats/S', remnants[0]);
            expect(fs.readFileSync(remnant, 'utf8')).toBe(original);
            expect(source.read('chats/S/source.jsonl')).toBe(original);
            expect(await repo.getState('u', 'S', 'source', 'notes')).toEqual(state);
            expect(source.read('chats/S/published.jsonl')).toBeNull();
            await repo.rename('u', 'S', 'source', 'published');
            expect(source.read('chats/S/source.jsonl')).toBeNull();
            expect(source.read('chats/S/published.jsonl')).toBe(original);
            expect(await repo.getState('u', 'S', 'published', 'notes')).toEqual(state);
            const name = '.chat-create-12345678-1234-4123-8123-123456789abc';
            const artifacts = [`chats/S/${name}`, `group chats/${name}`];
            for (const rel of artifacts) source.write(rel, `local artifact ${rel}`);
            const neighbor = `chats/S/${name}.jsonl`;
            source.write(neighbor, original);
            expect(await runSyncCycle(source.ctx)).toMatchObject({ status: 'synced', pushed: true });
            const published = await remoteHead(remote.remoteDir);
            const files = await readCommitFiles({ gitdir: remote.remoteDir, commitOid: published });
            expect([...files.keys()].sort()).toEqual([neighbor, 'chats/S/published.jsonl', 'chats/S/published.luker-state.notes.json'].sort());
            const sqlContext = { userRoot: sql.dirs.root, handle: sql.handle, directories: sql.dirs, backendId: BACKEND_ID, categories: ['chats'], engine: sql.engine,
                backend: new DirectoryBackend({ id: BACKEND_ID, userRoot: sql.dirs.root, remoteDir: remote.remoteDir }) };
            expect(await runSyncCycle(sqlContext)).toMatchObject({ status: 'synced', reconcile: { skipped: [] } });
            const payload = Object.fromEntries(await Promise.all([...files].map(async ([rel, entry]) => [rel, await readBlobBytes({ gitdir: remote.remoteDir, oid: entry.oid })])));
            for (const rel of artifacts) payload[rel] = 'previously published operation bytes';
            payload['chats/S/.luker-staging-chat-create-interrupted'] = 'interrupted incoming bytes';
            const incoming = await commitFiles(remote.remoteDir, payload, [published]);
            await git.writeRef({ fs: atomicFs, gitdir: remote.remoteDir, ref: MAIN_REF, value: incoming, force: true });
            expect(await runSyncCycle(sqlContext)).toMatchObject({ status: 'synced', reconcile: { skipped: [] } });
            const sqlShadow = await ensureShadowRepo({ userRoot: sql.dirs.root, peerId: BACKEND_ID });
            expect(await git.resolveRef({ fs: atomicFs, gitdir: sqlShadow.gitDir, ref: MAIN_REF })).toBe(incoming);
            const sqlRepo = new ChatRepo({ engine: sql.engine });
            expect((await sqlRepo.get(sql.handle, 'S', 'published')).body).toEqual(body);
            expect(await sqlRepo.getState(sql.handle, 'S', 'published', 'notes')).toEqual(state);
            expect((await sqlRepo.get(sql.handle, 'S', name)).body).toEqual(body);
            const receiver = openDevice({ userRoot: path.join(root, 'fs-receiver'), remoteDir: remote.remoteDir, categories: ['chats'] });
            for (const rel of artifacts) receiver.write(rel, `receiver-owned artifact ${rel}`);
            expect(await runSyncCycle(receiver.ctx)).toMatchObject({ status: 'synced', reconcile: { skipped: [] } });
            expect(receiver.read('chats/S/published.jsonl')).toBe(original);
            for (const rel of artifacts) {
                expect(source.read(rel)).toBe(`local artifact ${rel}`);
                expect(receiver.read(rel)).toBe(`receiver-owned artifact ${rel}`);
            }
            expect(receiver.read('chats/S/.luker-staging-chat-create-interrupted')).toBeNull();
            expect(fs.readFileSync(remnant, 'utf8')).toBe(original);
            expect((await readCommitFiles({ gitdir: remote.remoteDir, commitOid: incoming })).has(artifacts[0])).toBe(true);
        } finally {
            await sql.cleanup(); remote.cleanup();
        }
    });
});
