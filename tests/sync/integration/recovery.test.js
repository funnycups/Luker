import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import git from 'isomorphic-git';
import fs from 'node:fs';
import path from 'node:path';

import { startLanDevice, pair } from '../_lib/lan-devices.js';
import { until } from '../_lib/until.js';
import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { getGateState, _resetGateForTests } from '../../../src/sync/in-progress-gate.js';

describe('undo over the sync API', () => {
    let A;
    let B;
    beforeEach(async () => {
        _resetGateForTests();
        A = await startLanDevice();
        B = await startLanDevice();
    });
    afterEach(async () => {
        await A.close();
        await B.close();
    });

    test('undo reverts what the last sync brought in on both devices and reports later edits', async () => {
        A.write('worlds/a.json', 'A0');
        A.write('worlds/b.json', 'B0');
        const id = await pair(A, B);
        A.write('worlds/a.json', 'A1');
        A.write('worlds/b.json', 'B1');
        await A.call('POST', `/backends/${id}/sync`);
        await until(() => B.read('worlds/a.json') === 'A1');
        expect((await B.call('POST', `/backends/${id}/sync`)).body.ok).toBe(true);
        B.write('worlds/b.json', 'B-later');
        const res = await B.call('POST', `/backends/${id}/undo`);
        expect(res).toMatchObject({ status: 200, body: { ok: true, reverted: ['worlds/a.json'], keptEdited: ['worlds/b.json'] } });
        expect([B.read('worlds/a.json'), B.read('worlds/b.json')]).toEqual(['A0', 'B-later']);
        const { gitDir } = await ensureShadowRepo({ userRoot: B.userRoot, peerId: id });
        const log = await git.log({ fs: atomicFs, gitdir: gitDir, ref: 'refs/heads/main' });
        expect(log.some(entry => entry.commit.message.trim() === `undo sync ${res.body.restoredTag}`)).toBe(true);
        await until(() => A.read('worlds/a.json') === 'A0' && A.read('worlds/b.json') === 'B-later');
        expect(getGateState(B.userRoot)).toEqual({ readers: 0, writerHeld: false, waitingReaders: 0, waitingWriters: 0 });
    });

    test('undo returns 404 when there is nothing to undo', async () => {
        const id = await pair(A, B);
        expect(await B.call('POST', `/backends/${id}/undo`)).toMatchObject({ status: 404, body: { code: 'NO_BACKUP_TAG' } });
    });

    test('uncommitted undo returns a failure and retains its undo point', async () => {
        A.write('worlds/d/x.json', 'before');
        const id = await pair(A, B);
        fs.unlinkSync(path.join(A.userRoot, 'worlds/d/x.json'));
        await A.call('POST', `/backends/${id}/sync`);
        await until(() => !B.read('worlds/d/x.json'));
        await B.call('POST', `/backends/${id}/sync`);
        B.write('worlds/d', 'obstruction');
        const res = await B.call('POST', `/backends/${id}/undo`);
        expect(res).toMatchObject({ status: 409, body: { ok: false, committed: false, reverted: [], code: 'UNDO_NOT_COMMITTED' } });
        expect((await B.call('POST', `/backends/${id}/undo`)).body.restoredTag).toBe(res.body.restoredTag);
    });

    test('locally committed undo reports an offline propagation failure', async () => {
        A.write('worlds/a.json', 'before');
        const id = await pair(A, B);
        A.write('worlds/a.json', 'after');
        await A.call('POST', `/backends/${id}/sync`);
        await until(() => B.read('worlds/a.json') === 'after');
        await B.call('POST', `/backends/${id}/sync`);
        await A.close();
        const res = await B.call('POST', `/backends/${id}/undo`);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.body).toMatchObject({ ok: false, committed: true, propagation: { ok: false } });
        expect(B.read('worlds/a.json')).toBe('before');
    });
});
