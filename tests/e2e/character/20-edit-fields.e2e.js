// #20 — Edit existing character fields via the real UI edit panel.
// Seed Ash with the bundled fixture (PNG with embedded card metadata),
// then drive description + first_mes edits through the visible
// textareas + form submit. Restart, re-open, re-verify.
//
// Real flow:
//   1. seed Ash via fs fixture (writeEmbeddedCharacter)
//   2. clickCharacterCard('Ash the Cartographer')
//   3. fill #description_textarea + #firstmessage_textarea
//   4. click #create_button_label (save = same submit handler)
//   5. restart + reload + re-click + re-read fields

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, openCharacterEditPanel, clickCharacterCard, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock, avatar;

const ASH_NAME = 'Ash the Cartographer';
const NEW_DESC = 'Updated: Ash now carries a second brass spyglass calibrated to the shifting reef. Her sleeves are still ink-stained.';
const NEW_FIRST_MES = '*Ash looks up from the new chart, ink on her thumb.* "The reef changed again last night. Sit. Tell me what you saw."';

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'edit-fields' });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    avatar = writeEmbeddedCharacter({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#20 — Edit existing character fields via UI', () => {
    test('description + first_mes edits through the edit panel persist across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Open Ash via card click.
        await clickCharacterCard(page, ASH_NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);

        // Sanity: baseline values present.
        expect(await page.locator('#description_textarea').inputValue()).toContain('wiry coastal cartographer');
        expect(await page.locator('#firstmessage_textarea').inputValue()).toContain('half-folded chart');

        // Edit via the real inputs + blur each so ST's input handlers
        // mirror into ctx.characters and trigger saveCharacterDebounced.
        // In edit mode the visible save button is hidden (script.js hides
        // #create_button_label) — autosave on blur is the contract.
        // We await the CHARACTER_EDITED event so we know the debounced
        // /api/characters/edit round-trip has actually completed before
        // restarting — no need to poke any internal save function.
        const editedPromise = page.evaluate(() => new Promise((resolve, reject) => {
            const ctx = window.Luker.getContext();
            const t = setTimeout(() => reject(new Error('character edit timeout')), 30_000);
            const off = ctx.eventSource.on(ctx.eventTypes.CHARACTER_EDITED, () => {
                clearTimeout(t);
                try { ctx.eventSource.removeListener(ctx.eventTypes.CHARACTER_EDITED, off); } catch {}
                resolve(true);
            });
        }));
        await page.locator('#description_textarea').fill(NEW_DESC);
        await page.locator('#description_textarea').blur();
        await page.locator('#firstmessage_textarea').fill(NEW_FIRST_MES);
        await page.locator('#firstmessage_textarea').blur();
        await editedPromise;

        // Verify in-memory (and post-restart). Reload first, re-open card.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await clickCharacterCard(page, ASH_NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);

        expect(await page.locator('#description_textarea').inputValue()).toBe(NEW_DESC);
        expect(await page.locator('#firstmessage_textarea').inputValue()).toBe(NEW_FIRST_MES);
    });
});
