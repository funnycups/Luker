// #120 — orchestrator Runtime-limits auto-save via narrow persisted patch
//
// Bug shape: after hoisting director / agenda / loop Runtime-limits into
// Settings, handlers that mutated only an editor draft left
// `settings.presetLibraries.director.<activeId>.maxRounds` stale while a full-draft
// flush would accidentally leak unsaved Flow/Setup agent prompt edits.
//
// Fix: `access.setLimit(...)` -> `persistRuntimeLimitsPatch(...)` narrow-patches
// only the limits fields into the active preset, keeping mainAgent / subAgents /
// tools / customTools draft state untouched.
//
// REAL USER FLOW (Unified Workbench / Orchestra Lens):
//   1. Load app, open Workbench -> Orchestration, switch mode to director, enable.
//   2. In Flow view, open Lead writer (`main`) inspector and stage an UNSAVED
//      marker edit into Role prompt (`Done` without clicking `.ol-savebar` Save).
//   3. Switch to Settings view and change "Maximum tool-calling rounds" to 77.
//   4. Reload page; re-open Workbench -> Orchestration.
//   5. Verify Settings view shows `maxRounds === 77`.
//   6. Verify Flow view `main` Role prompt reverted to pre-draft value (no marker).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import {
    openOrchWorkspace,
    setOrchEnabled,
    setOrchMode,
} from '../_lib/ui-workbench.js';

let server;

const NEW_MAX_ROUNDS = 77;
const MAIN_AGENT_DRAFT_MARKER = 'REGRESSION-120-MAIN-AGENT-DRAFT-MARKER';

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '120-orch-rt-limits', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function openDirectorInWorkbench(page) {
    await setOrchMode(page, 'director');
    await setOrchEnabled(page, true);
}

test.describe('#120 — orchestrator Runtime-limits auto-save', () => {
    test.setTimeout(90_000);

    test('director maxRounds change persists across reload without touching mainAgent draft', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openDirectorInWorkbench(page);

        // Stage a draft-only mainAgent systemPrompt edit in Flow view (WITHOUT clicking Savebar Save).
        const flowLens = await openOrchWorkspace(page, 'flow');
        const mainCard = flowLens.locator('button.ol-card[data-agent="main"]').first();
        await expect(mainCard).toBeVisible({ timeout: 10_000 });
        await mainCard.click();

        const roleSection = flowLens.locator('aside.ol-inspector section.ol-field').filter({
            has: page.locator('.ol-section-title', { hasText: /Role prompt|角色提示/i }),
        }).first();
        await expect(roleSection).toBeVisible({ timeout: 10_000 });
        const mainAgentPromptBefore = ((await roleSection.locator('.ol-prompt').first().textContent()) || '').trim();

        await roleSection.locator('button[aria-label="Edit field"], button[title="Edit field"]').first().click();
        const textarea = roleSection.locator('textarea.ol-field-input').first();
        await expect(textarea).toBeVisible({ timeout: 5000 });
        await textarea.fill(MAIN_AGENT_DRAFT_MARKER);
        await roleSection.locator('.ol-field-foot button').filter({ hasText: /^(Done|完成)$/i }).first().click();
        await expect(flowLens.locator('.ol-savebar')).toBeVisible({ timeout: 5000 });

        // Switch to Settings view and change director Maximum tool-calling rounds.
        const settingsLens = await openOrchWorkspace(page, 'settings');
        const maxRoundsInput = settingsLens.locator('label.ol-form-row').filter({
            has: page.locator('span', { hasText: /Maximum tool-calling rounds/i }),
        }).first().locator('input.ol-input').first();
        await expect(maxRoundsInput).toBeVisible({ timeout: 10_000 });
        await maxRoundsInput.fill(String(NEW_MAX_ROUNDS));
        await maxRoundsInput.press('Tab');
        await page.waitForTimeout(800);

        // Reload — load-bearing leg.
        await reloadAndAwait(page, server.baseURL);
        await openDirectorInWorkbench(page);

        const settingsAfter = await openOrchWorkspace(page, 'settings');
        const maxRoundsAfter = await settingsAfter.locator('label.ol-form-row').filter({
            has: page.locator('span', { hasText: /Maximum tool-calling rounds/i }),
        }).first().locator('input.ol-input').first().inputValue();
        expect(Number(maxRoundsAfter),
            'director.maxRounds must persist to settings.presetLibraries.director.<activeId>.maxRounds',
        ).toBe(NEW_MAX_ROUNDS);

        // Discriminator: the unsaved Flow draft must NOT have survived reload.
        const flowAfter = await openOrchWorkspace(page, 'flow');
        const mainCardAfter = flowAfter.locator('button.ol-card[data-agent="main"]').first();
        await expect(mainCardAfter).toBeVisible({ timeout: 10_000 });
        await mainCardAfter.click();

        const roleAfter = flowAfter.locator('aside.ol-inspector section.ol-field').filter({
            has: page.locator('.ol-section-title', { hasText: /Role prompt|角色提示/i }),
        }).first();
        const mainAgentPromptAfter = ((await roleAfter.locator('.ol-prompt').first().textContent()) || '').trim();
        expect(mainAgentPromptAfter,
            'draft-only mainAgent edits must NOT be flushed by the runtime-limits auto-save',
        ).not.toContain(MAIN_AGENT_DRAFT_MARKER);
        expect(mainAgentPromptAfter,
            'mainAgent.systemPrompt must revert to the pre-draft persisted value on reload',
        ).toBe(mainAgentPromptBefore);
    });
});
