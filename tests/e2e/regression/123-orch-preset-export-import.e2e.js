// #123 — orchestrator preset skill embed roundtrip
//
// Verifies export/import path: exporting an orch preset that owns skills
// attaches skill bodies to the payload's extensions.luker.embedded_skills_source;
// importing the same file re-installs the skills into orch-preset/<mode>/<name> scope.
//
// REAL USER FLOW (Unified Workbench / Orchestra Lens):
//   1. Load app, open Workbench -> Orchestration, switch mode to loop, enable.
//   2. In Setup view, create preset "RP123-A" via `.ol-setup-bar` New button.
//   3. Install a skill in scope orch-preset/loop/RP123-A via `/api/skills/...`.
//   4. Click Export in `.ol-setup-bar` -> accept include-skills popup -> save download.
//   5. Verify exported JSON contains `extensions.luker.embedded_skills_source`.
//   6. Delete RP123-A via `.ol-setup-bar` Delete button; confirm cascade delete.
//   7. Click Import in `.ol-setup-bar` -> upload JSON via filechooser -> enter "RP123-A"
//      in `.ol-dialog` -> accept `.luker_skill_import_dialog` popup.
//   8. Verify skill scope directory re-appeared on disk.

import { test, expect } from '../../harness/playwright.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    openOrchWorkspace,
    setOrchEnabled,
    setOrchMode,
} from '../_lib/ui-workbench.js';

let server;
let tmpExportDir;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'regression', scenarioId: '123-orch-preset-export-import', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    tmpExportDir = (await scope.directory('orchestrator preset exports')).path;
    const skillDir = path.join(server.dataRoot, 'external-harbor-watch');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: harbor-watch\ndescription: Keep the harbor watch.\n---\n\nRecord the tide at the harbor bell.\n');
    const globalRoot = path.join(server.dataRoot, 'default-user', 'skills', 'global');
    await fs.mkdir(globalRoot, { recursive: true });
    await fs.writeFile(path.join(globalRoot, '.external-fixture'), 'External skill will arrive after the empty export.');
});



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

async function createPresetViaSetup(lens, name) {
    const newBtn = lens.locator('.ol-setup-bar button[aria-label="New"], .ol-setup-bar button[title="New"]').first();
    await expect(newBtn).toBeVisible({ timeout: 10_000 });
    await newBtn.click();

    const dialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.locator('input.ol-input').first().fill(name);
    await dialog.locator('.ol-dialog-foot button.is-primary').first().click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });

    const select = lens.locator('.ol-setup-bar select.ol-select').first();
    await expect.poll(async () => {
        return await select.evaluate(sel => sel.selectedOptions[0]?.textContent?.trim() || '');
    }, { message: `preset "${name}" must become active after create`, timeout: 10_000 }).toBe(name);
}

async function deleteActivePresetViaSetup(lens) {
    const deleteBtn = lens.locator('.ol-setup-bar button[aria-label="Delete"], .ol-setup-bar button[title="Delete"]').first();
    await expect(deleteBtn).toBeVisible({ timeout: 10_000 });
    await deleteBtn.click();

    const dialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.locator('.ol-dialog-foot button.is-danger').first().click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
}

function setupExportButton(lens) {
    return lens.locator('.ol-setup-bar button').filter({ hasText: /^(Export|导出|導出)$/i }).first();
}

