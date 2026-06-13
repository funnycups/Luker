// #62 — Floor-state inspector UI shows current floor's full state.
//
// The variable-op panel (the flask icon on each message in the chat list)
// is the UI surface that exposes a floor's recorded var_ops. It is wired
// by `initVarOpsPanelHandler` in public/scripts/variable-op-log/panel.js.
// The button starts hidden via inline `style="display: none"` and is
// toggled to display:'' by `refreshButtonVisibility` when the message has
// non-empty extra.var_ops.
//
// Crucially, the button lives inside `.extraMesButtons`, a hover-shown
// row (CSS `.extraMesButtons { display: none; }`, then unhidden via
// hover or `.expanded`). For an e2e test we don't want to fight CSS hover
// semantics — we assert the BUTTON's own display style flipped to non-none
// (the handler's contract), and then open the panel programmatically by
// firing a click on the flask icon (which works even when the parent
// container is hover-hidden, since click dispatches don't require
// visibility).
//
// What this case pins:
//   a) Each assistant turn's extra.var_ops faithfully records the macros.
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
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // ── Three turns ────────────────────────────────────────────────
        for (const text of [
            'Light the lantern — I need to see the breakers.',
            'The wind is still; what does the sea look like to you?',
            'Hand me what I need before the tide turns.',
        ]) {
            await sendMessageAndAwaitReply(page, text);
        }

        // Per-floor recorded ops (source of truth) — assistant messages only.
        const recorded = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.chat.map((m, idx) => ({
                idx,
                isUser: !!m.is_user,
                ops: m?.extra?.var_ops ?? null,
            }));
        });

        const asstFloors = recorded.filter(r => !r.isUser && Array.isArray(r.ops) && r.ops.length > 0);
        expect(asstFloors.length, 'three assistant turns recorded ops').toBeGreaterThanOrEqual(3);

        // Latest assistant floor should carry the two pushvar ops.
        const latest = asstFloors[asstFloors.length - 1];
        expect(latest.ops).toEqual([
            { op: 'pushvar', key: 'inventory', value: 'lantern' },
            { op: 'pushvar', key: 'inventory', value: 'spyglass' },
        ]);

        // For each assistant floor with ops, the button's inline display style
        // should have been flipped from "none" to "" by refreshButtonVisibility.
        // (We don't assert .toBeVisible because the parent .extraMesButtons row
        // is CSS-hover-shown and Playwright would report the button hidden until
        // hovered — that's a CSS concern, not the contract this test exercises.)
        const buttonStyles = await page.evaluate((idxs) => {
            return idxs.map((idx) => {
                const el = document.querySelector(`.mes[mesid="${idx}"] .mes_var_ops`);
                if (!el) return { idx, exists: false };
                const inline = el.style.display;
                return { idx, exists: true, inlineDisplay: inline };
            });
        }, asstFloors.map(r => r.idx));
        for (const b of buttonStyles) {
            expect(b.exists, `flask icon DOM exists for floor ${b.idx}`).toBe(true);
            expect(
                b.inlineDisplay,
                `flask icon inline display flipped off "none" for floor ${b.idx} (saw="${b.inlineDisplay}")`,
            ).not.toBe('none');
        }

        // Open the panel for the latest floor programmatically. Click dispatches
        // even when the parent's display is none (CSS hover only affects render).
        await page.locator(`.mes[mesid="${latest.idx}"] .mes_var_ops`).first().dispatchEvent('click');

        // The panel renders inside a generic popup. Wait for at least one row.
        const panel = page.locator('.var-ops-panel');
        await expect(panel).toBeVisible({ timeout: 5_000 });
        const rows = panel.locator('.var-ops-panel__row');
        await expect(rows, 'panel renders one row per recorded op').toHaveCount(latest.ops.length, { timeout: 5_000 });

        // Each row's op selector + key input + value textarea should match the
        // corresponding recorded op. Read all rows in one snapshot.
        const panelView = await page.evaluate(() => {
            const out = [];
            const rows = document.querySelectorAll('.var-ops-panel__row');
            rows.forEach((row) => {
                const opSel = row.querySelector('select.var-ops-panel__op');
                const keyInput = row.querySelector('input.var-ops-panel__key');
                const valueArea = row.querySelector('textarea.var-ops-panel__value');
                out.push({
                    op: opSel?.value ?? null,
                    key: keyInput?.value ?? null,
                    value: valueArea ? valueArea.value : undefined,
                });
            });
            return out;
        });

        expect(panelView).toEqual(latest.ops.map(op => ({
            op: op.op,
            key: op.key,
            value: op.value, // pushvar carries a value field
        })));

        // Dismiss the panel (Cancel — we don't want to mutate state in this case).
        await page.locator('.popup-button-cancel').first().click().catch(() => {});
        await expect(panel).not.toBeVisible({ timeout: 5_000 }).catch(() => {});

        // Also confirm the materialized state on the chat metadata reflects
        // all surviving ops from every floor we sent — this is the "full
        // state" the inspector shadows.
        const fullState = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.chatMetadata?.variables ?? null;
        });
        // hp=50 (turn 1) → +1 (turn 2) → 51
        expect(Number(fullState.hp)).toBe(51);
        expect(fullState.tension).toBe('low');
        expect(fullState.weather).toBe('clear');
        expect(JSON.parse(fullState.inventory)).toEqual(['lantern', 'spyglass']);
    });
});
