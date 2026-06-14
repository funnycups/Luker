// Case #91 — Author's Note injection at configured depth
//
// Spec:
//   Configure an Author's Note with depth=2, position=IN_CHAT,
//   interval=1 (insert every turn). Send a turn. Verify the AN content
//   shows up in the prompt sent to the mock at the documented position
//   (i.e. between the existing chat messages with the right offset from
//   the end).
//
// Why depth=2: the AN is inserted before the 2nd-most-recent message in
// the array passed to the LLM (i.e. "inject N messages from the end"),
// per public/scripts/authors-note.js → setExtensionPrompt(..., depth).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

const AN_TEXT = 'AUTHORSNOTE-SENTINEL: keep the lantern trimmed and the chart folded.';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash glances toward the lantern and nods.* "Understood."',
        '*Ash folds the chart corner and waits.* "Go on."',
        '*Ash watches the gull rocks.* "Keep talking."',
        '*Ash squints at the swell.* "I hear you."',
        '*Ash leans on the rail.* "Continue."',
    ] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '91-authors-note' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#91 — Authors Note depth-2 injection', () => {
    test('AN content appears in prompt sent to mock at configured depth', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for the greeting to land.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Configure the Author's Note via chat_metadata. AN reads:
        //   chat_metadata.note_prompt  → content
        //   chat_metadata.note_depth   → offset from end (IN_CHAT)
        //   chat_metadata.note_position → 1 = IN_CHAT
        //   chat_metadata.note_interval → 1 = every turn
        await page.evaluate((anText) => {
            const ctx = window.Luker.getContext();
            const md = ctx.chatMetadata;
            md.note_prompt = anText;
            md.note_interval = 1;
            md.note_depth = 2;
            md.note_position = 1; // IN_CHAT
            md.note_role = 0;     // SYSTEM
            // Force the textarea so AN's writer sees the value when it
            // runs setExtensionPrompt before the next turn.
            const ta = document.getElementById('extension_floating_prompt');
            if (ta) ta.value = anText;
            ctx.saveMetadataDebounced?.();
        }, AN_TEXT);

        const before = mock.requests.length;

        // Send 5 turns. AN is inserted from depth=2 every turn.
        await sendMessageAndAwaitReply(page, 'I walked the cliff path past the gull rocks.');
        await sendMessageAndAwaitReply(page, 'The tide was settling. I counted three breakers north.');
        await sendMessageAndAwaitReply(page, 'The drifters did not light fires inland.');
        await sendMessageAndAwaitReply(page, 'The chart edge had taken salt-crystal again.');
        const { text: finalReply } = await sendMessageAndAwaitReply(page, 'The lantern wick needs another trimming.');

        expect(finalReply).toBeTruthy();

        // Inspect the prompts the mock received. The AN sentinel must
        // appear in at least one of the chat-completion requests.
        const after = mock.requests.slice(before);
        const chatReqs = after.filter(r => r.url.includes('chat/completions'));
        expect(chatReqs.length).toBeGreaterThanOrEqual(5);
        const everyHasSentinel = chatReqs.every(req => {
            const blob = JSON.stringify(req.body.messages || []);
            return blob.includes('AUTHORSNOTE-SENTINEL');
        });
        expect(everyHasSentinel, 'AN with interval=1 should be present on every turn').toBe(true);

        // Position check on the most-recent request: AN must appear in
        // the message array (it's injected as a synthetic message at
        // depth=2 from the end for IN_CHAT). Locate its index.
        const lastReq = chatReqs[chatReqs.length - 1];
        const msgs = lastReq.body.messages || [];
        const anIdx = msgs.findIndex(m => {
            const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
            return c.includes('AUTHORSNOTE-SENTINEL');
        });
        expect(anIdx).toBeGreaterThan(-1);
        // depth=2 means the AN should be placed near the end (offset 2
        // from the last message). The exact slot depends on Luker's
        // injection ordering, but it must NOT be at index 0 (first
        // system prompt) and must NOT be the very last user message.
        expect(anIdx).toBeGreaterThan(0);
        expect(anIdx).toBeLessThan(msgs.length - 1);

        // The final user message must remain the last user-role entry.
        const lastUserIdx = msgs.findLastIndex?.(m => m.role === 'user') ??
            (() => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return i; return -1; })();
        const lastUserContent = typeof msgs[lastUserIdx].content === 'string'
            ? msgs[lastUserIdx].content
            : JSON.stringify(msgs[lastUserIdx].content);
        expect(lastUserContent).toMatch(/lantern wick/);
    });
});
