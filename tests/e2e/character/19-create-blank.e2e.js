// #19 — Create a fresh blank character + fill every field + save via the
// real "Create New Character" form. Then click the new card and assert
// the imported fields are visible in the edit panel. Restart + repeat.
//
// Real flow: open right drawer → click #rm_button_create → fill
// #character_name_pole + textareas → click #create_button_label (the
// visible label that submits the hidden #create_button form input).
// Personality / scenario / system_prompt live inside the "Advanced
// Definitions" popup (#character_popup); open the popup first and
// expand its inline-drawers before filling.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, openCharacterEditPanel, clickCharacterCard } from './_helpers.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;

const NAME = 'Saoirse the Beacon-Sworn';
const DESCRIPTION = 'Sixth in a line of beacon-keepers sworn to the inland reef. Carries the silver bell that signals safe passage.';
const PERSONALITY = 'Direct, ceremonial, slow to anger and slower to forgive.';
const SCENARIO = 'A merchant skiff is rounding the headland and you wait with Saoirse at the bell-tower for the all-clear signal.';
const SYSTEM_PROMPT = 'You are Saoirse. Stay in scene. Reply with one or two paragraphs.';
const FIRST_MES = '*Saoirse rests one hand on the bell rope and watches the headland.* "Not yet. Wait for the third lantern. The mate at the bow is reading our flags."';

/**
 * Create a blank character via the real UI form. The shared
 * `createBlankCharacter` helper in _lib/ui-character.js clicks the
 * hidden `#create_button` <input type="submit"> directly — Playwright
 * refuses to click hidden elements. The visible affordance is the
 * `<label for="create_button" id="create_button_label">` icon; clicking
 * the label submits the form correctly.
 *
 * Additionally, personality / scenario / system_prompt /
 * post_history_instructions live inside the "Advanced Definitions"
 * popup (#character_popup) which is mounted only after clicking
 * #advanced_div. Within that popup, system_prompt +
 * post_history_instructions sit inside an inline-drawer ("Prompt
 * Overrides") that is collapsed by default; we expand every
 * inline-drawer so all textareas are writable.
 */
