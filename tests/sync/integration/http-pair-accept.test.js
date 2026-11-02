import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { startLanDevice, pair } from '../_lib/lan-devices.js';
import { readRegistry, upsertLanBackend } from '../../../src/sync/state.js';

function barrier() {
    let enter, release;
    return { reached: new Promise(r => { enter = r; }), released: new Promise(r => { release = r; }), enter: () => enter(), release: () => release() };
}
import { until } from '../_lib/until.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { syncService } from '../../../src/sync/sync-service.js';

describe('pair accept', () => {
    let A;
    let B;
    let peerId;
    const idle = device => Object.values(syncService.getRunning(device.userRoot)).every(running => !running);

    beforeEach(async () => {
        _resetGateForTests();
        A = await startLanDevice();
        B = await startLanDevice();
    });
    afterEach(async () => {
        if (peerId) {
            await syncService.removeBackend(A.owner, peerId);
            await syncService.removeBackend(B.owner, peerId);
        }
        await A.close();
        await B.close();
    });

    test('every session opened at the other device is closed again', async () => {
        const started = await A.call('POST', '/pair/start', { body: { label: 'B device', categories: ['worlds'] } });
        expect(started.status).toBe(200);
        peerId = started.body.peerId;
        B.write('worlds/b.json', '{"b":1}');
        const accepted = await B.call('POST', '/pair/accept', {
            body: { peerBaseUrl: A.baseUrl, remotePeerId: peerId, label: 'A device', categories: ['worlds'], pairCode: started.body.pairCode },
        });
        expect(accepted).toMatchObject({ status: 200, body: { ok: true } });
        // Runs a push starts on the other device by notify keep one of the
        // two devices running until both are in sync.
        await until(() => idle(A) && idle(B));
        const count = route => A.requests.filter(r => r === `POST /api/sync/v1/session/${route}`).length;
        expect(count('offer')).toBeGreaterThan(0);
        expect(count('close')).toBe(count('offer'));
    });

    test('a current nonadmin profile is refused before any outbound request', async () => {
        const previous = process.env.LUKER_ENABLE_USER_ACCOUNTS;
        process.env.LUKER_ENABLE_USER_ACCOUNTS = 'true';
        try {
            const started = await A.call('POST', '/pair/start', { body: { label: 'B', categories: ['worlds'] } });
            peerId = started.body.peerId;
            B.profile.admin = false;
            const before = A.requests.length;
            const result = await B.call('POST', '/pair/accept', { body: { peerBaseUrl: A.baseUrl, remotePeerId: peerId, categories: ['worlds'], pairCode: started.body.pairCode } });
            expect(result).toMatchObject({ status: 403, body: { code: 'SYNC_PRIVATE_ADDRESS' } });
            expect(A.requests).toHaveLength(before);
            expect((await readRegistry({ userRoot: B.userRoot })).backends[peerId]).toBeUndefined();
        } finally {
            if (previous === undefined) delete process.env.LUKER_ENABLE_USER_ACCOUNTS;
            else process.env.LUKER_ENABLE_USER_ACCOUNTS = previous;
        }
    });

    test('a nonadmin generating owner rejects the real reverse callback without consuming its pairing code', async () => {
        const previous = process.env.LUKER_ENABLE_USER_ACCOUNTS;
        process.env.LUKER_ENABLE_USER_ACCOUNTS = 'true';
        try {
            const started = await A.call('POST', '/pair/start', { body: { label: 'B reverse', categories: ['worlds'] } });
            expect(started.status).toBe(200);
            peerId = started.body.peerId;
            A.profile.admin = false;
            const before = [...B.requests];
            const body = { peerId, protocol: 2, callback: B.userStore.selfCallback() };
            const refused = await A.offer(body, { pairCode: started.body.pairCode });
            expect(refused).toMatchObject({ status: 403, body: { code: 'SYNC_PRIVATE_ADDRESS' } });
            expect(B.requests).toEqual(before);
            expect((await readRegistry({ userRoot: A.userRoot })).backends[peerId].lan.syncSecret).toBe('');
            A.profile.admin = true;
            const accepted = await A.offer(body, { pairCode: started.body.pairCode });
            expect(accepted).toMatchObject({ status: 200, body: { protocol: 2, syncSecret: expect.stringMatching(/^[a-f0-9]{64}$/) } });
            expect(B.requests.slice(before.length)).toEqual(['GET /api/sync/v1/health']);
            expect(await A.call('POST', '/session/close', { headers: { Authorization: `Bearer ${accepted.body.token}` } })).toMatchObject({ status: 200 });
        } finally {
            if (previous === undefined) delete process.env.LUKER_ENABLE_USER_ACCOUNTS;
            else process.env.LUKER_ENABLE_USER_ACCOUNTS = previous;
        }
    });

    test.each(['maintenance', 'removed', 'recreated'])('existing acceptance cannot bypass %s while its real offer is in flight', async mode => {
        peerId = await pair(A, B, { categories: ['worlds'] });
        await syncService.trigger(A.owner, peerId, 'manual');
        await syncService.trigger(B.owner, peerId, 'manual');
        await until(() => idle(A) && idle(B));
        const held = barrier();
        const remote = await startLanDevice({ beforeRequest: async req => {
            if (req.path.endsWith('/session/offer')) { held.enter(); await held.released; }
        } });
        // A genuine peer router accepts the already stored durable secret.
        const original = (await readRegistry({ userRoot: B.userRoot })).backends[peerId];
        await upsertLanBackend({ userRoot: remote.userRoot, backendId: peerId, label: 'remote', categories: ['worlds'], syncSecret: original.lan.syncSecret });
        const controlHeld = barrier();
        try {
            const acceptance = B.call('POST', '/pair/accept', { body: { peerBaseUrl: remote.baseUrl, remotePeerId: peerId, label: 'new label', categories: ['characters'] } });
            await held.reached;
            if (mode === 'maintenance') {
                const active = syncService.withBackendOperation(B.owner, peerId, 'prepare', async () => { controlHeld.enter(); await controlHeld.released; });
                await controlHeld.reached;
                let maintained = false;
                const control = syncService.withBackendMaintenance(B.owner, peerId, async () => { maintained = true; });
                held.release();
                // The peer closing its issued session proves the outbound offer
                // finished without waiting on the local drain.
                await until(() => remote.requests.includes('POST /api/sync/v1/session/close'));
                expect(maintained).toBe(false);
                expect((await readRegistry({ userRoot: B.userRoot })).backends[peerId]).toEqual(original);
                controlHeld.release();
                await Promise.all([active, control]);
                expect((await acceptance).status).toBe(200);
                expect((await readRegistry({ userRoot: B.userRoot })).backends[peerId].categories).toEqual(['characters']);
            } else {
                await syncService.removeBackend(B.owner, peerId);
                if (mode === 'recreated') await upsertLanBackend({ userRoot: B.userRoot, backendId: peerId, label: 'replacement', categories: ['worlds'], syncSecret: 'b'.repeat(64) });
                const before = (await readRegistry({ userRoot: B.userRoot })).backends[peerId];
                held.release();
                expect(await acceptance).toMatchObject({ status: 404, body: { code: 'UNKNOWN_BACKEND', stage: 'record' } });
                expect((await readRegistry({ userRoot: B.userRoot })).backends[peerId]).toEqual(before);
            }
        } finally { held.release(); controlHeld.release(); await remote.close(); }
    });
});
