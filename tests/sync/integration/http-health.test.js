import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { startLanDevice } from '../_lib/lan-devices.js';
import { isBasicAuthExemptRequest } from '../../../src/middleware/basicAuth.js';

describe('health and basic-auth exemptions', () => {
    let A;
    beforeEach(async () => { A = await startLanDevice(); });
    afterEach(() => A.close());

    test('health reports protocol 2', async () => {
        expect(await A.call('GET', '/health')).toEqual({ status: 200, body: { ok: true, protocol: 2 } });
    });

    test('health and credential-bearing offers bypass basic auth', () => {
        expect(isBasicAuthExemptRequest({ path: '/api/sync/v1/health', method: 'GET', headers: {} })).toBe(true);
        expect(isBasicAuthExemptRequest({ path: '/api/sync/v1/session/offer', method: 'POST', headers: { 'x-sync-peer-secret': 'a'.repeat(64) } })).toBe(true);
        expect(isBasicAuthExemptRequest({ path: '/api/sync/v1/session/offer', method: 'POST', headers: {} })).toBe(false);
        expect(isBasicAuthExemptRequest({ path: '/api/sync/v1/backends', method: 'GET', headers: {} })).toBe(false);
    });
});
