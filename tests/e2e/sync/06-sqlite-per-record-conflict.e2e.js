// SQLite-mode LAN Sync e2e — per-record conflict on a single chat.
//
// The orchestrator no longer ships a whole-DB blob in SQLite mode (the
// `database` category was retired). Instead each side projects its rows
// into a shadow workdir as files (chats → .jsonl, worlds → .json, ...),
// commits that tree to the shadow git repo, and the receiver
// dematerializes the merged tree back through the storage engine. This
// spec covers the SQLite leg of that path end-to-end: same chat path on
// both sides with different bytes must surface as a single per-file
// conflict at the file boundary, and applying A's side must land A's
// chat body in B's SQLite DB through the real /api/chats/get route.
//
// The companion in-process test at
// `tests/sync/integration/sqlite-mode.test.js` pins the engine contract
// (rows land under the responder's handle); this spec proves the user-
// visible flow — admin migration UI, conflict panel, chat fetch — all
// honor the per-record path on a real Playwright browser pair.

import { test, expect } from '@playwright/test';

import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { migrateViaAdminUI, fetchStorageStatus, closeAdminPanel } from '../_lib/storage-ui.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    resolveAllConflictsAs,
    listConflictFilepaths,
    listConflictKinds,
} from '../_lib/sync.js';

let A, B;

const CARD_NAME = 'default_Seraphina';
const CHAT_FILE = '2026-06-25 diverged conflict';
const CHAT_REL_PATH = `chats/${CARD_NAME}/${CHAT_FILE}.jsonl`;

// Distinct chat bodies on each side. Both sides write to the SAME
// avatar_url + file_name pair, so after pairing the materializer
// projects both into the same workdir path with divergent bytes — the
// merge attempt falls back to MergeNotSupportedError and the file
// surfaces as a single bothModified conflict.
const A_CHAT_BODY = [
    {
        name: 'Captain',
        is_user: true,
        send_date: '2026-06-25',
        mes: 'Seraphina, the salt-mark drifters are sighting fires three coves north. What do the charts say about the tide window before dawn?',
    },
    {
        name: 'Seraphina',
        is_user: false,
        send_date: '2026-06-25',
        mes: '*She unrolls the brittle reef chart with one hand, weighting the corner with her brass spyglass.* "Three hours, no more. The slow swallow runs after that and no skiff crosses the gull rocks until next moon."',
    },
];
const B_CHAT_BODY = [
    {
        name: 'Captain',
        is_user: true,
        send_date: '2026-06-25',
        mes: 'Seraphina, the lantern on the north breaker has gone dark. Should we signal the relief crew or wait out the tide?',
    },
    {
        name: 'Seraphina',
        is_user: false,
        send_date: '2026-06-25',
        mes: '*Her jaw tightens; she lays a finger across the chart\'s margin.* "Wait. A dark lantern is a message, not an accident. Light our own and they will read us before we read them."',
    },
];

/**
 * Save a chat at chats/<CARD_NAME>/<CHAT_FILE>.jsonl through the real
 * /api/chats/save endpoint as the page's session sees it. Returns the
 * integrity token the repo assigned.
 *
 * `force: true` skips integrity comparison — both sides write a fresh
 * file, neither side knows the other's integrity.
 */
async function saveDivergedChat(page, body) {
    return page.evaluate(async ({ cardName, fileName, body }) => {
        const mod = await import('/script.js').catch(() => null);
        const headers = (typeof mod?.getRequestHeaders === 'function')
            ? mod.getRequestHeaders()
            : { 'Content-Type': 'application/json' };
        const header = {
            user_name: 'Captain',
            character_name: 'Seraphina',
            create_date: '2026-06-25 12:00:00',
            chat_metadata: {},
        };
        const res = await fetch('/api/chats/save', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                avatar_url: `${cardName}.png`,
                file_name: fileName,
                chat: [header, ...body],
                force: true,
            }),
        });
        if (!res.ok) throw new Error(`/api/chats/save failed: ${res.status} ${await res.text()}`);
        return res.json();
    }, { cardName: CARD_NAME, fileName: CHAT_FILE, body });
}

/**
 * Read the chat at chats/<CARD_NAME>/<CHAT_FILE>.jsonl through the real
 * /api/chats/get endpoint. Returns the parsed message-array response.
 */