test.describe('#123 — orchestrator preset skill embed roundtrip', () => {
    test.setTimeout(180_000);

    test('export attaches skills to JSON; import re-installs them', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchMode(page, 'loop');
        await setOrchEnabled(page, true);
        const lens = await openOrchWorkspace(page, 'setup');

        await createPresetViaSetup(lens, 'RP123-A');

        // The default loop has no visible skills until a scope-local skill
        // is installed. Export must finish without a confirmation popup.
        const exportBtn = setupExportButton(lens);
        await expect(exportBtn).toBeVisible({ timeout: 10_000 });
        const emptyDownload = page.waitForEvent('download');
        await exportBtn.click();
        const emptyPath = path.join(tmpExportDir, 'empty.json');
        await (await emptyDownload).saveAs(emptyPath);
        await expect(page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_export_confirm') })).toHaveCount(0);
        expect(JSON.parse(await fs.readFile(emptyPath, 'utf8')).extensions?.luker?.embedded_skills_source).toBeUndefined();

        const globalRoot = path.join(server.dataRoot, 'default-user', 'skills', 'global');
        await fs.mkdir(globalRoot, { recursive: true });
        await fs.rename(path.join(server.dataRoot, 'external-harbor-watch'), path.join(globalRoot, 'harbor-watch'));

        // Move skill into orch-preset/loop/RP123-A scope via real Manage skills... button in Orchestra Lens Setup bar.
        const manageSkillsBtn = lens.locator('.ol-setup-bar button').filter({ hasText: /Manage skills|管理技能/i }).first();
        await expect(manageSkillsBtn).toBeVisible({ timeout: 10_000 });
        await manageSkillsBtn.click();
        const manager = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_manager') });
        await expect(manager).toBeVisible({ timeout: 10_000 });
        await manager.locator('[data-skill-name="harbor-watch"] [data-skill-action="move"]').click();
        const picker = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_scope_picker') });
        await picker.locator('input[name="luker_skill_scope_kind"][value="orch-preset"]').check();
        await picker.locator('[data-skill-scope-orch-preset]').selectOption('orch-preset/loop/RP123-A');
        await picker.locator('.popup-button-ok').click();
        await expect(picker).toBeHidden();
        await manager.locator('.popup-button-ok').click();
        await expect(manager).toBeHidden();
        expect(await skillsDirExists(server.dataRoot, 'loop', 'RP123-A')).toBe(true);

        const skippedDownload = page.waitForEvent('download');
        await exportBtn.click();
        const skippedConfirm = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_export_confirm') });
        await expect(skippedConfirm.locator('.luker_skill_export_confirm_list li')).toHaveText(['harbor-watch']);
        await skippedConfirm.locator('.popup-button-cancel').click();
        const skippedPath = path.join(tmpExportDir, 'skipped.json');
        await (await skippedDownload).saveAs(skippedPath);
        expect(JSON.parse(await fs.readFile(skippedPath, 'utf8')).extensions?.luker?.embedded_skills_source).toBeUndefined();

        // Click Export and accept the embedded skills confirmation popup.
        const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
        await exportBtn.click();
        const popup = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_export_confirm') }).last();
        await expect(popup.locator('.luker_skill_export_confirm_scope')).toContainText('RP123-A');
        await popup.locator('.popup-button-ok').click();

        const download = await downloadPromise;
        const exportPath = path.join(tmpExportDir, 'RP123-A.json');
        await download.saveAs(exportPath);

        const raw = await fs.readFile(exportPath, 'utf-8');
        const parsed = JSON.parse(raw);
        expect(
            parsed.extensions?.luker?.embedded_skills_source,
            'export must attach embedded_skills_source when the source scope has skills',
        ).toBeDefined();
        expect(parsed.extensions.luker.embedded_skills_source.items.map(item => item.name)).toEqual(['harbor-watch']);
        expect(parsed.extensions.luker.embedded_skills_source.items[0].files.find(file => file.path === 'SKILL.md').content)
            .toBe(await fs.readFile(path.join(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', 'RP123-A', 'harbor-watch', 'SKILL.md'), 'utf8'));

        // Delete preset (cascades skill scope deletion).
        await deleteActivePresetViaSetup(lens);
        await expect.poll(
            async () => skillsDirExists(server.dataRoot, 'loop', 'RP123-A'),
            { message: 'cascade delete must remove scope dir before import', timeout: 15_000 },
        ).toBe(false);

        // Import preset via `.ol-setup-bar` Import button + filechooser.
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 15_000 });
        const importBtn = lens.locator('.ol-setup-bar button').filter({ hasText: /^(Import|导入|導入)$/i }).first();
        await expect(importBtn).toBeVisible({ timeout: 10_000 });
        await importBtn.click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(exportPath);

        // Name prompt uses Orchestra Lens `.ol-dialog`.
        const nameDialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
        await expect(nameDialog).toBeVisible({ timeout: 10_000 });
        await nameDialog.locator('input.ol-input').first().fill('RP123-A');
        await nameDialog.locator('.ol-dialog-foot button.is-primary').first().click();
        await nameDialog.waitFor({ state: 'hidden', timeout: 5000 });

        // Accept embed-import dialog (.luker_skill_import_dialog).
        const embedPopup = page.locator('dialog.popup[open]', {
            has: page.locator('.luker_skill_import_dialog'),
        }).last();
        await expect(embedPopup).toBeVisible({ timeout: 20_000 });
        await embedPopup.locator('.popup-button-ok').first().click();

        await expect.poll(
            async () => skillsDirExists(server.dataRoot, 'loop', 'RP123-A'),
            {
                message: 'skill scope directory must be recreated when an exported preset with embedded skills is imported',
                timeout: 20_000,
            },
        ).toBe(true);

        // The imported source file retains its old bundle. The built-in
        // library intentionally stores only sanitized profile fields, so its
        // portable export starts without envelope extensions. Verify both
        // that real import contract and the export choices against changed
        // actual inventory rather than claiming the raw hook receives STALE.
        const importedSource = JSON.parse(await fs.readFile(exportPath, 'utf8'));
        const settingsPath = path.join(server.dataRoot, 'default-user', 'settings.json');
        const readStored = async () => {
            const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')).extension_settings.orchestrator;
            return settings.presetLibraries.loop[settings.activePresetIds.loop];
        };
        const storedBefore = await readStored();
        expect(storedBefore.extensions).toBeUndefined();
        const freshBody = '---\nname: harbor-watch\ndescription: Keep the current harbor watch.\n---\n\nRecord the new tide at the harbor bell.\n';
        await fs.writeFile(path.join(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', 'RP123-A', 'harbor-watch', 'SKILL.md'), freshBody);
        for (const decision of ['skip', 'include']) {
            const nextDownload = page.waitForEvent('download');
            await setupExportButton(lens).click();
            const confirm = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_export_confirm') });
            await expect(confirm.locator('.luker_skill_export_confirm_list li')).toHaveText(['harbor-watch']);
            await confirm.locator(decision === 'include' ? '.popup-button-ok' : '.popup-button-cancel').click();
            const target = path.join(tmpExportDir, `imported-${decision}.json`);
            await (await nextDownload).saveAs(target);
            const out = JSON.parse(await fs.readFile(target, 'utf8'));
            const embed = out.extensions?.luker?.embedded_skills_source;
            expect(embed).toEqual(decision === 'skip' ? undefined : {
                version: 1, items: [{ bundleFormat: 'inline-files-v1', name: 'harbor-watch', files: [{ path: 'SKILL.md', encoding: 'utf8', content: freshBody }] }],
            });
            expect(await readStored()).toEqual(storedBefore);
            expect(JSON.parse(await fs.readFile(exportPath, 'utf8'))).toEqual(importedSource);
        }
    });
});
