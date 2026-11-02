import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import git from 'isomorphic-git';

import { ensureShadowRepo } from '../../src/sync/shadow.js';
import {
    fetchMissingObjects,
    readObjectForWire,
    writeObjectFromWire,
    writeObjectFromWireStream,
    hasObjectLocally,
    childOidsOfWireObject,
} from '../../src/sync/objects.js';
import { readCommitFiles } from '../../src/sync/pipeline/git-tree.js';
import { atomicFs } from '../../src/sync/pipeline/atomic-fs.js';
import { commitFiles, writeBlob, writeRawTree } from './_lib/commits.js';

describe('fetch repairs objects whose closure is incomplete', () => {
    let tmp;
    let source;
    let target;
    let c1;
    let head;
    const fromSource = oid => readObjectForWire({ dir: source.workdir, gitdir: source.gitDir, oid });
    const copyToTarget = async (oid) => {
        const obj = await fromSource(oid);
        await writeObjectFromWire({ dir: target.workdir, gitdir: target.gitDir, oid, type: obj.type, body: obj.body });
        return obj;
    };
    const has = oid => hasObjectLocally({ dir: target.workdir, gitdir: target.gitDir, oid });
    const fetchHead = (fetchObject = fromSource) => fetchMissingObjects({ dir: target.workdir, gitdir: target.gitDir, headOid: head, fetchObject });
    const closureIsPresent = async (oid) => {
        const stack = [oid];
        const seen = new Set();
        while (stack.length > 0) {
            const next = stack.pop();
            if (seen.has(next)) continue;
            seen.add(next);
            if (!(await has(next))) return false;
            const obj = await readObjectForWire({ dir: target.workdir, gitdir: target.gitDir, oid: next });
            stack.push(...childOidsOfWireObject(obj.type, obj.body));
        }
        return true;
    };

    beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-legacy-closure-'));
        source = await ensureShadowRepo({ userRoot: path.join(tmp, 'source'), peerId: 'p' });
        target = await ensureShadowRepo({ userRoot: path.join(tmp, 'target'), peerId: 'p' });
        c1 = await commitFiles(source.gitDir, { 'characters/a.png': 'A', 'worlds/w.json': '{}' });
        head = await commitFiles(source.gitDir, { 'characters/a.png': 'A2', 'worlds/w.json': '{}' }, [c1]);
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    test('a commit present without its tree gets its tree fetched', async () => {
        const commit = await copyToTarget(head);
        const [treeOid] = childOidsOfWireObject(commit.type, commit.body);
        expect(await has(treeOid)).toBe(false);

        await fetchHead();

        expect(await has(treeOid)).toBe(true);
        expect(await closureIsPresent(head)).toBe(true);
        const files = await readCommitFiles({ gitdir: target.gitDir, commitOid: head });
        expect([...files.keys()].sort()).toEqual(['characters/a.png', 'worlds/w.json']);
    });

    test('a complete commit whose parent lacks its tree gets the parent tree fetched', async () => {
        const headObj = await fromSource(head);
        const [headTree] = childOidsOfWireObject(headObj.type, headObj.body);
        const order = [];
        const walk = async (oid) => {
            const obj = await fromSource(oid);
            for (const child of childOidsOfWireObject(obj.type, obj.body)) await walk(child);
            order.push(oid);
        };
        await walk(headTree);
        for (const oid of order) await copyToTarget(oid);
        await copyToTarget(c1);
        await copyToTarget(head);

        await fetchHead();

        expect(await closureIsPresent(head)).toBe(true);
        expect((await readCommitFiles({ gitdir: target.gitDir, commitOid: c1 })).size).toBe(2);
    });

    test('a commit received without its tree after the first fetch is still repaired', async () => {
        await fetchMissingObjects({ dir: target.workdir, gitdir: target.gitDir, headOid: c1, fetchObject: fromSource });
        const commit = await fromSource(head);
        await writeObjectFromWireStream({ dir: target.workdir, gitdir: target.gitDir, oid: head, type: commit.type, stream: Readable.from([commit.body]) });

        await fetchHead();

        expect(await closureIsPresent(head)).toBe(true);
    });

    test('a complete local history needs no transfer', async () => {
        await fetchHead();
        const requested = [];
        const written = await fetchHead(async (oid) => {
            requested.push(oid);
            return fromSource(oid);
        });
        expect(written).toEqual([]);
        expect(requested).toEqual([]);
    });
});

describe('closure scan of legacy loose objects', () => {
    let tmp;
    let source;
    let target;
    beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-legacy-scan-'));
        source = await ensureShadowRepo({ userRoot: path.join(tmp, 'source'), peerId: 'p' });
        target = await ensureShadowRepo({ userRoot: path.join(tmp, 'target'), peerId: 'p' });
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const fromSource = oid => readObjectForWire({ dir: source.workdir, gitdir: source.gitDir, oid });
    const isMarkedSuspect = oid => fs.existsSync(path.join(target.gitDir, 'luker-closure', 'suspect', oid));

    test('a large root tree missing a blob is marked suspect and repaired', async () => {
        const entries = await Promise.all(Array.from({ length: 300 }, async (_, i) => {
            const content = `entry ${i}`;
            const oid = await writeBlob(source.gitDir, content);
            if (i !== 150) await writeBlob(target.gitDir, content);
            return { mode: '100644', name: `file-${String(i).padStart(3, '0')}.json`, oid };
        }));
        const treeOid = await writeRawTree(source.gitDir, entries);
        expect(await writeRawTree(target.gitDir, entries)).toBe(treeOid);
        const missing = entries[150].oid;

        await fetchMissingObjects({ dir: target.workdir, gitdir: target.gitDir, headOid: treeOid, fetchObject: fromSource });

        expect(await hasObjectLocally({ dir: target.workdir, gitdir: target.gitDir, oid: missing })).toBe(true);
        expect(isMarkedSuspect(treeOid)).toBe(false);
    });

    test('a corrupt loose object does not stop the scan', async () => {
        const corrupt = 'ab'.padEnd(40, '0');
        fs.mkdirSync(path.join(target.gitDir, 'objects', 'ab'), { recursive: true });
        fs.writeFileSync(path.join(target.gitDir, 'objects', 'ab', corrupt.slice(2)), 'not a zlib stream');
        const head = await commitFiles(source.gitDir, { 'characters/a.png': 'A' });
        const commit = await fromSource(head);
        await git.writeObject({ fs: atomicFs, gitdir: target.gitDir, type: 'commit', object: commit.body, format: 'content' });

        await fetchMissingObjects({ dir: target.workdir, gitdir: target.gitDir, headOid: head, fetchObject: fromSource });

        expect(fs.existsSync(path.join(target.gitDir, 'luker-closure', 'scanned'))).toBe(true);
        expect(isMarkedSuspect(corrupt)).toBe(true);
        expect((await readCommitFiles({ gitdir: target.gitDir, commitOid: head })).size).toBe(1);
    });
});
