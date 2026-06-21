// Real-UI helpers for persona management and preset management.
//
// Persona:
//   - openPersonaPanel: open the persona drawer
//   - createPersonaViaUI: clone the default user → rename → describe
//   - selectPersonaByName: click the card in the panel
//   - lockPersonaToCurrentCharacter: click persona-lock
//
// Preset:
//   - selectPresetByName: change #settings_preset_openai
//   - savePresetAs: open menu → "Save preset" → fill popup → confirm
//   - exportSelectedPreset / importPreset: real button + setInputFiles

import { expect } from '@playwright/test';
import { acceptTopmostPopup, fillTopmostPopupAndAccept } from './page.js';

// ──────────────────────────────────────────────────────────────────────────
// Persona
// ──────────────────────────────────────────────────────────────────────────

export async function openPersonaPanel(page) {
    const drawer = page.locator('#persona-management-button');
    const closed = await drawer.locator('.drawer-icon').first().evaluate(el => el.classList.contains('closedIcon')).catch(() => true);
    if (closed) {
        await drawer.locator('.drawer-toggle').first().click();
    }
    await page.locator('#persona-management-block').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Create a new persona by clicking the "+" button. Name + description
 * follow via inline rename + the description textarea.
 */
export async function createPersonaViaUI(page, { name, description = '' } = {}) {
    await openPersonaPanel(page);
    // The "create" affordance is #create_dummy_persona on current builds.
    await page.locator('#create_dummy_persona').click();
    // ST's flow asks for a name in a popup.
    const popup = page.locator('.popup:visible').last();
    if (await popup.isVisible({ timeout: 2000 }).catch(() => false)) {
        const input = popup.locator('input[type="text"], textarea').first();
        await input.fill(name);
        await popup.locator('.popup-button-ok').first().click();
        await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
    if (description) {
        const desc = page.locator('#persona_description');
        await desc.fill(description);
        await desc.blur();
    }
    await page.waitForTimeout(400);
}

/**
 * Select a persona by clicking its card in #persona-management-block.
 */
export async function selectPersonaByName(page, name) {
    await openPersonaPanel(page);
    const card = page.locator('#persona-management-block .avatar-container, #persona-management-block .persona_select', { hasText: name }).first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await card.click();
    await page.waitForTimeout(400);
}

/**
 * Upload a new image for the currently-selected persona via
 * #persona_set_image_button.
 */
export async function uploadPersonaImage(page, imagePath) {
    await openPersonaPanel(page);
    // Click the set-image icon; it triggers a hidden file input the page
    // mounts on demand. Wait for any file input to receive the file.
    await page.locator('#persona_set_image_button').click({ force: true });
    const input = page.locator('input[type="file"]:not([id="character_import_file"]):not([id="world_import_file"])').last();
    await input.waitFor({ state: 'attached', timeout: 5000 });
    await input.setInputFiles(imagePath);
    await page.waitForTimeout(800);
}

/**
 * Rename the currently-selected persona via #persona_rename_button.
 */
export async function renameSelectedPersona(page, newName) {
    await page.locator('#persona_rename_button').click();
    await fillTopmostPopupAndAccept(page, newName);
}

// ──────────────────────────────────────────────────────────────────────────
// Preset (OpenAI/chat-completion)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Select a preset by name via the visible #settings_preset_openai select.
 */
export async function selectPresetByName(page, name) {
    const sel = page.locator('#settings_preset_openai');
    await sel.waitFor({ state: 'visible', timeout: 5000 });
    await sel.selectOption({ label: name });
    // Wait for the change handler to run (settings apply).
    await page.waitForTimeout(400);
}

/**
 * Open the preset management menu (gear icon next to the select) and click
 * an item by visible text. Used for "New preset", "Save preset", "Save as",
 * "Export preset", "Import preset".
 */
async function clickPresetMenuItem(page, itemText) {
    // The cog/menu trigger varies by build — use a stable selector that
    // covers the common shapes. The menu lives next to #settings_preset_openai.
    const trigger = page.locator('#openai_preset_settings_menu, [data-action="open-preset-manager-menu"], .options-content-block button[title*="preset" i]').first();
    if (await trigger.isVisible({ timeout: 500 }).catch(() => false)) {
        await trigger.click();
    }
    const item = page.locator('.options-content-block li, .ui-menu-item, .dropdown-menu li', { hasText: itemText }).first();
    await item.waitFor({ state: 'visible', timeout: 5000 });
    await item.click();
}

/**
 * Save the current settings as a preset with the given name. Drives:
 *   - the preset menu → "Save preset as" / "New preset"
 *   - the popup that prompts for the name
 *
 * The flow uses ST's preset manager and varies across builds; fall back
 * to clicking the visible "Save preset" buttons in the OpenAI settings
 * area if the menu trigger isn't found.
 */
export async function savePresetAs(page, name) {
    // Try the visible "Save preset" button shape first.
    const saveBtn = page.locator('button:has-text("Save preset"), .preset_save_btn, #save_preset, [data-action="save-preset-as"]').first();
    if (await saveBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await saveBtn.click();
    } else {
        await clickPresetMenuItem(page, /save preset|save as/i.source);
    }
    await fillTopmostPopupAndAccept(page, name);
    // Wait for the select to include the new option.
    await page.waitForFunction((wanted) => {
        const sel = document.querySelector('#settings_preset_openai');
        if (!sel) return false;
        return Array.from(sel.options).some(o => o.textContent === wanted);
    }, name, { timeout: 10_000 });
}

/**
 * Trigger an export of the currently-selected preset via the visible
 * export button (or menu item) and await the download.
 */
export async function exportSelectedPreset(page, { timeoutMs = 15_000 } = {}) {
    const dl = page.waitForEvent('download', { timeout: timeoutMs });
    const exportBtn = page.locator('button:has-text("Export"), [data-action="export-preset"], #export_preset').first();
    if (await exportBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await exportBtn.click();
    } else {
        await clickPresetMenuItem(page, /export/i.source);
    }
    return dl;
}

/**
 * Import a preset file via the visible import button + setInputFiles.
 */
export async function importPresetFile(page, filePath) {
    const importInput = page.locator('input[type="file"][accept*="json"]:not([id*="world"]):not([id*="character"]):not([id*="memory"])').last();
    const visibleBtn = page.locator('button:has-text("Import preset"), [data-action="import-preset"], #import_preset').first();
    if (await visibleBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await visibleBtn.click().catch(() => {});
    }
    await importInput.setInputFiles(filePath);
    await page.waitForTimeout(800);
}
