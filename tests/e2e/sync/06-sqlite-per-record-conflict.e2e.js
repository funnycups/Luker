// SQLite-mode LAN Sync e2e — the same chat edited on both devices.
//
// Each side projects its SQLite rows into a shadow workdir as files
// (chats → .jsonl, worlds → .json, ...), commits that tree to the shadow
// git repo, and dematerializes the merged tree back through the storage
// engine. Same chat path on both sides with different bytes forks: the
// merge keeps one version under the chat's name and writes the other as
// a branch chat, which the Sync issues page announces with a notice. The
// branch chat must then be listed by the real /api/characters/chats
// route of B's SQLite engine.
//
// The companion in-process test at
// `tests/sync/integration/sqlite-mode.test.js` pins the engine contract
// (rows land under the device's handle); this e2e proves the user-
// visible flow — admin migration UI, Sync issues page, chat list — on a real
// Playwright browser pair.

import os from 'node:os';

import { test, expect } from '@playwright/test';
import sanitize from 'sanitize-filename';

import { normalizeDeviceLabel } from '../../../src/sync/device-label.js';
import { SIDECAR_INFIX } from '../../../src/storage/engines/sidecar-naming.js';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, selectCharacterByName, openOptionsAndClick } from '../_lib/page.js';
import { migrateViaAdminUI, fetchStorageStatus, closeAdminPanel } from '../_lib/storage-ui.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    waitForSyncPopup,
    listPopupNotices,
    closeSyncPopup,
    waitForBackgroundSync,
} from '../_lib/sync.js';

let A, B;

const CARD_NAME = 'default_Seraphina';
const CHAT_FILE = '2026-06-25 diverged conflict';

// The label both servers give themselves: with no device label set, a
// device uses its host name unless that is a localhost name.
const DEVICE_LABEL = normalizeDeviceLabel(os.hostname());
// The label part of a branch chat name, as `cleanNamePart` in
// src/sync/pipeline/chat-fork.js builds it.
const BRANCH_LABEL = sanitize(DEVICE_LABEL).replaceAll(SIDECAR_INFIX, ' ').trim();
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Chat file names of CARD_NAME through the real /api/characters/chats route. */
async function listChatNames(page) {
    const chats = await page.evaluate(async avatar => (await fetch('/api/characters/chats', { method: 'POST', headers: window.Luker.getContext().getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, simple: true }) })).json(), `${CARD_NAME}.png`);
    return Object.values(chats).map(c => c.file_name.replace(/\.jsonl$/, ''));
}
// Distinct chat bodies on each side. Both sides write to the SAME
// avatar_url + file_name pair, so after pairing the materializer
// projects both into the same workdir path with divergent bytes and the
// merge forks the chat.
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
 * Import an independently specified chat through the actual history form.
 */
async function saveDivergedChat(page, body) {
    await selectCharacterByName(page, 'Seraphina');
    const seedChat = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
    await openOptionsAndClick(page, 'option_select_chat');
    const imported = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chats/import' && response.request().method() === 'POST');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#chat_import_button').click();
    await (await chooser).setFiles({ name: `${CHAT_FILE}.jsonl`, mimeType: 'application/json', buffer: Buffer.from([
        { user_name: 'Captain', character_name: 'Seraphina', create_date: '2026-06-25 12:00:00', chat_metadata: {} }, ...body,
    ].map(value => JSON.stringify(value)).join('\n')) });
    const response = await imported;
    expect(response.ok()).toBe(true);
    const result = await response.json();
    expect(result.fileNames).toHaveLength(1);
    const originalName = result.fileNames[0].replace(/\.jsonl$/, '');
    const row = page.locator('.select_chat_block_wrapper').filter({ has: page.locator('.select_chat_block_filename', { hasText: originalName }) });
    await row.locator('.renameChatButton').click();
    const popup = page.locator('dialog.popup[open]').last();
    await popup.locator('.popup-input').fill(CHAT_FILE);
    const renamed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chats/rename' && response.request().method() === 'POST');
    await popup.locator('.popup-button-ok').click();
    expect((await renamed).ok()).toBe(true);
    await popup.waitFor({ state: 'detached' });
    await expect(page.locator('.select_chat_block_filename', { hasText: CHAT_FILE })).toHaveCount(1);
    // Opening the shipped chat saves device-local metadata. Remove that
    // fixture through its history action, leaving only the intended divergence.
    const seedRow = page.locator('.select_chat_block_wrapper').filter({ has: page.locator('.select_chat_block_filename', { hasText: seedChat }) });
    await seedRow.locator('.PastChat_cross').click();
    const confirm = page.locator('dialog.popup[open]').last();
    const deleted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chats/delete' && response.request().method() === 'POST');
    await confirm.locator('.popup-button-ok').click();
    expect((await deleted).ok()).toBe(true);
    await expect(page.locator('#select_chat_popup')).toBeVisible();
    await expect(seedRow).toHaveCount(0);
    await page.locator('#select_chat_cross').click();
}

