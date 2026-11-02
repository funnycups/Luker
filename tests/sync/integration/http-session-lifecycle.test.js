/**
 * `/session/offer` and `/session/close` endpoints.
 *
 * Exercises the session-bootstrap flow that turns an authenticated offer
 * from a registered LAN backend into a multi-use bearer token for the rest
 * of `/api/sync/v1/session/*`. Each test runs end-to-end over a real
 * loopback listener against the real router, real session cache, real
 * registry and a real fs engine — no mocks.
 *
 * Coverage:
 *   - happy path: offer issues a 64-hex token that unlocks `/session/manifest`
 *   - missing peerId → 400
 *   - the offer body categories are ignored
 *   - close: subsequent `/session/manifest` with the same token → 401
 *   - close with no/invalid bearer → 401 from `requireSyncToken`
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { startLanDevice } from '../_lib/lan-devices.js';
import { readRegistry, upsertLanBackend } from '../../../src/sync/state.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { readCommitFiles } from '../../../src/sync/pipeline/git-tree.js';

const SECRET = 'c'.repeat(64);
const PEER = 'u@0a1b2c3d';

describe('sync session lifecycle', () => {
    let device;

    beforeEach(async () => {
        _resetGateForTests();
        device = await startLanDevice();
        await upsertLanBackend({ userRoot: device.userRoot, backendId: PEER, label: 'p', categories: [], syncSecret: SECRET });
    });

    afterEach(async () => {
        await device.close();
    });

    const offer = (extra = {}) => device.offer({ peerId: PEER, label: 'p', protocol: 2, ...extra }, { secret: SECRET });
    const bearer = token => ({ headers: { Authorization: `Bearer ${token}` } });

    test('POST /session/offer issues a usable bearer token', async () => {
        const r = await offer();
        expect(r.status).toBe(200);
        expect(r.body.token).toMatch(/^[a-f0-9]{64}$/);
        expect(r.body.url).toContain('/api/sync/v1/session/manifest');
        expect(r.body.expiresAt).toBeGreaterThan(Date.now());
        expect(r.body.peerId).toBe(PEER);
        expect(r.body.protocol).toBe(2);

        // The token must unlock the manifest route. This is the actual
        // contract the peer relies on: not just "we got a token back" but
        // "the token works on the rest of /session/*".
        const m = await device.call('GET', '/session/manifest', bearer(r.body.token));
        expect(m.status).toBe(200);
        expect(m.body).toEqual(expect.objectContaining({ peerId: PEER, handle: device.handle }));
    });

    test('POST /session/offer rejects when peerId is missing or blank', async () => {
        const noPeer = await device.offer({ label: 'no peerId', protocol: 2 }, { secret: SECRET });
        expect(noPeer.status).toBe(400);
        expect(noPeer.body.error).toMatch(/peerId/i);

        const blankPeer = await device.offer({ peerId: '   ', label: 'still no peerId', protocol: 2 }, { secret: SECRET });
        expect(blankPeer.status).toBe(400);
    });

    test('the offer body categories are ignored', async () => {
        await upsertLanBackend({ userRoot: device.userRoot, backendId: PEER, label: 'p', categories: ['worlds'] });
        device.write('worlds/w.json', '{"a":1}');
        device.write('chats/Seraphina/c1.jsonl', '{"chat_metadata":{}}\n');
        const r = await offer({ categories: ['chats'] });
        expect(r.status).toBe(200);
        expect((await readRegistry({ userRoot: device.userRoot })).backends[PEER].categories).toEqual(['worlds']);
        const manifest = await device.call('GET', '/session/manifest', bearer(r.body.token));
        const { gitDir } = await ensureShadowRepo({ userRoot: device.userRoot, peerId: PEER });
        const files = await readCommitFiles({ gitdir: gitDir, commitOid: manifest.body.headOid });
        expect([...files.keys()]).toEqual(['worlds/w.json']);
    });

    test('POST /session/close invalidates the bearer token', async () => {
        const r = await offer();
        expect(r.status).toBe(200);
        const token = r.body.token;

        // Confirm the token works before close, so a failure on the
        // after-close request unambiguously means close did its job.
        expect((await device.call('GET', '/session/manifest', bearer(token))).status).toBe(200);

        const close = await device.call('POST', '/session/close', bearer(token));
        expect(close).toEqual({ status: 200, body: { ok: true } });

        expect((await device.call('GET', '/session/manifest', bearer(token))).status).toBe(401);
    });

    test('POST /session/close itself requires a valid bearer', async () => {
        expect((await device.call('POST', '/session/close')).status).toBe(401);
        expect((await device.call('POST', '/session/close', bearer('not-hex'))).status).toBe(401);
        expect((await device.call('POST', '/session/close', bearer('a'.repeat(64)))).status).toBe(401);
    });
});
