// Real-UI helpers for the four iter-studio popups (CPA / Orchestrator iter /
// CEA editor / MG schema). Each plugin exposes a different per-plugin
// action-attribute for the Send button; the Approve/Reject/Rollback
// affordances all live on the shared proposal-bus (data-proposal-action).
//
//   await openIterStudio(page, 'cpa');
//   await sendIterPrompt(page, 'cpa', 'lower temperature to 0.5');
//   await applyIterBatch(page, 'cpa');
//
// The mock LLM should be scripted to return the appropriate tool_calls
// before sendIterPrompt() so the studio renders a pending proposal card
// with an Approve button.

import { expect } from '@playwright/test';
import { openExtensionsDrawer, openInlineDrawer } from './page.js';

const VARIANT_MAP = {
    cpa: {
        // CPA: open via the assistant settings panel's "Open Assistant" button.
        openTrigger: '#completion_preset_assistant_open',
        actionAttr: 'data-cpa-it-action',
        // The mounted popup uses a CPA-specific input shell ID. We accept any
        // descendant of a visible popup matching the input class.
        inputSelector: '[data-cpa-it-input], .cpa_it_composer_input textarea, .cpa_it_composer_input [contenteditable="true"]',
    },
    orch: {
        // Orchestrator iter-studio: open via the orchestrator panel's
        // "Open AI Iteration Studio" button. The orchestrator panel itself
        // must already be expanded (callers can call openOrchestratorPanel
        // before this; openIterStudio handles the common case automatically).
        openTrigger: '[data-luker-action="ai-iterate-open"]',
        actionAttr: 'data-orch-it-action',
        inputSelector: '[data-orch-it-input], .orch_it_composer_input textarea, .orch_it_composer_input [contenteditable="true"]',
    },
    cea: {
        // CEA editor iter-studio: opened via the CEA editor's "Open Editor"
        // button, which itself mounts a popup containing the iter shell.
        openTrigger: '#cea_open_editor_popup',
        actionAttr: 'data-cea-editor-action',
        inputSelector: '[data-cea-editor-input], .cea_editor_composer_input textarea, .cea_editor_composer_input [contenteditable="true"]',
    },
    mg: {
        // MG schema iter-studio: opened via the MG settings panel's
        // "AI Iterate Schema" button.
        openTrigger: '#luker_rpg_memory_open_schema_studio',
        actionAttr: 'data-mg-schema-it-action',
        inputSelector: '[data-mg-schema-it-input], .mg_schema_it_composer_input textarea, .mg_schema_it_composer_input [contenteditable="true"]',
    },
};

/**
 * Open one of the four iter-studio popups. Walks the necessary drawer
 * gestures (extensions drawer + the plugin's inline-drawer) then clicks
 * the open trigger. Throws if the popup doesn't mount within timeoutMs.
 *
 * @param {import('@playwright/test').Page} page
 * @param {'cpa'|'orch'|'cea'|'mg'} variant
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 */
export async function openIterStudio(page, variant, { timeoutMs = 20_000 } = {}) {
    const v = VARIANT_MAP[variant];
    if (!v) throw new Error(`unknown iter-studio variant: ${variant}`);
    await openExtensionsDrawer(page);
    // Open the per-plugin inline-drawer that contains the open button.
    const hostMap = {
        cpa: 'completion_preset_assistant_settings',
        orch: 'orchestrator_settings',
        cea: 'character_editor_assistant_settings',
        mg: 'memory_graph_settings',
    };
    const host = hostMap[variant];
    if (host) {
        await openInlineDrawer(page, host).catch(() => { /* may already be open */ });
    }
    // For the orchestrator there are several "Open AI Iteration Studio"
    // buttons (one per mode panel + per director board). Pick the first
    // VISIBLE one so we don't try to click an off-screen instance.
    const trigger = page.locator(`${v.openTrigger}:visible`).first();
    await trigger.waitFor({ state: 'visible', timeout: timeoutMs });
    await trigger.click();
    // The iter-studio popup is a Luker popup with the iter shell mounted
    // inside. Wait for the variant-specific Send button to render.
    const sendBtn = page.locator(`[${v.actionAttr}="send"]`).last();
    await sendBtn.waitFor({ state: 'visible', timeout: timeoutMs });
}

/**
 * Fill the iter-studio prompt input and click Send. Awaits the
 * post-tool-call render (an Approve button on a proposal card) before
 * returning, so callers can immediately assert + applyIterBatch.
 *
 * If the mock LLM doesn't script a tool_call, no proposal is rendered and
 * this hangs until applyTimeoutMs.
 */
