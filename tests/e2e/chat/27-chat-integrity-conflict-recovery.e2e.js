// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    getChatSnapshot,
    getRenderedChatTexts,
} from '../_lib/page.js';

let server;
let mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina checks the harbor ledger.* "The night shift logs are sealed."',
        ],
    });
    server = await startServer({ scope, batchKey: 'chat', scenarioId: 'integrity-conflict-recovery' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await mock?.stop();
});

test.describe('chat integrity 409 conflict auto-recovery', () => {
    test('external disk integrity drift triggers real 409, auto-recovers in one /api/chats/get, persists UI edit, and survives reload', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 });

        await sendMessageAndAwaitReply(page, 'Confirm the northern beacon watch.');

        const renderedBefore = await getRenderedChatTexts(page);
        const userIdx = renderedBefore.findIndex((t) => /northern beacon/.test(t || ''));
        expect(userIdx).toBeGreaterThanOrEqual(0);

        const initialSnap = await getChatSnapshot(page);
        const initialIntegrity = initialSnap.metadata?.integrity;
        expect(typeof initialIntegrity).toBe('string');
        expect(initialIntegrity.length).toBeGreaterThan(0);

        const avatarUrl = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters?.[ctx.characterId]?.avatar || '';
        });
        expect(avatarUrl).toBeTruthy();

        // Simulate a concurrent writer (second tab/device) committing the same chat
        // via the real HTTP API so the stored integrity token rotates out from under
        // this browser tab and its next UI edit trips a genuine 409 conflict.
        const csrfRes = await page.request.get(`${server.baseURL}/csrf-token`);
        expect(csrfRes.ok()).toBe(true);
        const { token: csrfToken } = await csrfRes.json();
        const headers = {
            'Content-Type': 'application/json',
            'X-CSRF-Token': String(csrfToken || ''),
        };
        const getRes = await page.request.post(`${server.baseURL}/api/chats/get`, {
            headers,
            data: { ch_name: 'Seraphina', avatar_url: avatarUrl, file_name: initialSnap.chatId },
        });
        expect(getRes.ok()).toBe(true);
        const serverChat = await getRes.json();
        expect(Array.isArray(serverChat)).toBe(true);
        const saveRes = await page.request.post(`${server.baseURL}/api/chats/save`, {
            headers,
            data: {
                ch_name: 'Seraphina',
                avatar_url: avatarUrl,
                file_name: initialSnap.chatId,
                chat: serverChat,
                force: true,
            },
        });
        expect(saveRes.ok()).toBe(true);
        const { integrity: externalIntegrity } = await saveRes.json();
        expect(externalIntegrity).toBeTruthy();
        expect(externalIntegrity).not.toBe(initialIntegrity);

        // Observe real network requests during the user UI edit.
        const seenRequests = [];
        page.on('response', (res) => {
            const url = res.url();
            if (url.includes('/api/chats/')) {
                seenRequests.push({ path: new URL(url).pathname, status: res.status() });
            }
        });

        const editedText = 'Confirm the southern beacon watch after the gale.';
        const mes = page.locator(`.mes[mesid="${userIdx}"]`);
        await mes.waitFor({ state: 'visible', timeout: 10_000 });
        await mes.hover();
        await mes.locator('.mes_edit').first().click();
        const editArea = mes.locator('.edit_textarea').first();
        await editArea.waitFor({ state: 'visible', timeout: 5_000 });
        await editArea.fill(editedText);
        await mes.locator('.mes_edit_done').first().click();
        await editArea.waitFor({ state: 'detached', timeout: 10_000 });

        await expect.poll(() => seenRequests.some((r) => r.status === 409), { timeout: 10_000 }).toBe(true);
        await expect.poll(() => seenRequests.some((r) => (r.path === '/api/chats/patch' || r.path === '/api/chats/save') && r.status === 200), { timeout: 10_000 }).toBe(true);

        // Recovery issued at most 1 /api/chats/get fetch (single snapshot reuse).
        const getCalls = seenRequests.filter((r) => r.path === '/api/chats/get');
        expect(getCalls.length).toBeLessThanOrEqual(1);

        // Client integrity stayed populated and rotated past externalIntegrity.
        const recoveredSnap = await getChatSnapshot(page);
        expect(recoveredSnap.metadata?.integrity).toBeTruthy();
        expect(recoveredSnap.metadata?.integrity).not.toBe(initialIntegrity);
        expect(recoveredSnap.metadata?.integrity).not.toBe(externalIntegrity);

        // Reload and verify the edited text survived on disk and renders cleanly.
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 2, { timeout: 15_000 });

        const renderedAfter = await getRenderedChatTexts(page);
        expect(renderedAfter.some((t) => t.includes('southern beacon watch'))).toBe(true);
    });
});
