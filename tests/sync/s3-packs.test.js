import { expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import zlib from 'node:zlib';
import { hasCompleteClosure } from '../../src/sync/objects.js';
import { ensureShadowRepo, getShadowPaths } from '../../src/sync/shadow.js';
import { prepareLocalPackStore, readIndexedPacks } from '../../src/sync/backends/s3/packs.js';
import { buildPackFixture, highBitPackSignature, refDelta, objectOid, hash } from './_lib/s3-pack-fixtures.js';

test('pre-snapshot preparation quarantines a high-bit signature pair with valid checksums and removes its ledger record', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-signature-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-one' });
        const fixture = highBitPackSignature(await buildPackFixture({ objects: [{ body: Buffer.from('signature') }] }));
        expect(hash(fixture.pack.subarray(0, -20))).toEqual(fixture.pack.subarray(-20));
        expect(hash(fixture.index.subarray(0, -20))).toEqual(fixture.index.subarray(-20));
        const filename = `pack-${fixture.pack.subarray(-20).toString('hex')}.pack`;
        const indexName = filename.replace('.pack', '.idx');
        const packdir = path.join(paths.gitDir, 'objects/pack');
        await fs.writeFile(path.join(packdir, filename), fixture.pack);
        await fs.writeFile(path.join(packdir, indexName), fixture.index);
        await fs.writeFile(path.join(paths.peerDir, 's3-packs.json'), JSON.stringify({ v: 1, packs: { ['a'.repeat(32)]: { filename, size: fixture.pack.length + 41 } } }));
        await prepareLocalPackStore({ paths, withLocal: fn => fn() });
        expect(await fs.readdir(packdir)).toEqual([]);
        expect((await readIndexedPacks(paths)).packs).toEqual({});
        const quarantine = (await fs.readdir(paths.peerDir)).find(name => name.startsWith('.s3-invalid-'));
        expect(await fs.readFile(path.join(paths.peerDir, quarantine, filename))).toEqual(fixture.pack);
        expect(await fs.readFile(path.join(paths.peerDir, quarantine, indexName))).toEqual(fixture.index);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('pre-snapshot preparation rejects a delta base whose loose header has high-bit bytes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-loose-header-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-one' });
        const body = Buffer.from('hello'), oid = objectOid('blob', body);
        const fixture = await buildPackFixture({ deltas: [refDelta(oid, Buffer.from([5, 6, 0x90, 5, 1, 33]))], externalObjects: [{ type: 'blob', body }] });
        const args = { fs: { promises: fs }, dir: paths.workdir, gitdir: paths.gitDir };
        await git.writeBlob({ ...args, blob: body });
        const header = Buffer.from('blob 5\0'); header[0] |= 128;
        await fs.writeFile(path.join(paths.gitDir, 'objects', oid.slice(0, 2), oid.slice(2)), zlib.deflateSync(Buffer.concat([header, body])));
        const filename = `pack-${fixture.pack.subarray(-20).toString('hex')}`;
        const packdir = path.join(paths.gitDir, 'objects/pack');
        await fs.writeFile(path.join(packdir, `${filename}.pack`), fixture.pack);
        await fs.writeFile(path.join(packdir, `${filename}.idx`), fixture.index);
        await prepareLocalPackStore({ paths, withLocal: fn => fn() });
        expect(await fs.readdir(packdir)).toEqual([]);
        expect((await fs.readdir(paths.peerDir)).some(name => name.startsWith('.s3-invalid-'))).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('verified closure rejects a blob root while legacy presence behavior remains', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 's3-closure-'));
    try {
        await git.init({ fs: { promises: fs }, dir });
        const oid = await git.writeBlob({ fs: { promises: fs }, dir, blob: Buffer.from('root is not commit') });
        expect(await hasCompleteClosure({ dir, gitdir: path.join(dir, '.git'), oid })).toBe(true);
        expect(await hasCompleteClosure({ dir, gitdir: path.join(dir, '.git'), oid, verify: true })).toBe(false);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('pre-snapshot preparation quarantines an unrelated damaged index even with a loose duplicate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-store-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-one' });
        const body = Buffer.from('duplicate');
        const fixture = await buildPackFixture({ objects: [{ body }] });
        await git.writeBlob({ fs: { promises: fs }, dir: paths.workdir, gitdir: paths.gitDir, blob: body });
        const filename = `pack-${fixture.pack.subarray(-20).toString('hex')}.pack`;
        const packdir = path.join(paths.gitDir, 'objects/pack');
        await fs.writeFile(path.join(packdir, filename), fixture.pack);
        const damaged = Buffer.from(fixture.index); damaged[damaged.length - 1] ^= 1;
        await fs.writeFile(path.join(packdir, filename.replace('.pack', '.idx')), damaged);
        await fs.writeFile(path.join(paths.peerDir, 's3-packs.json'), JSON.stringify({ v: 1, packs: { ['a'.repeat(32)]: { filename, size: 100 } } }));
        await prepareLocalPackStore({ paths, withLocal: fn => fn() });
        expect(await fs.readdir(packdir)).toEqual([]);
        expect(await readIndexedPacks(paths)).toEqual({ v: 1, packs: {} });
        expect((await fs.readdir(paths.peerDir)).some(name => name.startsWith('.s3-invalid-'))).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('unsafe ledger records are preserved as unreadable backup and never followed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-ledger-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-one' });
        await fs.writeFile(path.join(paths.peerDir, 'sentinel'), 'keep');
        await fs.writeFile(path.join(paths.peerDir, 's3-packs.json'), '{"v":1,"packs":{"../escape":{"filename":"../sentinel","size":1}}}');
        expect(await readIndexedPacks(paths)).toEqual({ v: 1, packs: {} });
        expect(await fs.readFile(path.join(paths.peerDir, 'sentinel'), 'utf8')).toBe('keep');
        expect((await fs.readdir(paths.peerDir)).some(name => name.startsWith('s3-packs.json.unreadable-'))).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('verified closure hashes every requested object even after the legacy scan marker', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-verify-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-one' });
        const args = { fs: { promises: fs }, dir: paths.workdir, gitdir: paths.gitDir };
        const blob = await git.writeBlob({ ...args, blob: Buffer.from('original') });
        const tree = await git.writeTree({ ...args, tree: [{ mode: '100644', path: 'file', oid: blob, type: 'blob' }] });
        const commit = await git.commit({ ...args, tree, parent: [], message: 'fixture', author: { name: 'Fixture', email: 'fixture@example.org' } });
        const query = { dir: paths.workdir, gitdir: paths.gitDir, oid: commit };
        expect(await hasCompleteClosure(query)).toBe(true);
        expect(await hasCompleteClosure({ ...query, verify: true })).toBe(true);
        await fs.writeFile(path.join(paths.gitDir, 'objects', blob.slice(0, 2), blob.slice(2)), zlib.deflateSync(Buffer.from('blob 8\0replaced')));
        expect(await hasCompleteClosure({ ...query, verify: true })).toBe(false);
        expect(await hasCompleteClosure(query)).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('verified closure accepts a valid 130000-entry tree without a call-argument breadth limit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-wide-tree-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-one' });
        const args = { fs: { promises: fs }, dir: paths.workdir, gitdir: paths.gitDir };
        const body = Buffer.from('shared valid child');
        const blob = await git.writeBlob({ ...args, blob: body });
        expect(blob).toBe(objectOid('blob', body));
        const entries = [];
        for (let i = 0; i < 130000; i++) {
            entries.push(Buffer.concat([Buffer.from(`100644 f${String(i).padStart(6, '0')}\0`), Buffer.from(blob, 'hex')]));
        }
        const treeBody = Buffer.concat(entries);
        expect(treeBody.length).toBe(4550000);
        const tree = await git.writeObject({ ...args, type: 'tree', object: treeBody, format: 'content' });
        expect(tree).toBe(objectOid('tree', treeBody));
        const commit = await git.commit({ ...args, tree, parent: [], message: 'wide tree fixture', author: { name: 'Fixture', email: 'fixture@example.org' } });
        const result = await git.readObject({ ...args, oid: commit, format: 'content' });
        expect(objectOid('commit', Buffer.from(result.object))).toBe(commit);
        expect(await hasCompleteClosure({ dir: paths.workdir, gitdir: paths.gitDir, oid: commit, verify: true })).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('pack preparation rejects unsafe ancestors before creating quarantine or following symlinks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-safe-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 's3-outside-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-one' });
        await fs.rmdir(path.join(paths.gitDir, 'objects/pack'));
        await fs.symlink(outside, path.join(paths.gitDir, 'objects/pack'));
        await expect(prepareLocalPackStore({ paths, withLocal: fn => fn() })).rejects.toMatchObject({ code: 'UNSAFE_WORKDIR_PATH' });
        expect(await fs.readdir(outside)).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});