export async function sendIterPrompt(page, variant, prompt, { applyTimeoutMs = 60_000 } = {}) {
    const v = VARIANT_MAP[variant];
    if (!v) throw new Error(`unknown iter-studio variant: ${variant}`);
    const popup = page.locator('.popup:visible').last();
    const input = popup.locator(v.inputSelector).first();
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    const tag = await input.evaluate(el => el.tagName.toLowerCase());
    if (tag === 'textarea' || tag === 'input') {
        await input.fill(prompt);
    } else {
        await input.click();
        await input.press('ControlOrMeta+a');
        await input.press('Delete');
        await input.type(prompt);
    }
    const sendBtn = popup.locator(`[${v.actionAttr}="send"]`).first();
    await sendBtn.click();
    // Approve button (proposal-bus) appears once the LLM has returned and
    // edits are pending. Per-card uses data-proposal-action="approve";
    // turn-level uses data-proposal-action="approve-all-pending".
    const approveBtn = popup.locator(
        '[data-proposal-action="approve"], [data-proposal-action="approve-all-pending"]',
    ).first();
    await approveBtn.waitFor({ state: 'visible', timeout: applyTimeoutMs });
}

/**
 * Click the Approve button(s) (proposal-bus). Prefers the turn-level
 * "Approve all pending" affordance; otherwise iterates every per-card
 * Approve button currently visible — this is what a real user does when
 * the studio holds multiple pending proposals across batched LLM rounds
 * (each round renders one card; turn-level "approve all" only appears
 * when a SINGLE message holds 2+ entries).
 *
 * After 2026-Q2, iter-studios migrated to the proposal-bus model — every
 * pending tool_call becomes a card with [data-proposal-action="approve"],
 * and a turn-level [data-proposal-action="approve-all-pending"] groups
 * them. The old [data-*-it-action="apply-batch"] form no longer exists.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.all=true]  Prefer turn-level "approve all pending".
 */
export async function applyIterBatch(page, variant, { timeoutMs = 30_000, all = true } = {}) {
    const v = VARIANT_MAP[variant];
    if (!v) throw new Error(`unknown iter-studio variant: ${variant}`);
    const popup = page.locator('.popup:visible').last();
    if (all) {
        const approveAll = popup.locator('[data-proposal-action="approve-all-pending"]').first();
        if (await approveAll.isVisible({ timeout: 1000 }).catch(() => false)) {
            await approveAll.click();
            // After approval the turn-level button is replaced by the
            // committed-state card chrome.
            await approveAll.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});
            return;
        }
    }
    // Per-card approves: each pending card has its own Approve button.
    // The bus pump can re-render between clicks (committing one entry
    // triggers a drainBusOutcomes → render cycle), so we re-query the
    // first visible Approve each iteration rather than caching locators.
    // Loop exits when no Approve button is visible within a short window.
    while (true) {
        const approveBtn = popup.locator('[data-proposal-action="approve"]').first();
        const visible = await approveBtn.isVisible({ timeout: 2000 }).catch(() => false);
        if (!visible) break;
        await approveBtn.click();
        await approveBtn.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});
    }
}

/**
 * Click the Reject button (proposal-bus). Prefers turn-level
 * "reject-all-pending"; falls back to per-card reject.
 */
export async function discardIterBatch(page, variant, { timeoutMs = 10_000, all = true } = {}) {
    const v = VARIANT_MAP[variant];
    if (!v) throw new Error(`unknown iter-studio variant: ${variant}`);
    const popup = page.locator('.popup:visible').last();
    if (all) {
        const rejectAll = popup.locator('[data-proposal-action="reject-all-pending"]').first();
        if (await rejectAll.isVisible({ timeout: 1000 }).catch(() => false)) {
            await rejectAll.click();
            await rejectAll.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});
            return;
        }
    }
    const rejectBtn = popup.locator('[data-proposal-action="reject"]').first();
    await rejectBtn.waitFor({ state: 'visible', timeout: timeoutMs });
    await rejectBtn.click();
    await rejectBtn.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});
}

/**
 * Click the Rollback button on a previously-committed proposal. Bus model:
 * per-card data-proposal-action="rollback" or turn-level "rollback-turn".
 */
export async function rollbackIterBatch(page, variant, { timeoutMs = 10_000, turn = false } = {}) {
    const v = VARIANT_MAP[variant];
    if (!v) throw new Error(`unknown iter-studio variant: ${variant}`);
    const popup = page.locator('.popup:visible').last();
    const selector = turn
        ? '[data-proposal-action="rollback-turn"]'
        : '[data-proposal-action="rollback"]';
    const rollbackBtn = popup.locator(selector).first();
    await rollbackBtn.waitFor({ state: 'visible', timeout: timeoutMs });
    await rollbackBtn.click();
}

/**
 * Close the currently-open iter-studio popup by clicking the Luker popup
 * close (or X) button. Falls back to Escape if none found.
 */
export async function closeIterStudio(page) {
    const popup = page.locator('.popup:visible').last();
    const closeBtn = popup.locator('.popup-button-close, .fa-xmark[role="button"], [data-popup-close]').first();
    if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await closeBtn.click();
    } else {
        await page.keyboard.press('Escape');
    }
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}
