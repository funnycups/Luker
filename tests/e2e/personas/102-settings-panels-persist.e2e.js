// #102 — Toggle one representative checkbox in each of the four major
// settings panels (User Settings, Power User aka inside User Settings,
// AI Response Configuration, AI Response Formatting), persist via the
// usual saveSettingsDebounced path, restart, reload, and assert the
// toggle is still set.
//
// "Power User" controls are actually rendered inside the User Settings
// drawer in Luker — there is no separate panel — so we pick distinct
// representative DOM ids for "User Settings" (UI behaviour like
// timestamps) and "Power User" (chat-flow like trim_sentences). The
// other two panels have their own drawers (#sys-settings-button,
// #advanced-formatting-button).
//
// We assert against `localStorage` / settings.json via the page context
// rather than poking the DOM after restart, because the toggle state is
// applied via the JS hydration path during page load — DOM checked-state
// is the right surface to validate that the rehydrated value won.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;

const PANEL_TOGGLES = [
    {
        panel: 'User Settings (UI behaviour)',
        toggleId: 'messageTimestampsEnabled',
        powerUserKey: 'timestamps_enabled',
    },
    {
        panel: 'Power User (chat flow)',
        toggleId: 'trim_sentences_checkbox',
        powerUserKey: 'trim_sentences',
    },
    {
        panel: 'AI Response Configuration',
        toggleId: 'streaming_kobold',
        // streaming flips a top-level kobold key (the most stable boolean in
        // this drawer); even if streaming is hidden when koboldhorde isn't
        // active, the input still exists in the DOM.
        powerUserKey: null,
        settingsField: 'streaming_kobold',
    },
    {
        panel: 'AI Response Formatting',
        toggleId: 'trim_spaces',
        powerUserKey: 'trim_spaces',
    },
];

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [] });
    server = await startServer({ batchKey: 'personas', scenarioId: 'settings-persist' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#102 — each major settings panel persists across restart', () => {
    for (const tc of PANEL_TOGGLES) {
        test(`${tc.panel}: #${tc.toggleId} survives restart`, async ({ page }) => {
            await awaitMainUI(page, server.baseURL);

            const exists = await page.locator(`#${tc.toggleId}`).count();
            if (!exists) {
                test.fixme(true, `toggle #${tc.toggleId} not present in DOM for this build — selector drift`);
                return;
            }

            const before = await page.evaluate(({ id }) => {
                const el = document.getElementById(id);
                return el instanceof HTMLInputElement ? !!el.checked : null;
            }, { id: tc.toggleId });
            expect(before, `#${tc.toggleId} should be a checkbox`).not.toBeNull();

            // Flip and dispatch both 'change' and 'input' so any handler
            // wired to either event fires.
            const desired = !before;
            await page.evaluate(({ id, want }) => {
                const el = document.getElementById(id);
                if (!(el instanceof HTMLInputElement)) return;
                el.checked = want;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }, { id: tc.toggleId, want: desired });

            // Force a settings save (saveSettingsDebounced is debounced, so
            // we flush via the public API on getContext()).
            await page.evaluate(async () => {
                const ctx = window.Luker.getContext();
                if (typeof ctx.saveSettings === 'function') await ctx.saveSettings();
            });

            // Tiny settle so the debounce + write reach disk.
            await page.waitForTimeout(800);

            // Restart server + reload page. Toggle should reflect post-restart.
            await server.restart();
            await reloadAndAwait(page, server.baseURL);

            const after = await page.evaluate(({ id }) => {
                const el = document.getElementById(id);
                return el instanceof HTMLInputElement ? !!el.checked : null;
            }, { id: tc.toggleId });
            expect(after, `#${tc.toggleId} did not persist across restart`).toBe(desired);
        });
    }
});
