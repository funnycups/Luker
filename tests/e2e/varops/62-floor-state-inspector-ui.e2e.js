// #62 — Floor-state inspector UI shows current floor's full state.
//
// The variable-op panel (the flask icon on each message in the chat list)
// is the UI surface that exposes a floor's recorded var_ops. It is wired
// by `initVarOpsPanelHandler` in public/scripts/variable-op-log/panel.js.
// The button starts hidden via inline `style="display: none"` and is
// toggled to display:'' by `refreshButtonVisibility` when the message has
// non-empty extra.var_ops.
//
// What this case pins:
//   a) Each assistant turn's extra.var_ops faithfully records the macros
//      (assertion via panel rows read from rendered DOM, not from chat).
//   b) The .mes_var_ops button's inline display style is flipped to ''
//      (not 'none') for every floor with ops — proving the visibility
//      handler ran.
//   c) Opening the panel for the latest floor populates rows that
//      mirror the recorded ops 1:1 (op, key, value match).
//   d) The materialized chat_metadata.variables reflects the full forward
//      apply of every recorded op across all floors.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { openVarOpsPanel, getRenderedVarOpsRows } from '../_lib/ui-mg-varops.js';

let server, mock;

const REPLY_TURN_1 = '*Seraphina lights the lantern with the patience of long habit.* {{setvar::hp::50}} *The wick takes; she nods once.* {{setvar::tension::low}}';
const REPLY_TURN_2 = '*She glances toward the dark beyond the lantern\'s glow.* {{incvar::hp}}{{setvar::weather::clear}} "The sea is steady tonight."';
const REPLY_TURN_3 = '*A gull cries over the breaker; she does not flinch.* {{pushvar::inventory::lantern}}{{pushvar::inventory::spyglass}} "Hold these — both at once if it comes to that."';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [REPLY_TURN_1, REPLY_TURN_2, REPLY_TURN_3] });
    server = await startServer({ batchKey: 'varops', scenarioId: 'inspector-ui' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#62 — Floor-state inspector UI shows current floor full state', () => {
    test('per-message flask icon is un-hidden by handler; opening the panel mirrors recorded ops', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // ── Three turns ────────────────────────────────────────────────
        const replyIds = [];
        for (const text of [
            'Light the lantern — I need to see the breakers.',
            'The wind is still; what does the sea look like to you?',
            'Hand me what I need before the tide turns.',
        ]) {
            const { replyId } = await sendMessageAndAwaitReply(page, text);
            await page.waitForFunction((id) => {
                const ctx = window.Luker.getContext();
                const m = ctx.chat?.[id];
                return Boolean(m && Array.isArray(m?.extra?.var_ops) && m.extra.var_ops.length > 0);
            }, replyId, { timeout: 15_000 });
            replyIds.push(replyId);
        }

        // For each assistant floor with ops, the button's inline display style
        // should have been flipped from "none" to "" by refreshButtonVisibility.
        const buttonStyles = await page.evaluate((idxs) => {
            return idxs.map((idx) => {
                const el = document.querySelector(`.mes[mesid="${idx}"] .mes_var_ops`);
                return { idx, exists: !!el, inlineDisplay: el?.style.display ?? null };
            });
        }, replyIds);
        for (const b of buttonStyles) {
            expect(b.exists, `flask icon DOM exists for floor ${b.idx}`).toBe(true);
            expect(
                b.inlineDisplay,
                `flask icon inline display flipped off "none" for floor ${b.idx} (saw="${b.inlineDisplay}")`,
            ).not.toBe('none');
        }

        // Open the panel for the latest floor via the helper and assert
        // every rendered row matches the recorded ops 1:1.
        const latestId = replyIds[replyIds.length - 1];
        await openVarOpsPanel(page, latestId);
        const rows = await getRenderedVarOpsRows(page);
        // Latest reply ops: two pushvars onto inventory.
        expect(rows).toEqual([
            { op: 'pushvar', key: 'inventory', value: 'lantern', path: '' },
            { op: 'pushvar', key: 'inventory', value: 'spyglass', path: '' },
        ]);

        // Dismiss the panel (Cancel — we do not want to mutate state).
        await page.locator('.popup-button-cancel').first().click().catch(() => {});

        // Also confirm the materialized state on the chat metadata reflects
        // all surviving ops from every floor we sent — this is the "full
        // state" the inspector shadows.
        const fullState = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.chatMetadata?.variables ?? null;
        });
        // hp=50 (turn 1) → +1 (turn 2) → 51
        expect(Number(fullState.hp)).toBe(51);
        expect(fullState.tension).toBe('low');
        expect(fullState.weather).toBe('clear');
        expect(JSON.parse(fullState.inventory)).toEqual(['lantern', 'spyglass']);
    });
});