async function createBlankCharacterViaUI(page, fields = {}) {
    const drawer = page.locator('#rightNavDrawerIcon');
    const closed = await drawer.evaluate(el => el.classList.contains('closedIcon')).catch(() => true);
    if (closed) await drawer.click();
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').waitFor({ state: 'visible', timeout: 10_000 });

    const MAIN_FIELDS = {
        name: '#character_name_pole',
        description: '#description_textarea',
        firstmes: '#firstmessage_textarea',
        creator_notes: '#creator_notes_textarea',
        creator: '#creator_textarea',
        character_version: '#character_version_textarea',
    };
    for (const [key, sel] of Object.entries(MAIN_FIELDS)) {
        if (fields[key] == null) continue;
        const loc = page.locator(sel);
        if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
            await loc.fill(String(fields[key]));
        }
    }

    const ADV_FIELDS = {
        personality: '#personality_textarea',
        scenario: '#scenario_pole',
        mes_example: '#mes_example_textarea',
        system_prompt: '#system_prompt_textarea',
        post_history_instructions: '#post_history_instructions_textarea',
    };
    const needAdvanced = Object.keys(ADV_FIELDS).some(k => fields[k] != null);
    if (needAdvanced) {
        await page.locator('#advanced_div').click();
        await page.locator('#personality_textarea').waitFor({ state: 'visible', timeout: 5000 });
        // Expand every inline-drawer in the popup so all textareas
        // become writable.
        await page.evaluate(() => {
            document.querySelectorAll('#character_popup .inline-drawer').forEach(d => {
                const content = d.querySelector('.inline-drawer-content');
                if (content && getComputedStyle(content).display === 'none') {
                    d.querySelector('.inline-drawer-toggle')?.click();
                }
            });
        });
        for (const [key, sel] of Object.entries(ADV_FIELDS)) {
            if (fields[key] == null) continue;
            const loc = page.locator(sel);
            await loc.waitFor({ state: 'attached', timeout: 5000 });
            await loc.fill(String(fields[key]));
            await loc.blur();
        }
        // Close the advanced popup via JS click (the icon is covered by
        // the popup overlay so a normal click is intercepted).
        await page.evaluate(() => { document.querySelector('#advanced_div')?.click(); });
        await page.locator('#personality_textarea').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    }

    // Submit via the visible label.
    await page.locator('#create_button_label').click();
    if (fields.name) {
        await page.locator('#rm_print_characters_block .character_select', { hasText: fields.name }).first()
            .waitFor({ state: 'visible', timeout: 20_000 });
    }
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'create-blank' });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#19 — Create blank character via UI form', () => {
    test('all fields filled through the create form land on disk and survive restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await createBlankCharacterViaUI(page, {
            name: NAME,
            description: DESCRIPTION,
            personality: PERSONALITY,
            scenario: SCENARIO,
            firstmes: FIRST_MES,
            system_prompt: SYSTEM_PROMPT,
            creator_notes: 'e2e — fresh-blank fixture via UI',
            creator: 'luker-e2e',
            character_version: '1.0',
        });
        await dismissAnyPopup(page);

        // Wait for the character to be added to ctx.characters.
        await page.waitForFunction((wantName) => {
            const ctx = window.Luker?.getContext?.();
            return !!ctx?.characters?.find?.(c => c?.name === wantName);
        }, NAME, { timeout: 15_000 });

        const cardCount = await page.locator('#rm_print_characters_block .character_select', { hasText: NAME }).count();
        expect(cardCount).toBeGreaterThanOrEqual(1);

        const onDisk = listCharacters({ dataRoot: server.dataRoot });
        expect(onDisk.some(f => /Saoirse/i.test(f))).toBe(true);

        // Click the new card and verify every field round-tripped.
        await clickCharacterCard(page, NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);

        expect(await page.locator('#character_name_pole').inputValue()).toBe(NAME);
        expect(await page.locator('#description_textarea').inputValue()).toBe(DESCRIPTION);
        expect(await page.locator('#firstmessage_textarea').inputValue()).toBe(FIRST_MES);

        // Personality / scenario / system_prompt live in the advanced
        // popup; open + expand inline-drawers to inspect.
        await page.locator('#advanced_div').click();
        await page.locator('#personality_textarea').waitFor({ state: 'visible', timeout: 5000 });
        await page.evaluate(() => {
            document.querySelectorAll('#character_popup .inline-drawer').forEach(d => {
                const content = d.querySelector('.inline-drawer-content');
                if (content && getComputedStyle(content).display === 'none') {
                    d.querySelector('.inline-drawer-toggle')?.click();
                }
            });
        });
        expect(await page.locator('#personality_textarea').inputValue()).toBe(PERSONALITY);
        expect(await page.locator('#scenario_pole').inputValue()).toBe(SCENARIO);
        expect(await page.locator('#system_prompt_textarea').inputValue()).toBe(SYSTEM_PROMPT);
        await page.evaluate(() => { document.querySelector('#advanced_div')?.click(); });
        await page.locator('#personality_textarea').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

        // ── Persistence ─────────────────────────────────────────────────
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        await page.waitForFunction((wantName) => {
            const ctx = window.Luker?.getContext?.();
            return !!ctx?.characters?.find?.(c => c?.name === wantName);
        }, NAME, { timeout: 15_000 });

        const cardCountAfter = await page.locator('#rm_print_characters_block .character_select', { hasText: NAME }).count();
        expect(cardCountAfter).toBeGreaterThanOrEqual(1);

        await clickCharacterCard(page, NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);
        expect(await page.locator('#description_textarea').inputValue()).toBe(DESCRIPTION);
        expect(await page.locator('#firstmessage_textarea').inputValue()).toBe(FIRST_MES);
        await page.locator('#advanced_div').click();
        await page.locator('#personality_textarea').waitFor({ state: 'visible', timeout: 5000 });
        await page.evaluate(() => {
            document.querySelectorAll('#character_popup .inline-drawer').forEach(d => {
                const content = d.querySelector('.inline-drawer-content');
                if (content && getComputedStyle(content).display === 'none') {
                    d.querySelector('.inline-drawer-toggle')?.click();
                }
            });
        });
        expect(await page.locator('#system_prompt_textarea').inputValue()).toBe(SYSTEM_PROMPT);
    });
});
