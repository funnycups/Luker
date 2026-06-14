// Case #89 — Regex extension: pre-process input + post-process output
//
// Spec:
//   Install two global regex scripts:
//     (a) USER_INPUT (placement 1) replaces `[BR]` with `<br>` in
//         the user's outgoing turn so the assistant sees the substitution.
//     (b) AI_OUTPUT (placement 2) replaces `lantern` with `LANTERN` in
//         the assistant's incoming reply so the rendered chat bubble
//         reflects the transformation.
//
// Verify:
//   - The mock's recorded `/v1/chat/completions` payload has the pre-
//     processed user text (i.e. `<br>`, not `[BR]`).
//   - The chat bubble after MESSAGE_RECEIVED contains the post-processed
//     assistant text (i.e. `LANTERN`, not the raw `lantern`).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash trims the lantern wick and the lantern flame settles to a steady blue.* "The lantern will hold another hour."',
    ] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '89-regex' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#89 — Regex pre+post process applied', () => {
    test('user-input regex replaces [BR] before send; AI-output regex transforms reply', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for greeting so MESSAGE_RECEIVED later is the real reply.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Install two GLOBAL regex scripts via extension_settings.regex.
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const reg = ctx.extensionSettings.regex = Array.isArray(ctx.extensionSettings.regex) ? ctx.extensionSettings.regex : [];
            reg.length = 0;
            reg.push({
                id: 'e2e-pre-br',
                scriptName: 'e2e-pre-br',
                findRegex: '/\\[BR\\]/g',
                replaceString: '<br>',
                trimStrings: [],
                placement: [1], // USER_INPUT
                disabled: false,
                markdownOnly: false,
                promptOnly: false,
                pluginOnly: false,
                runOnEdit: false,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            });
            reg.push({
                id: 'e2e-post-lantern',
                scriptName: 'e2e-post-lantern',
                findRegex: '/lantern/g',
                replaceString: 'LANTERN',
                trimStrings: [],
                placement: [2], // AI_OUTPUT
                disabled: false,
                markdownOnly: false,
                promptOnly: false,
                pluginOnly: false,
                runOnEdit: false,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            });
            ctx.saveSettingsDebounced();
        });

        const before = mock.requests.length;

        // Send a turn carrying `[BR]` placeholders.
        const userInput = 'I walked the cliff path.[BR]The wind was steady and the lantern still burned.';
        const { text: replyText } = await sendMessageAndAwaitReply(page, userInput);

        // ===== Assert pre-process: mock saw `<br>` not `[BR]`. =====
        const newReqs = mock.requests.slice(before);
        const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
        expect(chatReq, 'mock should have received the user turn').toBeTruthy();
        const payload = JSON.stringify(chatReq.body.messages);
        // The user's content must reflect the regex substitution.
        expect(payload).toMatch(/<br>/);
        expect(payload).not.toMatch(/\[BR\]/);

        // ===== Assert post-process: the chat bubble has the transformed reply. =====
        // The post-process regex runs on the assistant reply, mutating
        // the persisted chat message. Reply text returned by the helper
        // is the persisted `mes` after post-processing.
        expect(replyText).toMatch(/LANTERN/);
        // The raw lower-case "lantern" should no longer appear because
        // the global replace covers every occurrence.
        expect(replyText).not.toMatch(/\blantern\b/);
    });
});
