import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';

import { ensureShadowRepo } from '../../src/sync/shadow.js';
import {
    fetchMissingObjects,
    readObjectForWire,
    hasObjectLocally,
    childOidsOfWireObject,
    listObjectsChildrenFirst,
    hasCompleteClosure,
} from '../../src/sync/objects.js';
import { atomicFs } from '../../src/sync/pipeline/atomic-fs.js';
import { commitFiles } from './_lib/commits.js';

async function closureIsPresent(shadow, oid) {
    const stack = [oid];
    const seen = new Set();
    while (stack.length > 0) {
        const next = stack.pop();
        if (seen.has(next)) continue;
        seen.add(next);
        if (!(await hasObjectLocally({ dir: shadow.workdir, gitdir: shadow.gitDir, oid: next }))) return false;
        const obj = await readObjectForWire({ dir: shadow.workdir, gitdir: shadow.gitDir, oid: next });
        stack.push(...childOidsOfWireObject(obj.type, obj.body));
    }
    return true;
}

describe('children-first object transfer', () => {
    let tmp;
    let source;
    let head;
    let roots;
    beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-closure-'));
        roots = 0;
        source = await ensureShadowRepo({ userRoot: path.join(tmp, 'source'), peerId: 'p' });
        const c1 = await commitFiles(source.gitDir, { 'characters/a.png': 'A', 'worlds/w.json': '{}' });
        const c2 = await commitFiles(source.gitDir, { 'characters/a.png': 'A2', 'characters/sub/b.png': 'B', 'worlds/w.json': '{}' }, [c1]);
        head = await commitFiles(source.gitDir, { 'characters/a.png': 'A3', 'characters/sub/b.png': 'B', 'chats/x/c.jsonl': '{}' }, [c2]);
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const freshTarget = () => ensureShadowRepo({ userRoot: path.join(tmp, `target-${roots++}`), peerId: 'p' });
    const fromSource = oid => readObjectForWire({ dir: source.workdir, gitdir: source.gitDir, oid });

    test('childOidsOfWireObject reads commit tree and parents and tree entries', async () => {
        const commit = await fromSource(head);
        const children = childOidsOfWireObject(commit.type, commit.body);
        expect(children).toHaveLength(2);
        const tree = await fromSource(children[0]);
        expect(tree.type).toBe('tree');
        expect(childOidsOfWireObject(tree.type, tree.body)).toHaveLength(2);
        expect(childOidsOfWireObject('blob', Buffer.from('x'))).toEqual([]);
    });

    test('listObjectsChildrenFirst lists every object after all of its children', async () => {
        const order = await listObjectsChildrenFirst({ dir: source.workdir, gitdir: source.gitDir, headOid: head, skip: new Set() });
        const position = new Map(order.map((oid, index) => [oid, index]));
        expect(new Set(order).size).toBe(order.length);
        for (const oid of order) {
            const obj = await fromSource(oid);
            for (const child of childOidsOfWireObject(obj.type, obj.body)) expect(position.get(child)).toBeLessThan(position.get(oid));
        }
        expect(order[order.length - 1]).toBe(head);
    });

    test('an interrupted fetch never leaves an object without its closure and a resumed fetch completes', async () => {
        const all = await listObjectsChildrenFirst({ dir: source.workdir, gitdir: source.gitDir, headOid: head, skip: new Set() });
        for (let failAt = 0; failAt < all.length; failAt++) {
            const target = await freshTarget();
            let calls = 0;
            const flaky = async (oid) => {
                if (calls++ === failAt) throw new Error('transport dropped');
                return fromSource(oid);
            };
            await expect(fetchMissingObjects({ dir: target.workdir, gitdir: target.gitDir, headOid: head, fetchObject: flaky })).rejects.toThrow('transport dropped');
            const incomplete = [];
            for (const oid of all) {
                if (await hasObjectLocally({ dir: target.workdir, gitdir: target.gitDir, oid }) && !(await closureIsPresent(target, oid))) incomplete.push(oid);
            }
            expect(incomplete).toEqual([]);
            await fetchMissingObjects({ dir: target.workdir, gitdir: target.gitDir, headOid: head, fetchObject: fromSource });
            expect(await closureIsPresent(target, head)).toBe(true);
        }
    }, 60_000);

    test('fetchMissingObjects writes children before parents', async () => {
        const target = await freshTarget();
        const written = await fetchMissingObjects({ dir: target.workdir, gitdir: target.gitDir, headOid: head, fetchObject: fromSource });
        const position = new Map(written.map((oid, index) => [oid, index]));
        for (const oid of written) {
            const obj = await fromSource(oid);
            for (const child of childOidsOfWireObject(obj.type, obj.body)) expect(position.get(child)).toBeLessThan(position.get(oid));
        }
    });
});

describe('childOidsOfWireObject', () => {
    test('rejects a tree entry whose mode has no space before the NUL', () => {
        const oid = Buffer.alloc(20, 1);
        const body = Buffer.concat([Buffer.from('100644\0'), oid, Buffer.from('100644 x\0'), oid]);
        expect(() => childOidsOfWireObject('tree', body)).toThrow('malformed tree object');
    });
});

describe('hasCompleteClosure', () => {
    let userRoot;
    let gitdir;
    beforeEach(async () => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-complete-'));
        ({ gitDir: gitdir } = await ensureShadowRepo({ userRoot, peerId: 'p' }));
    });
    afterEach(() => fs.rmSync(userRoot, { recursive: true, force: true }));

    test('scans an unscanned repository before answering', async () => {
        const blob = await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from('x') });
        const tree = await git.writeTree({ fs: atomicFs, gitdir, tree: [{ mode: '100644', path: 'x', oid: blob, type: 'blob' }] });
        const parentFirst = await git.writeObject({ fs: atomicFs, gitdir, type: 'commit', format: 'content',
            object: Buffer.from(`tree ${'f'.repeat(40)}\nauthor t <t@t> 0 +0000\ncommitter t <t@t> 0 +0000\n\nm\n`) });
        const complete = await git.commit({ fs: atomicFs, gitdir, message: 'm', author: { name: 't', email: 't@t' }, tree, noUpdateBranch: true });
        expect(await hasCompleteClosure({ dir: gitdir, gitdir, oid: parentFirst })).toBe(false);
        expect(await hasCompleteClosure({ dir: gitdir, gitdir, oid: complete })).toBe(true);
        expect(await hasCompleteClosure({ dir: gitdir, gitdir, oid: 'e'.repeat(40) })).toBe(false);
    });
});
