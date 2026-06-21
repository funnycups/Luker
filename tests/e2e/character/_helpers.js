// Shared helper for the character/ batch: write a "real" character file
// by embedding card metadata into a PNG's tEXt chunk. The bundled
// `writeCharacter` fixture in _lib/fixtures.js only writes a JSON
// sidecar, but ST's /api/characters/all path parses card data from the
// PNG itself, so the sidecar is invisible — characters created that way
// surface under the bundled Seraphina's name. This helper embeds the
// card properly so the character appears under its own name.

import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Patch `power_user.tag_import_setting = NONE` (value 2) on the seeded
 * settings.json so the post-import "Existing tags" confirm dialog never
 * appears — that popup blocks every gesture in the right-drawer
 * (including the card click we use to verify import). Must be called
 * after `markOnboarded` (so the file exists) and before `awaitMainUI`.
 *
 * `tag_import_setting.NONE = 2` — cf. public/scripts/tags.js:248.
 */
export function disableTagImportPopup({ dataRoot, handle = 'default-user' }) {
    const path = resolve(dataRoot, handle, 'settings.json');
    if (!existsSync(path)) return;
    const s = JSON.parse(readFileSync(path, 'utf8'));
    s.power_user = s.power_user || {};
    s.power_user.tag_import_setting = 2; // NONE — never prompt
    // Do NOT set import_card_tags — the migration in power-user.js
    // (line 2144) would overwrite tag_import_setting based on that key.
    delete s.power_user.import_card_tags;
    writeFileSync(path, JSON.stringify(s, null, 4));
}

/**
 * Open the character edit panel for the currently-selected character.
 * Idempotent: opens the right nav drawer if closed, then clicks the
 * "selected character" tab (#rm_button_selected_ch) to bring up the
 * #rm_ch_create_block. Waits for #description_textarea (always visible
 * in both create and edit modes; #character_name_pole is hidden in
 * edit mode because the name surfaces in the tab header — cf.
 * script.js:15722).
 */
export async function openCharacterEditPanel(page, { timeoutMs = 10_000 } = {}) {
    const drawer = page.locator('#rightNavDrawerIcon');
    const closed = await drawer.evaluate(el => el.classList.contains('closedIcon')).catch(() => true);
    if (closed) {
        await drawer.click();
    }
    // Click the "selected character" tab to ensure we're on the edit
    // panel rather than the character list view. Use evaluate-click —
    // the element is sometimes covered by HotSwap drawer overlays.
    await page.evaluate(() => {
        const tab = document.querySelector('#rm_button_selected_ch');
        if (tab && typeof tab.click === 'function') tab.click();
    }).catch(() => {});
    await page.locator('#rm_ch_create_block').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.locator('#description_textarea').waitFor({ state: 'visible', timeout: timeoutMs });
}

/**
 * Click the card for a character by display name, in the open right
 * drawer's character list. Unlike `selectCharacterByName` in _lib/page.js
 * this does NOT close the drawer afterwards — useful when the test
 * immediately wants to read fields from the character edit panel.
 *
 * If the list panel is hidden (because another character is currently
 * selected and the edit panel is showing instead), call
 * select_rm_characters() to return to the list before searching for
 * the card.
 *
 * Pass `name` as a plain string to match display name, or as
 * `{ avatar: '<avatar.png>' }` to match by file path — useful when
 * two cards share the same display name (e.g. a duplicate).
 */
export async function clickCharacterCard(page, nameOrSpec, { timeoutMs = 10_000 } = {}) {
    const drawer = page.locator('#rightNavDrawerIcon');
    const closed = await drawer.evaluate(el => el.classList.contains('closedIcon')).catch(() => true);
    if (closed) await drawer.click();
    const blockHidden = await page.evaluate(() => {
        const el = document.querySelector('#rm_print_characters_block');
        if (!el) return true;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none') return true;
        const parent = el.closest('#rm_characters_block');
        if (parent && window.getComputedStyle(parent).display === 'none') return true;
        return false;
    }).catch(() => true);
    if (blockHidden) {
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            if (typeof mod.printCharacters === 'function') {
                const btn = document.querySelector('#rm_button_characters');
                if (btn) btn.click();
                await mod.printCharacters(true);
            }
        });
        await page.waitForFunction(() => {
            const parent = document.querySelector('#rm_characters_block');
            if (!parent) return false;
            const cs = window.getComputedStyle(parent);
            return cs.display !== 'none';
        }, { timeout: timeoutMs });
        await page.waitForTimeout(300);
    }
    // Resolve the chid (data-chid index) we want, then click that
    // .character_select directly. This avoids ambiguity when multiple
    // cards share a display name (e.g. a duplicate).
    const targetChid = await page.evaluate((spec) => {
        const ctx = window.Luker?.getContext?.();
        if (!ctx?.characters) return -1;
        if (spec && typeof spec === 'object' && spec.avatar) {
            return ctx.characters.findIndex(c => c?.avatar === spec.avatar);
        }
        return ctx.characters.findIndex(c => c?.name === String(spec));
    }, nameOrSpec);
    if (targetChid < 0) {
        throw new Error(`clickCharacterCard: no character matching ${JSON.stringify(nameOrSpec)}`);
    }
    const card = page.locator(`#rm_print_characters_block .character_select[chid="${targetChid}"], #rm_print_characters_block .character_select[data-chid="${targetChid}"]`).first();
    await card.waitFor({ state: 'attached', timeout: timeoutMs });
    await card.click();
    await page.locator('#rm_ch_create_block').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.locator('#description_textarea').waitFor({ state: 'visible', timeout: timeoutMs });
}

