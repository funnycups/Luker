// Real-UI helpers for AI iteration inside the unified Workbench.
// Maps legacy studio variant names ('cpa', 'orch', 'cea', 'mg', 'mg-graph',
// 'world') onto real Workbench UI gestures (open Workbench -> AI iteration tab ->
// target segmented control -> composer fill + Send -> Apply selected / Discard / Undo).

import {
    applyWorkbenchChanges,
    closeWorkbench,
    discardWorkbenchChanges,
    openWorkbenchIterate,
    sendWorkbenchIterationPrompt,
    undoWorkbenchChangeCard,
} from './ui-workbench.js';

/**
 * Open Workbench AI iteration for the given variant via real DOM clicks.
 */
export async function openIterStudio(page, variant, opts = {}) {
    return openWorkbenchIterate(page, variant, opts);
}

/**
 * Fill the Workbench AI iteration composer, click Send, and wait for the turn to settle.
 */
export async function sendIterPrompt(page, _variant, prompt, { applyTimeoutMs = 60_000, waitForSettle = true } = {}) {
    return sendWorkbenchIterationPrompt(page, prompt, { timeout: applyTimeoutMs, waitForSettle });
}

/**
 * Click `Apply selected` on pending `.wb-chg.is-pending` change batch(es).
 */
export async function applyIterBatch(page, _variant, { timeoutMs = 30_000, all = true } = {}) {
    const win = page.locator('.wbench .wb-win').first();
    const pending = win.locator('.wb-chg.is-pending');
    await pending.first().waitFor({ state: 'visible', timeout: timeoutMs });
    if (!all) {
        await applyWorkbenchChanges(page, { timeout: timeoutMs });
        return;
    }
    while (await pending.count() > 0) {
        const popupsBefore = await page.locator('dialog.popup[open]').count();
        await applyWorkbenchChanges(page, { index: 0, timeout: timeoutMs });
        if ((await page.locator('dialog.popup[open]').count()) > popupsBefore) break;
    }
}

/**
 * Click `Discard everything` on pending `.wb-chg.is-pending` change batch(es).
 */
export async function discardIterBatch(page, _variant, { timeoutMs = 10_000, all = true } = {}) {
    const win = page.locator('.wbench .wb-win').first();
    const pending = win.locator('.wb-chg.is-pending');
    await pending.first().waitFor({ state: 'visible', timeout: timeoutMs });
    if (!all) {
        await discardWorkbenchChanges(page, { timeout: timeoutMs });
        return;
    }
    while (await pending.count() > 0) {
        await discardWorkbenchChanges(page, { index: 0, timeout: timeoutMs });
    }
}

/**
 * Click `Undo` on applied `.wb-chg:is(.is-applied, .is-partial)` card(s).
 */
export async function rollbackIterBatch(page, _variant, { timeoutMs = 15_000, turn = false } = {}) {
    const win = page.locator('.wbench .wb-win').first();
    const applied = win.locator('.wb-chg:is(.is-applied, .is-partial)');
    await applied.first().waitFor({ state: 'visible', timeout: timeoutMs });
    if (!turn) {
        await undoWorkbenchChangeCard(page, { timeout: timeoutMs });
        return;
    }
    while (await applied.count() > 0) {
        await undoWorkbenchChangeCard(page, { timeout: timeoutMs });
    }
}

/**
 * Fold the Workbench window back to its corner pill.
 */
export async function closeIterStudio(page) {
    await closeWorkbench(page);
}
