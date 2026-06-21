// #42 — Profile with no URL → friendly error.
//
// Real UI surface: clear `#generic_api_url_text` via the dropdown panel,
// click Connect. Confirm a user-visible failure (toast or assistant
// error bubble) within a bounded time — no eternal spinner.
//
// The setup writes settings.json to point at the CUSTOM/openai source
// with empty `custom_url`; the user-visible URL input mirrors that
// state. The ACT is sending a chat turn — the regression we guard
// against is "URL empty → page hangs forever".

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'server', scenarioId: 'no-url' });
    markOnboarded({ dataRoot: server.dataRoot });
    // Bootstrap CUSTOM source with EMPTY custom_url so the user-visible
    // URL input is empty when the UI loads. The test then attempts a send.
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
    test('empty URL: send fails fast with a user-visible signal, no eternal spinner', async ({ page }) => {
        test.setTimeout(120_000);
        const errors = [];
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', e => { errors.push(`pageerror: ${e.message}`); });

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for greeting so any failure we observe is the attempted
        // send turn, not the initial load.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        const chatLenBefore = await page.evaluate(() => window.Luker.getContext().chat.length);

        // REAL act: type into the textarea and click send.
        const textarea = page.locator('#send_textarea');
        await textarea.fill('The reef shifts under the dark.');
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 10_000 });
        await page.locator('#send_but').click();

        // Give the system up to 20s to either error or succeed.
        const outcome = await page.evaluate(async () => {
            const deadline = Date.now() + 20_000;
            while (Date.now() < deadline) {
                const ctx = window.Luker.getContext();
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
                await new Promise(r => setTimeout(r, 250));
            }
            return { kind: 'timeout' };
        });

        expect(outcome.kind, `expected user-visible failure signal within 20s; got ${JSON.stringify(outcome)}`).not.toBe('timeout');

        const chatLenAfter = await page.evaluate(() => window.Luker.getContext().chat.length);
        if (outcome.kind === 'asst-bubble') {
            expect(outcome.mes.toLowerCase()).toMatch(/error|fail|url|fetch|invalid|400|500/);
        }
        expect(chatLenAfter).toBeLessThanOrEqual(chatLenBefore + 2);
    });
});
