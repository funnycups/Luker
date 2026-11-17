// #119 — orchestrator Settings view hydrates from live settings
//
// Bug shape: after the tab-refactor commits (7af4b419a, 720f87cc0, 1953665a6,
// 6ceb8bc47, 7925fedac, b25d0d4eb, f8b5b7bd8, 2d55913ff), the secondary view
// arrived with completely empty API preset dropdowns, empty iteration-AI system
// prompt textarea, and stale profile scope pills because re-rendering rebuilt
// markup without re-hydrating from live settings.
//
// In Unified Workbench, Orchestration's Settings view (`ol-setup` inside
// `.olens.ol-lens`) is the single authoritative surface for those controls.
//
// REAL USER FLOW:
//   1. Load the app fresh and open Workbench -> Orchestration -> Settings.
//   2. Type a marker value into "Iteration AI base system prompt" and commit.
//   3. Switch to Flow view (verify live scope pill), close & reopen Workbench,
//      and switch back to Orchestration -> Settings.
//   4. Verify "Iteration AI base system prompt" hydrates with the marker, and
//      the AI Iteration Studio Connection profile `<select>` is populated with
//      at least one option.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    openOrchWorkspace,
    setOrchEnabled,
    closeWorkbench,
} from '../_lib/ui-workbench.js';

let server;

const REQUEST_PROMPT_MARKER = 'REGRESSION-119 marker: hydrate the request system prompt from live settings.';

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '119-orch-popup-hydrate', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#119 — orchestrator Settings view hydrates from live settings', () => {
    test.setTimeout(90_000);

    test('settings view re-opens with API preset options, request system prompt, and live scope pill populated', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchEnabled(page, true);

        let lens = await openOrchWorkspace(page, 'settings');
        const requestPromptRow = lens.locator('label.ol-form-row').filter({
            has: page.locator('span', { hasText: /Iteration AI base system prompt/i }),
        }).first();
        const promptTextarea = requestPromptRow.locator('textarea.ol-textarea').first();
        await expect(promptTextarea).toBeVisible({ timeout: 10_000 });

        await promptTextarea.fill(REQUEST_PROMPT_MARKER);
        await promptTextarea.press('Tab');
        await page.waitForTimeout(500);

        // Switch away to Flow view (also assert scope pill reflects global profile),
        // close Workbench, and reopen Orchestration -> Settings to force re-mount/re-hydration.
        lens = await openOrchWorkspace(page, 'flow');
        await expect(lens.locator('.ol-flow-meta .ol-pill[data-source="global"]')).toBeVisible({ timeout: 10_000 });
        await closeWorkbench(page);

        lens = await openOrchWorkspace(page, 'settings');

        // Assertion 1: request-system-prompt hydrated from settings.
        const hydratedTextarea = lens.locator('label.ol-form-row').filter({
            has: page.locator('span', { hasText: /Iteration AI base system prompt/i }),
        }).first().locator('textarea.ol-textarea').first();
        await expect(hydratedTextarea).toBeVisible({ timeout: 5000 });
        await expect(hydratedTextarea,
            'Iteration AI base system prompt must hydrate from settings.requestSystemPrompt',
        ).toHaveValue(REQUEST_PROMPT_MARKER);

        // Assertion 2: Connection profile dropdown populated (at least the "Current" option).
        const iterSection = lens.locator('section.ol-setup-section').filter({
            has: page.locator('.lw-sec-title', { hasText: /AI Iteration Studio configuration/i }),
        }).first();
        const apiPresetSelect = iterSection.locator('label.ol-form-row').filter({
            has: page.locator('span', { hasText: /Connection profile/i }),
        }).first().locator('select.ol-select').first();
        await expect(apiPresetSelect).toBeVisible({ timeout: 5000 });
        const optionCount = await apiPresetSelect.locator('option').count();
        expect(optionCount,
            'API preset dropdown must be populated from live presets/profiles',
        ).toBeGreaterThan(0);
    });
});
