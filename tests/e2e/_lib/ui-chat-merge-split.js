// Playwright helpers for the chat merge/split dialogs.
//
// These wrap the real-user gestures for opening, configuring, and
// submitting the merge and split dialogs introduced by the
// chat-merge-split feature. Tasks 12-15 import these helpers; nothing
// here triggers product logic via page.evaluate — the only evaluate()
// blocks are CHAT_CHANGED listeners that observe ST state.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { openOptionsAndClick } from './page.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCREENSHOTS_DIR = path.resolve(__dirname, '../../../docs/public/screenshots/chat-merge-split');

/**
 * Take a step screenshot under docs/public/screenshots/chat-merge-split/.
 *
 * DEFAULT: no-op. The chat merge/split e2e specs are regression tests,
 * not a docs screenshot generator. Writing into docs/ on every
 * regression run means:
 *   - CI leaves the working tree dirty,
 *   - a subtle mock-LLM wording change silently rewrites doc images,
 *   - the in-tree docs screenshots (which the /features/chat-merge-split
 *     doc references) can be overwritten by a partial / failing run.
 *
 * To rebuild the doc screenshots deliberately, opt-in:
 *   LUKER_UPDATE_DOC_SCREENSHOTS=1 npx playwright test e2e/chat/{15,16,18,19,20}*.e2e.js
 *
 * The current in-tree images under docs/public/screenshots/chat-merge-split/
 * remain the canonical set and are committed to git.
 */
export async function takeStepScreenshot(page, slug) {
    if (!process.env.LUKER_UPDATE_DOC_SCREENSHOTS) return null;
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const file = path.join(SCREENSHOTS_DIR, `${slug}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
}

/**
 * Open Past Chats via the options dropdown and click the header
 * "Merge chats" button. Returns the merge dialog locator.
 *
 * Idempotent w.r.t. the past-chats popup: if some prior gesture (most
 * commonly the rename handler, which re-triggers option_select_chat on
 * a 250ms delay after rename completes) has already opened the popup,
 * we skip the options-dropdown click and reach for the Merge button
 * directly. This avoids fighting the shadow overlay's pointer capture.
 */
export async function openMergeDialogViaUI(page) {
    const popupAlreadyOpen = await page.evaluate(() => {
        const shadow = document.querySelector('#shadow_select_chat_popup');
        if (!shadow) return false;
        const style = window.getComputedStyle(shadow);
        return style.display !== 'none' && Number(style.opacity || '1') > 0.1;
    });
    if (!popupAlreadyOpen) {
        await openOptionsAndClick(page, 'option_select_chat');
    }
    await page.locator('#select_chat_popup').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#merge_chats_button').click();
    const dialog = page.locator('.cms-dialog').first();
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    return dialog;
}

/**
 * Click "+ Add chat" in the merge dialog, pick a chat by its file_name
 * (without the .jsonl extension), and confirm the picker popup.
 */
export async function addSourceToMerge(page, dialog, chatFileName) {
    await dialog.locator('.cms-add-chat').click();
    const picker = page.locator('.cms-picker').first();
    await picker.waitFor({ state: 'visible', timeout: 10_000 });
    await picker.locator(`input[type="radio"][value="${chatFileName}"]`).check();
    await page.locator('dialog.popup[open]').last().locator('.popup-button-ok').click();
    await picker.waitFor({ state: 'detached' });
}

/**
 * Type from/to values into a specific segment row in the merge dialog.
 */
export async function setSegmentRangeInDialog(dialog, index, from, to) {
    const row = dialog.locator('.cms-segment-row').nth(index);
    await row.locator('.cms-range-from').fill(String(from));
    await row.locator('.cms-range-to').fill(String(to));
}

/**
 * Drag a segment row by its handle from one index to another. Uses
 * Playwright's dragTo on the .cms-drag-handle elements; jQuery UI
 * sortable handles the actual reordering.
 */
export async function dragSegmentToIndex(dialog, fromIdx, toIdx) {
    const handles = dialog.locator('.cms-drag-handle');
    await handles.nth(fromIdx).dragTo(handles.nth(toIdx));
}

/**
 * Fill the merge dialog's target-name field and click OK. When
 * awaitNavigation is true (default), returns a promise that resolves
 * with the new chat id after CHAT_CHANGED fires. The listener attaches
 * BEFORE the click to avoid losing the event.
 */
export async function submitMergeDialog(page, dialog, targetName, { awaitNavigation = true, timeoutMs = 30_000 } = {}) {
    await dialog.locator('.cms-target-name').fill(targetName);
    const dialogElement = page.locator('dialog.popup[open]').last();
    if (awaitNavigation) {
        const navPromise = page.evaluate((to) => new Promise((resolve, reject) => {
            const ctx = window.Luker.getContext();
            const timer = setTimeout(() => reject(new Error('chat_changed timeout')), to);
            const off = ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, (id) => {
                clearTimeout(timer);
                try { ctx.eventSource.removeListener(ctx.eventTypes.CHAT_CHANGED, off); } catch {}
                resolve(id);
            });
        }), timeoutMs);
        await dialogElement.locator('.popup-button-ok').click();
        return navPromise;
    }
    await dialogElement.locator('.popup-button-ok').click();
    return null;
}

/**
 * Open the split dialog for a specific message by clicking the message's
 * extras hint to reveal the action row, then clicking .mes_split_chat.
 * Returns the split dialog locator.
 */
export async function openSplitDialogViaUI(page, mesid) {
    const mes = page.locator(`.mes[mesid="${mesid}"]`);
    await mes.waitFor({ state: 'visible', timeout: 10_000 });
    await mes.locator('.extraMesButtonsHint').first().click({ force: true });
    await mes.locator('.mes_split_chat').first().click();
    const dialog = page.locator('.cms-dialog-split').first();
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    return dialog;
}

/**
 * Set the split-point list to exactly `points` by adding/removing
 * .cms-split-point-cell rows from the current state (the dialog opens
 * with 1 point pre-filled, so this normalises down or up as needed)
 * then filling each input with the requested value.
 */
export async function setSplitPoints(dialog, points) {
    while ((await dialog.locator('.cms-split-point-cell').count()) > points.length) {
        await dialog.locator('.cms-remove-point').last().click();
    }
    while ((await dialog.locator('.cms-split-point-cell').count()) < points.length) {
        await dialog.locator('.cms-add-split-point').click();
    }
    for (let i = 0; i < points.length; i++) {
        await dialog.locator('.cms-split-point-input').nth(i).fill(String(points[i]));
    }
}

/**
 * Set the name of a specific generated split segment. Waits for the
 * segment row to settle after any pending re-render before filling.
 */
export async function setSplitSegmentName(dialog, segIdx, name) {
    const row = dialog.locator('.cms-split-segment-row').nth(segIdx);
    await row.waitFor({ state: 'visible', timeout: 5000 });
    await row.locator('.cms-split-segment-name').fill(name);
}

/**
 * Click OK on the split dialog and wait for it to close. Caller is
 * responsible for any subsequent assertions on the resulting chats.
 */
export async function submitSplitDialog(page, dialog) {
    const dialogElement = page.locator('dialog.popup[open]').last();
    await dialogElement.locator('.popup-button-ok').click();
    await dialog.waitFor({ state: 'detached' });
}