/**
 * Dismiss any currently-visible ST popup (`.popup` dialogs) by clicking
 * its Cancel or OK button. Iterates a small number of times in case a
 * popup spawns a chained follow-up. Best-effort — silently no-ops when
 * no popup is on screen.
 *
 * Use this BEFORE any gesture that targets a non-popup element after a
 * flow that may surface a transient confirm (character import →
 * orchestrator customTools review; character open → embed-skills
 * dialog; etc.). Cancel is preferred so we don't accidentally accept
 * destructive operations.
 */
export async function dismissAnyPopup(page, { maxRounds = 3, perRoundTimeoutMs = 1500 } = {}) {
    for (let i = 0; i < maxRounds; i++) {
        const popup = page.locator('dialog.popup[open]').last();
        const visible = await popup.isVisible({ timeout: perRoundTimeoutMs }).catch(() => false);
        if (!visible) return;
        const cancel = popup.locator('.popup-button-cancel').first();
        const ok = popup.locator('.popup-button-ok').first();
        if (await cancel.isVisible({ timeout: 200 }).catch(() => false)) {
            await cancel.click().catch(() => {});
        } else if (await ok.isVisible({ timeout: 200 }).catch(() => false)) {
            await ok.click().catch(() => {});
        } else {
            await page.keyboard.press('Escape').catch(() => {});
        }
        await popup.waitFor({ state: 'detached', timeout: perRoundTimeoutMs }).catch(() => {});
    }
}

function buildAshCard(overrides = {}) {
    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Ash the Cartographer',
        description: 'A wiry coastal cartographer in her early thirties. Wind-bitten hands, ink-stained sleeves, and a quiet patience earned from years of mapping reefs that refuse to stay still. Carries a brass spyglass that once belonged to her mother.',
        personality: 'Observant, dry-witted, slow to anger but stubborn once committed. Prefers questions to assertions. Holds grief privately and competence publicly.',
        scenario: 'You and Ash share a watchpost on the Bryn headland, charged with reading the night reef for any sign of the salt-mark drifters returning before dawn.',
        first_mes: '*Ash looks up from a half-folded chart, brushing salt-crystal from the corner of the paper.* "You came earlier than I expected. The tide is still settling — sit. The lantern needs trimming and I would rather not do it twice."',
        mes_example: '',
        creator_notes: 'For e2e fixtures; safe for any backend.',
        system_prompt: 'You are Ash. Stay in scene. Reply with one to three immersive paragraphs unless the user asks a direct OOC question.',
        post_history_instructions: '',
        alternate_greetings: [
            '*Ash is already at the rail when you arrive, spyglass to her eye.* "Hold. Don\'t speak for a moment."',
        ],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        ...overrides,
    };
    // V2/V3 spec — wrap in `data` block as the import path expects.
    const v2Payload = {
        spec: card.spec,
        spec_version: card.spec_version,
        name: card.name,
        description: card.description,
        personality: card.personality,
        scenario: card.scenario,
        first_mes: card.first_mes,
        mes_example: card.mes_example,
        creator_notes: card.creator_notes,
        system_prompt: card.system_prompt,
        post_history_instructions: card.post_history_instructions,
        alternate_greetings: card.alternate_greetings,
        tags: card.tags,
        creator: card.creator,
        character_version: card.character_version,
        data: {
            name: card.name,
            description: card.description,
            personality: card.personality,
            scenario: card.scenario,
            first_mes: card.first_mes,
            mes_example: card.mes_example,
            creator_notes: card.creator_notes,
            system_prompt: card.system_prompt,
            post_history_instructions: card.post_history_instructions,
            alternate_greetings: card.alternate_greetings,
            tags: card.tags,
            creator: card.creator,
            character_version: card.character_version,
            extensions: card.extensions || {},
        },
    };
    return v2Payload;
}

/**
 * Write a character PNG with embedded v2 card metadata.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} [opts.handle='default-user']
 * @param {string} [opts.avatarFile='ash-the-cartographer.png']
 * @param {object} [opts.overrides] Field overrides merged onto the default Ash card.
 * @returns {string} The avatar filename (with .png).
 */
export function writeEmbeddedCharacter({ dataRoot, handle = 'default-user', avatarFile = 'ash-the-cartographer.png', overrides = {} } = {}) {
    const charsDir = resolve(dataRoot, handle, 'characters');
    mkdirSync(charsDir, { recursive: true });
    const seed = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');
    const seedPng = readFileSync(seed);
    const card = buildAshCard(overrides);
    const png = writePngCard(seedPng, JSON.stringify(card));
    writeFileSync(resolve(charsDir, avatarFile), png);
    return avatarFile;
}
