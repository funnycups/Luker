import { afterEach, beforeEach, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { startLanDevice } from '../_lib/lan-devices.js';
import { makeUserDirs } from '../_lib/user-dirs.js';
import { commitFiles } from '../_lib/commits.js';
import { LanBackend } from '../../../src/sync/backends/lan/client.js';
import { upsertLanBackend } from '../../../src/sync/state.js';
import { ensureShadowRepo, snapshotLiveToShadow } from '../../../src/sync/shadow.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { readBlobBytes, readCommitFiles } from '../../../src/sync/pipeline/git-tree.js';
import { mergeCommitTrees, writeMergeCommit } from '../../../src/sync/pipeline/merge.js';
import { createConflictPolicy } from '../../../src/sync/pipeline/conflict-policy.js';
import { CONFLICTS_PATH, NOTICES_PATH, readEntries } from '../../../src/sync/pipeline/conflict-records.js';

const PEER = 'u@0a1b2c3d';
const SECRET = 'a'.repeat(64);
const CHAT = 'chats/S/c.jsonl';
let origin, root, inherited, lan;
beforeEach(async () => {
    origin = await startLanDevice({ deviceLabel: 'Publisher current label' });
    await upsertLanBackend({ userRoot: origin.userRoot, backendId: PEER, label: 'Unrelated backend label', categories: ['worlds', 'chats'], syncSecret: SECRET });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-inherited-'));
    inherited = await ensureShadowRepo({ userRoot: root, peerId: PEER });
    lan = new LanBackend({ id: PEER, userRoot: root, owner: { getCurrentProfile: async () => ({ enabled: true, admin: true }) },
        entry: { lan: { peerBaseUrl: origin.baseUrl, syncSecret: SECRET } }, deviceLabel: 'Inheritor current label', callback: null });
});
afterEach(async () => {
    await lan.close();
    await origin.close();
    fs.rmSync(root, { recursive: true, force: true });
});

async function mergeAt(gitdir, base, heads, localDevice, remoteDevice) {
    const [ours, theirs] = [...heads].sort();
    const merged = await mergeCommitTrees({ gitdir, base, ours, theirs });
    const policy = createConflictPolicy({ directories: origin.directories, localDevice, remoteDevice });
    const { files } = await policy({ gitdir, base, ours, theirs, ...merged });
    const mergeOid = await writeMergeCommit({ gitdir, files, parents: heads });
    const { commit } = await git.readCommit({ fs: atomicFs, gitdir, oid: mergeOid });
    return { parents: commit.parent, tree: commit.tree, mergeOid,
        conflictBytes: await readBlobBytes({ gitdir, oid: files.get(CONFLICTS_PATH).oid }),
        noticeBytes: await readBlobBytes({ gitdir, oid: files.get(NOTICES_PATH).oid }),
        forkPaths: [...files.keys()].filter(key => key.includes('Sync conflict')).sort(),
        records: await readEntries({ gitdir, files, path: CONFLICTS_PATH, kind: 'conflicts' }),
        notices: await readEntries({ gitdir, files, path: NOTICES_PATH, kind: 'notices' }),
    };
}

test.each(['device', 'historical', 'generic merge'])('same %s heads inherited over guarded LAN retain exact conflict bytes and merge OID after relabel', async kind => {
    const shadow = await ensureShadowRepo({ userRoot: origin.userRoot, peerId: PEER });
    const snapshot = deviceLabel => snapshotLiveToShadow({ userRoot: origin.userRoot, peerId: PEER, directories: origin.directories, enabledCategoryIds: ['worlds', 'chats'], deviceLabel });
    const content = value => ({ 'worlds/w.json': value, [CHAT]: `${JSON.stringify({ chat_metadata: {} })}\n${JSON.stringify({ mes: value })}\n` });
    for (const [key, value] of Object.entries(content('base'))) origin.write(key, value);
    const base = (await snapshot('Base origin')).oid;
    for (const [key, value] of Object.entries(content('X'))) origin.write(key, value);
    let x = (await snapshot('X origin')).oid;
    await git.writeRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: 'refs/heads/main', value: base, force: true });
    for (const [key, value] of Object.entries(content('Y'))) origin.write(key, value);
    const y = (await snapshot('Y origin')).oid;
    if (kind === 'historical') x = await commitFiles(shadow.gitDir, content('X'), [base]);
    if (kind === 'generic merge') x = await writeMergeCommit({ gitdir: shadow.gitDir, files: await readCommitFiles({ gitdir: shadow.gitDir, commitOid: x }), parents: [base, x] });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('unguarded global fetch used'); };
    try {
        await lan.openSession();
        await lan.fetchInto([x, y]);
    } finally { globalThis.fetch = originalFetch; }
    expect(origin.requests.some(request => request.includes('/session/object/'))).toBe(true);
    for (const oid of [x, y]) {
        const source = await git.readObject({ fs: atomicFs, gitdir: shadow.gitDir, oid, format: 'content' });
        const copy = await git.readObject({ fs: atomicFs, gitdir: inherited.gitDir, oid, format: 'content' });
        expect(Buffer.from(copy.object)).toEqual(Buffer.from(source.object));
    }
    const first = await mergeAt(shadow.gitDir, base, [x, y], 'Observer A', 'Current peer A');
    const copied = await mergeAt(inherited.gitDir, base, [y, x], 'Observer C', 'Current peer C');
    expect(copied.parents).toEqual(first.parents);
    expect(copied.conflictBytes).toEqual(first.conflictBytes);
    expect(copied.noticeBytes).toEqual(first.noticeBytes);
    expect(copied.forkPaths).toEqual(first.forkPaths);
    expect(copied.tree).toBe(first.tree);
    expect(copied.mergeOid).toBe(first.mergeOid);
    const labels = Object.fromEntries([[x, kind === 'device' ? 'X origin' : 'Luker Sync'], [y, 'Y origin']]);
    expect(first.records['worlds/w.json']).toMatchObject({ oursDevice: labels[first.parents[0]], theirsDevice: labels[first.parents[1]] });
    expect(Object.values(first.notices)[0].device).toBe(labels[first.parents[1]]);
    expect(await mergeAt(inherited.gitDir, base, [x, y], 'Relabeled C', 'Relabeled publisher')).toEqual(first);
    const directories = makeUserDirs(root);
    for (const [key, value] of Object.entries(content('Y'))) {
        fs.mkdirSync(path.dirname(path.join(root, key)), { recursive: true });
        fs.writeFileSync(path.join(root, key), value);
    }
    await git.writeRef({ fs: atomicFs, gitdir: inherited.gitDir, ref: 'refs/heads/main', value: y, force: true });
    expect(await snapshotLiveToShadow({ userRoot: root, peerId: PEER, directories, enabledCategoryIds: ['worlds', 'chats'], deviceLabel: 'New inheritor label' })).toEqual({ committed: false, oid: y });
});
