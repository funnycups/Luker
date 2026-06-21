// Case #91 — Author's Note injection at configured depth (real UI inputs)
//
// Spec:
//   Configure an Author's Note with depth=2, position=IN_CHAT,
//   interval=1 (insert every turn). Send a turn. Verify the AN content
//   appears in the prompt sent to the mock at the documented position.
//
// Real UI surface:
//   - Author's Note textarea: #extension_floating_prompt
//   - Depth input:            #extension_floating_depth
//   - Interval input:         #extension_floating_interval
//   - Position radio (IN_CHAT, value=1): #extension_floating_position_depth
//   These live under the Author's Note inline-drawer in the Extensions
//   panel. The drawer mounts inside #floatingPrompt_container.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openOptionsAndClick,
} from '../_lib/page.js';

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

test.describe('#91 — Authors Note via real inputs, depth-2 injection', () => {
    test('AN content appears in prompt sent to mock at configured depth', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for the greeting to land.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Open the Author's Note floating panel via the wand-menu entry
        // — the real user flow (options_button → option_toggle_AN). The
        // panel is a separate #movingDivs > #floatingPrompt element, not
        // part of the Extensions drawer.
        await openOptionsAndClick(page, 'option_toggle_AN');
        await page.locator('#floatingPrompt').waitFor({ state: 'visible', timeout: 5000 });

        // The Author's Note inputs live in #floatingPrompt; #ANBlockToggle
        // is the main inline-drawer header that should already be open
        // from onANMenuItemClick. Just scroll to the textarea — it's the
        // canonical AN input.
        const noteTextarea = page.locator('#extension_floating_prompt');
        await noteTextarea.waitFor({ state: 'visible', timeout: 10_000 });
        await noteTextarea.scrollIntoViewIfNeeded().catch(() => {});
        await noteTextarea.fill(AN_TEXT);
        await noteTextarea.blur();

        // Set depth + interval via real inputs.
        const depthInput = page.locator('#extension_floating_depth');
        await depthInput.scrollIntoViewIfNeeded().catch(() => {});
        await depthInput.fill('2');
        await depthInput.blur();

        const intervalInput = page.locator('#extension_floating_interval');
        await intervalInput.scrollIntoViewIfNeeded().catch(() => {});
        await intervalInput.fill('1');
        await intervalInput.blur();

        // Position radio: IN_CHAT at depth. The radio group is
        // input[name="extension_floating_position"] with value="1" for
        // in-chat-at-depth.
        const posRadio = page.locator('#extension_floating_position_depth');
        await posRadio.scrollIntoViewIfNeeded().catch(() => {});
        await posRadio.check();

        // Tiny settle so the change handlers persist to chat_metadata.
        await page.waitForTimeout(500);

        // Sanity: chat_metadata reflects the inputs (this is what the AN
        // writer reads on each turn).
        const md = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                note_prompt: ctx.chatMetadata?.note_prompt,
                note_depth: ctx.chatMetadata?.note_depth,
                note_interval: ctx.chatMetadata?.note_interval,
                note_position: ctx.chatMetadata?.note_position,
            };
        });
        expect(md.note_prompt).toBe(AN_TEXT);
        expect(Number(md.note_depth)).toBe(2);
        expect(Number(md.note_interval)).toBe(1);
        expect(Number(md.note_position)).toBe(1);

        const before = mock.requests.length;

        // Send 5 turns via the REAL send_textarea + send_but path. AN is
        // inserted from depth=2 every turn (interval=1).
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

        // Position check on the most-recent request.
        const lastReq = chatReqs[chatReqs.length - 1];
        const msgs = lastReq.body.messages || [];
        const anIdx = msgs.findIndex(m => {
            const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
            return c.includes('AUTHORSNOTE-SENTINEL');
        });
        expect(anIdx).toBeGreaterThan(-1);
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
