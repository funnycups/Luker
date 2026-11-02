import { afterEach, beforeEach, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { authorForDevice, deviceLabelForCommit } from '../../../src/sync/pipeline/commit-provenance.js';
import { ensureShadowRepo, snapshotLiveToShadow } from '../../../src/sync/shadow.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { makeUserDirs } from '../_lib/user-dirs.js';
import { commitFiles } from '../_lib/commits.js';

let userRoot, gitdir, directories;
beforeEach(async () => {
    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-provenance-'));
    directories = makeUserDirs(userRoot);
    ({ gitDir: gitdir } = await ensureShadowRepo({ userRoot, peerId: 'p' }));
});
afterEach(() => fs.rmSync(userRoot, { recursive: true, force: true }));

test.each([
    ['Desk', 'Desk', 'RGVzaw'],
    ['  平板\t<家>\n\u0000\u200b ', '平板 <家>', '5bmz5p2_IDzlrrY-'],
    ['a'.repeat(300), 'a'.repeat(255), Buffer.from('a'.repeat(255)).toString('base64url')],
])('normalizes and safely round trips %s', async (input, label, encoded) => {
    const author = authorForDevice(input);
    expect(author).toEqual({ name: `Luker Device v1 ${encoded}`, email: 'device@luker.local' });
    const oid = await commitFiles(gitdir, { 'worlds/w.json': '{}' }, [], author);
    expect(await deviceLabelForCommit({ gitdir, oid })).toBe(label);
});

test.each([
    ['historical', 'Desk', 'device@luker.local'],
    ['wrong email', 'Luker Device v1 RGVzaw', 'sync@luker.local'],
    ['wrong version', 'Luker Device v2 RGVzaw', 'device@luker.local'],
    ...['', 'RGVzaw==', 'RGVzax', 'RGVzaw+', '_w', 'IERlc2s', 'QQBC', Buffer.from('a'.repeat(256)).toString('base64url')].map(encoded => [encoded, `Luker Device v1 ${encoded}`, 'device@luker.local']),
    ['generic', 'Luker Sync', 'sync@luker.local'],
])('rejects %s provenance without guessing identity', async (_case, name, email) => {
    const oid = await commitFiles(gitdir, { 'worlds/w.json': '{}' }, [], { name, email });
    expect(await deviceLabelForCommit({ gitdir, oid })).toBe('Luker Sync');
});

test('empty labels create generic authors', () => {
    expect(authorForDevice(' \u0000\u200b ')).toEqual({ name: 'Luker Sync', email: 'sync@luker.local' });
});

test('snapshots retain immutable provenance on relabel and stamp only actual edits with fixed committer', async () => {
    fs.mkdirSync(directories.worlds, { recursive: true });
    fs.writeFileSync(path.join(directories.worlds, 'w.json'), 'one');
    const snapshot = deviceLabel => snapshotLiveToShadow({ userRoot, peerId: 'p', directories, enabledCategoryIds: ['worlds'], deviceLabel });
    const first = await snapshot('Origin <家>');
    expect(await deviceLabelForCommit({ gitdir, oid: first.oid })).toBe('Origin <家>');
    expect(await snapshot('Relabeled')).toEqual({ oid: first.oid, committed: false });
    fs.writeFileSync(path.join(directories.worlds, 'w.json'), 'two');
    const next = await snapshot('Relabeled');
    expect(next.oid).not.toBe(first.oid);
    expect(await deviceLabelForCommit({ gitdir, oid: next.oid })).toBe('Relabeled');
    const { commit } = await git.readCommit({ fs: atomicFs, gitdir, oid: next.oid });
    expect(commit.committer).toEqual({ name: 'Luker Sync', email: 'sync@luker.local', timestamp: commit.author.timestamp, timezoneOffset: commit.author.timezoneOffset });
});
