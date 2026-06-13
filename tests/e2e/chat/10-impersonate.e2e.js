// #10 — /impersonate: mock returns a user-style line; that line should
// be inserted as the user textarea text (or as a user message, depending
// on Luker convention), NOT as a normal assistant turn.
//
// Luker's impersonate behavior: Generate('impersonate', ...) returns a
// text the user could have said. The text goes into the #send_textarea
// input — it does NOT append a message to the chat. We verify both
// (a) the textarea is populated and (b) chat.length is unchanged.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

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

test.describe('#10 — /impersonate populates the user textarea', () => {
    test('impersonate output lands in #send_textarea, chat length unchanged', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        const before = await page.evaluate(() => window.SillyTavern.getContext().chat.length);
        const beforeRequests = mock.requests.length;

        await page.evaluate(async () => {
            await window.SillyTavern.getContext().executeSlashCommandsWithOptions('/impersonate await=true');
        });

        // Wait for the chat-completion request to have happened so we know
        // the impersonation generation finished.
        await page.waitForFunction(({ before }) => {
            return true;
        }, { before: beforeRequests }, { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(800);

        const after = await page.evaluate(() => window.SillyTavern.getContext().chat.length);
        expect(after, '/impersonate should NOT add a new chat message').toBe(before);

        // The mock must have been hit (at least once), with an impersonate
        // marker — `quietToLoud` etc. send a generate type 'impersonate'.
        const newReqs = mock.requests.slice(beforeRequests);
        const chatReq = newReqs.find(r => /chat\/completions/.test(r.url));
        expect(chatReq, '/impersonate should fire a chat completion request').toBeTruthy();

        // Final assertion: the user-textarea should now contain the
        // impersonated text (Luker's impersonate writes to #send_textarea).
        const textareaValue = await page.locator('#send_textarea').inputValue();
        expect(textareaValue, '/impersonate result should populate #send_textarea').toContain('lantern myself');
    });
});
