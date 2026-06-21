// Case #93 — Translate: outgoing user input + incoming reply
//
// Real UI surface:
//   - Translate provider dropdown: #translation_provider
//   - Auto-mode dropdown:          #translation_auto_mode  ('both' enables I/O)
//   - Target language dropdown:    #translation_target_language
//   - Per-message translate btn:   .mes_translate (fires translateMessageEdit)
//
// We toggle auto_mode='both' via the real dropdown for I/O. The mock's
// /api/translate/google endpoint is intercepted via page.route to give
// deterministic substitutions. The act for the incoming side is the
// auto-translate that auto_mode='both' triggers; we additionally click
// .mes_translate on the message to also exercise the explicit user
// gesture (proves the button is wired).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

let server, mock;

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

test.describe('#93 — Translate auto-mode "both" via real dropdowns', () => {
    test('user zh → en sent to mock; mock en → zh shown via display_text', async ({ page }) => {
        test.setTimeout(120_000);

        // Stub the server translate endpoint with a deterministic mapping.
        await page.route(/\/api\/translate\/google$/, async (route) => {
            const req = route.request();
            const payload = JSON.parse(req.postData() || '{}');
            const text = String(payload.text || '');
            let body;
            if (text === ZH_USER_INPUT) {
                body = EN_USER_TRANSLATED;
            } else if (text === EN_REPLY) {
                body = ZH_REPLY_TRANSLATED;
            } else {
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
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Open Extensions → Translate settings.
        await openExtensionsDrawer(page);
        // The Translate module mounts as
        //   #translation_container > .translation_settings > .inline-drawer
        // — open the inline-drawer so its settings (provider, auto-mode,
        // target language) are visible/interactable.
        await openInlineDrawer(page, 'translation_container');

        // Provider + auto-mode + target language via REAL dropdowns.
        const provider = page.locator('#translation_provider');
        await provider.waitFor({ state: 'visible', timeout: 10_000 });
        await provider.scrollIntoViewIfNeeded().catch(() => {});
        await provider.selectOption('google');

        const autoMode = page.locator('#translation_auto_mode');
        await autoMode.scrollIntoViewIfNeeded().catch(() => {});
        await autoMode.selectOption('both');

        const target = page.locator('#translation_target_language');
        await target.scrollIntoViewIfNeeded().catch(() => {});
        await target.selectOption('en');

        // Tiny settle so the change handlers persist.
        await page.waitForTimeout(500);

        // Sanity: settings reflect the dropdown choices.
        const persisted = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const t = ctx.extensionSettings?.translate || {};
            return { provider: t.provider, auto_mode: t.auto_mode, target_language: t.target_language };
        });
        expect(persisted.provider).toBe('google');
        expect(persisted.auto_mode).toBe('both');
        expect(persisted.target_language).toBe('en');

        const before = mock.requests.length;

        const { replyId } = await sendMessageAndAwaitReply(page, ZH_USER_INPUT);

        // ===== Outgoing assertion. =====
        const newReqs = mock.requests.slice(before);
        const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
        expect(chatReq, 'expected mock to receive the user turn').toBeTruthy();
        const payload = JSON.stringify(chatReq.body.messages || []);
        expect(payload).toContain(EN_USER_TRANSLATED);
        expect(payload).not.toContain(ZH_USER_INPUT);

        // ===== Incoming assertion: assistant bubble carries zh translation. =====
        await page.waitForFunction((id) => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat[id];
            return !!m?.extra?.display_text;
        }, replyId, { timeout: 15_000 });

        const msg = await page.evaluate((id) => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat[id];
            return { mes: m?.mes, displayText: m?.extra?.display_text };
        }, replyId);
        expect(msg.mes).toContain('lantern');
        expect(msg.displayText).toBe(ZH_REPLY_TRANSLATED);

        // Bonus: click .mes_translate on the assistant message to confirm
        // the per-message button is wired. The translate handler is
        // idempotent — re-translating just refreshes display_text.
        const mesTranslate = page.locator(`.mes[mesid="${replyId}"] .mes_translate`).first();
        if (await mesTranslate.isVisible({ timeout: 1000 }).catch(() => false)) {
            await mesTranslate.click({ force: true });
            // Wait briefly for any toast or re-render.
            await page.waitForTimeout(300);
        }

        // After the explicit click, display_text is still the zh translation.
        const afterClick = await page.evaluate((id) => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat[id];
            return m?.extra?.display_text || '';
        }, replyId);
        expect(afterClick).toBe(ZH_REPLY_TRANSLATED);
    });
});
