// #109 — iter-diff card stays readable at 400px viewport (commit 7ffab6526)
//
// Bug shape: at narrow viewports the iter-diff header used flex with no
// wrap; long path strings and the +N/-M chips would each be forced onto
// their own row mid-string, chopping chars off the path.
//
// Fix: `.luker_lib_diff_header` got `flex-wrap: wrap`; chip spans got
// `white-space: nowrap`; path text got `overflow-wrap: anywhere`.
//
// REAL USER FLOW: open the orchestrator iter-studio popup at 400px
// viewport, script the LLM to emit a profile-edit tool call (the kind
// the runtime renders via `renderDiffCard`), and assert the diff card
// fits inside the 400-pixel popup body without horizontal overflow and
// without any chip splitting onto two lines.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';

let server, mock;

const VERY_LONG_PROMPT = '*You are Ash, cartographer of the Bryn headland, a brine-bitten coast keeper who reads the reef like a slow ledger.* '
    + 'Hold an immersive register and close every turn with a tactile sense beat — the verdigris on the spyglass, the cold of the lantern bezel, the salt-grit of the rail under a palm.';

test.beforeAll(async () => {
    mock = await startMockLLM();
    server = await startServer({ batchKey: 'regression', scenarioId: '109-iter-diff-narrow', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

// Local inline helpers — _lib/ui-iter-studio.js's helpers are stale
// (assume legacy apply-batch / discard-batch action attrs; iter-library
// now uses a proposal-bus model). The brief forbids editing _lib/, so
// we inline the up-to-date flow here.

async function setOrchModeToDirector(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const modeSelect = page.locator('#luker_orch_execution_mode');
    await modeSelect.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await modeSelect.inputValue()) !== 'director') {
        await modeSelect.selectOption('director');
        await modeSelect.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });
        await page.waitForFunction(() => {
            const board = document.querySelector('#luker_orch_director_board');
            return board && board.offsetParent !== null;
        }, { timeout: 5000 });
    }
    // Flip the Enabled checkbox via the real settings panel — no
    // internal-state mutation. The drawer is already open (we just
    // toggled execution mode above), so the checkbox is visible.
    // bootstrapCustomBackend already cleared requestApi/LlmPresetName.
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await enabled.isChecked())) {
        await enabled.check();
    }
}

async function openOrchIterStudio(page) {
    const openBtn = page.locator('#luker_orch_director_board [data-luker-action="ai-iterate-open"]:visible').first();
    await openBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await openBtn.click();
    const sendBtn = page.locator('[data-orch-it-action="send"]').last();
    await sendBtn.waitFor({ state: 'visible', timeout: 15_000 });
}

async function sendOrchIterPromptAndAwaitProposal(page, text) {
    const popup = page.locator('.popup:visible').last();
    const composer = popup.locator('textarea[data-orch-it-input]').first();
    await composer.waitFor({ state: 'visible', timeout: 10_000 });
    await composer.fill(text);
    const sendBtn = popup.locator('button[data-orch-it-action="send"]').first();
    await sendBtn.click();
    const approveBtn = popup.locator('[data-proposal-action="approve"]').first();
    await approveBtn.waitFor({ state: 'visible', timeout: 60_000 });
}

test.describe('#109 — iter-diff card stays readable at narrow viewport', () => {
    test('diff card chips and path do not overflow a 400px viewport popup', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchModeToDirector(page);

        // Shrink viewport AFTER the bootstrap UI flow has run, so the
        // user-select gate / connect handshake aren't fighting a 400px
        // window. The bug is layout-only and only fires when the diff
        // renders against the narrow viewport — which we set BEFORE the
        // iter-studio popup mounts.
        await page.setViewportSize({ width: 400, height: 800 });

        mock.scriptToolCall({
            name: 'luker_orch_set_director_main_agent',
            arguments: { systemPrompt: VERY_LONG_PROMPT },
        });

        await openOrchIterStudio(page);
        await sendOrchIterPromptAndAwaitProposal(page, 'Update the director main agent to take the voice of Ash.');

        const popup = page.locator('.popup:visible').last();
        const card = popup.locator('.luker_lib_diff_card').first();
        await card.waitFor({ state: 'visible', timeout: 15_000 });

        await page.evaluate(async () => {
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        });

        const measurements = await popup.evaluate((root) => {
            const popupBody = root.querySelector('.popup-body, .popup-content, .luker-iter-workspace') || root;
            const card = root.querySelector('.luker_lib_diff_card');
            const op = card?.querySelector('.luker_lib_diff_op');
            const chips = Array.from(card?.querySelectorAll(
                '.luker_lib_diff_meta_add, .luker_lib_diff_meta_del, .luker_lib_diff_meta',
            ) || []);
            const fontPx = op ? parseFloat(getComputedStyle(op).fontSize) : 14;
            const popupRect = popupBody.getBoundingClientRect();
            const cardRect = card?.getBoundingClientRect();
            const opRect = op?.getBoundingClientRect();
            return {
                popup: popupRect ? { left: popupRect.left, right: popupRect.right, width: popupRect.width } : null,
                card: cardRect ? { left: cardRect.left, right: cardRect.right, width: cardRect.width } : null,
                op: opRect ? { left: opRect.left, right: opRect.right, height: opRect.height } : null,
                chips: chips.map(c => {
                    const r = c.getBoundingClientRect();
                    return { text: c.textContent || '', width: r.width, height: r.height, right: r.right };
                }),
                fontPx,
            };
        });

        expect(measurements.card, 'diff card must mount in the popup').not.toBeNull();
        expect(measurements.op, 'diff op (path) label must render').not.toBeNull();

        const maxChipHeight = measurements.fontPx * 2.5;
        for (const chip of measurements.chips) {
            expect(chip.height,
                `chip "${chip.text}" should not exceed ${maxChipHeight}px (~2.5×font); got ${chip.height}px at font=${measurements.fontPx}px`,
            ).toBeLessThanOrEqual(maxChipHeight);
        }

        expect(measurements.card.right,
            `diff card right=${measurements.card.right} must be inside popup body right=${measurements.popup.right} at 400px viewport`,
        ).toBeLessThanOrEqual(measurements.popup.right + 6);
    });
});
