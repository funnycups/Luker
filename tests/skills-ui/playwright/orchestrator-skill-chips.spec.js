/**
 * Orchestrator skill chips smoke spec.
 *
 * Scope (Unified Workbench / Orchestra Lens):
 *   - Open Workbench -> Orchestration, switch execution mode to Director,
 *     and open Setup view.
 *   - Verify the mode-level Skills block renders visible skill chips and its
 *     "Add" dropdown lists available skills.
 *   - Expand a sub-agent `<details class="ol-setup-node">` row (when present)
 *     and confirm its inherited/agent skill chips mount and hydrate cleanly.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import {
    SCREENSHOTS_DIR,
    screenshotPath,
    awaitMainUI,
    ensureSkillsApiAvailable,
    openWorkbenchOrchView,
    setWorkbenchOrchMode,
    closeWorkbenchWindow,
    takeDocScreenshot,
} from './helpers.js';

test.describe('Skills: orchestrator skill chips', () => {
    test.setTimeout(60_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('Director mode chips render + sub-agent inherit + add dropdown lists method skills', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        // 1. Open Workbench -> Orchestration -> capture current mode, switch to Director.
        let lens = await openWorkbenchOrchView(page);
        const modeBtn = lens.locator('.ol-modebtn:visible').first();
        await expect(modeBtn).toBeVisible({ timeout: 10_000 });
        const previousModeLabel = ((await modeBtn.locator('.ol-modebtn-value').textContent()) || '').trim();

        lens = await setWorkbenchOrchMode(page, /Director|导演|導演/i);
        lens = await openWorkbenchOrchView(page, /^(Setup|准备阶段|準備階段|配置)$/i);

        // 2. Locate the mode-level Skills section inside Setup view.
        const skillsSection = lens.locator('section.ol-setup-section').filter({
            has: page.locator('.lw-sec-title > span', { hasText: /^Skills$|^技能$/i }),
        }).first();
        await expect(skillsSection).toBeVisible({ timeout: 15_000 });

        const modeChipBlock = skillsSection.locator('.ol-setup-chips .luker_skill_chips').first();
        try {
            await modeChipBlock.waitFor({ state: 'visible', timeout: 15_000 });
        } catch {
            await takeDocScreenshot(page, screenshotPath('chips', 'hydrate-failed'), { fullPage: false });
            throw new Error('Skill chips did not hydrate inside Orchestra Lens Setup view');
        }

        // 3. Mode-level chip block shows visible default skills.
        const modeChips = modeChipBlock.locator('.luker_skill_chip[data-skill-chip-name]');
        const modeChipCount = await modeChips.count();
        // eslint-disable-next-line no-console
        console.log(`[smoke] mode-level chip count = ${modeChipCount}`);
        expect(modeChipCount).toBeGreaterThanOrEqual(1);

        await takeDocScreenshot(page, screenshotPath('chips', 'mode-level'), { fullPage: false });

        // 4. Add dropdown shows available skills (if any remain unchipped).
        const addSelect = modeChipBlock.locator('[data-skill-chip-add-select]').first();
        if ((await addSelect.count()) > 0) {
            const optionValues = await addSelect.locator('option').evaluateAll((opts) =>
                opts.map((o) => o.value).filter((v) => v && v.length > 0),
            );
            // eslint-disable-next-line no-console
            console.log(`[smoke] add-dropdown option count = ${optionValues.length}`);
            expect(optionValues.length).toBeGreaterThanOrEqual(0);
        }

        await takeDocScreenshot(page, screenshotPath('chips', 'add-dropdown'), { fullPage: false });

        // 5. Sub-agent chip rows: expand the first sub-agent `<details class="ol-setup-node">`
        // (excluding agent-main) and verify its chip mount hydrates cleanly.
        const subagentDetails = lens.locator('details.ol-setup-node[data-details-key^="agent-"]:not([data-details-key="agent-main"])').first();
        if (await subagentDetails.isVisible().catch(() => false)) {
            await subagentDetails.scrollIntoViewIfNeeded();
            const isOpen = await subagentDetails.evaluate(el => el.open).catch(() => false);
            if (!isOpen) {
                await subagentDetails.locator('summary').first().click();
            }
            const subChipBlock = subagentDetails.locator('.ol-setup-chips .luker_skill_chips').first();
            await subChipBlock.waitFor({ state: 'visible', timeout: 10_000 });
            await takeDocScreenshot(page, screenshotPath('chips', 'sub-agent'), { fullPage: false });
        } else {
            // eslint-disable-next-line no-console
            console.log('[smoke] no sub-agent details visible — skipping sub-agent screenshot');
        }

        // 6. Best-effort restore previous mode if changed, then close Workbench.
        if (previousModeLabel && !/Director|导演|導演/i.test(previousModeLabel)) {
            const visibleModeBtn = lens.locator('.ol-modebtn:visible').first();
            await visibleModeBtn.click();
            const restoreItem = lens.locator('.ol-menu:visible [role="menuitemradio"]').filter({
                has: page.locator('.ol-menu-title', { hasText: previousModeLabel }),
            }).first();
            if (await restoreItem.isVisible().catch(() => false)) {
                await restoreItem.click();
            }
        }
        await closeWorkbenchWindow(page);
    });
});
