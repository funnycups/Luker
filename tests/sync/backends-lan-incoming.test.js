import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';

import { IncomingRefBackend, incomingRefFor } from '../../src/sync/backends/lan/incoming.js';
import { assertRemoteBackend } from '../../src/sync/backends/contract.js';
import { ensureShadowRepo } from '../../src/sync/shadow.js';
import { atomicFs } from '../../src/sync/pipeline/atomic-fs.js';
import { commitFiles } from './_lib/commits.js';
import { makeUserDirs } from './_lib/user-dirs.js';
import { runSyncCycle } from '../../src/sync/pipeline/cycle.js';
import { PAUSEPOINTS } from '../../src/sync/pipeline/failpoints.js';
import { FsEngine } from '../../src/storage/engines/fs-engine.js';
import { _resetGateForTests } from '../../src/sync/in-progress-gate.js';

describe('IncomingRefBackend', () => {
    let userRoot;
    beforeEach(() => { userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-incoming-')); });
    afterEach(() => fs.rmSync(userRoot, { recursive: true, force: true }));

    test('reads the local incoming ref as the remote head', async () => {
        const backend = assertRemoteBackend(new IncomingRefBackend({ id: 'u@aa', userRoot }));
        const { gitDir } = await ensureShadowRepo({ userRoot, peerId: 'u@aa' });
        expect(await backend.readHead()).toBeNull();
        const commit = await commitFiles(gitDir, { 'worlds/w.json': '{}' });
        await git.writeRef({ fs: atomicFs, gitdir: gitDir, ref: incomingRefFor('u@aa'), value: commit, force: true });
        expect(await backend.readHead()).toEqual({ oid: commit, etag: commit });
        expect(await backend.casHead(commit, commit)).toEqual({ ok: true });
        expect(backend.kind).toBe('lan');
        expect(backend.isLocal).toBe(true);
    });

    test('a cycle over the incoming ref passes the remote-head pausepoint without pausing', async () => {
        _resetGateForTests();
        const pauseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-incoming-pause-'));
        process.env.LUKER_SYNC_PAUSEPOINT = PAUSEPOINTS.AFTER_REMOTE_HEAD;
        process.env.LUKER_SYNC_PAUSE_DIR = pauseDir;
        try {
            const arm = path.join(pauseDir, `${PAUSEPOINTS.AFTER_REMOTE_HEAD}.arm`);
            fs.writeFileSync(arm, '');
            const directories = makeUserDirs(userRoot);
            const { gitDir } = await ensureShadowRepo({ userRoot, peerId: 'u@aa' });
            const commit = await commitFiles(gitDir, { 'worlds/w.json': '{"w":1}' });
            await git.writeRef({ fs: atomicFs, gitdir: gitDir, ref: incomingRefFor('u@aa'), value: commit, force: true });
            const outcome = await runSyncCycle({
                userRoot, handle: 'u', directories, backendId: 'u@aa', categories: ['worlds'],
                engine: new FsEngine({ directoriesByHandle: () => directories }),
                backend: new IncomingRefBackend({ id: 'u@aa', userRoot }),
            });
            expect(outcome.status).toBe('synced');
            expect(fs.readFileSync(path.join(directories.worlds, 'w.json'), 'utf8')).toBe('{"w":1}');
            expect(fs.existsSync(arm)).toBe(true);
        } finally {
            delete process.env.LUKER_SYNC_PAUSEPOINT;
            delete process.env.LUKER_SYNC_PAUSE_DIR;
            fs.rmSync(pauseDir, { recursive: true, force: true });
        }
    });
});
