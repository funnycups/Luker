// #123 — orchestrator preset skill embed roundtrip
//
// Verifies Task 6 + Task 7 export/import path: exporting an orch preset
// that owns skills attaches skill bodies to the payload's
// extensions.luker.embedded_skills_source; importing the same file
// re-installs the skills into orch-preset/<mode>/<name> scope.
//
// REAL USER FLOW:
//   1. Load app, open orchestrator drawer, switch mode to loop.
//   2. Create preset "RP123-A" via selector bar (real DOM + real popup).
//   3. Install a skill in scope orch-preset/loop/RP123-A. Setup uses the
//      real skills API (ctx.skills.install) — writes to the same server
//      endpoint the scope-picker UI would.
//   4. Click Export in preset selector bar → capture download.
//   5. maybeAttachSkillsToOrchPresetExport surfaces the include-skills
//      confirm popup; accept via real DOM click on .popup-button-ok.
//   6. Parse JSON, verify extensions.luker.embedded_skills_source present.
//   7. Delete RP123-A via UI (cascade also deletes the skill scope).
//   8. Verify skill scope directory gone.
//   9. Click Import in preset selector bar → set file via filechooser.
//  10. Fill imported-preset name INPUT popup with "RP123-A", click OK.
//  11. Accept the embed-import dialog (runEmbedImportFlow shows radios).
//  12. Verify skill scope directory re-appeared with the same skill.

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
let tmpExportDir;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '123-orch-preset-export-import', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
    tmpExportDir = await fs.mkdtemp(path.join(server.dataRoot, 'exports-'));
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function openOrchDrawerLoop(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const modeSelect = page.locator('#luker_orch_execution_mode');
    await modeSelect.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await modeSelect.inputValue()) !== 'loop') {
        await modeSelect.selectOption('loop');
        await modeSelect.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });
    }
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await enabled.isChecked())) await enabled.check();
    await page.locator('#orchestrator_settings [data-orch-mode="loop"] [data-luker-preset-action="new"][data-mode="loop"][data-scope="global"]')
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

async function deletePresetViaUI(page, mode) {
    await page.locator(`#orchestrator_settings [data-orch-mode="${mode}"] [data-luker-preset-action="delete"][data-mode="${mode}"][data-scope="global"]`)
        .first().click();
    const popup = page.locator('dialog.popup[open]').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

test.describe('#123 — orchestrator preset skill embed roundtrip', () => {
    test.setTimeout(180_000);

    test('export attaches skills to JSON; import re-installs them', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openOrchDrawerLoop(page);

        // Create preset "RP123-A" via the selector bar.
        await createPresetViaUI(page, 'loop', 'RP123-A');

        // Install a skill in orch-preset/loop/RP123-A scope. Frontmatter
        // name gives the skill directory name (test-skill-123); payload
        // root must contain the SKILL.md file (repository.validatePayloadFiles).
        const SKILL_MD_CONTENT = '---\nname: test-skill-123\ndescription: embed fixture\n---\n\nBody.\n';
        await page.evaluate(async (content) => {
            const ctx = window.Luker.getContext();
            await ctx.skills.install({
                scope: { kind: 'orch-preset', mode: 'loop', name: 'RP123-A' },
                payload: {
                    files: [{
                        path: 'SKILL.md',
                        encoding: 'utf-8',
                        content,
                    }],
                },
            });
        }, SKILL_MD_CONTENT);
        expect(await skillsDirExists(server.dataRoot, 'loop', 'RP123-A')).toBe(true);

        // Click Export — capture the download.
        // maybeAttachSkillsToOrchPresetExport surfaces a confirm popup
        // (body wrapper class .luker_skill_export_confirm) asking whether
        // to include skills. Kick off the popup-accept in the background
        // BEFORE the export click so it lands regardless of surfacing race.
        const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
        const exportConfirmClicker = (async () => {
            try {
                const popup = page.locator('dialog.popup[open]', {
                    has: page.locator('.luker_skill_export_confirm'),
                }).last();
                await popup.locator('.popup-button-ok').first().click({ timeout: 25_000 });
            } catch (_err) { /* popup never showed — download timeout will surface it */ }
        })();
        await page.locator('#orchestrator_settings [data-orch-mode="loop"] [data-luker-preset-action="export"][data-mode="loop"][data-scope="global"]')
            .first().click();
        await exportConfirmClicker;
        const download = await downloadPromise;
        const exportPath = path.join(tmpExportDir, 'RP123-A.json');
        await download.saveAs(exportPath);

        // Verify JSON has embedded_skills_source.
        const raw = await fs.readFile(exportPath, 'utf-8');
        const parsed = JSON.parse(raw);
        expect(
            parsed.extensions?.luker?.embedded_skills_source,
            'export must attach embedded_skills_source when the source scope has skills; '
                + 'if maybeAttachSkillsToOrchPresetExport did not fire or confirm was skipped, '
                + 'this key is absent',
        ).toBeDefined();
        // Sanity: the embed should reference our skill name.
        const embedStr = JSON.stringify(parsed.extensions.luker.embedded_skills_source);
        expect(embedStr).toContain('test-skill-123');

        // Delete the preset (also cascades scope delete — see #122).
        await deletePresetViaUI(page, 'loop');
        await expect.poll(
            async () => skillsDirExists(server.dataRoot, 'loop', 'RP123-A'),
            { message: 'cascade delete must remove scope dir before import', timeout: 15_000 },
        ).toBe(false);

        // Import via the selector bar's Import button. It creates a hidden
        // <input type=file> and click()s it — Playwright's filechooser
        // event catches that.
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 15_000 });
        await page.locator('#orchestrator_settings [data-orch-mode="loop"] [data-luker-preset-action="import"][data-mode="loop"][data-scope="global"]')
            .first().click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(exportPath);

        // triggerImportPresetIntoLibrary calls callGenericPopup INPUT for
        // the imported preset name (default: name field from payload).
        // Fill with "RP123-A" and accept.
        const namePopup = page.locator('dialog.popup[open]').last();
        const namePopupInput = namePopup.locator('.popup-input').last();
        await namePopupInput.waitFor({ state: 'visible', timeout: 10_000 });
        await namePopupInput.fill('RP123-A');
        await namePopup.locator('.popup-button-ok').first().click();
        await namePopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

        // After preset persist, checkOrchPresetEmbeddedSkills fires and
        // runEmbedImportFlow shows the embed-import dialog (body wrapper
        // class .luker_skill_import_dialog). Accept it.
        const embedPopup = page.locator('dialog.popup[open]', {
            has: page.locator('.luker_skill_import_dialog'),
        }).last();
        await embedPopup.waitFor({ state: 'visible', timeout: 20_000 });
        await embedPopup.locator('.popup-button-ok').first().click();

        // Verify the skill scope directory re-appeared with the same skill.
        // If checkOrchPresetEmbeddedSkills did not fire or the user was
        // not prompted, the scope stays empty and this poll times out.
        await expect.poll(
            async () => skillsDirExists(server.dataRoot, 'loop', 'RP123-A'),
            {
                message: 'skill scope directory must be recreated when a preset that '
                    + 'carries embedded_skills_source is imported; if '
                    + 'checkOrchPresetEmbeddedSkills did not fire or the user was not '
                    + 'prompted, the scope stays empty',
                timeout: 20_000,
            },
        ).toBe(true);
    });
});
