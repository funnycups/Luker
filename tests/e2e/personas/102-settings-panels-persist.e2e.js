// #102 — Toggle one representative checkbox in each of the four major
// settings panels via real Playwright check/uncheck gestures (NOT
// `el.checked = true`), persist via the standard saveSettings path,
// restart, reload, and assert the toggle is still set.
//
// "Power User" controls are rendered inside the User Settings drawer in
// Luker — there is no separate panel — so we pick distinct representative
// DOM ids for "User Settings" (UI behaviour like timestamps) and
// "Power User" (chat-flow like trim_sentences). The other two panels
// have their own drawers (#sys-settings-button, #advanced-formatting-button).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;

// (panel, toggleId, parent-drawer-id)
//
// Each panel sits inside a collapsed drawer at boot. Driving the
// representative checkbox via real .check()/.uncheck() requires the
// drawer to be open so the input is visible and clickable. The
// parent-drawer-id field below feeds the ensureDrawerOpen helper which
// finds the visible drawer-toggle button by id and clicks it if its
// content is not yet shown.
//
// Toggle locations (verified against public/index.html):
//   - #messageTimestampsEnabled lives in User Settings (#user-settings-button)
//   - #trim_sentences_checkbox lives in AI Response Formatting (#advanced-formatting-button)
//   - #streaming_kobold lives in AI Response Configuration (#ai-config-button);
//     this checkbox only renders when the kobold API panel is active, so we
//     pick a more portable "Power User" toggle (#auto-load-chat-checkbox)
//     for that representative.
//   - #trim_spaces also lives in AI Response Formatting; it's our chosen
//     representative for that panel.
const PANEL_TOGGLES = [
    {
        panel: 'User Settings (UI behaviour)',
        toggleId: 'messageTimestampsEnabled',
        drawerButtonId: 'user-settings-button',
    },
    {
        panel: 'Power User (auto-load chat)',
        toggleId: 'auto-load-chat-checkbox',
        drawerButtonId: 'user-settings-button',
    },
    {
        panel: 'AI Response Formatting (Trim Incomplete Sentences)',
        toggleId: 'trim_sentences_checkbox',
        drawerButtonId: 'advanced-formatting-button',
    },
    {
        panel: 'AI Response Formatting (Trim Spaces)',
        toggleId: 'trim_spaces',
        drawerButtonId: 'advanced-formatting-button',
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

/**
 * Open the drawer whose toggle button has id=drawerButtonId, if its
 * inline-drawer content is currently hidden. ST's drawer pattern: each
 * top-bar button has a `.drawer-toggle` child that flips a sibling
 * `.drawer-content` block from `closedDrawer` to open.
 */
async function ensureDrawerOpen(page, drawerButtonId) {
    const button = page.locator(`#${drawerButtonId}`);
    await button.waitFor({ state: 'attached', timeout: 5000 });
    // Find the drawer-icon; if `.closedIcon`, click the toggle to open.
    const closed = await page.locator(`#${drawerButtonId} .drawer-icon.closedIcon`).count();
    if (closed > 0) {
        await page.locator(`#${drawerButtonId} .drawer-toggle`).click();
        // Wait for any nested drawer-content to actually show by polling
        // the drawer-icon class flip (closedIcon → openIcon).
        await page.waitForFunction((id) => {
            const icon = document.querySelector(`#${id} .drawer-icon`);
            return icon && icon.classList.contains('openIcon');
        }, drawerButtonId, { timeout: 5000 }).catch(() => {});
    }
}

test.describe('#102 — each major settings panel persists across restart (real check/uncheck)', () => {
    for (const tc of PANEL_TOGGLES) {
        test(`${tc.panel}: #${tc.toggleId} survives restart`, async ({ page }) => {
            await awaitMainUI(page, server.baseURL);

            // Open the parent drawer so the target checkbox is visible.
            await ensureDrawerOpen(page, tc.drawerButtonId);

            const cb = page.locator(`#${tc.toggleId}`);
            const exists = await cb.count();
            expect(exists, `toggle #${tc.toggleId} must exist in ${tc.panel} — selector drift is a real regression`).toBeGreaterThan(0);

            // Scroll the checkbox into view so Playwright's actionability
            // check is satisfied even in narrow drawer layouts.
            await cb.scrollIntoViewIfNeeded().catch(() => {});

            const before = await cb.isChecked().catch(() => null);
            expect(before, `#${tc.toggleId} should be a real checkbox`).not.toBeNull();

            // Real gesture: .check() if we want true, .uncheck() if false.
            if (before) {
                await cb.uncheck();
            } else {
                await cb.check();
            }
            const desired = !before;

            // Let the 1000ms saveSettingsDebounced flush — mirrors a real
            // user pausing briefly after toggling a setting. 200ms slack
            // covers the setTimeout + fetch round-trip.
            await page.waitForTimeout(1200);

            // Restart server + reload page. Toggle should reflect post-restart.
            await server.restart();
            await reloadAndAwait(page, server.baseURL);

            // Re-open the parent drawer (drawer state is not persisted).
            await ensureDrawerOpen(page, tc.drawerButtonId);

            const after = await page.locator(`#${tc.toggleId}`).isChecked().catch(() => null);
            expect(after, `#${tc.toggleId} did not persist across restart`).toBe(desired);
        });
    }
});
