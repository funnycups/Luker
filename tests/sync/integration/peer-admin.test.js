/**
 * Admin endpoints for the LAN Sync UI:
 *   - GET    /api/sync/v1/peers
 *   - DELETE /api/sync/v1/peers/:peerId
 *   - POST   /api/sync/v1/peers/:peerId/label
 *   - POST   /api/sync/v1/pair/start
 *   - POST   /api/sync/v1/pair/accept
 *
 * The peer-to-peer protocol (`/session/*`, `/pull`, `/undo`) is covered by
 * the integration suites in this directory. THIS file pins the admin
 * wrappers: registry shape, on-disk shadow cleanup on forget, pair
 * generation, accept-then-pull happy path.
 *
 * Strategy mirrors `full-flow.test.js`: real harnesses on real HTTP
 * listeners so `/pair/accept`'s outbound `fetch` to the peer is a real
 * round-trip rather than supertest's in-process dispatch.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../../storage/harness/endpoint-harness.js';
import { router as syncRouter } from '../../../src/endpoints/sync.js';
import { ensureShadowRepo, getShadowPaths } from '../../../src/sync/shadow.js';
import { recordPeer, readSyncState } from '../../../src/sync/state.js';

const FS_HARNESSES = ENDPOINT_HARNESSES.filter(h => h.mode === 'fs');

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

describe.each(FS_HARNESSES)('LAN Sync admin endpoints on $name', ({ mode }) => {
    let A, B, aListener, bListener;

    beforeEach(async () => {
        A = await makeEndpointHarness({
            mode,
            mount: app => app.use('/api/sync/v1', syncRouter),
        });
        B = await makeEndpointHarness({
            mode,
            mount: app => app.use('/api/sync/v1', syncRouter),
        });
        aListener = await startListener(A.app);
        bListener = await startListener(B.app);
    });

    afterEach(async () => {
        if (aListener) await aListener.close();
        if (bListener) await bListener.close();
        if (A) await A.cleanup();
        if (B) await B.cleanup();
    });

    describe('GET /peers', () => {
        test('returns empty registry when no peers exist', async () => {
            const res = await request(A.app).get('/api/sync/v1/peers');
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ peers: {} });
        });

        test('returns the full peer entries verbatim', async () => {
            await recordPeer({
                userRoot: A.dirs.root,
                peerId: 'p1@deadbeef',
                label: 'Phone',
                categories: ['characters', 'chats'],
            });
            const res = await request(A.app).get('/api/sync/v1/peers');
            expect(res.status).toBe(200);
            expect(res.body.peers['p1@deadbeef']).toEqual(expect.objectContaining({
                label: 'Phone',
                categories: ['characters', 'chats'],
                pairedAt: expect.any(Number),
            }));
        });
    });

    describe('GET /categories', () => {
        test('returns the SYNC_CATEGORIES shape without resolver functions', async () => {
            const res = await request(A.app).get('/api/sync/v1/categories');
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.categories)).toBe(true);
            expect(res.body.categories.length).toBeGreaterThan(5);
            for (const cat of res.body.categories) {
                expect(typeof cat.id).toBe('string');
                expect(typeof cat.displayKey).toBe('string');
                expect(typeof cat.descriptionKey).toBe('string');
                expect(['file', 'none']).toContain(cat.conflictMode);
                expect(['on', 'opt-in', 'never']).toContain(cat.syncDefault);
                // Resolver functions are stripped — paths must not leak.
                expect(cat.paths).toBeUndefined();
            }
        });
    });

    describe('GET /availability', () => {
        test('reports available on fs storage mode', async () => {
            const res = await request(A.app).get('/api/sync/v1/availability');
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ available: true });
        });
    });

    describe('DELETE /peers/:peerId', () => {
        test('removes both the registry entry AND the shadow dir on disk', async () => {
            const peerId = 'p1@feedface';
            await recordPeer({ userRoot: A.dirs.root, peerId, label: 'Phone', categories: ['chats'] });
            await ensureShadowRepo({ userRoot: A.dirs.root, peerId });
            const { peerDir } = getShadowPaths({ userRoot: A.dirs.root, peerId });
            expect(fs.existsSync(peerDir)).toBe(true);

            const res = await request(A.app).delete(`/api/sync/v1/peers/${peerId}`);
            expect(res.status).toBe(204);
            expect(fs.existsSync(peerDir)).toBe(false);
            expect(readSyncState({ userRoot: A.dirs.root }).peers[peerId]).toBeUndefined();
        });

        test('is idempotent — 204 even when the peer was never registered', async () => {
            const res = await request(A.app).delete('/api/sync/v1/peers/never@existed');
            expect(res.status).toBe(204);
        });

        test('rejects unsafe peerIds with 400', async () => {
            // `*` is outside the safe character class enforced by
            // assertSafePeerId (PEER_ID_PATTERN = [A-Za-z0-9._@-]+). It
            // does NOT trip Express path normalization, so it reaches our
            // handler and exercises the validation gate. Path-traversal
            // strings like `..` are normalized by Express before routing
            // (decoded or not), so they hit no-such-route 404 rather than
            // the handler — those are blocked at a layer further out, not
            // by our gate, which is fine.
            const res = await request(A.app).delete('/api/sync/v1/peers/bad*id');
            expect(res.status).toBe(400);
        });
    });

    describe('POST /peers/:peerId/label', () => {
        test('relabels a registered peer without losing pairedAt', async () => {
            const peerId = 'p1@cafe1234';
            await recordPeer({ userRoot: A.dirs.root, peerId, label: 'Old', categories: ['chats'] });
            const before = readSyncState({ userRoot: A.dirs.root }).peers[peerId].pairedAt;

            const res = await request(A.app)
                .post(`/api/sync/v1/peers/${peerId}/label`)
                .send({ label: 'New', categories: ['chats', 'characters'] });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ ok: true });

            const after = readSyncState({ userRoot: A.dirs.root }).peers[peerId];
            expect(after.label).toBe('New');
            expect(after.categories).toEqual(['chats', 'characters']);
            // pairedAt preserved per recordPeer's contract.
            expect(after.pairedAt).toBe(before);
        });

        test('returns 400 when label is missing', async () => {
            const peerId = 'p1@deadbeef';
            await recordPeer({ userRoot: A.dirs.root, peerId, label: 'X', categories: [] });
            const res = await request(A.app)
                .post(`/api/sync/v1/peers/${peerId}/label`)
                .send({ categories: ['chats'] });
            expect(res.status).toBe(400);
        });
    });

    describe('POST /pair/start', () => {
        test('returns a peerId, base URL, and echoed categories', async () => {
            const res = await request(A.app)
                .post('/api/sync/v1/pair/start')
                .send({ label: 'Desktop', categories: ['characters', 'chats'] });
            expect(res.status).toBe(200);
            // peerId shape: <handle>@<8 hex chars>.
            expect(res.body.peerId).toMatch(/@[a-f0-9]{8}$/);
            expect(res.body.label).toBe('Desktop');
            expect(res.body.categories).toEqual(['characters', 'chats']);
            // peerBaseUrl comes from the request — supertest sets host to
            // 127.0.0.1:<random>, so the shape is `http://127.0.0.1:<port>`.
            expect(res.body.peerBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1(:\d+)?$/);
        });

        test('registers the peerId locally so it shows up in /peers', async () => {
            const start = await request(A.app)
                .post('/api/sync/v1/pair/start')
                .send({ label: 'Desktop', categories: ['chats'] });
            const peerId = start.body.peerId;

            const peers = await request(A.app).get('/api/sync/v1/peers');
            expect(peers.body.peers[peerId]).toEqual(expect.objectContaining({
                label: 'Desktop',
                categories: ['chats'],
            }));
        });

        test('rejects empty category list', async () => {
            const res = await request(A.app)
                .post('/api/sync/v1/pair/start')
                .send({ label: 'X', categories: [] });
            expect(res.status).toBe(400);
        });
    });

    describe('POST /pair/accept', () => {
        test('drives /session/offer + first /pull end-to-end via real HTTP', async () => {
            // Seed A with content so the first pull has data to move.
            fs.writeFileSync(path.join(A.dirs.characters, 'one.png'), Buffer.from('\x89PNGdata'));

            // B starts the pairing (allocates a local peerId to register A under).
            const aStart = await request(A.app)
                .post('/api/sync/v1/pair/start')
                .send({ label: 'B-from-A', categories: ['characters'] });
            expect(aStart.status).toBe(200);

            // B issues the accept against A. /pair/accept on B's server
            // does the outbound fetch to A's /session/offer, then runs
            // runPull. We assert the success shape returned by runPull.
            const accept = await request(B.app)
                .post('/api/sync/v1/pair/accept')
                .send({
                    peerBaseUrl: aListener.baseUrl,
                    remotePeerId: aStart.body.peerId,
                    label: 'A',
                    categories: ['characters'],
                });
            expect(accept.status).toBe(200);
            expect(accept.body.ok).toBe(true);
            expect(accept.body.fastForward).toBe(true);
            expect(accept.body.peerId).toBe(aStart.body.peerId);
            expect(accept.body.label).toBe('A');

            // A's seeded character must now exist on B (reconcile moved it
            // from shadow → live). This is the load-bearing assertion:
            // /pair/accept must actually land the data, not just succeed.
            expect(fs.existsSync(path.join(B.dirs.characters, 'one.png'))).toBe(true);

            // The peer is registered on B for future syncs.
            const bPeers = await request(B.app).get('/api/sync/v1/peers');
            expect(bPeers.body.peers[aStart.body.peerId]).toBeTruthy();
        });

        test('reports 400 on missing peerBaseUrl or remotePeerId', async () => {
            const res = await request(B.app)
                .post('/api/sync/v1/pair/accept')
                .send({ label: 'A', categories: ['chats'] });
            expect(res.status).toBe(400);
        });

        test('reports 400 on unsafe remotePeerId', async () => {
            const res = await request(B.app)
                .post('/api/sync/v1/pair/accept')
                .send({
                    peerBaseUrl: aListener.baseUrl,
                    remotePeerId: '../escape',
                    label: 'A',
                    categories: ['chats'],
                });
            expect(res.status).toBe(400);
        });

        test('reports 502 when peer is unreachable', async () => {
            // Close A's listener so the outbound fetch from B fails.
            await aListener.close();
            aListener = null;

            const res = await request(B.app)
                .post('/api/sync/v1/pair/accept')
                .send({
                    peerBaseUrl: 'http://127.0.0.1:1',  // refused — TCP/1 is reserved
                    remotePeerId: `${B.handle}@deadbeef`,
                    label: 'A',
                    categories: ['chats'],
                });
            expect(res.status).toBe(502);
            expect(res.body.stage).toBe('offer');
        });

        test('forwards resolutions to runPull when caller provides them', async () => {
            // Seed both sides with a divergent file in the worlds category
            // so the first /pair/accept returns conflicts (no common
            // ancestor: both shadows commit independently before pairing).
            fs.mkdirSync(path.join(A.dirs.worlds), { recursive: true });
            fs.mkdirSync(path.join(B.dirs.worlds), { recursive: true });
            fs.writeFileSync(path.join(A.dirs.worlds, 'collide.json'), JSON.stringify({ side: 'A' }));
            fs.writeFileSync(path.join(B.dirs.worlds, 'collide.json'), JSON.stringify({ side: 'B' }));

            const aStart = await request(A.app)
                .post('/api/sync/v1/pair/start')
                .send({ label: 'B', categories: ['worlds'] });
            const remotePeerId = aStart.body.peerId;

            // First call: no resolutions, conflicts returned.
            const firstAccept = await request(B.app)
                .post('/api/sync/v1/pair/accept')
                .send({
                    peerBaseUrl: aListener.baseUrl,
                    remotePeerId,
                    label: 'A',
                    categories: ['worlds'],
                });
            expect(firstAccept.status).toBe(200);
            expect(firstAccept.body.ok).toBe(false);
            expect(firstAccept.body.conflicts.length).toBe(1);
            expect(firstAccept.body.conflicts[0].filepath).toBe('worlds/collide.json');

            // Second call: provide resolutions picking A's version. The
            // bug this test pins: before the fix, /pair/accept silently
            // dropped the resolutions field and returned the SAME
            // conflict shape. The fix forwards resolutions to runPull
            // which routes through applyResolutions.
            const secondAccept = await request(B.app)
                .post('/api/sync/v1/pair/accept')
                .send({
                    peerBaseUrl: aListener.baseUrl,
                    remotePeerId,
                    label: 'A',
                    categories: ['worlds'],
                    resolutions: { 'worlds/collide.json': 'theirs' },
                });
            expect(secondAccept.status).toBe(200);
            expect(secondAccept.body.ok).toBe(true);

            // B's live file is now A's content — the resolution was honored.
            const onB = JSON.parse(fs.readFileSync(path.join(B.dirs.worlds, 'collide.json'), 'utf8'));
            expect(onB.side).toBe('A');
        });
    });

    describe('POST /peers/:peerId/sync', () => {
        test('uses the recorded peerBaseUrl to re-sync without prompting the user', async () => {
            // Seed A with content, then pair B → A so B's registry has
            // peerBaseUrl recorded. After pairing, edit A again and
            // verify /peers/:peerId/sync (called on B) pulls the new
            // content using the stored URL, without the test passing
            // peerBaseUrl in the request body.
            fs.writeFileSync(path.join(A.dirs.characters, 'first.png'), Buffer.from('\x89PNGdata1'));

            const aStart = await request(A.app)
                .post('/api/sync/v1/pair/start')
                .send({ label: 'B', categories: ['characters'] });
            const remotePeerId = aStart.body.peerId;

            const accept = await request(B.app)
                .post('/api/sync/v1/pair/accept')
                .send({
                    peerBaseUrl: aListener.baseUrl,
                    remotePeerId,
                    label: 'A',
                    categories: ['characters'],
                });
            expect(accept.status).toBe(200);
            expect(accept.body.ok).toBe(true);

            // Confirm B's registry now has peerBaseUrl.
            const peers = await request(B.app).get('/api/sync/v1/peers');
            expect(peers.body.peers[remotePeerId].peerBaseUrl).toBe(aListener.baseUrl);

            // Edit A again — add another file.
            fs.writeFileSync(path.join(A.dirs.characters, 'second.png'), Buffer.from('\x89PNGdata2'));

            // Call /peers/:peerId/sync on B with NO peerBaseUrl in body.
            const syncRes = await request(B.app)
                .post(`/api/sync/v1/peers/${remotePeerId}/sync`)
                .send({});
            expect(syncRes.status).toBe(200);
            expect(syncRes.body.ok).toBe(true);

            // The new file landed on B.
            expect(fs.existsSync(path.join(B.dirs.characters, 'second.png'))).toBe(true);
        });

        test('returns 404 for an unknown peer', async () => {
            const res = await request(B.app)
                .post('/api/sync/v1/peers/never@paired/sync')
                .send({});
            expect(res.status).toBe(404);
        });

        test('returns 412 NO_BASE_URL when the registry entry lacks peerBaseUrl', async () => {
            // Create a peer entry the old way (no peerBaseUrl) via the
            // label endpoint — simulates legacy state from before the
            // peerBaseUrl column was added.
            await recordPeer({
                userRoot: B.dirs.root,
                peerId: 'legacy@deadbeef',
                label: 'Legacy',
                categories: ['chats'],
            });
            const res = await request(B.app)
                .post('/api/sync/v1/peers/legacy@deadbeef/sync')
                .send({});
            expect(res.status).toBe(412);
            expect(res.body.code).toBe('NO_BASE_URL');
        });
    });

    describe('peer wire failure modes (/pull)', () => {
        // Coverage for the low-probability, high-impact peer transport
        // scenarios that the happy-path integration suites do not exercise:
        //   - peer accepts the TCP connection but never writes a response
        //     body (Wi-Fi drop mid-request) → orchestrator's peerFetch
        //     catches the AbortError and re-codes it as PEER_TIMEOUT, which
        //     /pull maps to 504.
        //   - peer writes a 200 OK with Content-Length but destroys the
        //     socket after sending only part of the body → orchestrator's
        //     `r.json()` / `r.arrayBuffer()` throw on the truncated body,
        //     which /pull surfaces as a generic 500 (the wrapper only
        //     special-cases PEER_TIMEOUT and PEER_REF_CHANGED).

        test('reports 504 PEER_TIMEOUT when the orchestrator fetch aborts', async () => {
            // Drive a real /pull. The offer step is fulfilled by a real
            // call on A's app so the test exercises the /pull happy path
            // up to the first peerFetch inside runPull. That peerFetch is
            // then intercepted via `jest.spyOn(global, 'fetch')` to throw
            // a synthetic AbortError — the OS-level signal we cannot
            // produce deterministically inside a unit test without
            // waiting the real 30s PEER_FETCH_TIMEOUT_MS or threading a
            // fake-clock through node:internal. The catch branch under
            // test is real product code (src/sync/orchestrator.js
            // peerFetch), and the endpoint mapping (504 with stage 'pull')
            // is real product code in src/endpoints/sync.js. The mock
            // simulates only the input to peerFetch's catch.
            const peerId = 'u@deadbeef';
            const offer = await request(A.app)
                .post('/api/sync/v1/session/offer')
                .send({ peerId, label: 'A', categories: ['chats'] });
            expect(offer.status).toBe(200);

            const realFetch = global.fetch;
            const spy = jest.spyOn(global, 'fetch').mockImplementationOnce(async () => {
                // Mirror the shape `AbortSignal.timeout` produces. The
                // peerFetch catch matches `name === 'AbortError'` OR
                // `name === 'TimeoutError'` — we pick AbortError here to
                // exercise the path Node's current undici-backed fetch
                // surfaces. The TimeoutError name is also covered by the
                // ` || ` in peerFetch's check so a future undici update
                // doesn't silently degrade us to a 500.
                const err = new Error('synthetic abort for test');
                err.name = 'AbortError';
                throw err;
            });
            try {
                const pull = await request(B.app)
                    .post('/api/sync/v1/pull')
                    .send({
                        peerId,
                        peerLabel: 'A',
                        peerBaseUrl: aListener.baseUrl,
                        offerToken: offer.body.token,
                        categories: ['chats'],
                    });
                expect(pull.status).toBe(504);
                expect(pull.body.error).toMatch(/timed out/i);
            } finally {
                spy.mockRestore();
                // Belt and suspenders — confirm restoration so a leak
                // would surface obviously in the next test instead of
                // mysteriously timing out.
                expect(global.fetch).toBe(realFetch);
            }
        });

        test('reports 500 when peer truncates the response body mid-stream', async () => {
            // Real http.Server registered to handle exactly the manifest
            // route, returns 200 OK with a Content-Length that promises
            // more bytes than it writes, then destroys the socket. The
            // orchestrator's `r.json()` call inside fetchRemoteManifestHead
            // throws on the truncated body — the catch in /pull does NOT
            // recognize this as PEER_TIMEOUT, so it falls through to the
            // generic 500 branch. Pins the actual behavior rather than
            // an aspirational design.
            const truncatingServer = http.createServer((req, res) => {
                if (req.url === '/api/sync/v1/session/manifest') {
                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'Content-Length': '500',
                    });
                    res.write('{"head');
                    // Force-close the underlying socket so the client sees
                    // an ECONNRESET / premature-close before the promised
                    // body completes. `res.end()` would write a clean tail
                    // and the client could still parse — destroy is what
                    // produces the genuine truncation case.
                    res.socket.destroy();
                    return;
                }
                res.writeHead(404).end();
            });
            await new Promise(resolve => truncatingServer.listen(0, '127.0.0.1', resolve));
            const truncatingBaseUrl = `http://127.0.0.1:${truncatingServer.address().port}`;
            try {
                const pull = await request(B.app)
                    .post('/api/sync/v1/pull')
                    .send({
                        peerId: 'u@feedface',
                        peerLabel: 'A',
                        peerBaseUrl: truncatingBaseUrl,
                        offerToken: 'unused-the-manifest-fails-first',
                        categories: ['chats'],
                    });
                // 500 because peerFetch returned a Response object (no
                // throw at the fetch boundary), and then `r.json()` on
                // the truncated body threw a regular Error whose name is
                // not Abort/Timeout — so it bypasses both the
                // PEER_TIMEOUT and PEER_REF_CHANGED branches in /pull.
                expect(pull.status).toBe(500);
                expect(typeof pull.body.error).toBe('string');
            } finally {
                await new Promise(resolve => truncatingServer.close(resolve));
            }
        });
    });
});
