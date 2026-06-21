// Case #92 — Quick Reply triggers slash command (real DOM button click)
//
// Spec:
//   Create a quick-reply set, attach it as a global visible set, define
//   a single quick reply whose `message` is a slash command pipeline
//   `/send hello world | /trigger`. Click the QR button in the actual
//   #qr--bar in the composer area. Verify the message was sent and an
//   assistant reply came back.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash sets the brass spyglass on the rail.* "Hello yourself. The reef has been restless tonight."',
    ] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '92-quick-reply' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#92 — Quick Reply triggers slash command via real button click', () => {
    test('clicking the rendered .qr--button in #qr--bar sends a message and triggers reply', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for greeting so MESSAGE_RECEIVED later is the QR reply.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Wait for the QR extension's API to attach.
        await page.waitForFunction(() => !!globalThis.quickReplyApi, { timeout: 10_000 });

        // Build a set with one quick reply and expose it globally. The
        // quickReplyApi is the canonical interaction surface for tests
        // and equivalent to what the Manage popup does — both end up
        // calling settings.save(). We use it strictly for the setup
        // phase; the actual ACT (button click) is a real DOM gesture.
        await page.evaluate(async () => {
            const api = globalThis.quickReplyApi;
            api.settings.isEnabled = true;
            await api.createSet('e2e-set', { disableSend: false, placeBeforeInput: false, injectInput: false });
            api.createQuickReply('e2e-set', 'Greet', {
                icon: '',
                showLabel: true,
                message: '/send hello world | /trigger',
                title: 'Send hello world',
            });
            api.addGlobalSet('e2e-set', true);
            await api.settings.save();
        });

        // Wait for the rendered button in #qr--bar.
        const qrBtn = page.locator('#qr--bar .qr--button', { has: page.locator('.qr--button-label', { hasText: 'Greet' }) }).first();
        await qrBtn.waitFor({ state: 'visible', timeout: 10_000 });

        // Subscribe to MESSAGE_RECEIVED before clicking.
        const replyHandle = page.evaluateHandle(() => new Promise((resolve, reject) => {
            const ctx = window.Luker.getContext();
            const t = setTimeout(() => reject(new Error('reply timeout')), 60_000);
            const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, (id) => {
                clearTimeout(t);
                try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch {}
                resolve(id);
            });
        }));

        const before = mock.requests.length;

        // REAL click: the user's gesture on the rendered button.
        await qrBtn.click();

        // Await reply.
        const replyId = await replyHandle.then(h => h.jsonValue());
        expect(typeof replyId === 'number' || typeof replyId === 'string').toBe(true);

        const lastUser = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const u = [...ctx.chat].reverse().find(m => m.is_user);
            return u?.mes || '';
        });
        expect(lastUser).toMatch(/hello world/);

        const newReqs = mock.requests.slice(before);
        const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
        expect(chatReq).toBeTruthy();
        const payload = JSON.stringify(chatReq.body.messages || []);
        expect(payload).toMatch(/hello world/);
    });
});
