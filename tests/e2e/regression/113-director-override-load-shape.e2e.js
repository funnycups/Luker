// #113 — director-mode character override survives reload with the flat shape
// (memory: known_bug_director_override_load_shape, resolved 2026-05-28)
//
// Bug shape: pre-fix, character-card director overrides were saved as the
// BARE inner sub-object (`override.director = { mainAgent, ... }`), while
// the loader fed it through `sanitizeDirectorProfile`, which expected the
// legacy `{ director: { mainAgent, ... } }` wrapper. The bare shape made
// `profile.director` undefined and the sanitizer returned defaults —
// user-visible: AI Iteration Studio in director mode appeared to "save
// nothing" because the loader rebuilt the override from defaults on every
// open.
//
// Fix: director profile is flat — `{ mode, mainAgent, subAgents, ... }`.
// `sanitizeDirectorProfile` auto-detects all three input shapes (legacy
// wrapped, new flat, bare card-override sub-object) and produces flat
// output unconditionally; writes always produce flat.
//
// REAL USER FLOW (Unified Workbench / Orchestra Lens):
//   1. Select a character.
//   2. Open Workbench -> Orchestration, switch execution mode to "director",
//      and ensure Orchestrator is enabled.
//   3. In Setup view, click "Save To Character Override" to create & enable
//      the character card override.
//   4. In Flow view, select the Lead writer (`main`) card, edit "Role prompt
//      (system prompt)" with a marker, click Done, and Save via `.ol-savebar`.
//   5. Reload the page; re-select the character; open Workbench -> Orchestration.
//   6. Verify character scope remains active and `main` role prompt still
//      contains the marker.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    selectCharacterByName,
} from '../_lib/page.js';
import {
    openOrchWorkspace,
    setOrchEnabled,
    setOrchMode,
    saveOrchDraftIfVisible,
    closeWorkbench,
} from '../_lib/ui-workbench.js';

let server;

const OVERRIDE_MARKER = 'REGRESSION-113 marker: Ash stands on the Bryn cliff at slow tide and watches the salt-mark drifters.';

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '113-director-override', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function openDirectorInWorkbench(page) {
    await setOrchMode(page, 'director');
    await setOrchEnabled(page, true);
}

test.describe('#113 — director-mode character override survives reload', () => {
    test.setTimeout(120_000);

    test('save-to-character then reload reloads the override with its flat shape and the marker intact', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openDirectorInWorkbench(page);

        // Step 1: Fork global director profile to a character-card override in Setup view.
        const setupLens = await openOrchWorkspace(page, 'setup');
        const saveCharBtn = setupLens.locator('.ol-setup-bar button').filter({
            hasText: /Save To Character Override|保存到角色覆盖/i,
        }).first();
        await expect(saveCharBtn).toBeVisible({ timeout: 10_000 });
        await saveCharBtn.click();

        const select = setupLens.locator('.ol-setup-bar select.ol-select').first();
        await expect.poll(async () => {
            return await select.evaluate((sel) => {
                const opt = sel.selectedOptions[0];
                if (!opt) return '';
                const val = String(opt.value || '');
                const sep = val.indexOf(':');
                return opt.dataset?.scope || (sep >= 0 ? val.slice(0, sep) : '');
            });
        }, { timeout: 10_000 }).toBe('character');

        // Step 2: Switch to Flow view, select Lead writer (`main`), and edit its Role prompt.
        const flowLens = await openOrchWorkspace(page, 'flow');
        const mainCard = flowLens.locator('button.ol-card[data-agent="main"]').first();
        await expect(mainCard).toBeVisible({ timeout: 10_000 });
        await mainCard.click();

        const inspector = flowLens.locator('aside.ol-inspector').first();
        const roleSection = inspector.locator('section.ol-field').filter({
            has: page.locator('.ol-section-title', { hasText: /Role prompt|角色提示/i }),
        }).first();
        await expect(roleSection).toBeVisible({ timeout: 10_000 });

        const editPen = roleSection.locator('button[aria-label="Edit field"], button[title="Edit field"]').first();
        await expect(editPen).toBeVisible({ timeout: 5000 });
        await editPen.click();

        const textarea = roleSection.locator('textarea.ol-field-input').first();
        await expect(textarea).toBeVisible({ timeout: 5000 });
        await textarea.fill(OVERRIDE_MARKER);
        await roleSection.locator('.ol-field-foot button').filter({ hasText: /^(Done|完成)$/i }).first().click();

        await saveOrchDraftIfVisible(page);
        await expect(flowLens.locator('.ol-flow-meta .ol-pill[data-source="character"]')).toBeVisible({ timeout: 10_000 });
        await closeWorkbench(page);

        // Step 3: RELOAD — the load-bearing leg.
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openDirectorInWorkbench(page);

        const setupAfter = await openOrchWorkspace(page, 'setup');
        const selectAfter = setupAfter.locator('.ol-setup-bar select.ol-select').first();
        await expect.poll(async () => {
            return await selectAfter.evaluate((sel) => {
                const opt = sel.selectedOptions[0];
                if (!opt) return '';
                const val = String(opt.value || '');
                const sep = val.indexOf(':');
                return opt.dataset?.scope || (sep >= 0 ? val.slice(0, sep) : '');
            });
        }, { timeout: 15_000 }).toBe('character');

        const flowAfter = await openOrchWorkspace(page, 'flow');
        await expect(flowAfter.locator('.ol-flow-meta .ol-pill[data-source="character"]')).toBeVisible({ timeout: 10_000 });

        const mainCardAfter = flowAfter.locator('button.ol-card[data-agent="main"]').first();
        await expect(mainCardAfter).toBeVisible({ timeout: 10_000 });
        await mainCardAfter.click();

        const roleAfter = flowAfter.locator('aside.ol-inspector section.ol-field').filter({
            has: page.locator('.ol-section-title', { hasText: /Role prompt|角色提示/i }),
        }).first();
        await expect(roleAfter).toBeVisible({ timeout: 10_000 });
        const promptText = await roleAfter.locator('.ol-prompt').first().textContent();

        expect(promptText || '',
            'director main agent systemPrompt must round-trip through the override sanitizer; ' +
            'if the loader regresses to the bare-shape misread, defaults overwrite the marker',
        ).toContain(OVERRIDE_MARKER);
    });
});
