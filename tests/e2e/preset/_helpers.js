// Local test helpers for the preset/iterstudio batches.
//
// These wrap pieces of UI that the shared _lib helpers don't cover
// correctly for this build:
//   - selectPresetByName: drive the hidden select2 element via jQuery
//     (Playwright's selectOption rejects hidden selects).
//   - savePresetAsViaButton: open the AI Response Configuration drawer
//     (if closed) and click the Save-preset-as icon (#new_oai_preset)
//     via a real Playwright gesture — actionability checks (visible /
//     enabled / stable / receives-events) protect against regressions
//     that would hide the button.
//   - setCounterInput / setSliderInput: write to the slider via jQuery
//     so ST's canonical input handler fires (the counter on its own
//     doesn't update oai_settings.<key>).
//   - normalizeIterStudioSettings: rewrite settings.json to clear the
//     dev-only requestApiPresetName / requestLlmPresetName so iter-studio
//     LLM requests don't get rerouted via a missing connection profile.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function normalizeIterStudioSettings(dataRoot) {
    const sp = resolve(dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.preset_settings_openai = 'Default';
    s.oai_settings.stream_openai = false;
    for (const key of ['completion_preset_assistant', 'orchestrator', 'memory_graph', 'character_editor_assistant']) {
        if (s.extension_settings?.[key]) {
            s.extension_settings[key].requestLlmPresetName = '';
            s.extension_settings[key].requestApiPresetName = '';
        }
    }
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

export async function selectPresetByName(page, name) {
    await page.evaluate(async (target) => {
        const $sel = window.jQuery?.('#settings_preset_openai');
        if (!$sel?.length) throw new Error('settings_preset_openai not found');
        const opt = $sel.find('option').filter((_i, el) => el.textContent === target).first();
        if (!opt.length) throw new Error(`preset option not found: ${target}`);
        $sel.val(String(opt.val())).trigger('change');
        await new Promise(r => setTimeout(r, 50));
    }, name);
    await page.waitForFunction((target) => {
        const ctx = window.Luker?.getContext?.();
        return ctx?.chatCompletionSettings?.preset_settings_openai === target;
    }, name, { timeout: 10_000 });
}

/**
 * Ensure the AI Response Configuration drawer (`#leftNavDrawerIcon`) is
 * open before interacting with its contents. `#new_oai_preset` and the
 * other preset-manager buttons live inside this drawer and are
 * `display:none` when it's closed, so any real Playwright click needs
 * the drawer open first.
 */
export async function ensureOaiDrawerOpen(page) {
    const drawer = page.locator('#leftNavDrawerIcon');
    if (await drawer.evaluate(el => el.classList.contains('closedIcon'))) {
        await drawer.click();
        await page.waitForFunction(() => document.querySelector('#leftNavDrawerIcon')?.classList.contains('openIcon'), { timeout: 5000 });
    }
}

export async function savePresetAsViaButton(page, name) {
    // Open the AI Response Configuration drawer (parent of
    // #new_oai_preset) so the button is actionable — display:none until
    // the drawer opens; a real click gesture requires a visible target.
    await ensureOaiDrawerOpen(page);
    await page.locator('#new_oai_preset').click();
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    const input = popup.locator('input[type="text"], textarea').first();
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await input.fill(name);
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    await page.waitForFunction((n) => Array.from(document.querySelectorAll('#settings_preset_openai option')).some(o => o.textContent === n), name, { timeout: 10_000 });
    // Wait for the change handler to actually flip the active preset name
    // on the runtime settings — saveOpenAIPresetBody triggers a change
    // event but doesn't await its async listener, so preset_settings_openai
    // can lag behind the dropdown's selected option by a few hundred ms.
    await page.waitForFunction((n) => {
        const ctx = window.Luker?.getContext?.();
        return ctx?.chatCompletionSettings?.preset_settings_openai === n;
    }, name, { timeout: 10_000 });
}

export async function setCounterInput(page, selector, value) {
    const sliderId = selector.replace(/_counter_/, '_').replace(/^#/, '');
    await page.evaluate(({ counterSel, sliderId, v }) => {
        const counter = document.querySelector(counterSel);
        if (counter) {
            counter.value = String(v);
            counter.dispatchEvent(new Event('input', { bubbles: true }));
            counter.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const $slider = window.jQuery?.(`#${sliderId}`);
        if ($slider?.length) {
            $slider.val(String(v)).trigger('input').trigger('change');
        } else {
            // For non-slider counters (e.g. #openai_max_tokens itself is the
            // number input, not a counter; no sibling slider). The counter
            // dispatch above already updates oai_settings via its own change
            // handler in that case.
        }
    }, { counterSel: selector, sliderId, v: value });
    await page.waitForTimeout(150);
}

/**
 * Force the right nav drawer closed via the drawer-toggle click, then
 * confirm it actually shows the closedIcon. Polls because the drawer
 * toggle's animation gate (animation_duration delay) can delay class
 * updates by ~150ms.
 */
async function ensureRightDrawerClosed(page) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const isOpen = await page.evaluate(() => {
            const i = document.querySelector('#rightNavDrawerIcon');
            return i && i.classList.contains('openIcon');
        });
        if (!isOpen) return;
        await page.evaluate(() => {
            const i = document.querySelector('#rightNavDrawerIcon');
            const toggle = i?.closest('.drawer-toggle') || i;
            toggle?.click();
        });
        // Settle: doNavbarIconClick may delay by animation_duration when
        // it has to close other drawers first. 250ms is comfortably above
        // the default animation_duration (typically 200ms).
        await page.waitForTimeout(300);
    }
}

export async function bindCurrentPresetToCharacter(page) {
    const drawer = page.locator('#rightNavDrawerIcon');
    const drawerClosed = await drawer.evaluate(el => el.classList.contains('closedIcon')).catch(() => true);
    if (drawerClosed) await drawer.click();
    // The dropdown change handler reads selectedOptions[0].id to route the
    // action. The dropdown options have no `value` attribute, so we set
    // the selectedIndex by matching id and fire the change event directly
    // via jQuery (Playwright's selectOption only accepts string labels and
    // matches by textContent — fragile when the option text wraps over
    // multiple lines as it does for this select).
    await page.waitForSelector('#char-management-dropdown', { state: 'attached', timeout: 5000 });
    await page.evaluate(() => {
        const sel = document.querySelector('#char-management-dropdown');
        if (!sel) throw new Error('#char-management-dropdown not found');
        const opt = sel.querySelector('#bind_character_chat_completion_preset');
        if (!opt) throw new Error('bind option not present');
        opt.selected = true;
        // jQuery change so the script.js handler that reads
        // selectedOptions[0].id actually runs.
        if (window.jQuery) window.jQuery(sel).trigger('change');
        else sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Wait for the bind confirm popup to render then accept it.
    const popup = page.locator('.popup:visible, dialog.popup[open]').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const okBtn = popup.locator('.popup-button-ok').last();
    if (await okBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await okBtn.click();
    }
    // Wait until the popup is fully detached so subsequent gestures aren't
    // intercepted by its overlay (#shadow_popup leaves residue otherwise).
    await page.waitForFunction(() => {
        const all = document.querySelectorAll('.popup');
        return Array.from(all).every(p => {
            const isOpenDialog = p.tagName === 'DIALOG' && p.hasAttribute('open');
            const style = window.getComputedStyle(p);
            const visible = style.display !== 'none' && style.visibility !== 'hidden';
            return !(isOpenDialog || visible);
        });
    }, { timeout: 5000 }).catch(() => {});
    // After binding, the right drawer is showing the character edit panel.
    // Switch the drawer to the characters list before closing so subsequent
    // selectCharacterByName calls find #rm_print_characters_block visible
    // after re-opening the drawer.
    await page.evaluate(() => {
        const btn = document.querySelector('#rm_button_characters');
        if (btn) btn.click();
    });
    await page.locator('#rm_print_characters_block').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    // Close drawer for subsequent gestures.
    await ensureRightDrawerClosed(page);
}
