import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startLanDevice, pair } from '../_lib/lan-devices.js';
import { until } from '../_lib/until.js';
import { upsertLanBackend } from '../../../src/sync/state.js';
import { getGateState, runGatedWrite, _resetGateForTests } from '../../../src/sync/in-progress-gate.js';

const IDLE = { readers: 0, writerHeld: false, waitingReaders: 0, waitingWriters: 0 };

describe('the write gate around LAN syncs', () => {
    let A;
    let B;
    let pauseDir;
    beforeEach(async () => {
        _resetGateForTests();
        A = await startLanDevice();
        B = await startLanDevice();
        pauseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-gate-pause-'));
    });
    afterEach(async () => {
        delete process.env.LUKER_SYNC_PAUSEPOINT;
        delete process.env.LUKER_SYNC_PAUSE_DIR;
        await A.close();
        await B.close();
        fs.rmSync(pauseDir, { recursive: true, force: true });
    });

    test('a manual sync leaves the gate idle when it returns', async () => {
        const id = await pair(A, B);
        B.write('worlds/w.json', '{}');
        await B.call('POST', `/backends/${id}/sync`);
        expect(getGateState(B.userRoot)).toEqual(IDLE);
    });

    test('a write waits while a snapshot holds the gate and then succeeds', async () => {
        const id = await pair(A, B);
        process.env.LUKER_SYNC_PAUSE_DIR = pauseDir;
        process.env.LUKER_SYNC_PAUSEPOINT = 'inside-snapshot-lock';
        fs.writeFileSync(path.join(pauseDir, 'inside-snapshot-lock.arm'), '');
        const sync = B.call('POST', `/backends/${id}/sync`);
        await until(() => fs.existsSync(path.join(pauseDir, 'inside-snapshot-lock.reached')));
        let wrote = false;
        const write = runGatedWrite({ userRoot: B.userRoot, handle: 'u' }, async () => { B.write('worlds/user.json', '{}'); wrote = true; });
        await new Promise(resolve => setImmediate(resolve));
        expect(wrote).toBe(false);
        expect(getGateState(B.userRoot)).toMatchObject({ writerHeld: true, waitingReaders: 1 });
        fs.writeFileSync(path.join(pauseDir, 'inside-snapshot-lock.release'), '');
        await write;
        expect(wrote).toBe(true);
        expect((await sync).body.ok).toBe(true);
    });

    test('a failed sync still releases the gate', async () => {
        const id = await pair(A, B);
        await upsertLanBackend({ userRoot: B.userRoot, backendId: id, label: 'A device', categories: ['worlds', 'chats'], peerBaseUrl: 'http://127.0.0.1:9' });
        expect((await B.call('POST', `/backends/${id}/sync`)).body).toMatchObject({ ok: false, code: 'PEER_UNREACHABLE' });
        expect(getGateState(B.userRoot)).toEqual(IDLE);
    });
});
