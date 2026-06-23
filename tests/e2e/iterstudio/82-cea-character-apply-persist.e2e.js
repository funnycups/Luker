// #82 — CEA Character iter-studio: Apply → character description mutated → survives restart.
//
// REAL USER-GESTURE flow:
//   1. Select the bundled Seraphina character via her card.
//   2. Open the CEA editor iter-studio popup via real clicks
//      (extensions drawer → CEA panel → "Open Editor") (openIterStudio).
//   3. Script a `cea_set_card_field` tool_call on the mock with
//      field='description', value=NEW_DESCRIPTION.
//   4. Click Send via sendIterPrompt; wait for Apply button.
//   5. Click Apply via applyIterBatch.
//   6. Close popup. Verify the character description was rewritten:
//      - In-memory ctx.characters[id] carries the new description
//      - /api/characters/get returns the new description from disk
//   7. Restart, reload, re-select Seraphina, re-assert via the rendered
//      #description_textarea (DOM-side ground truth).

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

let server, mock;

const NEW_DESCRIPTION = 'Seraphina now wears a wind-bitten cartographer\'s coat over her healer\'s robes. '
    + 'A brass spyglass, verdigrised at the bezel, hangs from her belt — Ash gifted it to her '
    + 'after the third reef survey. Her hands still smell of salt and chamomile.';

// normalizeIterStudioSettings imported from preset/_helpers

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'iterstudio',
        scenarioId: '82-cea-char-apply',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#82 — CEA character iter-studio Apply → description persists across restart (real UI)', () => {
    test('Apply writes Seraphina.description via real Apply button click', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        const beforeAvatar = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters?.[ctx.characterId]?.avatar || '';
        });
        expect(beforeAvatar).toBeTruthy();

        // Open CEA editor iter-studio popup.
        await openIterStudio(page, 'cea');

        // Script the tool_call.
        mock.scriptToolCall({
            name: 'cea_set_card_field',
            arguments: {
                field: 'description',
                value: NEW_DESCRIPTION,
            },
        });

        // Send + wait for Apply.
        await sendIterPrompt(page, 'cea', 'Rewrite Seraphina\'s description to give her a wind-bitten cartographer\'s coat over her healer\'s robes.');

        // Click Apply via real button.
        await applyIterBatch(page, 'cea');

        // Close popup.
        await closeIterStudio(page);

        // In-memory: character now carries the new description.
        await expect.poll(async () => {
            return await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                const c = ctx.characters?.[ctx.characterId] || null;
                return c?.data?.description || c?.description || '';
            });
        }, { timeout: 10_000 }).toContain('wind-bitten cartographer');

        // Disk-side check via API (proves the persistence path).
        const fromApi = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
            const resp = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
            });
            const data = await resp.json();
            return data?.data?.description || data?.description || '';
        }, beforeAvatar);
        expect(fromApi).toBe(NEW_DESCRIPTION);

        // Restart + reload + re-select character.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // After reload, the right-nav editor's #description_textarea must
        // reflect the persisted description (the user-facing surface).
        await page.evaluate(() => {
            // Force the right nav drawer open so the description textarea
            // is rendered.
            const i = document.querySelector('#rightNavDrawerIcon');
            if (i && i.classList.contains('closedIcon')) {
                const toggle = i.closest('.drawer-toggle') || i;
                toggle?.click();
            }
        });
        await expect.poll(async () => {
            const v = await page.locator('#description_textarea').inputValue().catch(() => '');
            return v;
        }, { timeout: 15_000 }).toBe(NEW_DESCRIPTION);
    });
});
