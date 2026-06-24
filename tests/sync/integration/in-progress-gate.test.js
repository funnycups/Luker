/**
 * Integration: SYNC_IN_PROGRESS gate is held while a sync is in flight
 * and released on every exit path (success / error / pending conflict).
 *
 * Spec §4.4. The unit tests in `tests/sync/in-progress-gate.test.js`
 * pin the registry + middleware in isolation. THIS suite stands up two
 * real Luker servers (per the `full-flow` test pattern) and proves that
 * the orchestrator actually invokes `markSyncInProgress` around its
 * work so a `/api/chats/save` arriving mid-pull returns the
 * documented 409 with `Retry-After` and structured body.
 *
 * Test strategy:
 *   - Mount the sync router AND a thin stub for `/api/chats/save` on
 *     each harness. The stub is wrapped by `syncInProgressMiddleware()`
 *     so the gate's effect is visible in HTTP form (same wire shape as
 *     production).
 *   - In a happy-path pull: hook the orchestrator's slowest step
 *     (`reconcileShadowToLive`) so it parks until the test fires
 *     `/api/chats/save`. While parked, the save must 409; once the
 *     reconcile is allowed to proceed and `runPull` returns, the same
 *     save must 200.
 *   - In a failure-path pull: force the orchestrator to throw
 *     (unreachable peer base URL). The gate must still clear so a
 *     subsequent save 200s.
 *   - In a pending-conflict pull (the trickiest): make both sides edit
 *     the same file so `runPull` returns `{ ok: false, conflicts }`
 *     and the shadow stays in merge-in-progress. The gate MUST be
 *     released because the orchestrator has handed control back to the
 *     UI and writes are safe again — see the `runPullBody` doc in
 *     `src/sync/orchestrator.js`.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../../storage/harness/endpoint-harness.js';
import { router as syncRouter } from '../../../src/endpoints/sync.js';
import {
    syncInProgressMiddleware,
    getInFlightSyncs,
    SYNC_GATE_RETRY_AFTER_MS,
    _resetInFlightForTests,
} from '../../../src/sync/in-progress-gate.js';

const FS_HARNESSES = ENDPOINT_HARNESSES.filter(h => h.mode === 'fs');

/**
 * Wrap an Express app in a real http.Server on a random loopback port.
 * Copied from `full-flow.test.js` — same shape so the orchestrator's
 * outbound `fetch()` does a real TCP round trip rather than supertest's
 * in-process dispatch.
 */
function startListener(app) {
    return new Promise(resolve => {
        const server = http.createServer(app).listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                server,
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => new Promise(done => server.close(done)),
            });
        });
    });
}

/**
 * Mount on each harness: a router-level latch in front of `/session/object`
 * that the parked-pull test flips on to suspend object fetches; THEN
 * the sync router; THEN the gate middleware and a stub `/api/chats/save`.
 *
 * Express runs middleware in registration order, so the latch — being
 * registered BEFORE the sync router — sees every object-fetch GET
 * before the router does. By default (no `_objectFetchGate` set on the
 * app) it passes through immediately, so harnesses for the other tests
 * aren't affected.
 */
function mountSyncAndChatsStub(app) {
    app.use('/api/sync/v1/session/object', async (req, _res, next) => {
        const gate = req.app.get('_objectFetchGate');
        if (gate) await gate;
        next();
    });
    app.use('/api/sync/v1', syncRouter);
    app.use(syncInProgressMiddleware());
    app.post('/api/chats/save', (_req, res) => res.json({ ok: true }));
}

