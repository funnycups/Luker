// Case #93 — Translate: outgoing user input + incoming reply
//
// Spec:
//   Enable the translate extension with auto_mode='both'. User types zh
//   text → translate to en before sending. Mock receives en. Mock replies
//   en → translate back to zh → displayed to user as message.extra.display_text.
//
// Strategy:
//   The translate extension calls Luker's server route /api/translate/google.
//   That route requires no server-side keys for the google provider but
//   does an outbound HTTPS call we can't allow in CI. We intercept the
//   route directly via Playwright's `page.route` and serve a deterministic
//   plaintext translation that the test can assert on.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

// A canned table mapping the test's user / reply text to its
// "translation". Real translation is irrelevant — we only need
// determinism for asserts.
const ZH_USER_INPUT = '我沿着悬崖小径走过,海风很冷,但灯笼仍然燃烧。';
const EN_USER_TRANSLATED = 'I walked the cliff path; the wind was cold but the lantern still burned.';
const EN_REPLY = '*Ash trims the lantern wick and the flame settles.* "The reef has been restless tonight, but the lantern still holds."';
const ZH_REPLY_TRANSLATED = '*阿什修剪灯芯,火焰稳定下来。*「礁岩今晚不安,但灯笼仍然稳固。」';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [EN_REPLY] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '93-translate' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#93 — Translate auto-mode both', () => {
    test('user zh → en sent to mock; mock en → zh shown in chat as display_text', async ({ page }) => {
        // Stub the server translate endpoint with a deterministic mapping.
        await page.route(/\/api\/translate\/google$/, async (route) => {
            const req = route.request();
            const payload = JSON.parse(req.postData() || '{}');
            const text = String(payload.text || '');
            // direction is implied by the from_lang/to_lang pair, but for
            // this test we just look up the canned response by content.
            let body;
            if (text === ZH_USER_INPUT) {
                body = EN_USER_TRANSLATED;
            } else if (text === EN_REPLY) {
                body = ZH_REPLY_TRANSLATED;
            } else {
                // Echo with a marker so we notice unexpected calls.
                body = `[t]${text}`;
            }
            await route.fulfill({
                status: 200,
                contentType: 'text/plain',
                body,
            });
        });

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Enable translate auto-mode 'both' (translate input AND responses).
        await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            ctx.extensionSettings.translate = ctx.extensionSettings.translate || {};
            ctx.extensionSettings.translate.target_language = 'en';
            ctx.extensionSettings.translate.internal_language = 'en';
            ctx.extensionSettings.translate.provider = 'google';
            ctx.extensionSettings.translate.auto_mode = 'both';
            ctx.saveSettingsDebounced();
        });

        const before = mock.requests.length;

        const { replyId } = await sendMessageAndAwaitReply(page, ZH_USER_INPUT);

        // ===== Outgoing assertion: mock should receive the translated en text. =====
        const newReqs = mock.requests.slice(before);
        const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
        expect(chatReq, 'expected mock to receive the user turn').toBeTruthy();
        const payload = JSON.stringify(chatReq.body.messages || []);
        // The translated EN string should be in the prompt; the raw zh
        // should NOT (auto_mode=both replaces the outgoing payload).
        expect(payload).toContain(EN_USER_TRANSLATED);
        expect(payload).not.toContain(ZH_USER_INPUT);

        // ===== Incoming assertion: assistant bubble should hold the zh translation. =====
        // Luker stores the translation in message.extra.display_text and
        // keeps the original `mes` intact.
        await page.waitForFunction((id) => {
            const ctx = window.SillyTavern.getContext();
            const m = ctx.chat[id];
            return !!m?.extra?.display_text;
        }, replyId, { timeout: 15_000 });

        const msg = await page.evaluate((id) => {
            const ctx = window.SillyTavern.getContext();
            const m = ctx.chat[id];
            return { mes: m?.mes, displayText: m?.extra?.display_text };
        }, replyId);

        expect(msg.mes).toContain('lantern');
        expect(msg.displayText).toBe(ZH_REPLY_TRANSLATED);
    });
});
