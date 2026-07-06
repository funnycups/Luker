// #122 — orchestrator preset skill cascade delete
//
// Verifies Task 6 + Task 7 wiring: deleting an orchestrator preset that
// owns skills in scope `{kind:'orch-preset', mode, name}` cascades a
// skill-scope-directory delete on the server via ORCH_PRESET_DELETED →
// onOrchPresetDeletedCascade → context.skills.deleteScope.
//
// REAL USER FLOW:
//   1. Load app, open orchestrator drawer, switch mode to director.
//   2. Create preset "RP122-A" via the selector bar's New button
//      (real DOM click + real popup input fill).
//   3. Install a skill in orch-preset/director/RP122-A scope. Setup
//      uses the real skills API (ctx.skills.install) rather than
//      driving the scope-picker + file-upload dialog — setup is not
//      the test's subject and the API path writes to the same
//      server endpoint the picker would.
//   4. Verify skill directory exists on server.
//   5. Delete RP122-A via the preset selector bar's Delete button
//      (real DOM click + real confirm popup OK click).
//   6. Verify skill directory is gone on server (cascade fired).

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
    server = await startServer({ batchKey: 'regression', scenarioId: '122-orch-preset-skill-cascade', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function openOrchDrawerDirector(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const modeSelect = page.locator('#luker_orch_execution_mode');
    await modeSelect.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await modeSelect.inputValue()) !== 'director') {
        await modeSelect.selectOption('director');
        await modeSelect.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });
    }
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await enabled.isChecked())) await enabled.check();
    // Wait until the director preset selector bar wrapper is visible
    // (renderDynamicPanels toggles [data-orch-mode] visibility off the
    // executionMode change handler).
    await page.locator('#orchestrator_settings [data-orch-mode="director"] [data-luker-preset-action="new"][data-mode="director"][data-scope="global"]')
        .first().waitFor({ state: 'visible', timeout: 10_000 });
}

// Server writes skills under `<dataRoot>/<userHandle>/skills/` because
// createSkillRepository uses `req.user.directories.root` — which is
// `<dataRoot>/default-user/` for a single-user config (USER_DIRECTORY_TEMPLATE.root
// is empty). See src/server-startup.js:167 + src/skills/repository.js:48.
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

/**
 * Create a preset via the selector bar's New button + INPUT popup.
 * `callGenericPopup` renders an in-DOM `<dialog class="popup">` with a
 * `.popup-input` textarea and a `.popup-button-ok` accept button — the
 * `page.on('dialog')` browser-native handler does NOT apply here.
 */
async function createPresetViaUI(page, mode, name) {
    await page.locator(`#orchestrator_settings [data-orch-mode="${mode}"] [data-luker-preset-action="new"][data-mode="${mode}"][data-scope="global"]`)
        .first().click();
    const popup = page.locator('dialog.popup[open]').last();
    const popupInput = popup.locator('.popup-input').last();
    await popupInput.waitFor({ state: 'visible', timeout: 5000 });
    await popupInput.fill(name);
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    // Wait until settings.activePresetIds[mode] points at a library
    // entry whose name === the new name. The click handler awaits
    // saveSettings + reloadOrchestratorEditor; polling this predicate
    // covers both the settings write AND the editor rebuild.
    await expect.poll(async () => {
        return await page.evaluate((m) => {
            const ext = window.Luker?.getContext()?.extensionSettings?.orchestrator;
            const activeId = ext?.activePresetIds?.[m] || '';
            return ext?.presetLibraries?.[m]?.[activeId]?.name || '';
        }, mode);
    }, { message: `preset "${name}" must become active after create`, timeout: 10_000 }).toBe(name);
}

/**
 * Delete the currently-active preset via the selector bar's Delete
 * button + CONFIRM popup.
 */
async function deletePresetViaUI(page, mode) {
    await page.locator(`#orchestrator_settings [data-orch-mode="${mode}"] [data-luker-preset-action="delete"][data-mode="${mode}"][data-scope="global"]`)
        .first().click();
    const popup = page.locator('dialog.popup[open]').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

test.describe('#122 — orchestrator preset skill cascade delete', () => {
    test.setTimeout(120_000);

    test('deleting an orch preset cascade-deletes its skill scope directory', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openOrchDrawerDirector(page);

        // Create preset "RP122-A" via the selector bar's New button.
        await createPresetViaUI(page, 'director', 'RP122-A');

        // Install a test skill into the orch-preset/director/RP122-A
        // scope. Payload shape follows repository.validatePayloadFiles:
        // the file at root path `SKILL.md` carries `name:` frontmatter;
        // the skill directory takes the frontmatter name (test-skill-122).
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            await ctx.skills.install({
                scope: { kind: 'orch-preset', mode: 'director', name: 'RP122-A' },
                payload: {
                    files: [{
                        path: 'SKILL.md',
                        encoding: 'utf-8',
                        content: '---\nname: test-skill-122\ndescription: cascade fixture\n---\n\nBody.\n',
                    }],
                },
            });
        });

        // Verify the skill dir landed on disk.
        expect(await skillsDirExists(server.dataRoot, 'director', 'RP122-A')).toBe(true);
        // Verify skill file contents survived the roundtrip.
        const md = await readSkillMd(server.dataRoot, 'director', 'RP122-A', 'test-skill-122');
        expect(md).toContain('name: test-skill-122');

        // Delete the preset via the selector bar's Delete button.
        await deletePresetViaUI(page, 'director');

        // Poll for the cascade: ORCH_PRESET_DELETED emit → subscriber runs
        // deleteScope HTTP call → server fs.rm removes the scope dir. If
        // the ORCH_PRESET_DELETED subscriber in embed-lifecycle did not
        // fire, the directory would still exist and this poll would time out.
        await expect.poll(
            async () => skillsDirExists(server.dataRoot, 'director', 'RP122-A'),
            {
                message: 'skill scope directory must be cascade-deleted when its '
                    + 'owning orch preset is deleted; if the ORCH_PRESET_DELETED '
                    + 'subscriber in embed-lifecycle did not fire, the directory '
                    + 'would still exist',
                timeout: 15_000,
            },
        ).toBe(false);
    });
});
