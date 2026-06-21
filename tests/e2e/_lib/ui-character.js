// Real-UI helpers for character management: import via file picker, create,
// edit fields, duplicate, delete (with confirm popup), bulk-select operations,
// avatar upload.
//
// Every helper uses real DOM gestures — no raw fetch('/api/characters/...'),
// no direct ctx.characters mutation. Tests that bypass these helpers are
// going against the audit's intent.

import { expect } from '@playwright/test';
import { acceptTopmostPopup, fillTopmostPopupAndAccept } from './page.js';

/**
 * Open the right nav (character list) drawer if it's closed.
 */
async function ensureRightDrawerOpen(page) {
    const drawer = page.locator('#rightNavDrawerIcon');
    const closed = await drawer.evaluate(el => el.classList.contains('closedIcon')).catch(() => true);
    if (closed) {
        await drawer.click();
        await page.locator('#rm_print_characters_block').waitFor({ state: 'visible', timeout: 10_000 });
    }
}

/**
 * Import a character file (PNG / JSON / charx / byaf) by clicking the real
 * import button and uploading the file via setInputFiles.
 *
 * Asserts the imported character appears in #rm_print_characters_block
 * within timeoutMs (default 30s — large files take a while to parse).
 */
export async function importCharacterFile(page, { filePath, expectedName, timeoutMs = 30_000 } = {}) {
    if (!filePath) throw new Error('importCharacterFile: filePath required');
    if (!expectedName) throw new Error('importCharacterFile: expectedName required');
    await ensureRightDrawerOpen(page);
    // The visible button is #character_import_button (icon); clicking it
    // triggers the hidden file input #character_import_file. Drive the
    // input directly via setInputFiles — that's the documented Playwright
    // pattern for file pickers.
    await page.locator('#character_import_button').click().catch(() => { /* not strictly required, but flexes the visible icon */ });
    await page.locator('#character_import_file').setInputFiles(filePath);
    // Wait for the new card to appear.
    const card = page.locator('#rm_print_characters_block .character_select', { hasText: expectedName }).first();
    await card.waitFor({ state: 'visible', timeout: timeoutMs });
}

/**
 * Create a blank character by clicking "Create New Character" → typing the
 * name → clicking save.
 *
 * The form has two layers:
 *   - Top fields (name, description, firstmes) live in the inline create
 *     panel.
 *   - Advanced fields (personality, scenario, system_prompt, etc.) live
 *     inside `#advanced_div`, which is a popup opened from the same panel.
 *     We open it on demand only if the caller supplied any advanced field.
 *
 * Submission goes through the visible label `#create_button_label` — the
 * underlying `<input id="create_button">` is hidden and Playwright refuses
 * to click hidden elements.
 *
 * @param {object} fields  All fields are optional; only those provided
 *   are populated. Recognized keys map to ST's character form ids:
 *     name, description, firstmes, personality, scenario, mes_example,
 *     creator_notes, system_prompt, post_history_instructions,
 *     tags (comma-separated), creator, character_version.
 */
export async function createBlankCharacter(page, fields = {}) {
    await ensureRightDrawerOpen(page);
    await page.locator('#rm_button_create').click();
    const nameInput = page.locator('#character_name_pole');
    await nameInput.waitFor({ state: 'visible', timeout: 10_000 });
    if (fields.name) await nameInput.fill(fields.name);

    // Always-visible fields.
    const TOP_FIELDS = {
        description: '#description_textarea',
        firstmes: '#firstmessage_textarea',
        creator_notes: '#creator_notes_textarea',
        tags: '#tags_input',
    };
    for (const [key, sel] of Object.entries(TOP_FIELDS)) {
        if (fields[key] == null) continue;
        const loc = page.locator(sel);
        if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
            await loc.fill(String(fields[key]));
        }
    }

    // Advanced fields live in a popup opened by the "Advanced Definitions"
    // button (`#advanced_div_open` or similar). Only open it if needed.
    const ADV_FIELDS = ['personality', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator', 'character_version'];
    const wantsAdv = ADV_FIELDS.some(k => fields[k] != null);
    if (wantsAdv) {
        const advTrigger = page.locator('#advanced_div_open, [data-action="open-advanced-def"], button:has-text("Advanced")').first();
        if (await advTrigger.isVisible({ timeout: 1500 }).catch(() => false)) {
            await advTrigger.click();
        }
        // Inline drawers within #advanced_div fold sections; expand any
        // that are closed so the textareas are visible to fill.
        await page.evaluate(() => {
            document.querySelectorAll('#advanced_div .inline-drawer-toggle, #advanced_div .inline-drawer-header').forEach(el => {
                const drawer = el.closest('.inline-drawer');
                const content = drawer?.querySelector('.inline-drawer-content');
                if (content && (content.style.display === 'none' || getComputedStyle(content).display === 'none')) {
                    el.click();
                }
            });
        });
        const ADV_MAP = {
            personality: '#personality_textarea',
            scenario: '#scenario_pole',
            mes_example: '#mes_example_textarea',
            system_prompt: '#system_prompt_textarea',
            post_history_instructions: '#post_history_instructions_textarea',
            creator: '#creator_textarea',
            character_version: '#character_version_textarea',
        };
        for (const [key, sel] of Object.entries(ADV_MAP)) {
            if (fields[key] == null) continue;
            const loc = page.locator(sel).first();
            if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
                await loc.fill(String(fields[key]));
            }
        }
    }

    // Submit via the visible label (the actual <input id="create_button">
    // is display:none in current builds).
    const submit = page.locator('#create_button_label').first();
    if (await submit.isVisible({ timeout: 1000 }).catch(() => false)) {
        await submit.click();
    } else {
        // Fallback to the input itself with force (older layouts).
        await page.locator('#create_button').click({ force: true });
    }
    if (fields.name) {
        const card = page.locator('#rm_print_characters_block .character_select', { hasText: fields.name }).first();
        await card.waitFor({ state: 'visible', timeout: 20_000 });
    }
}

