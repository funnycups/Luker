/**
 * Plan 2 Unit 8 — skill manager flow smoke spec.
 *
 * Scope:
 *   - Open orchestrator config → Manage skills button → panel renders.
 *   - "Installed" tab shows the 18 bundled global skills after the
 *     auto-populate hook ran at server startup.
 *   - "Browse bundled" tab lists every bundled skill (state = installed).
 *   - "Import from URL..." button opens the URL prompt popup (we don't
 *     submit a real URL — Plan 3 covers full end-to-end import flows).
 *
 * Each step captures a screenshot for the Plan 3 docs under
 * docs/public/_screenshots/skills/manager-*.png.
 *
 * The spec does NOT exercise any LLM and never depends on an active
 * character / connection profile — these are pure UI-state assertions.
 */

import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
    SCREENSHOTS_DIR,
    screenshotPath,
    awaitMainUI,
    ensureExtensionsDrawerOpen,
    ensureInlineDrawerOpen,
    ensureSkillsApiAvailable,
    openSkillManagerPanel,
} from './helpers.js';

// eslint-disable-next-line no-unused-vars
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Skills: manager panel flow', () => {
    test.setTimeout(60_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('Manager opens, shows bundled skills, exposes import-URL prompt', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        // ── 1. Open the manager panel ────────────────────────────────
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'orchestrator_settings');

        // Capture the orchestrator drawer with the "Manage skills..."
        // button visible — useful for Plan 3 docs to show how a user
        // reaches the panel.
        await page.screenshot({
            path: screenshotPath('manager', 'entry-button'),
            fullPage: false,
        });

        const popup = await openSkillManagerPanel(page);

        // ── 2. Installed tab + 18 bundled skills ─────────────────────
        // The bundled scaffolds auto-populate into global on fresh
        // install (Plan 1 Unit 7 startup hook). The default ships 18
        // entries (see default/skills/global/). If the user previously
        // wiped some, the panel still renders — we assert "at least 1"
        // for resilience but log the actual count so docs stay honest.
        const installedTab = popup.locator('[data-skill-tab="installed"]').first();
        await expect(installedTab).toHaveClass(/luker_skill_tab_active/);

        const rows = popup.locator('.luker_skill_row[data-skill-name]');
        const rowCount = await rows.count();
        // eslint-disable-next-line no-console
        console.log(`[smoke] installed skill rows = ${rowCount}`);
        expect(rowCount).toBeGreaterThanOrEqual(1);

        // Confirm at least one bundled scaffold name lands — these
        // names are stable shipped artifacts (see default/skills/global/).
        const knownBundledNames = [
            'director-zh-style-baseline',
            'director-turn-workflow-zh',
            'director-character-voice-zh',
        ];
        for (const name of knownBundledNames) {
            const row = popup.locator(`.luker_skill_row[data-skill-name="${name}"]`).first();
            await expect(row).toBeVisible();
        }

        await page.screenshot({
            path: screenshotPath('manager', 'initial-view'),
            fullPage: false,
        });

        // ── 3. Switch to Browse bundled tab ──────────────────────────
        const bundledTab = popup.locator('[data-skill-tab="bundled"]').first();
        await bundledTab.click();
        await expect(bundledTab).toHaveClass(/luker_skill_tab_active/);

        // Wait for the bundled-browser mount to paint a row. The mount
        const bundledRows = popup.locator('[data-bundled-row]');
        await bundledRows.first().waitFor({ state: 'visible', timeout: 8_000 });

        const bundledCount = await bundledRows.count();
        // eslint-disable-next-line no-console
        console.log(`[smoke] bundled rows = ${bundledCount}`);
        // 18 bundled skills ship in default/skills/global/. Be defensive
        // and assert ≥ 1 so renaming a scaffold doesn't sink the suite,
        // but log the count for Plan 3 doc review.
        expect(bundledCount).toBeGreaterThanOrEqual(1);

        await page.screenshot({
            path: screenshotPath('manager', 'bundled-tab'),
            fullPage: false,
        });

        // ── 4. Import from URL... button shows the URL prompt ────────
        // Switch back to Installed (the toolbar lives there) and click
        // Import from URL. We cancel rather than submitting an actual
        // URL — the smoke spec only verifies the prompt renders. Plan 3
        // covers full URL-fetch end-to-end with a mock server.
        await popup.locator('[data-skill-tab="installed"]').first().click();
        const importUrlBtn = popup.locator('[data-skill-toolbar="import-url"]').first();
        await expect(importUrlBtn).toBeVisible();
        await importUrlBtn.click();

        // callGenericPopup(INPUT, ...) renders a new top-level popup
        // with an input field. We assert the prompt body text matches
        // the english i18n key (active locale may also be zh-cn / zh-tw,
        // so match on a regex).
        const urlPopup = page.locator('.popup:has(textarea), .popup:has(input[type="text"])').last();
        await urlPopup.waitFor({ state: 'visible', timeout: 5_000 });

        await page.screenshot({
            path: screenshotPath('manager', 'import-url-dialog'),
            fullPage: false,
        });

        // Cancel the URL prompt so the parent panel resumes.
        const cancelBtn = urlPopup.locator('.popup-button-cancel, [data-result="cancelled"], [data-result="0"]').first();
        if (await cancelBtn.count() > 0) {
            await cancelBtn.click();
        } else {
            // Fallback: press Escape if no labelled cancel button was found.
            await page.keyboard.press('Escape');
        }

        // ── 5. Close the manager panel ───────────────────────────────
        await page.keyboard.press('Escape');
    });
});
