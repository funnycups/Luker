/**
 * Storage-mode regression guard for `/session/offer` and `/availability`.
 *
 * Earlier revisions of LAN Sync gated `/session/offer`, `/pull`,
 * `/pair/start`, `/pair/accept`, `/peers/:peerId/sync` with a 412 when the
 * storage engine was `mysql` or `postgres`, and reported the same modes as
 * `available: false` on `/availability`. Once sync started routing
 * SQL-engine data through the per-record materializer, those gates became
 * dead weight. This file pins the contract — every storage engine is
 * accepted — so a future regression that re-introduces a storage-mode gate
 * fails loudly here instead of silently shipping.
 *
 * Each case runs a real LAN device whose engine is built by the case's
 * contract harness; mysql/postgres cases need the test containers.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { CONTRACT_HARNESSES } from '../_lib/required-engines.js';
import { startLanDevice } from '../_lib/lan-devices.js';
import { upsertLanBackend } from '../../../src/sync/state.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';

const SECRET = 'd'.repeat(64);
const PEER = 'u@0a1b2c3d';

describe.each(CONTRACT_HARNESSES)('sync routes on $name', ({ make }) => {
    let device;
    let harness;

    beforeEach(async () => {
        _resetGateForTests();
        device = await startLanDevice({
            makeEngine: async () => {
                harness = await make();
                return harness.engine;
            },
        });
        await upsertLanBackend({ userRoot: device.userRoot, backendId: PEER, label: 'p', categories: [], syncSecret: SECRET });
    });

    afterEach(async () => {
        await device.close();
        await harness.cleanup();
    });

    test('/session/offer issues a token', async () => {
        const r = await device.offer({ peerId: PEER, label: 'p', protocol: 2 }, { secret: SECRET });
        expect(r.status).toBe(200);
        expect(r.body.token).toMatch(/^[a-f0-9]{64}$/);
    });

    test('/availability reports available', async () => {
        expect(await device.call('GET', '/availability')).toEqual({ status: 200, body: { available: true } });
    });
});
