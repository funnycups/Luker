// #61 — Multiple var-ops per AI turn surface as rendered rows in the flask panel.
//
// Real user flow:
//   1. Send a user turn via the textarea + send button (no programmatic /trigger).
//   2. The mock AI reply weaves four side-effect macros into RP-immersive prose.
//   3. The variable-op-log scanner records each op onto the assistant
//      message's `extra.var_ops`; the panel handler flips the per-message
//      flask icon visible.
//   4. Click the flask icon → the panel popup mounts → assert the rendered
//      rows reflect each op (op/key/value) read from the DOM, not from
//      ctx.chat.
//   5. Reload the page after a server restart; click the same flask icon
//      again; the rendered rows must still match because the per-message
//      var_ops record is the durable persistence boundary.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';
import { openVarOpsPanel, getRenderedVarOpsRows } from '../_lib/ui-mg-varops.js';

let server, mock;

// Four mutations woven into Seraphina's reply.
const RICH_REPLY = [
    '*Seraphina drops to one knee at the lantern base, salt cracking on her cuffs.* ',
    'The wick is fickle tonight. {{setvar::hp::50}}{{setvar::tension::high}}',
    ' She wedges the spyglass under one arm. {{incvar::hp}}',
    ' "Take the lantern," she says, pressing it into your palm. {{pushvar::inventory::lantern}}',
    ' "And keep your eyes on the third breaker — that one has been lying to me all watch."',
].join('');

// Second reply used post-restart so the same flask panel can be re-opened
// from a fresh page load.
const RESTART_REPLY = '*Seraphina nods.* "The tally still reads as it did at the third bell."';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [RICH_REPLY, RESTART_REPLY] });
    server = await startServer({ batchKey: 'varops', scenarioId: 'multi-ops-per-turn' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#61 — One turn / multiple var_ops mutations → rendered panel rows', () => {
    test('four ops surface as four rendered rows; survives server restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Real send via the textarea + #send_but; await the streamed reply.
        const { replyId } = await sendMessageAndAwaitReply(
            page,
            'I will hold the lantern. Tell me what the breaker is doing.',
        );

        // The var-op extractor runs from `saveReply()` AFTER GENERATION_ENDED
        // fires (which is what sendMessageAndAwaitReply awaits). Wait
        // explicitly for the post-extract state: extra.var_ops populated AND
        // chat[].mes scrubbed of macro literals (redrawMessageBubble follows).
        await page.waitForFunction((id) => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat?.[id];
            if (!m || !Array.isArray(m?.extra?.var_ops) || m.extra.var_ops.length === 0) return false;
            return !String(m.mes || '').includes('{{setvar');
        }, replyId, { timeout: 20_000 });

        // ctx.chat[id].mes is the canonical stripped body (post-extractor).
        const persisted = await page.evaluate((id) => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat?.[id];
            return { mes: m?.mes || '', ops: m?.extra?.var_ops || [] };
        }, replyId);

        expect(persisted.mes).not.toContain('{{setvar');
        expect(persisted.mes).not.toContain('{{incvar');
        expect(persisted.mes).not.toContain('{{pushvar');
        expect(persisted.mes).toContain('third breaker');
        expect(persisted.ops).toEqual([
            { op: 'setvar', key: 'hp', value: '50' },
            { op: 'setvar', key: 'tension', value: 'high' },
            { op: 'incvar', key: 'hp' },
            { op: 'pushvar', key: 'inventory', value: 'lantern' },
        ]);

        // Click the flask icon on the assistant message and read the rendered rows.
        await openVarOpsPanel(page, replyId);
        const rows = await getRenderedVarOpsRows(page);
        expect(rows).toEqual([
            { op: 'setvar', key: 'hp', value: '50', path: '' },
            { op: 'setvar', key: 'tension', value: 'high', path: '' },
            // incvar has no value field — the textarea is not rendered for non-value ops.
            { op: 'incvar', key: 'hp', value: '', path: '' },
            { op: 'pushvar', key: 'inventory', value: 'lantern', path: '' },
        ]);

        // Close the panel with the Cancel button — we do not want to commit edits.
        await page.locator('.popup-button-cancel').first().click().catch(() => {});

        // Wait for the relaxed chat-save debounce (1000ms) to flush its
        // pending write to disk before the server restart. This mirrors a
        // real user pausing for a moment after their last action rather
        // than racing the debounce window. Adding 200ms slack covers the
        // setTimeout + fetch round-trip.
        await page.waitForTimeout(1200);

        // ── Persistence: restart, reload, re-open the same flask panel ─
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            return Array.isArray(ctx?.chat) && ctx.chat.length >= 2;
        }, { timeout: 15_000 });

        // Find the assistant message that carries var_ops in the rehydrated chat.
        const reopenId = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            for (let i = ctx.chat.length - 1; i >= 0; i--) {
                if (!ctx.chat[i]?.is_user && Array.isArray(ctx.chat[i]?.extra?.var_ops) && ctx.chat[i].extra.var_ops.length > 0) {
                    return i;
                }
            }
            return -1;
        });
        expect(reopenId, 'expected an assistant message with var_ops after reload').toBeGreaterThanOrEqual(0);

        await openVarOpsPanel(page, reopenId);
        const reopenedRows = await getRenderedVarOpsRows(page);
        expect(reopenedRows).toEqual([
            { op: 'setvar', key: 'hp', value: '50', path: '' },
            { op: 'setvar', key: 'tension', value: 'high', path: '' },
            { op: 'incvar', key: 'hp', value: '', path: '' },
            { op: 'pushvar', key: 'inventory', value: 'lantern', path: '' },
        ]);
        // Dismiss.
        await page.locator('.popup-button-cancel').first().click().catch(() => {});
    });
});