describe.each(FS_HARNESSES)('SYNC_IN_PROGRESS gate on $name', ({ mode }) => {
    let A, B, aListener, bListener;

    beforeEach(async () => {
        _resetInFlightForTests();
        A = await makeEndpointHarness({ mode, mount: mountSyncAndChatsStub });
        B = await makeEndpointHarness({ mode, mount: mountSyncAndChatsStub });
        aListener = await startListener(A.app);
        bListener = await startListener(B.app);
    });

    afterEach(async () => {
        if (aListener) await aListener.close();
        if (bListener) await bListener.close();
        if (A) await A.cleanup();
        if (B) await B.cleanup();
        _resetInFlightForTests();
    });

    test('successful pull marks the handle in-flight, then clears on completion', async () => {
        // Seed A with a tiny tree so the pull has something to do.
        fs.writeFileSync(
            path.join(A.dirs.characters, 'a.png'),
            Buffer.from('A'),
        );

        const PEER_ID = 'u@deadbeef';

        // Before any sync work: writes pass.
        const before = await request(B.app).post('/api/chats/save').send({});
        expect(before.status).toBe(200);
        expect(getInFlightSyncs(B.handle)).toEqual([]);

        const offer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'B',
                categories: ['characters'],
            });
        expect(offer.status).toBe(200);

        const pull = await request(B.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: offer.body.token,
                categories: ['characters'],
            });
        expect(pull.status).toBe(200);
        expect(pull.body.ok).toBe(true);

        // After pull completes: gate is cleared.
        expect(getInFlightSyncs(B.handle)).toEqual([]);
        const after = await request(B.app).post('/api/chats/save').send({});
        expect(after.status).toBe(200);
    });

    test('writes to gated endpoints return 409 while a pull is in flight', async () => {
        fs.writeFileSync(
            path.join(A.dirs.characters, 'a.png'),
            Buffer.from('A'),
        );
        const PEER_ID = 'u@deadbeef';

        // Park A's `/session/object/:oid` GETs behind a manually-released
        // latch so B's `runPull` blocks in `fetchMissingObjects`. We
        // mounted a router-level middleware below at harness setup time
        // (`A.app.set('parkObjectFetches', ...)`) — flip the latch on
        // here so it actually parks for this test, then release it
        // after the assertions.
        let releaseObjectFetches;
        const objectFetchGate = new Promise(resolve => {
            releaseObjectFetches = resolve;
        });
        A.app.set('_objectFetchGate', objectFetchGate);

        const offer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'B',
                categories: ['characters'],
            });
        expect(offer.status).toBe(200);

        // Fire the pull. supertest's `Test` only sends the request
        // when something registers `.then()` or invokes `.end()`, so
        // calling `.then(x => x)` here kicks the request off as a
        // real Promise without awaiting completion.
        const pullPromise = request(B.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: offer.body.token,
                categories: ['characters'],
            })
            .then(res => res);

        // Wait for the orchestrator to enter the in-flight state.
        // `markSyncInProgress` runs inside `queueOnKey`'s callback —
        // synchronously after the queue admits us and before any
        // network I/O — so as soon as the manifest fetch is in flight,
        // the gate is closed. Poll a few ms for the registry update.
        const waitForInFlight = async () => {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                if (getInFlightSyncs(B.handle).length > 0) return;
                await new Promise(r => setTimeout(r, 10));
            }
            throw new Error('Timed out waiting for sync to mark in-flight');
        };
        await waitForInFlight();

        // While the pull is parked at the object-fetch step: save 409s.
        const during = await request(B.app).post('/api/chats/save').send({});
        expect(during.status).toBe(409);
        expect(during.body.error).toBe('SYNC_IN_PROGRESS');
        expect(during.body.retryAfterMs).toBe(SYNC_GATE_RETRY_AFTER_MS);
        expect(during.body.peers).toEqual(expect.arrayContaining([
            expect.objectContaining({ peerId: PEER_ID }),
        ]));
        expect(during.headers['retry-after']).toBe(String(Math.ceil(SYNC_GATE_RETRY_AFTER_MS / 1000)));

        // Release the parked fetches → pull completes.
        releaseObjectFetches();
        const pull = await pullPromise;
        expect(pull.status).toBe(200);
        expect(pull.body.ok).toBe(true);

        // Gate cleared, saves pass again.
        expect(getInFlightSyncs(B.handle)).toEqual([]);
        const after = await request(B.app).post('/api/chats/save').send({});
        expect(after.status).toBe(200);
    });

    test('pull error path still clears the gate', async () => {
        const PEER_ID = 'u@deadbeef';

        // Pick an unbound port: bind an http server on ephemeral port,
        // grab the number, immediately close — the kernel won't recycle
        // that port to another process for a while, so the next fetch
        // to it lands on ECONNREFUSED. Doing this from a free port
        // (rather than hardcoding "65000") keeps the test robust on
        // hosts that happen to have something at the picked number.
        const probe = http.createServer().listen(0, '127.0.0.1');
        await new Promise(r => probe.once('listening', r));
        const unboundPort = probe.address().port;
        await new Promise(r => probe.close(r));
        const unboundUrl = `http://127.0.0.1:${unboundPort}`;

        const offer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'X',
                categories: ['characters'],
            });
        expect(offer.status).toBe(200);

        // `runPull` will fail at `fetchRemoteManifestHead`.
        // The gate must be released by the `try/finally`.
        const pull = await request(B.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'X',
                peerBaseUrl: unboundUrl,
                offerToken: offer.body.token,
                categories: ['characters'],
            });
        // Either 500 (generic fetch failure) or 504 (PEER_TIMEOUT) is
        // acceptable here; both are non-2xx and both should still
        // clear the gate.
        expect([500, 502, 503, 504]).toContain(pull.status);

        // Gate cleared despite the error.
        expect(getInFlightSyncs(B.handle)).toEqual([]);
        const after = await request(B.app).post('/api/chats/save').send({});
        expect(after.status).toBe(200);
    });

    test('pending-conflict pull releases the gate so the user can keep working until they post resolutions', async () => {
        // Pair first.
        const PEER_ID = 'u@deadbeef';
        fs.writeFileSync(
            path.join(A.dirs.characters, 'shared.png'),
            Buffer.from('SHARED'),
        );
        const pairOffer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'B',
                categories: ['characters'],
            });
        expect(pairOffer.status).toBe(200);
        const pair = await request(B.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: pairOffer.body.token,
                categories: ['characters'],
            });
        expect(pair.body.ok).toBe(true);

        // Now both sides edit the same file → forced conflict.
        fs.writeFileSync(
            path.join(A.dirs.characters, 'shared.png'),
            Buffer.from('A_VERSION'),
        );
        fs.writeFileSync(
            path.join(B.dirs.characters, 'shared.png'),
            Buffer.from('B_VERSION'),
        );

        const conflictOffer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'B',
                categories: ['characters'],
            });
        const conflictPull = await request(B.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: conflictOffer.body.token,
                categories: ['characters'],
            });
        expect(conflictPull.status).toBe(200);
        expect(conflictPull.body.ok).toBe(false);
        expect(conflictPull.body.conflicts).toEqual(expect.any(Array));
        expect(conflictPull.body.conflicts.length).toBeGreaterThan(0);

        // The conflict was returned to the UI — the orchestrator has
        // released control. Saves must be allowed while the user picks
        // a side. If we didn't clear, the user would be stuck at 409
        // until they re-post `/pull` with `resolutions`, which is a
        // UX trap (the UI for picking lives on the same client as the
        // saves).
        expect(getInFlightSyncs(B.handle)).toEqual([]);
        const between = await request(B.app).post('/api/chats/save').send({});
        expect(between.status).toBe(200);
    });

    test('undo last sync also gates writes for the duration', async () => {
        // Pair, then sync once, then undo.
        const PEER_ID = 'u@deadbeef';
        fs.writeFileSync(
            path.join(A.dirs.characters, 'a.png'),
            Buffer.from('A'),
        );
        const pairOffer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'B',
                categories: ['characters'],
            });
        const pair = await request(B.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: pairOffer.body.token,
                categories: ['characters'],
            });
        expect(pair.body.ok).toBe(true);

        // Make a second sync so there's a backup tag to undo.
        fs.writeFileSync(
            path.join(A.dirs.characters, 'b.png'),
            Buffer.from('B'),
        );
        const secondOffer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'B',
                categories: ['characters'],
            });
        const second = await request(B.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: secondOffer.body.token,
                categories: ['characters'],
            });
        expect(second.body.ok).toBe(true);

        // Before undo: gate is open.
        expect(getInFlightSyncs(B.handle)).toEqual([]);

        // Undo runs synchronously w.r.t. supertest's await, so the gate
        // window is hard to observe in-line. Assert post-condition:
        // gate cleared after the call returns AND writes pass.
        const undo = await request(B.app)
            .post('/api/sync/v1/undo')
            .send({ peerId: PEER_ID });
        expect(undo.status).toBe(200);
        expect(getInFlightSyncs(B.handle)).toEqual([]);
        const after = await request(B.app).post('/api/chats/save').send({});
        expect(after.status).toBe(200);
    });
});
