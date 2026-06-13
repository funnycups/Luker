// #42 — Profile with no URL → friendly error.
//
// Seed a CUSTOM-source profile that has an empty `custom-url`. Try to send
// a chat turn. We expect:
//   - the page does NOT hang forever (no eternal spinner)
//   - some user-visible error indicator appears (toast or error message)
//   - the chat does NOT get a "successful" assistant bubble from the empty URL

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'server', scenarioId: 'no-url' });
    markOnboarded({ dataRoot: server.dataRoot });
    // Manually bootstrap with EMPTY custom_url + matching empty profile so the
    // attempt to dispatch a turn fails fast.
    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.main_api = 'openai';
    s.firstRun = false;
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.chat_completion_source = 'custom';
    s.oai_settings.custom_url = '';
    s.oai_settings.custom_model = 'no-such-model';
    s.oai_settings.openai_model = 'no-such-model';
    s.oai_settings.stream_openai = false;
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#42 — profile with no URL surfaces a friendly error', () => {
    test('empty custom-url: send fails fast with a user-visible signal, no eternal spinner', async ({ page }) => {
        const errors = [];
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', e => { errors.push(`pageerror: ${e.message}`); });

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for greeting to be in chat so any failure we observe is the
        // attempted /send turn, not the initial load.
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        const chatLenBefore = await page.evaluate(() => window.SillyTavern.getContext().chat.length);

        // Dispatch the /send + /trigger pair. Do NOT await MESSAGE_RECEIVED —
        // we expect this to fail and never fire that event. Instead, wait a
        // bounded amount of time then assert outcome.
        await page.evaluate(async () => {
            window.__sendError = null;
            try {
                await window.SillyTavern.getContext()
                    .executeSlashCommandsWithOptions('/send The reef shifts under the dark. | /trigger');
            } catch (e) {
                window.__sendError = String(e?.message || e);
            }
        });

        // Give the system up to 20s to either error or succeed.
        const outcome = await page.evaluate(async () => {
            const deadline = Date.now() + 20_000;
            while (Date.now() < deadline) {
                const ctx = window.SillyTavern.getContext();
                const chat = ctx?.chat || [];
                const last = chat[chat.length - 1];
                const isAsst = last && !last.is_user;
                const isGenerating = !!document.querySelector('#mes_stop:not(.displayNone)');
                const toast = document.querySelector('#toast-container .toast, .toast-error, .toast-warning');
                if (isAsst && !isGenerating && last?.mes && last.mes.length > 5) {
                    return { kind: 'asst-bubble', mes: last.mes.slice(0, 200) };
                }
                if (toast) {
                    return { kind: 'toast', text: toast.textContent.trim().slice(0, 200) };
                }
                if (window.__sendError) {
                    return { kind: 'send-error', text: String(window.__sendError).slice(0, 200) };
                }
                await new Promise(r => setTimeout(r, 250));
            }
            return { kind: 'timeout' };
        });

        // The test passes if EITHER:
        //   (a) we got a user-visible error toast, OR
        //   (b) the slash chain rejected with a readable error, OR
        //   (c) we eventually got an assistant bubble that surfaces "error",
        //       "fetch", or "url" in its content (some backends render
        //       failed-call diagnostics as a fake assistant message).
        // The fail mode we are guarding against is `kind: 'timeout'` with
        // no toast/error — that would mean the UI hung indefinitely on an
        // empty URL.
        expect(outcome.kind, `expected some user-visible failure signal within 20s; got ${JSON.stringify(outcome)}`).not.toBe('timeout');

        const chatLenAfter = await page.evaluate(() => window.SillyTavern.getContext().chat.length);
        // User message may still have been appended. The key assertion is
        // that we did NOT just sit there forever and that a real assistant
        // bubble with body did NOT silently appear from nowhere.
        if (outcome.kind === 'asst-bubble') {
            expect(outcome.mes.toLowerCase()).toMatch(/error|fail|url|fetch|invalid|400|500/);
        }
        expect(chatLenAfter).toBeLessThanOrEqual(chatLenBefore + 2);
    });
});
