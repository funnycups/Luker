// #124 — orchestrator preset rename → skill scope rename
//
// Verifies Task 6 wiring: renaming an orchestrator preset triggers
// renameOrchPresetSkills → context.skills.renameScope → server renames
// the on-disk scope directory.
//
// REAL USER FLOW:
//   1. Load app, open orchestrator drawer, switch mode to agenda.
//   2. Create preset "RP124-Old" via selector bar (real DOM + real popup).
//   3. Install a skill in orch-preset/agenda/RP124-Old scope. Setup uses
//      the real skills API (ctx.skills.install) — writes to the same
//      server endpoint the scope-picker UI would.
//   4. Verify old scope dir exists.
//   5. Rename preset to "RP124-New" via the selector bar's Rename button
//      (real DOM click + real INPUT popup with pre-filled old name).
//   6. Verify old scope dir gone AND new scope dir present AND skill files
//      survived the rename.

import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '124-orch-preset-rename-scope', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function openOrchDrawerAgenda(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const modeSelect = page.locator('#luker_orch_execution_mode');
    await modeSelect.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await modeSelect.inputValue()) !== 'agenda') {
        await modeSelect.selectOption('agenda');
        await modeSelect.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });
    }
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await enabled.isChecked())) await enabled.check();
    await page.locator('#orchestrator_settings [data-orch-mode="agenda"] [data-luker-preset-action="new"][data-mode="agenda"][data-scope="global"]')
        .first().waitFor({ state: 'visible', timeout: 10_000 });
}

// Server writes skills under `<dataRoot>/<userHandle>/skills/` because
// createSkillRepository uses `req.user.directories.root` — which is
// `<dataRoot>/default-user/` for a single-user config. See
// src/server-startup.js:167 + src/skills/repository.js:48.
function skillsRootFor(dataRoot) {
    return path.join(dataRoot, 'default-user', 'skills');
}

async function skillsDirExists(dataRoot, mode, name) {
    const dir = path.join(skillsRootFor(dataRoot), 'orch-preset', mode, name);
    try {
        const stat = await fs.stat(dir);
        return stat.isDirectory();
    } catch (e) {
        if (e && e.code === 'ENOENT') return false;
        throw e;
    }
}

async function readSkillMd(dataRoot, mode, name, skillName) {
    const p = path.join(skillsRootFor(dataRoot), 'orch-preset', mode, name, skillName, 'SKILL.md');
    return await fs.readFile(p, 'utf-8');
}

async function createPresetViaUI(page, mode, name) {
    await page.locator(`#orchestrator_settings [data-orch-mode="${mode}"] [data-luker-preset-action="new"][data-mode="${mode}"][data-scope="global"]`)
        .first().click();
    const popup = page.locator('dialog.popup[open]').last();
    const popupInput = popup.locator('.popup-input').last();
    await popupInput.waitFor({ state: 'visible', timeout: 5000 });
    await popupInput.fill(name);
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await expect.poll(async () => {
        return await page.evaluate((m) => {
            const ext = window.Luker?.getContext()?.extensionSettings?.orchestrator;
            const activeId = ext?.activePresetIds?.[m] || '';
            return ext?.presetLibraries?.[m]?.[activeId]?.name || '';
        }, mode);
    }, { message: `preset "${name}" must become active after create`, timeout: 10_000 }).toBe(name);
}

test.describe('#124 — orchestrator preset rename → skill scope rename', () => {
    test.setTimeout(120_000);

    test('renaming a preset renames its skill scope directory on disk', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openOrchDrawerAgenda(page);

        // Create preset "RP124-Old" via selector bar.
        await createPresetViaUI(page, 'agenda', 'RP124-Old');

        // Install a skill in orch-preset/agenda/RP124-Old scope. Payload
        // shape follows repository.validatePayloadFiles: file at root
        // path `SKILL.md`; the skill directory takes the frontmatter name.
        const SKILL_MD_CONTENT = '---\nname: test-skill-124\ndescription: rename fixture\n---\n\nRename-me body.\n';
        await page.evaluate(async (content) => {
            const ctx = window.Luker.getContext();
            await ctx.skills.install({
                scope: { kind: 'orch-preset', mode: 'agenda', name: 'RP124-Old' },
                payload: {
                    files: [{
                        path: 'SKILL.md',
                        encoding: 'utf-8',
                        content,
                    }],
                },
            });
        }, SKILL_MD_CONTENT);
        expect(await skillsDirExists(server.dataRoot, 'agenda', 'RP124-Old')).toBe(true);

        // Rename preset via selector bar. The rename handler opens an
        // INPUT popup pre-filled with the current name; .fill() replaces
        // the value with the new name.
        await page.locator('#orchestrator_settings [data-orch-mode="agenda"] [data-luker-preset-action="rename"][data-mode="agenda"][data-scope="global"]')
            .first().click();
        const renamePopup = page.locator('dialog.popup[open]').last();
        const renameInput = renamePopup.locator('.popup-input').last();
        await renameInput.waitFor({ state: 'visible', timeout: 5000 });
        // Sanity: the pre-filled value should be the old name.
        expect(await renameInput.inputValue()).toBe('RP124-Old');
        await renameInput.fill('RP124-New');
        await renamePopup.locator('.popup-button-ok').first().click();
        await renamePopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

        // Poll for the rename to complete on disk. renameOrchPresetSkills
        // calls context.skills.renameScope, which the server implements as
        // an atomic fs.rename — so both `old absent` and `new present`
        // land in the same tick once the HTTP round-trip completes.
        await expect.poll(
            async () => skillsDirExists(server.dataRoot, 'agenda', 'RP124-Old'),
            {
                message: 'old scope dir must be gone after rename; renameScope moves '
                    + 'the directory rather than copying',
                timeout: 15_000,
            },
        ).toBe(false);
        await expect.poll(
            async () => skillsDirExists(server.dataRoot, 'agenda', 'RP124-New'),
            {
                message: 'new scope dir must exist after rename; if '
                    + 'renameOrchPresetSkills did not fire or the client renameScope '
                    + 'call failed, the new dir stays absent',
                timeout: 15_000,
            },
        ).toBe(true);

        const md = await readSkillMd(server.dataRoot, 'agenda', 'RP124-New', 'test-skill-124');
        expect(md).toContain('name: test-skill-124');
        expect(md).toContain('Rename-me body');

        // Verify orchestrator settings reflect the new preset name.
        const activeName = await page.evaluate(() => {
            const ext = window.Luker?.getContext()?.extensionSettings?.orchestrator;
            const activeId = ext?.activePresetIds?.agenda || '';
            return ext?.presetLibraries?.agenda?.[activeId]?.name || '';
        });
        expect(activeName).toBe('RP124-New');
    });
});
