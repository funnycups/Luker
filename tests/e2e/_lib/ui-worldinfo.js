// Real-UI helpers for World Info / lorebook flows.
//
// All gestures go through real DOM affordances: WI drawer toggle, book
// import via setInputFiles on #world_import_button's hidden input, entry
// creation via #world_popup_new, field edits via the rendered entry form,
// bulk-edit popup via the bulk-edit button + apply, export/delete via
// the dedicated icons.

import { expect } from '@playwright/test';

/**
 * Open the WI panel drawer (#WIDrawerIcon). Idempotent.
 */
export async function openWorldInfoDrawer(page) {
    const icon = page.locator('#WIDrawerIcon');
    const isClosed = await icon.evaluate(el => el.classList.contains('closedIcon')).catch(() => true);
    if (isClosed) {
        await icon.click();
    }
    await page.locator('#world_popup').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Select a world book by name from the editor select (#world_editor_select).
 * Triggers the real change event so the entries panel populates.
 */
export async function selectWorldBook(page, name) {
    await openWorldInfoDrawer(page);
    const sel = page.locator('#world_editor_select');
    await sel.waitFor({ state: 'visible', timeout: 5000 });
    await sel.selectOption({ label: name });
    // Wait for entries list to render.
    await page.waitForTimeout(400);
}

/**
 * Import a world book file via the real import button.
 *
 * The icon #world_import_button triggers the hidden #world_import_file
 * input. Drive setInputFiles directly.
 */
export async function importWorldBook(page, { filePath, expectedName, timeoutMs = 30_000 } = {}) {
    if (!filePath) throw new Error('importWorldBook: filePath required');
    await openWorldInfoDrawer(page);
    await page.locator('#world_import_button').click().catch(() => { /* visible icon */ });
    await page.locator('#world_import_file').setInputFiles(filePath);
    if (expectedName) {
        await page.waitForFunction((wanted) => {
            const sel = document.querySelector('#world_editor_select');
            if (!sel) return false;
            return Array.from(sel.options).some(o => o.textContent === wanted);
        }, expectedName, { timeout: timeoutMs });
    }
}

/**
 * Click the export icon (#world_popup_export) on the currently-selected
 * book and wait for the download. Returns the saved file path.
 */
export async function exportSelectedWorldBook(page, { timeoutMs = 15_000 } = {}) {
    await openWorldInfoDrawer(page);
    const downloadPromise = page.waitForEvent('download', { timeout: timeoutMs });
    await page.locator('#world_popup_export').click();
    return downloadPromise;
}

/**
 * Delete the currently-selected world book via #world_popup_delete and
 * confirm.
 */
export async function deleteSelectedWorldBook(page, { timeoutMs = 10_000 } = {}) {
    await openWorldInfoDrawer(page);
    await page.locator('#world_popup_delete').click();
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});
}

/**
 * Create a new lorebook by clicking #world_create_button, entering a name
 * in the popup, and confirming.
 */
export async function createWorldBook(page, name, { timeoutMs = 10_000 } = {}) {
    await openWorldInfoDrawer(page);
    await page.locator('#world_create_button').click();
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    const input = popup.locator('input[type="text"], textarea').first();
    await input.fill(name);
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});
    // The new book should be selected automatically.
}

/**
 * Add a new entry to the currently-selected book via #world_popup_new and
 * populate the visible form fields. The entry's UID is returned.
 *
 * @param {object} fields  { key, content, comment?, constant?, depth?, order?, vectorized? }
 */
export async function addWorldEntry(page, fields = {}) {
    await openWorldInfoDrawer(page);
    await page.locator('#world_popup_new').click();
    // Wait for the new entry row to render — it's the last .world_entry.
    const entryRow = page.locator('.world_entry').last();
    await entryRow.waitFor({ state: 'visible', timeout: 5000 });
    if (fields.key) {
        const keyInput = entryRow.locator('.keyprimary input, .keyprimary textarea, [name="key"]').first();
        if (await keyInput.isVisible({ timeout: 500 }).catch(() => false)) {
            // Some WI key inputs use a select2 widget; falling back to fill
            // works for the plain input shape.
            await keyInput.fill(Array.isArray(fields.key) ? fields.key.join(',') : String(fields.key));
            await keyInput.blur();
        }
    }
    if (fields.content) {
        const contentArea = entryRow.locator('textarea[name="content"], .world_entry_form_content textarea').first();
        await contentArea.fill(String(fields.content));
        await contentArea.blur();
    }
    if (fields.comment != null) {
        const commentArea = entryRow.locator('input[name="comment"], textarea[name="comment"]').first();
        if (await commentArea.isVisible({ timeout: 300 }).catch(() => false)) {
            await commentArea.fill(String(fields.comment));
            await commentArea.blur();
        }
    }
    // Allow ST's autosave debounce to flush.
    await page.waitForTimeout(400);
}

/**
 * Read all visible entry rows on the currently-selected book and return
 * their rendered key + content. Useful as a DOM-side assertion.
 */
export async function getRenderedWorldEntries(page) {
    return page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.world_entry'));
        return rows.map(r => {
            const keyEl = r.querySelector('.keyprimary input, .keyprimary textarea, [name="key"]');
            const contentEl = r.querySelector('textarea[name="content"], .world_entry_form_content textarea');
            const commentEl = r.querySelector('input[name="comment"], textarea[name="comment"]');
            return {
                key: keyEl?.value || '',
                content: contentEl?.value || '',
                comment: commentEl?.value || '',
            };
        });
    });
}
