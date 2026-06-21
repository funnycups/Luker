// #10 — Impersonate: the mock returns a user-style line; that line lands
// in #send_textarea, NOT as a normal chat message.
//
// Real user gesture: open the options dropdown (#options_button), click
// #option_impersonate. Luker's Generate('impersonate', ...) returns a
// proposed user line that fills #send_textarea — it does NOT append a
// new message. We assert (a) the textarea contains the mock's text and
// (b) the chat DOM count is unchanged.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    impersonateViaUI,
} from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        'I am stepping out toward the rail; I want to see the lantern myself before I trust it.',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'impersonate' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#10 — Impersonate populates the user textarea', () => {
    test('impersonate output lands in #send_textarea, chat length unchanged', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        const beforeCount = await page.locator('#chat .mes').count();
        const beforeRequests = mock.requests.length;

        // Real user gesture: open options dropdown, click Impersonate.
        const textareaValue = await impersonateViaUI(page);

        // DOM-side: chat bubble count unchanged.
        const afterCount = await page.locator('#chat .mes').count();
        expect(afterCount, 'Impersonate should NOT add a new chat message').toBe(beforeCount);

        // Mock must have been hit.
        const newReqs = mock.requests.slice(beforeRequests);
        const chatReq = newReqs.find(r => /chat\/completions/.test(r.url));
        expect(chatReq, 'Impersonate should fire a chat completion request').toBeTruthy();

        // Textarea contains the impersonated text.
        expect(textareaValue, 'Impersonate result should populate #send_textarea').toContain('lantern myself');
        // Double-check via the live input value too.
        expect(await page.locator('#send_textarea').inputValue()).toContain('lantern myself');
    });
});