test('pre-snapshot preparation accepts an uninitialized backend without creating unsafe directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-new-'));
    try {
        const paths = getShadowPaths({ userRoot: root, peerId: 'new-backend' });
        await prepareLocalPackStore({ paths, withLocal: fn => fn() });
        expect(await fs.readdir(root)).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test.each([false, true])('pre-snapshot preparation validates the main pack independently of redundant loose objects=%s', async redundant => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-main-'));
    try {
        const paths = await ensureShadowRepo({ userRoot: root, peerId: 's3-one' });
        const args = { fs: { promises: fs }, dir: paths.workdir, gitdir: paths.gitDir };
        const blob = await git.writeBlob({ ...args, blob: Buffer.from('main data') });
        const tree = await git.writeTree({ ...args, tree: [{ mode: '100644', path: 'file', oid: blob, type: 'blob' }] });
        const commit = await git.commit({ ...args, tree, parent: [], message: 'fixture', author: { name: 'Fixture', email: 'fixture@example.org' } });
        const objects = [];
        for (const oid of [blob, tree, commit]) {
            const result = await git.readObject({ ...args, oid, format: 'content' });
            objects.push({ type: result.type, body: Buffer.from(result.object) });
            if (!redundant) await fs.unlink(path.join(paths.gitDir, 'objects', oid.slice(0, 2), oid.slice(2)));
        }
        const fixture = await buildPackFixture({ objects });
        const name = `pack-${fixture.pack.subarray(-20).toString('hex')}`;
        const damaged = Buffer.from(fixture.pack); damaged[damaged.length - 1] ^= 1;
        await fs.writeFile(path.join(paths.gitDir, 'objects/pack', `${name}.pack`), damaged);
        await fs.writeFile(path.join(paths.gitDir, 'objects/pack', `${name}.idx`), fixture.index);
        await prepareLocalPackStore({ paths, withLocal: fn => fn() });
        expect(await fs.readdir(path.join(paths.gitDir, 'objects/pack'))).toEqual([]);
        expect(await hasCompleteClosure({ dir: paths.workdir, gitdir: paths.gitDir, oid: commit, verify: true })).toBe(redundant);
        expect(await git.resolveRef({ ...args, ref: 'main' })).toBe(commit);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