/**
 * Read a chat of CARD_NAME through the real /api/chats/get endpoint.
 * Returns the parsed message-array response.
 */
async function fetchChat(page, fileName) {
    return page.evaluate(async ({ cardName, fileName }) => {
        const res = await fetch('/api/chats/get', {
            method: 'POST',
            headers: window.Luker.getContext().getRequestHeaders(),
            body: JSON.stringify({
                avatar_url: `${cardName}.png`,
                file_name: fileName,
            }),
        });
        if (!res.ok) throw new Error(`/api/chats/get failed: ${res.status} ${await res.text()}`);
        return res.json();
    }, { cardName: CARD_NAME, fileName });
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
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — SQLite per-record chat conflict', () => {
    test('the same chat edited on both sqlite devices keeps both versions, the other one as a branch chat', async ({ browser }) => {
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
        expect((await fetchChat(pageA, CHAT_FILE))[1].mes).toBe(A_CHAT_BODY[0].mes);
        expect((await fetchChat(pageB, CHAT_FILE))[1].mes).toBe(B_CHAT_BODY[0].mes);

        // Pair with the chats category enabled. Worlds is left off so
        // the Sync issues page holds only the one chat notice — keeps the
        // assertion below tight on the per-record contract.
        const pairedSince = Date.now();
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, {
            label: 'B device',
            categories: ['chats'],
        });

        await openLanSyncPanel(pageB);
        // A chat conflict never needs a decision: it forks, so the pair
        // answers success with no conflicts.
        expect(await acceptPairingLink(pageB, link, {
            categories: ['chats'],
            localLabel: 'A device',
        })).toBe('success');

        // The branch chat is named after the device whose version it
        // holds and the time of the newer commit. Both e2e servers run on
        // one host, so either way the label is the host name.
        expect(DEVICE_LABEL, 'a localhost host name makes the label fall back to the user name').not.toMatch(/^localhost(\.|$)/i);
        await waitForSyncPopup(pageB);
        const notices = await listPopupNotices(pageB);
        expect(notices).toHaveLength(1);
        const [notice] = notices;
        const branchPattern = new RegExp(`^chats/${escapeRegex(CARD_NAME)}/(${escapeRegex(CHAT_FILE)} - Sync conflict ${escapeRegex(BRANCH_LABEL)} \\d{4}-\\d{2}-\\d{2} \\d{2}\\.\\d{2})\\.jsonl$`);
        expect(notice.path).toMatch(branchPattern);
        const branchName = branchPattern.exec(notice.path)[1];
        await closeSyncPopup(pageB);

        // B's SQLite engine lists both chats through the real route.
        expect(await listChatNames(pageB)).toEqual(expect.arrayContaining([CHAT_FILE, branchName]));

        // One chat holds A's body and the other B's.
        const bodies = [(await fetchChat(pageB, CHAT_FILE))[1].mes, (await fetchChat(pageB, branchName))[1].mes];
        expect(bodies.sort()).toEqual([A_CHAT_BODY[0].mes, B_CHAT_BODY[0].mes].sort());

        // A gets the same two chats from its notify-driven run.
        await waitForBackgroundSync(pageA, { since: pairedSince });
        expect(await listChatNames(pageA)).toEqual(expect.arrayContaining([CHAT_FILE, branchName]));

        await ctxA.close();
        await ctxB.close();
    });
});
