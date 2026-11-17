// #119b — orchestrator Settings view writes propagate & persist across reload
//
// Bug shape: after a UI refactor, General/Settings fields stopped wiring
// change handlers cleanly to `settings.requestSystemPrompt` and
// `settings.iterModePromptSpec`, turning edits into silent no-ops on disk.
//
// In Unified Workbench, Orchestra Lens Settings view renders these controls
// as `.ol-form-row` textareas backed directly by `access.set(...)` -> `saveSettingsChecked`.
//
// REAL USER FLOW:
//   1. Load app, open Workbench -> Orchestration, enable Orchestrator, open Settings view.
//   2. Type marker A into "Iteration AI base system prompt" and commit change.
//   3. Type marker B into "Spec mode iteration prompt" and commit change.
//   4. Wait for save, reload the page.
//   5. Re-open Workbench -> Orchestration -> Settings view.
//   6. Verify both textareas still hold marker A and marker B.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openOrchWorkspace, setOrchEnabled } from '../_lib/ui-workbench.js';

let server;

const PROMPT_MARKER_A = 'REGRESSION-119b marker A: edits must persist to settings.requestSystemPrompt.';
const PROMPT_MARKER_B = 'REGRESSION-119b marker B: edits must persist to settings.iterModePromptSpec.';

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '119b-orch-popup-writes', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

function settingsTextarea(lens, labelRegex) {
    return lens.locator('label.ol-form-row').filter({
        has: lens.page().locator('span', { hasText: labelRegex }),
    }).first().locator('textarea.ol-textarea').first();
}

test.describe('#119b — orchestrator Settings writes persist across reload', () => {
    test.setTimeout(90_000);

    test('editing request-system-prompt and iter-mode-prompt-spec persists across reload', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchEnabled(page, true);

        const lens = await openOrchWorkspace(page, 'settings');

        const basePrompt = settingsTextarea(lens, /Iteration AI base system prompt/i);
        await expect(basePrompt).toBeVisible({ timeout: 5000 });
        await basePrompt.fill(PROMPT_MARKER_A);
        await basePrompt.press('Tab');

        const specIterPrompt = settingsTextarea(lens, /Spec mode iteration prompt/i);
        await expect(specIterPrompt).toBeVisible({ timeout: 5000 });
        await specIterPrompt.fill(PROMPT_MARKER_B);
        await specIterPrompt.press('Tab');

        await page.waitForTimeout(800);

        // Reload the page — the load-bearing leg.
        await reloadAndAwait(page, server.baseURL);

        const lensAfter = await openOrchWorkspace(page, 'settings');
        const baseAfter = settingsTextarea(lensAfter, /Iteration AI base system prompt/i);
        await expect(baseAfter).toBeVisible({ timeout: 10_000 });
        await expect(baseAfter,
            'request-system-prompt must persist across reload',
        ).toHaveValue(PROMPT_MARKER_A);

        const specAfter = settingsTextarea(lensAfter, /Spec mode iteration prompt/i);
        await expect(specAfter,
            'spec mode iteration prompt must persist across reload',
        ).toHaveValue(PROMPT_MARKER_B);
    });
});
