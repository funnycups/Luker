/**
 * Unit tests for the SYNC_IN_PROGRESS gate registry + middleware
 * (`src/sync/in-progress-gate.js`, spec §4.4).
 *
 * Covers the pure module surface; an end-to-end test that proves the
 * orchestrator actually invokes `markSyncInProgress` around its work
 * lives in `tests/sync/integration/sync-in-progress-gate.test.js`.
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import {
    markSyncInProgress,
    clearSyncInProgress,
    getInFlightSyncs,
    isGatedPath,
    syncInProgressMiddleware,
    SYNC_GATE_RETRY_AFTER_MS,
    _resetInFlightForTests,
} from '../../src/sync/in-progress-gate.js';

beforeEach(() => {
    _resetInFlightForTests();
});

describe('in-progress registry', () => {
    test('mark + getInFlightSyncs returns the registered entry', () => {
        markSyncInProgress('alice', 'peer-1');
        const entries = getInFlightSyncs('alice');
        expect(entries).toHaveLength(1);
        expect(entries[0].peerId).toBe('peer-1');
        expect(typeof entries[0].since).toBe('number');
        expect(entries[0].since).toBeGreaterThan(0);
    });

    test('clear removes a single entry without dropping siblings', () => {
        markSyncInProgress('alice', 'peer-1');
        markSyncInProgress('alice', 'peer-2');
        clearSyncInProgress('alice', 'peer-1');
        const entries = getInFlightSyncs('alice');
        expect(entries.map(e => e.peerId).sort()).toEqual(['peer-2']);
    });

    test('clear of the last entry removes the bucket entirely', () => {
        markSyncInProgress('alice', 'peer-1');
        clearSyncInProgress('alice', 'peer-1');
        expect(getInFlightSyncs('alice')).toEqual([]);
    });

    test('per-handle isolation: bob marks do not affect alice', () => {
        markSyncInProgress('alice', 'peer-1');
        markSyncInProgress('bob', 'peer-1');
        expect(getInFlightSyncs('alice').map(e => e.peerId)).toEqual(['peer-1']);
        expect(getInFlightSyncs('bob').map(e => e.peerId)).toEqual(['peer-1']);
        clearSyncInProgress('alice', 'peer-1');
        expect(getInFlightSyncs('alice')).toEqual([]);
        expect(getInFlightSyncs('bob').map(e => e.peerId)).toEqual(['peer-1']);
    });

    test('re-mark refreshes since timestamp, does not duplicate', () => {
        markSyncInProgress('alice', 'peer-1');
        const first = getInFlightSyncs('alice')[0].since;
        // Spin a small busy-wait so Date.now advances reliably even when
        // the test runner happens to be at a clock edge (sub-millisecond).
        const target = first + 2;
        while (Date.now() < target) { /* spin */ }
        markSyncInProgress('alice', 'peer-1');
        const entries = getInFlightSyncs('alice');
        expect(entries).toHaveLength(1);
        expect(entries[0].since).toBeGreaterThanOrEqual(target);
    });

    test('clear is a no-op when no marker exists', () => {
        expect(() => clearSyncInProgress('alice', 'peer-1')).not.toThrow();
        expect(getInFlightSyncs('alice')).toEqual([]);
    });

    test('mark with missing args is a no-op (defensive)', () => {
        markSyncInProgress('', 'peer-1');
        markSyncInProgress('alice', '');
        expect(getInFlightSyncs('alice')).toEqual([]);
        expect(getInFlightSyncs('')).toEqual([]);
    });

    test('getInFlightSyncs returns a copy, not a live view', () => {
        markSyncInProgress('alice', 'peer-1');
        const snapshot = getInFlightSyncs('alice');
        markSyncInProgress('alice', 'peer-2');
        expect(snapshot).toHaveLength(1);
        expect(getInFlightSyncs('alice')).toHaveLength(2);
    });
});

describe('isGatedPath', () => {
    test('matches the explicit spec §4.4 examples', () => {
        expect(isGatedPath('/api/chats/save')).toBe(true);
        expect(isGatedPath('/api/settings/save')).toBe(true);
    });

    test('matches expanded write paths under the same routers', () => {
        const gated = [
            '/api/chats/append',
            '/api/chats/patch',
            '/api/chats/rename',
            '/api/chats/delete',
            '/api/chats/meta',
            '/api/chats/meta/patch',
            '/api/chats/group/save',
            '/api/chats/group/append',
            '/api/settings/patch',
            '/api/settings/make-snapshot',
            '/api/presets/save',
            '/api/presets/delete',
            '/api/themes/save',
            '/api/themes/delete',
            '/api/quick-replies/save',
            '/api/moving-ui/save',
            '/api/worldinfo/edit',
            '/api/worldinfo/import',
            '/api/characters/edit',
            '/api/characters/create',
            '/api/characters/delete',
            '/api/users/me/settings/save',
        ];
        for (const p of gated) {
            expect(isGatedPath(p)).toBe(true);
        }
    });

    test('does NOT match read-only paths', () => {
        const allowed = [
            '/api/chats/get',
            '/api/chats/get-delta',
            '/api/chats/recent',
            '/api/chats/search',
            '/api/chats/export',
            '/api/chats/state/get',
            '/api/chats/state/get-batch',
            '/api/settings/get',
            '/api/settings/bootstrap',
            '/api/settings/get-snapshots',
            '/api/presets/state/get',
            '/api/presets/state/get-batch',
            '/api/worldinfo/get',
            '/api/worldinfo/list',
            '/api/characters/all',
            '/api/characters/get',
            '/api/characters/chats',
        ];
        for (const p of allowed) {
            expect(isGatedPath(p)).toBe(false);
        }
    });

    test('does NOT match the sync protocol itself', () => {
        expect(isGatedPath('/api/sync/v1/health')).toBe(false);
        expect(isGatedPath('/api/sync/v1/pull')).toBe(false);
        expect(isGatedPath('/api/sync/v1/session/manifest')).toBe(false);
        expect(isGatedPath('/api/sync/v1/session/object')).toBe(false);
    });

    test('handles bad input without throwing', () => {
        expect(isGatedPath('')).toBe(false);
        expect(isGatedPath(null)).toBe(false);
        expect(isGatedPath(undefined)).toBe(false);
        expect(isGatedPath(42)).toBe(false);
    });
});

