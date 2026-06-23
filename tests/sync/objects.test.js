import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { ensureShadowRepo } from '../../src/sync/shadow.js';
import { readObjectForWire, writeObjectFromWire, fetchMissingObjects, hasObjectLocally } from '../../src/sync/objects.js';

describe('object wire transfer', () => {
    let aRoot, bRoot;

    beforeEach(() => {
        aRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-obj-a-'));
        bRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-obj-b-'));
    });
    afterEach(() => {
        fs.rmSync(aRoot, { recursive: true, force: true });
        fs.rmSync(bRoot, { recursive: true, force: true });
    });

    test('round-trips a blob from A to B via readObjectForWire / writeObjectFromWire', async () => {
        const a = await ensureShadowRepo({ userRoot: aRoot, peerId: 'p' });
        const b = await ensureShadowRepo({ userRoot: bRoot, peerId: 'p' });

        fs.writeFileSync(path.join(a.workdir, 'file.txt'), 'hello world');
        await git.add({ fs, dir: a.workdir, gitdir: a.gitDir, filepath: 'file.txt' });
        const oid = await git.commit({
            fs, dir: a.workdir, gitdir: a.gitDir,
            message: 'a',
            author: { name: 't', email: 't@t' },
        });

        // Pull the commit blob from A; the commit object references a tree which references the blob.
        const commitObj = await readObjectForWire({ dir: a.workdir, gitdir: a.gitDir, oid });
        await writeObjectFromWire({ dir: b.workdir, gitdir: b.gitDir, ...commitObj });

        const commitB = await git.readObject({ fs, dir: b.workdir, gitdir: b.gitDir, oid });
        expect(commitB.type).toBe('commit');
        expect(commitB.object.message).toBe('a\n');
    });

    test('fetchMissingObjects walks the graph and pulls only missing objects', async () => {
        const a = await ensureShadowRepo({ userRoot: aRoot, peerId: 'p' });
        const b = await ensureShadowRepo({ userRoot: bRoot, peerId: 'p' });

        fs.writeFileSync(path.join(a.workdir, 'f1.txt'), '1');
        fs.writeFileSync(path.join(a.workdir, 'f2.txt'), '2');
        await git.add({ fs, dir: a.workdir, gitdir: a.gitDir, filepath: 'f1.txt' });
        await git.add({ fs, dir: a.workdir, gitdir: a.gitDir, filepath: 'f2.txt' });
        const commitOid = await git.commit({
            fs, dir: a.workdir, gitdir: a.gitDir,
            message: 'a',
            author: { name: 't', email: 't@t' },
        });

        const fetchedOids = new Set();
        async function fetchObject(oid) {
            fetchedOids.add(oid);
            return readObjectForWire({ dir: a.workdir, gitdir: a.gitDir, oid });
        }

        const writtenOids = await fetchMissingObjects({
            dir: b.workdir,
            gitdir: b.gitDir,
            headOid: commitOid,
            fetchObject,
        });

        expect(writtenOids).toContain(commitOid);
        // We should have fetched commit + tree + 2 blobs.
        expect(fetchedOids.size).toBe(4);

        // Running it again should fetch nothing (everything is local now).
        fetchedOids.clear();
        await fetchMissingObjects({ dir: b.workdir, gitdir: b.gitDir, headOid: commitOid, fetchObject });
        expect(fetchedOids.size).toBe(0);
    });

    test('hasObjectLocally returns true for present, false for absent', async () => {
        const a = await ensureShadowRepo({ userRoot: aRoot, peerId: 'p' });
        fs.writeFileSync(path.join(a.workdir, 'f.txt'), 'x');
        await git.add({ fs, dir: a.workdir, gitdir: a.gitDir, filepath: 'f.txt' });
        const oid = await git.commit({
            fs, dir: a.workdir, gitdir: a.gitDir,
            message: 'a',
            author: { name: 't', email: 't@t' },
        });
        expect(await hasObjectLocally({ dir: a.workdir, gitdir: a.gitDir, oid })).toBe(true);
        expect(await hasObjectLocally({ dir: a.workdir, gitdir: a.gitDir, oid: '0'.repeat(40) })).toBe(false);
    });

    test('fetchMissingObjects rejects when the responder returns bytes that hash to a different oid', async () => {
        const a = await ensureShadowRepo({ userRoot: aRoot, peerId: 'p' });
        const b = await ensureShadowRepo({ userRoot: bRoot, peerId: 'p' });

        // Make a real commit in A so we have a real oid to ask for.
        fs.writeFileSync(path.join(a.workdir, 'requested.txt'), 'REQUESTED_CONTENT');
        await git.add({ fs, dir: a.workdir, gitdir: a.gitDir, filepath: 'requested.txt' });
        const requestedOid = await git.commit({
            fs, dir: a.workdir, gitdir: a.gitDir,
            message: 'requested', author: { name: 't', email: 't@t' },
        });

        // Make a DIFFERENT commit; we'll use its body to lie.
        fs.writeFileSync(path.join(a.workdir, 'other.txt'), 'OTHER_CONTENT');
        await git.add({ fs, dir: a.workdir, gitdir: a.gitDir, filepath: 'other.txt' });
        const otherOid = await git.commit({
            fs, dir: a.workdir, gitdir: a.gitDir,
            message: 'other', author: { name: 't', email: 't@t' },
        });

        // Hostile responder: when asked for ANY oid, returns the 'other' object body
        // but with the requested oid claimed in the wire envelope.
        const otherObj = await readObjectForWire({ dir: a.workdir, gitdir: a.gitDir, oid: otherOid });
        async function hostileFetch(askedOid) {
            return { oid: askedOid, type: otherObj.type, body: otherObj.body };
        }

        // The walker should reject when the bytes hash to otherOid but askedOid was requested.
        await expect(fetchMissingObjects({
            dir: b.workdir,
            gitdir: b.gitDir,
            headOid: requestedOid,
            fetchObject: hostileFetch,
        })).rejects.toThrow(/oid mismatch/);
    });
});
