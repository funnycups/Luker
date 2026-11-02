import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

import { makeEndpointHarness } from '../../storage/harness/endpoint-harness.js';
import { router as statsRouter, flushStatsForHandle, registerStatsSyncHooks } from '../../../src/endpoints/stats.js';
import { getStorageEngine } from '../../../src/storage/index.js';
import { runSyncCycle } from '../../../src/sync/pipeline/cycle.js';
import { runBeforeSnapshot, runAfterReconcile } from '../../../src/sync/pipeline/sync-hooks.js';
import { withWriterLock, setDirtyListener, getGateState, _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { readBlobBytes, readCommitFiles } from '../../../src/sync/pipeline/git-tree.js';
import { DirectoryBackend } from '../_lib/directory-backend.js';
import { until } from '../_lib/until.js';
import { BACKEND_ID, makeDevice, makeRemote, remoteHead } from '../_lib/devices.js';

describe('stats around sync', () => {
    let harness;
    let remote;
    let unregister;
    let owner;
    const ctx = () => ({
        userRoot: harness.dirs.root, handle: harness.handle, directories: harness.dirs, backendId: BACKEND_ID, categories: ['stats'],
        engine: getStorageEngine(), backend: new DirectoryBackend({ id: BACKEND_ID, remoteDir: remote.remoteDir, userRoot: harness.dirs.root }),
        beforeSnapshot: () => runBeforeSnapshot(owner),
        onLiveApplied: report => runAfterReconcile(owner, report),
    });
    const statsFile = () => JSON.parse(fs.readFileSync(path.join(harness.dirs.root, 'stats.json'), 'utf8'));

    beforeEach(async () => {
        _resetGateForTests();
        remote = await makeRemote();
        harness = await makeEndpointHarness({ mode: 'fs', mount: app => app.use('/api/stats', statsRouter) });
        owner = { handle: harness.handle, userRoot: harness.dirs.root, directories: harness.dirs };
        unregister = registerStatsSyncHooks();
    });
    afterEach(async () => {
        unregister();
        setDirtyListener(null);
        await harness.cleanup();
        remote.cleanup();
    });

    test('in-memory stats are flushed before the snapshot without a dirty mark', async () => {
        const dirty = [];
        setDirtyListener(info => dirty.push(info));
        expect((await request(harness.server).post('/api/stats/update').send({ Seraphina: { user_word_count: 42 } })).status).toBe(200);
        await runSyncCycle(ctx());
        const files = await readCommitFiles({ gitdir: remote.remoteDir, commitOid: await remoteHead(remote.remoteDir) });
        const pushed = JSON.parse((await readBlobBytes({ gitdir: remote.remoteDir, oid: files.get('stats.json').oid })).toString('utf8'));
        expect(pushed.Seraphina.user_word_count).toBe(42);
        expect(dirty).toEqual([]);
    });

    test('a flush waiting on the gate cannot overwrite stats.json written by a sync', async () => {
        expect((await request(harness.server).post('/api/stats/update').send({ Seraphina: { user_word_count: 1 } })).status).toBe(200);
        const synced = { Seraphina: { user_word_count: 99 }, timestamp: 5 };
        // The flush starts outside the writer scope, as the periodic save does.
        let release;
        const writer = withWriterLock(harness.dirs.root, () => new Promise(resolve => { release = resolve; }));
        await until(() => getGateState(harness.dirs.root).writerHeld && release);
        fs.writeFileSync(path.join(harness.dirs.root, 'stats.json'), JSON.stringify(synced));
        const flush = flushStatsForHandle(owner);
        await new Promise(resolve => setImmediate(resolve));
        expect(getGateState(harness.dirs.root).waitingReaders).toBe(1);
        await runAfterReconcile(owner, { written: ['stats.json'], deleted: [], alreadyApplied: [], skipped: [], ignored: [] });
        release();
        await writer;
        await flush;
        expect(statsFile().Seraphina.user_word_count).toBe(99);
        expect((await request(harness.server).post('/api/stats/get')).body).toEqual(statsFile());
    });

    test('stats updated after the last flush are merged over a synced stats.json and saved by the next flush', async () => {
        const update = body => request(harness.server).post('/api/stats/update').send(body);
        expect((await update({ Seraphina: { user_word_count: 1 }, Lilith: { user_word_count: 4 } })).status).toBe(200);
        await flushStatsForHandle(owner);
        const flushedAt = Date.now();
        // A save at the same millisecond as an update does not count the update as newer.
        await until(() => Date.now() > flushedAt);
        expect((await update({ Seraphina: { user_word_count: 5 }, Lilith: { user_word_count: 4 }, Mira: { user_word_count: 2 } })).status).toBe(200);
        fs.writeFileSync(path.join(harness.dirs.root, 'stats.json'), JSON.stringify({ Seraphina: { user_word_count: 3 }, Other: { user_word_count: 8 }, timestamp: 5 }));
        await runAfterReconcile(owner, { written: ['stats.json'], deleted: [], alreadyApplied: [], skipped: [], ignored: [] });
        const merged = (await request(harness.server).post('/api/stats/get')).body;
        expect(merged).toMatchObject({ Seraphina: { user_word_count: 5 }, Mira: { user_word_count: 2 }, Other: { user_word_count: 8 } });
        expect(merged.Lilith).toBeUndefined();
        await flushStatsForHandle(owner);
        expect(statsFile()).toEqual(merged);
    });

    test('a synced stats.json from another device becomes the in-memory stats', async () => {
        const A = makeDevice({ remoteDir: remote.remoteDir, categories: ['stats'] });
        A.write('stats.json', JSON.stringify({ Seraphina: { user_word_count: 7 }, timestamp: 3 }));
        await runSyncCycle(A.ctx);
        await runSyncCycle(ctx());
        expect((await request(harness.server).post('/api/stats/get')).body).toEqual({ Seraphina: { user_word_count: 7 }, timestamp: 3 });
        A.cleanup();
    });
});