describe('syncInProgressMiddleware', () => {
    function buildApp({ handle = 'alice' } = {}) {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { profile: { handle, admin: true } };
            next();
        });
        app.use(syncInProgressMiddleware());
        // Stub that always answers 200, so any 4xx in tests is the gate
        // talking, not the route below.
        app.post('/api/chats/save', (_req, res) => res.json({ ok: true }));
        app.post('/api/settings/save', (_req, res) => res.json({ ok: true }));
        app.post('/api/chats/get', (_req, res) => res.json({ ok: true }));
        app.get('/api/chats/save', (_req, res) => res.json({ ok: true })); // would not exist in prod, here to assert GET passes
        app.post('/api/sync/v1/pull', (_req, res) => res.json({ ok: true }));
        return app;
    }

    test('lets writes through when no sync is in flight', async () => {
        const app = buildApp();
        const res = await request(app).post('/api/chats/save').send({});
        expect(res.status).toBe(200);
    });

    test('returns 409 with structured body when a sync is in flight', async () => {
        const app = buildApp();
        markSyncInProgress('alice', 'peer-1');
        const res = await request(app).post('/api/chats/save').send({});
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('SYNC_IN_PROGRESS');
        expect(res.body.retryAfterMs).toBe(SYNC_GATE_RETRY_AFTER_MS);
        expect(res.body.peers).toEqual(expect.arrayContaining([
            expect.objectContaining({ peerId: 'peer-1' }),
        ]));
        // Retry-After header (seconds, per HTTP spec)
        expect(res.headers['retry-after']).toBe(String(Math.ceil(SYNC_GATE_RETRY_AFTER_MS / 1000)));
    });

    test('gates settings/save the same way', async () => {
        const app = buildApp();
        markSyncInProgress('alice', 'peer-1');
        const res = await request(app).post('/api/settings/save').send({});
        expect(res.status).toBe(409);
    });

    test('does NOT gate read endpoints during sync', async () => {
        const app = buildApp();
        markSyncInProgress('alice', 'peer-1');
        const res = await request(app).post('/api/chats/get').send({});
        expect(res.status).toBe(200);
    });

    test('does NOT gate GET requests on gated paths (defensive)', async () => {
        const app = buildApp();
        markSyncInProgress('alice', 'peer-1');
        const res = await request(app).get('/api/chats/save');
        expect(res.status).toBe(200);
    });

    test('does NOT gate the sync protocol itself', async () => {
        const app = buildApp();
        markSyncInProgress('alice', 'peer-1');
        const res = await request(app).post('/api/sync/v1/pull').send({});
        expect(res.status).toBe(200);
    });

    test('per-handle isolation: bob can save while alice is syncing', async () => {
        const aliceApp = buildApp({ handle: 'alice' });
        const bobApp = buildApp({ handle: 'bob' });
        markSyncInProgress('alice', 'peer-1');
        const aliceRes = await request(aliceApp).post('/api/chats/save').send({});
        const bobRes = await request(bobApp).post('/api/chats/save').send({});
        expect(aliceRes.status).toBe(409);
        expect(bobRes.status).toBe(200);
    });

    test('write opens up again after clearSyncInProgress', async () => {
        const app = buildApp();
        markSyncInProgress('alice', 'peer-1');
        const blocked = await request(app).post('/api/chats/save').send({});
        expect(blocked.status).toBe(409);
        clearSyncInProgress('alice', 'peer-1');
        const allowed = await request(app).post('/api/chats/save').send({});
        expect(allowed.status).toBe(200);
    });

    test('stays gated while ANY peer of the same handle is syncing', async () => {
        const app = buildApp();
        markSyncInProgress('alice', 'peer-1');
        markSyncInProgress('alice', 'peer-2');
        clearSyncInProgress('alice', 'peer-1');
        const res = await request(app).post('/api/chats/save').send({});
        expect(res.status).toBe(409);
        expect(res.body.peers.map(p => p.peerId)).toEqual(['peer-2']);
    });

    test('lets writes through when request has no authenticated user', async () => {
        const app = express();
        app.use(express.json());
        app.use(syncInProgressMiddleware());
        app.post('/api/chats/save', (_req, res) => res.json({ ok: true }));
        markSyncInProgress('alice', 'peer-1');
        const res = await request(app).post('/api/chats/save').send({});
        // No req.user → middleware can't decide the handle → falls through.
        // The downstream route will reject the request for its own reasons
        // (no user); the gate is not the right layer for auth.
        expect(res.status).toBe(200);
    });
});
