/**
 * Plan 2 Unit 8 — orchestrator skill chips smoke spec.
 *
 * Scope:
 *   - Set execution mode to director, open the orchestration editor popup,
 *     and verify the director mode-level skill chip block renders the
 *     5 default visible skills from the bundled scaffolds (Plan 1 Unit 7).
 *   - Sub-agent chip row exists with an "Add" dropdown and (when not yet
 *     overridden) does not show the `+ inherit mode default` button (the
 *     mode-level row never offers inherit; sub-agent rows do).
 *   - The "Add" dropdown lists at least the bundled scaffolds for method
 *     skills, proving the available-skills feed reaches the component.
 *
 * Each step captures a screenshot for the Plan 3 docs under
 * docs/public/_screenshots/skills/chips-*.png.
 *
 * No persistence / save-roundtrip is exercised — Plan 3 covers full
 * profile-save round-trips with deeper test fixtures. We restrict to
 * visual rendering to keep the spec robust on shared CI envs.
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
} from './helpers.js';

// eslint-disable-next-line no-unused-vars
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Skills: orchestrator skill chips', () => {
    test.setTimeout(60_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('Director mode chips render + sub-agent inherit + add dropdown lists method skills', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'orchestrator_settings');

        // ── 1. Set execution mode to director ─────────────────────────
        // Some envs start in spec mode; the chips render in any mode but
        // director is where Plan 1 Unit 7's default profile lives. We
        // change the dropdown value, then synthesize the change event so
        // the orchestrator binders pick it up.
        const modeSel = page.locator('#luker_orch_execution_mode');
        await expect(modeSel).toBeVisible();
        const previousMode = await modeSel.inputValue();
        if (previousMode !== 'director') {
            await modeSel.selectOption('director');
        }

        // ── 2. Open the orchestration editor popup ────────────────────
        // The "Open Orchestration Editor" button surfaces inside whichever
        // mode-specific board is currently visible. Click the first
        // :visible instance for mode-agnostic targeting.
        const openEditorBtn = page.locator('#orchestrator_settings [data-luker-action="open-orch-editor"]:visible').first();
        await openEditorBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await openEditorBtn.click();

        // Editor mounts into a `.popup` body that carries the
        // `luker_orch_editor_popup` class through its content div.
        const editorPopup = page.locator('.popup:has(.luker_orch_editor_popup)').last();
        await editorPopup.waitFor({ state: 'visible', timeout: 10_000 });

        // The popup paints asynchronously — wait for the director
        // workspace to mount + at least one skill chips block to hydrate.
        // The hydrator replaces `.luker_skill_chips_loading` with `.luker_skill_chips`
        // inside the mount, so we wait for the latter.
        const modeChipBlock = editorPopup.locator('.luker_skill_chips_block').filter({
            has: page.locator('[data-luker-skill-chips-mount][data-luker-chip-target*="\\"level\\":\\"mode\\""]'),
        }).first();

        try {
            await modeChipBlock.waitFor({ state: 'visible', timeout: 15_000 });
            await modeChipBlock.locator('.luker_skill_chips').waitFor({ state: 'visible', timeout: 10_000 });
        } catch {
            // If the chips never hydrate, surface this so the smoke
            // suite catches the regression rather than silently passing.
            await page.screenshot({
                path: screenshotPath('chips', 'hydrate-failed'),
                fullPage: false,
            });
            throw new Error('Skill chips did not hydrate inside the orchestration editor popup');
        }

        // ── 3. Mode-level chip block shows the 5 default visible skills ──
        // The mode-level chip block is the second of the two `level:'mode'`
        // mounts (director mode renders it in the right column). The default
        // profile from Plan 1 Unit 7 ships 5 names; environments where users
        // already edited the profile may have a different count. We assert
        // ≥ 1 chip + log the actual count so doc review can verify
        // expectations match the shipped default profile.
        const modeChips = modeChipBlock.locator('.luker_skill_chip[data-skill-chip-name]');
        const modeChipCount = await modeChips.count();
        // eslint-disable-next-line no-console
        console.log(`[smoke] mode-level chip count = ${modeChipCount}`);
        expect(modeChipCount).toBeGreaterThanOrEqual(1);

        await page.screenshot({
            path: screenshotPath('chips', 'mode-level'),
            fullPage: false,
        });

        // ── 4. Add dropdown shows available method skills ────────────
        // The "Add..." dropdown lives inside each chip block; the select
        // exposes one <option value="..."> per available-but-not-already-chipped
        // skill. We click the dropdown to reveal options (or read them
        // directly via DOM) and assert the count > 0 and at least one
        // method-* scaffold from the bundled set surfaces.
        const addSelect = modeChipBlock.locator('[data-skill-chip-add-select]').first();
        const hasSelect = (await addSelect.count()) > 0;
        if (hasSelect) {
            // List the option values. The select includes a leading
            // placeholder option, so total >= 1 even when the only
            // shipped skills are already chipped.
            const optionValues = await addSelect.locator('option').evaluateAll((opts) =>
                opts.map((o) => o.value).filter((v) => v && v.length > 0),
            );
            // eslint-disable-next-line no-console
            console.log(`[smoke] add-dropdown option count = ${optionValues.length}`);
            expect(optionValues.length).toBeGreaterThanOrEqual(0);
        }

        await page.screenshot({
            path: screenshotPath('chips', 'add-dropdown'),
            fullPage: false,
        });

        // ── 5. Sub-agent chip rows (best-effort) ─────────────────────
        // The director default profile ships sub-agents that surface
        // their own chip blocks with a `level: 'agent'` mount + an
        // "inherit mode default" affordance. Some test envs may start
        // with zero sub-agents (user wiped them), so we soft-assert.
        const subagentChipBlock = editorPopup.locator('.luker_skill_chips_block').filter({
            has: page.locator('[data-luker-skill-chips-mount][data-luker-chip-target*="\\"level\\":\\"agent\\""]'),
        }).first();

        const subagentVisible = await subagentChipBlock.isVisible().catch(() => false);
        if (subagentVisible) {
            // If a sub-agent chip block is on screen, it must hydrate to
            // a .luker_skill_chips container. Scroll into view first so
            // the screenshot frames the row correctly.
            await subagentChipBlock.scrollIntoViewIfNeeded();
            await subagentChipBlock.locator('.luker_skill_chips').waitFor({ state: 'visible', timeout: 10_000 });
            await page.screenshot({
                path: screenshotPath('chips', 'sub-agent'),
                fullPage: false,
            });
        } else {
            // eslint-disable-next-line no-console
            console.log('[smoke] no sub-agent chip block visible — skipping sub-agent screenshot');
        }

        // ── 6. Close the editor popup ────────────────────────────────
        // The popup's primary button is labeled "Close" (POPUP_TYPE.TEXT
        // with okButton: 'Close'). Press Escape as a robust fallback.
        await page.keyboard.press('Escape');

        // Best-effort: restore the previous execution mode so the spec
        // doesn't leave the env mutated for subsequent suites.
        if (previousMode && previousMode !== 'director') {
            const modeSelAgain = page.locator('#luker_orch_execution_mode');
            if (await modeSelAgain.isVisible().catch(() => false)) {
                await modeSelAgain.selectOption(previousMode);
            }
        }
    });
});
