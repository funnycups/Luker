// Real-UI helpers for AI iteration inside the unified Workbench.
// Maps studio variant names ('cpa', 'orch', 'cea', 'mg', 'mg-graph', 'world')
// onto real Workbench UI gestures (open Workbench -> AI iteration tab ->
// target segmented control -> composer fill + Send -> Apply selected / Discard / Undo).

import { expect } from '@playwright/test';
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
export async function applyIterBatch(page, _variant, { timeoutMs = 30_000, all = true, count = null } = {}) {
    const win = page.locator('.wbench .wb-win').first();
    const pending = win.locator('.wb-chg.is-pending');
    await pending.first().waitFor({ state: 'visible', timeout: timeoutMs });
    if (count !== null) {
        if (!Number.isInteger(count) || count < 1) {
            throw new RangeError(`applyIterBatch count must be a positive integer (got ${count})`);
        }
        for (let i = 0; i < count; i++) {
            await pending.first().waitFor({ state: 'visible', timeout: timeoutMs });
            await applyWorkbenchChanges(page, { index: 0, timeout: timeoutMs });
        }
        // Wait for any in-flight generation to settle before asserting final cardinality
        // so a transient pause while streaming is not mistaken for final completeness.
        await expect.poll(async () => {
            const liveCount = await win.locator('.wb-reads.is-live').count();
            const stopVisible = await win.locator('.wb-msg-ai:has(.wb-reads.is-live) button').isVisible().catch(() => false);
            return liveCount === 0 && !stopVisible;
        }, { timeout: timeoutMs, intervals: [100, 250] }).toBe(true);
        const remaining = await pending.count();
        if (remaining > 0) {
            throw new Error(`applyIterBatch expected exactly ${count} pending change batch(es), but ${remaining} extra pending batch(es) remained after turn settled`);
        }
        return;
    }
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