/**
 * Update fields on the currently-selected character via the edit panel.
 * Caller must have already opened the character (via selectCharacterByName).
 */
export async function editSelectedCharacterFields(page, fields = {}) {
    const FIELD_MAP = {
        name: '#character_name_pole',
        description: '#description_textarea',
        firstmes: '#firstmessage_textarea',
        personality: '#personality_textarea',
        scenario: '#scenario_pole',
        mes_example: '#mes_example_textarea',
        creator_notes: '#creator_notes_textarea',
        system_prompt: '#system_prompt_textarea',
        post_history_instructions: '#post_history_instructions_textarea',
        tags: '#tags_input',
    };
    for (const [key, sel] of Object.entries(FIELD_MAP)) {
        if (fields[key] == null) continue;
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
            await loc.fill(String(fields[key]));
            // Many ST forms autosave on blur; trigger one for safety.
            await loc.blur();
        }
    }
    // Wait for ST's autosave debounce to fire.
    await page.waitForTimeout(800);
}

/**
 * Upload a new avatar for the currently-selected character via the hidden
 * character-avatar file input. Note: `#avatar_upload_file` is the *persona*
 * input — characters use a different hidden input mounted under the
 * `#add_avatar_button` label.
 */
export async function uploadAvatarForSelected(page, avatarPath) {
    // The character avatar's hidden input lives inside the
    // <label id="add_avatar_button">. Drive it via the descendant
    // input[type=file] so we don't have to know its exact id (which
    // varies across builds).
    const input = page.locator('#add_avatar_button input[type="file"], #add_avatar_button[type="file"]').first();
    await input.setInputFiles(avatarPath);
    // Some builds open a crop popup; accept it if present.
    const popup = page.locator('.popup:visible, dialog.popup[open]').last();
    if (await popup.isVisible({ timeout: 1500 }).catch(() => false)) {
        await popup.locator('.popup-button-ok').first().click().catch(() => {});
    }
    await page.waitForTimeout(800);
}

/**
 * Duplicate the currently-selected character via the duplicate icon.
 * Returns the new card's avatar filename (the server appends `_N` to the
 * source's avatar). Display name is identical between source and dup —
 * callers needing a unique identifier should use the returned avatar.
 */
export async function duplicateSelectedCharacter(page, { timeoutMs = 20_000 } = {}) {
    const beforeAvatars = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return ctx.characters.map(c => c?.avatar || '').filter(Boolean);
    });
    await page.locator('#dupe_button').click();
    // The confirm popup may take a few seconds to render on cold start.
    const ok = page.locator('.popup:visible .popup-button-ok, dialog.popup[open] .popup-button-ok').first();
    if (await ok.isVisible({ timeout: 5000 }).catch(() => false)) {
        await ok.click();
    }
    // Wait for the character list to grow.
    await page.waitForFunction((before) => {
        const ctx = window.Luker.getContext?.();
        return ctx && Array.isArray(ctx.characters) && ctx.characters.length > before;
    }, beforeAvatars.length, { timeout: timeoutMs });
    const afterAvatars = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return ctx.characters.map(c => c?.avatar || '').filter(Boolean);
    });
    const newAvatar = afterAvatars.find(a => !beforeAvatars.includes(a));
    return newAvatar;
}

/**
 * Delete the currently-selected character via the trash icon + confirm
 * popup OK.
 */
export async function deleteSelectedCharacter(page, { timeoutMs = 15_000 } = {}) {
    await page.locator('#delete_button').click();
    // The delete confirm popup includes a checkbox + OK. Tick the
    // confirmation checkbox if present, then click OK.
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    const confirmCheckbox = popup.locator('input[type="checkbox"]').first();
    if (await confirmCheckbox.isVisible({ timeout: 500 }).catch(() => false)) {
        await confirmCheckbox.check().catch(() => {});
    }
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});
}

/**
 * Enter bulk-select mode (the multi-checkbox UI on the character list)
 * and toggle the checkboxes for the named characters.
 *
 * The `.bulk_select_checkbox` elements have computed visibility 0 in
 * headless (they're styled to appear only via the surrounding label),
 * so Playwright's `force:true` still refuses to click them. Dispatch
 * the click via JS instead.
 */
export async function bulkSelectCharacters(page, names = []) {
    // Toggle bulk-select mode. Current builds use `#bulkEditButton`.
    const modeBtn = page.locator('#bulkEditButton, #rm_bulk_select, [data-action="bulk-edit"]').first();
    if (await modeBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await modeBtn.click();
    }
    // For each requested name, locate the row + tick the checkbox via JS.
    for (const name of names) {
        await page.evaluate((wanted) => {
            const rows = Array.from(document.querySelectorAll('#rm_print_characters_block .character_select'));
            const row = rows.find(r => (r.textContent || '').includes(wanted));
            if (!row) throw new Error(`character "${wanted}" not in list`);
            const cb = row.querySelector('input.bulk_select_checkbox, input[type="checkbox"]');
            if (cb && !cb.checked) cb.click();
        }, name);
    }
}

/**
 * Click the bulk-delete button and accept the confirm.
 */
export async function bulkDeleteSelected(page, { timeoutMs = 15_000 } = {}) {
    const btn = page.locator('#bulkDeleteButton, [data-action="bulk-delete"]').first();
    await btn.click();
    const popup = page.locator('.popup:visible, dialog.popup[open]').last();
    if (await popup.isVisible({ timeout: 2000 }).catch(() => false)) {
        await popup.locator('.popup-button-ok').first().click();
        await popup.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});
    }
}
