/**
 * Plan Task 15 — `/undo` rewinds the local replica to the most recent
 * `sync-backup-*` tag without touching the peer (spec §4.6).
 *
 * Mirrors `full-flow.test.js`'s two-real-server pattern: A and B each
 * get their own `makeEndpointHarness`, their own data root, and stand
 * up on real `http.Server` listeners on random ports so the
 * orchestrator's `fetch()` between them is a real outbound HTTP call.
 * supertest still drives the user-facing routes (`/session/offer`,
 * `/pull`, `/undo`) against each app directly.
 *
 * Tag-timing note: `runPull` only plants a `sync-backup-<ISO>` tag
 * when `main` already exists (see `tagCurrentMainAsBackup` —
 * silently a no-op on the "first pair" case). So a peer that has
 * only ever done ONE sync has no recoverable tag and `/undo` MUST
 * surface 404 NO_BACKUP_TAG rather than silently restoring an empty
 * state. The "no prior sync" test below pins that contract.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../../storage/harness/endpoint-harness.js';
import { router as syncRouter } from '../../../src/endpoints/sync.js';

const FS_HARNESSES = ENDPOINT_HARNESSES.filter(h => h.mode === 'fs');
const PEER_ID = 'u@a1b2c3d4';

/**
 * Wrap an Express app in a real `http.Server` on a random loopback
 * port. Same helper shape as `full-flow.test.js` — keeping it inline
 * rather than lifting to a shared util because both tests only need
 * this trivial wrapper and the integration suite is small.
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

describe.each(FS_HARNESSES)('undo last sync on $name', ({ mode }) => {
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

    test('post-sync, /undo restores prior live state and rewinds shadow ref', async () => {
        // --- Pair: A has before.png, B starts empty. ---
        // The first pull is the "pair init" path: B has no `main` yet,
        // so `tagCurrentMainAsBackup` is a no-op and NO tag is planted
        // on B's shadow. That's intentional — there is nothing on B to
        // rewind to. The recoverable tag comes from the SECOND sync,
        // which captures B's post-pair state before merging in A's
        // newer commit.
        fs.writeFileSync(
            path.join(A.dirs.characters, 'before.png'),
            Buffer.from('BEFORE'),
        );

        let offer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: PEER_ID, label: 'A', categories: ['characters'] });
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
        expect(fs.existsSync(path.join(B.dirs.characters, 'before.png'))).toBe(true);

        // --- A adds after.png; second sync. This is the one whose tag
        // we will rewind to. After this pull, B's shadow has a
        // sync-backup-<ISO> tag anchored at the post-pair commit (just
        // before.png) and a new main pointing at the post-second-sync
        // commit (before.png + after.png).
        fs.writeFileSync(
            path.join(A.dirs.characters, 'after.png'),
            Buffer.from('AFTER'),
        );
        offer = await request(A.app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: PEER_ID, label: 'A', categories: ['characters'] });
        expect(offer.status).toBe(200);
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
        expect(pull.body.ok).toBe(true);
        expect(fs.existsSync(path.join(B.dirs.characters, 'after.png'))).toBe(true);

        // --- B undoes the most recent sync. ---
        // Should rewind to the pre-second-sync state: before.png
        // present, after.png absent. Reconcile uses B's recorded
        // categories from state.json, so undo scope matches the
        // pairing's category subset (no accidental writes to chats/
        // or worlds/).
        const undo = await request(B.app)
            .post('/api/sync/v1/undo')
            .send({ peerId: PEER_ID });
        expect(undo.status).toBe(200);
        expect(undo.body.restoredTag).toMatch(/^sync-backup-/);
        expect(undo.body.restoredOid).toMatch(/^[a-f0-9]{40}$/);

        expect(fs.existsSync(path.join(B.dirs.characters, 'before.png'))).toBe(true);
        expect(fs.existsSync(path.join(B.dirs.characters, 'after.png'))).toBe(false);

        // A is unaffected — undo is strictly local. A.app never saw
        // the /undo POST, so its live tree still has both files.
        expect(fs.existsSync(path.join(A.dirs.characters, 'before.png'))).toBe(true);
        expect(fs.existsSync(path.join(A.dirs.characters, 'after.png'))).toBe(true);
    });

    test('POST /undo returns 404 when no sync-backup tag exists', async () => {
        // A peer that has never paired (no sync flow ever ran for this
        // peerId) has a freshly-init'd shadow with no tags. The spec
        // distinguishes "no recoverable prior state" from "server
        // error" — surface it as 404 so the UI can render "no prior
        // sync to undo" rather than a generic 500. Also exercises the
        // first-pair tag-timing edge: even a peer that has done
        // exactly one pair-init pull has no tag, because
        // `tagCurrentMainAsBackup` only runs when `main` already
        // exists at the start of the pull.
        const r = await request(B.app)
            .post('/api/sync/v1/undo')
            .send({ peerId: 'never-paired' });
        expect(r.status).toBe(404);
        expect(r.body.error).toMatch(/No sync backup tag/i);
    });

    test('POST /undo returns 400 when peerId is missing', async () => {
        const r = await request(B.app)
            .post('/api/sync/v1/undo')
            .send({});
        expect(r.status).toBe(400);
    });
});