async function fetchDivergedChat(page) {
    return page.evaluate(async ({ cardName, fileName }) => {
        const mod = await import('/script.js').catch(() => null);
        const headers = (typeof mod?.getRequestHeaders === 'function')
            ? mod.getRequestHeaders()
            : { 'Content-Type': 'application/json' };
        const res = await fetch('/api/chats/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                avatar_url: `${cardName}.png`,
                file_name: fileName,
            }),
        });
        if (!res.ok) throw new Error(`/api/chats/get failed: ${res.status} ${await res.text()}`);
        return res.json();
    }, { cardName: CARD_NAME, fileName: CHAT_FILE });
}

test.beforeAll(async () => {
    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'sqlite-A',
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'sqlite-B',
    });
    markOnboarded({ dataRoot: A.dataRoot });
    markOnboarded({ dataRoot: B.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — SQLite per-record chat conflict', () => {
    test('same chat path with different bytes surfaces one per-file conflict; resolving theirs lands A\'s body in B\'s DB', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // Migrate both sides fs → sqlite through the real admin UI.
        // After this returns, every storage call on either server
        // routes through SqliteEngine.
        await migrateViaAdminUI(pageA, 'sqlite');
        expect((await fetchStorageStatus(pageA)).currentMode).toBe('sqlite');
        await closeAdminPanel(pageA);

        await migrateViaAdminUI(pageB, 'sqlite');
        expect((await fetchStorageStatus(pageB)).currentMode).toBe('sqlite');
        await closeAdminPanel(pageB);

        // Seed each side with a chat at the same path but with
        // different message bodies. Both writes go through
        // /api/chats/save → ChatRepo.save → SqliteEngine.putResource,
        // so the rows land in each side's SQLite DB.
        await saveDivergedChat(pageA, A_CHAT_BODY);
        await saveDivergedChat(pageB, B_CHAT_BODY);

        // Sanity: each side reads back ITS OWN body before the sync —
        // proves the writes actually diverged at the record level.
        const aPre = await fetchDivergedChat(pageA);
        expect(Array.isArray(aPre)).toBe(true);
        expect(aPre[1].mes).toBe(A_CHAT_BODY[0].mes);
        expect(aPre[2].mes).toBe(A_CHAT_BODY[1].mes);

        const bPre = await fetchDivergedChat(pageB);
        expect(Array.isArray(bPre)).toBe(true);
        expect(bPre[1].mes).toBe(B_CHAT_BODY[0].mes);
        expect(bPre[2].mes).toBe(B_CHAT_BODY[1].mes);

        // Pair with the chats category enabled. Worlds is left off so
        // the conflict list contains only the one chat — keeps the
        // assertion below tight on the per-record contract.
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, {
            label: 'B device',
            categories: ['chats'],
        });

        await openLanSyncPanel(pageB);
        const acceptOutcome = await acceptPairingLink(pageB, link, {
            categories: ['chats'],
            localLabel: 'A device',
        });

        // First pair, no common ancestor, divergent bytes on the same
        // path: attemptMerge's MergeNotSupportedError fallback marks
        // every divergent file as bothModified. The conflict panel
        // must appear.
        expect(acceptOutcome).toBe('warning');

        // The load-bearing assertion: ONE per-file conflict at the
        // chat's POSIX rel path, kind=bothModified. If the engine had
        // regressed to a whole-DB swap, the path would read
        // `database/...` or similar instead of the per-record file.
        const filepaths = await listConflictFilepaths(pageB);
        expect(filepaths).toContain(CHAT_REL_PATH);

        const kinds = await listConflictKinds(pageB);
        expect(kinds[CHAT_REL_PATH]).toBe('bothModified');

        // Take A's version everywhere. Apply lands A's bytes in B's
        // workdir, dematerialize writes them through the engine into
        // B's SQLite DB under B's handle.
        const resolveOutcome = await resolveAllConflictsAs(pageB, 'theirs');
        expect(resolveOutcome).toBe('success');

        // B's chat repo now reports A's chat content under B's own
        // handle — the per-record sync's defining outcome. Read goes
        // through the real /api/chats/get → ChatRepo.get →
        // SqliteEngine.getResource path; if dematerialize had missed
        // the chat or written to the wrong handle, this would return
        // B's pre-sync body instead.
        const bPost = await fetchDivergedChat(pageB);
        expect(Array.isArray(bPost)).toBe(true);
        expect(bPost[1].mes).toBe(A_CHAT_BODY[0].mes);
        expect(bPost[2].mes).toBe(A_CHAT_BODY[1].mes);

        await ctxA.close();
        await ctxB.close();
    });
});
