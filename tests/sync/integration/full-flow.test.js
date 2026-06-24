/**
 * Plan Task 13 — end-to-end sync flow across two real Luker server
 * instances.
 *
 * Two `makeEndpointHarness` instances (A and B) each get their own
 * temp data root and Express app, but stand up on real `http.Server`
 * listeners on random ports so the orchestrator's `fetch()` actually
 * makes real HTTP requests between them. supertest is still used for
 * the user-facing routes (`/session/offer`, `/pull`) — it drives the
 * app under test directly without needing a port for THAT side.
 *
 * The peer-side routes the orchestrator hits (`/session/manifest`,
 * `/session/object/:oid`, `/session/object`, `/session/ref`) MUST go
 * through a real listener: `fetch(peerBaseUrl + '/...')` is a real
 * outbound request that wouldn't resolve to supertest's in-process
 * dispatcher.
 *
 * Module-level note: `src/storage/index.js`'s `_engine` is process-
 * global. Two `makeEndpointHarness` calls in the same test serialize
 * `initStorage`, so by the time either request lands `_engine` is the
 * second harness's instance. That's fine for fs mode — `/pull` only
 * consults `getStorageEngine().kind`, and sync I/O reads directly
 * from `request.user.directories.root` (per-harness, injected by the
 * harness's middleware) rather than going through any engine.
 *
 * Session tokens live in the `session.js` module-level Cache, which is
 * also shared, but each session payload carries its own bound `userRoot`
 * — so a token issued by A.app correctly points the responder side at
 * A's shadow, not B's.
 *
 * The conflict round-trip (third test) exercises the two-step shape of
 * `/pull` when both sides edited the same file: first call returns
 * `{ ok: false, conflicts: [...] }` with the shadow left in
 * merge-in-progress; the second call passes `resolutions` and finalizes.
 * Session tokens are multi-use within the TTL, so the same offer token
 * carries both pulls — no fresh offer between them.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../../storage/harness/endpoint-harness.js';
import { router as syncRouter } from '../../../src/endpoints/sync.js';

const FS_HARNESSES = ENDPOINT_HARNESSES.filter(h => h.mode === 'fs');

/**
 * Wrap an Express app in a real `http.Server` listening on a random
 * loopback port. Returned `baseUrl` is the value to pass to `runPull`
 * as `peerBaseUrl` — concrete enough that the orchestrator's `fetch`
 * resolves DNS (`127.0.0.1` is in the OS hosts file on every supported
 * platform) and binds to whatever ephemeral port the kernel hands us.
 *
 * Closing is `await server.close(...)`-style: the helper returns a
 * `close()` function the test's `afterEach` awaits. `server.close`
 * waits for in-flight connections to drain, which is what we want
 * between tests — otherwise a not-yet-released socket can interleave
 * with the next test's listener.
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

describe.each(FS_HARNESSES)('end-to-end sync flow on $name', ({ mode }) => {
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
        // Close listeners BEFORE harness cleanup so any still-draining
        // connection doesn't touch the about-to-be-rm'd data root.
        if (aListener) await aListener.close();
        if (bListener) await bListener.close();
        if (A) await A.cleanup();
        if (B) await B.cleanup();
    });

    test('pairing: empty B receives full snapshot from A', async () => {
        // Seed A with one character and one chat. The harness already
        // pre-created `characters/` and `chats/`, so we only need to drop
        // files in. Binary content (the leading 0x89PNG byte sequence)
        // exercises the wire format for non-text blobs.
        fs.writeFileSync(
            path.join(A.dirs.characters, 'one.png'),
            Buffer.from('\x89PNGdata'),
        );
        fs.mkdirSync(path.join(A.dirs.chats, 'one'), { recursive: true });
        fs.writeFileSync(
            path.join(A.dirs.chats, 'one', 'c.jsonl'),
            '{"name":"u","mes":"hi"}',
        );

        // A issues an offer. Per spec §4.1 the peerId names the LINK
        // between A and B and is shared by both sides — A stores its
        // shadow at `<userRoot>/.sync/<peerId>/`, B stores its mirror
        // shadow at the same path under B's userRoot. The test reuses
        // one canonical id for that reason.
        const PEER_ID = 'u@a1b2c3d4';
        const offer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'B',
                categories: ['characters', 'chats'],
            });
        expect(offer.status).toBe(200);

        // B pulls from A. The `peerBaseUrl` points at A's real
        // listener so the orchestrator's `fetch` resolves a real
        // network round trip to A's app.
        const pull = await request(B.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: offer.body.token,
                categories: ['characters', 'chats'],
            });
        expect(pull.status).toBe(200);
        expect(pull.body.ok).toBe(true);
        // No prior `main` on B → fastForward path.
        expect(pull.body.fastForward).toBe(true);
        // mergeOid is the commit oid B's shadow now points at — A's
        // post-snapshot HEAD, since B started empty and took A's
        // history wholesale.
        expect(pull.body.mergeOid).toMatch(/^[a-f0-9]{40}$/);

        // B's live tree should mirror A's after reconcile.
        expect(fs.existsSync(path.join(B.dirs.characters, 'one.png'))).toBe(true);
        expect(fs.readFileSync(path.join(B.dirs.characters, 'one.png'))).toEqual(
            Buffer.from('\x89PNGdata'),
        );
        expect(fs.existsSync(path.join(B.dirs.chats, 'one', 'c.jsonl'))).toBe(true);
        expect(
            fs.readFileSync(path.join(B.dirs.chats, 'one', 'c.jsonl'), 'utf8'),
        ).toBe('{"name":"u","mes":"hi"}');
    });

    test('normal sync: disjoint edits each side become visible after one round-trip', async () => {
        // Pair first — same shape as the pairing test, but kept inline
        // because each `beforeEach` rebuilds the harnesses, so the
        // earlier test's state does not survive into this one.
        const PEER_ID = 'u@a1b2c3d4';
        fs.writeFileSync(
            path.join(A.dirs.characters, 'shared.png'),
            Buffer.from('SHARED'),
        );
        const pairOffer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'B',
                categories: ['characters', 'chats', 'worlds'],
            });
        expect(pairOffer.status).toBe(200);
        const pair = await request(B.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: pairOffer.body.token,
                categories: ['characters', 'chats', 'worlds'],
            });
        expect(pair.status).toBe(200);
        expect(pair.body.ok).toBe(true);

        // Now both sides have `shared.png` and their shadow main points
        // at the same commit. Make disjoint edits on each side.
        fs.writeFileSync(
            path.join(A.dirs.characters, 'a-only.png'),
            Buffer.from('A_ONLY'),
        );
        fs.writeFileSync(
            path.join(B.dirs.worlds, 'b-only.json'),
            '{"entries":{}}',
        );

        // Second pull: A advertises an offer, B pulls. The orchestrator
        // snapshots B's local edit first, fetches A's missing objects,
        // attempts merge — which should be a clean auto-merge since the
        // two edits are in disjoint files — then reconciles back into
        // B's live tree and pushes the merged HEAD to A.
        const offer2 = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'B',
                categories: ['characters', 'chats', 'worlds'],
            });
        expect(offer2.status).toBe(200);
        const pull2 = await request(B.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: offer2.body.token,
                categories: ['characters', 'chats', 'worlds'],
            });
        expect(pull2.status).toBe(200);
        expect(pull2.body.ok).toBe(true);
        // Not a fast-forward this time — both sides had local commits
        // post-pair, so the merge is a real two-parent commit.
        expect(pull2.body.fastForward).toBeUndefined();

        // Both files should now exist on B's side; on A's side too,
        // because the responder-side reconcile in `/session/ref`
        // (spec §4.2: responder does steps 1-4 ... and 10) writes the
        // merged tree back into live as soon as the puller's push
        // lands. So a single pull from B is enough to land b-only.json
        // in both replicas' live trees.
        expect(fs.existsSync(path.join(B.dirs.characters, 'a-only.png'))).toBe(true);
        expect(fs.existsSync(path.join(B.dirs.worlds, 'b-only.json'))).toBe(true);
        expect(fs.existsSync(path.join(B.dirs.characters, 'shared.png'))).toBe(true);
        expect(fs.existsSync(path.join(A.dirs.characters, 'a-only.png'))).toBe(true);
        expect(fs.existsSync(path.join(A.dirs.worlds, 'b-only.json'))).toBe(true);
        expect(fs.existsSync(path.join(A.dirs.characters, 'shared.png'))).toBe(true);

        // Reciprocal pull is now a no-op (both sides are at the same
        // commit), but exercising it locks in the "already-in-sync"
        // path: snapshot finds no diff, peerHead matches localMain,
        // merge is alreadyMerged. No assertion change — we just need
        // it to return 200 cleanly.
        const offer3 = await request(B.app)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'A',
                categories: ['characters', 'chats', 'worlds'],
            });
        expect(offer3.status).toBe(200);
        const pull3 = await request(A.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'B',
                peerBaseUrl: bListener.baseUrl,
                offerToken: offer3.body.token,
                categories: ['characters', 'chats', 'worlds'],
            });
        expect(pull3.status).toBe(200);
        expect(pull3.body.ok).toBe(true);

        // After the reciprocal pull the assertions above still hold —
        // verify nothing got dropped.
        expect(fs.existsSync(path.join(A.dirs.worlds, 'b-only.json'))).toBe(true);
        expect(fs.existsSync(path.join(A.dirs.characters, 'a-only.png'))).toBe(true);
        expect(fs.existsSync(path.join(A.dirs.characters, 'shared.png'))).toBe(true);
    });

    test('conflict: same file edited on both sides → conflicts returned, then resolution succeeds', async () => {
        // Pair first so both sides share a common base commit for the
        // conflicting file. Without that base, `bothModified` wouldn't
        // be the merge classification — isomorphic-git would diagnose
        // a different state and the conflict shape would differ.
        const PEER_ID = 'u@a1b2c3d4';
        fs.writeFileSync(
            path.join(A.dirs.characters, 'shared.png'),
            Buffer.from('BASE_VERSION'),
        );
        let offer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: PEER_ID, label: 'B', categories: ['characters'] });
        expect(offer.status).toBe(200);
        let pull = await request(B.app)
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
        expect(fs.existsSync(path.join(B.dirs.characters, 'shared.png'))).toBe(true);

        // Now both sides diverge on the same file. Distinct content on
        // each replica is what tells isomorphic-git "both modified"
        // when the third pull runs.
        fs.writeFileSync(
            path.join(A.dirs.characters, 'shared.png'),
            Buffer.from('A_VERSION'),
        );
        fs.writeFileSync(
            path.join(B.dirs.characters, 'shared.png'),
            Buffer.from('B_VERSION'),
        );

        // A advertises a fresh offer that snapshots A's new edit into
        // A's shadow. The puller (B) will then pick up `A_VERSION` from
        // the wire, snapshot its own `B_VERSION` locally, and fall into
        // the merge step.
        offer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: PEER_ID, label: 'B', categories: ['characters'] });
        expect(offer.status).toBe(200);

        // First conflicted pull: no resolutions supplied → orchestrator
        // returns the conflict set so the caller can show a picker.
        pull = await request(B.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: offer.body.token,
                categories: ['characters'],
            });
        expect(pull.status).toBe(200);
        expect(pull.body.ok).toBe(false);
        expect(pull.body.conflicts).toEqual([
            expect.objectContaining({
                filepath: 'characters/shared.png',
                kind: 'bothModified',
                oursOid: expect.any(String),
                theirsOid: expect.any(String),
            }),
        ]);

        // No merge committed yet, so B's live file still has B_VERSION
        // and A's still has A_VERSION — neither side has been touched
        // by the conflict-only response.
        expect(fs.readFileSync(path.join(B.dirs.characters, 'shared.png'))).toEqual(
            Buffer.from('B_VERSION'),
        );
        expect(fs.readFileSync(path.join(A.dirs.characters, 'shared.png'))).toEqual(
            Buffer.from('A_VERSION'),
        );

        // Second pull with the user's pick. Token is multi-use within
        // the SYNC_SESSION_TTL_MS window (see `src/sync/session.js`), so
        // we reuse the same offer token rather than asking A for a
        // fresh one — that matches the production UX where the picker
        // dialog turns around faster than the TTL expires.
        pull = await request(B.app)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: offer.body.token,
                categories: ['characters'],
                resolutions: { 'characters/shared.png': 'ours' },
            });
        expect(pull.status).toBe(200);
        expect(pull.body.ok).toBe(true);
        expect(pull.body.mergeOid).toMatch(/^[a-f0-9]{40}$/);

        // 'ours' from B's perspective is B_VERSION, so after the merge
        // both sides should agree on B_VERSION — A picks it up via the
        // responder reconcile on `/session/ref` (spec §4.2 step 10).
        expect(fs.readFileSync(path.join(B.dirs.characters, 'shared.png'))).toEqual(
            Buffer.from('B_VERSION'),
        );
        expect(fs.readFileSync(path.join(A.dirs.characters, 'shared.png'))).toEqual(
            Buffer.from('B_VERSION'),
        );
    });
});
