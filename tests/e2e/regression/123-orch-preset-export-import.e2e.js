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

import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    openOrchWorkspace,
    setOrchEnabled,
    setOrchMode,
} from '../_lib/ui-workbench.js';

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
    await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

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
    await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

async function installPresetSkillViaHttp(page, { mode, presetName, skillName }) {
    await page.evaluate(async (arg) => {
        const csrfRes = await fetch('/csrf-token', { credentials: 'same-origin' });
        const csrfData = await csrfRes.json();
        const scopeUrl = `orch-preset/${arg.mode}/${arg.presetName}`;
        const res = await fetch(`/api/skills/${encodeURIComponent(scopeUrl)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfData.token,
            },
            body: JSON.stringify({
                payload: {
                    files: [{
                        path: 'SKILL.md',
                        encoding: 'utf-8',
                        content: `---\nname: ${arg.skillName}\ndescription: embed fixture\n---\n\nBody.\n`,
                    }],
                },
            }),
        });
        if (!res.ok) throw new Error(`Skill install failed: ${res.status}`);
    }, { mode, presetName, skillName });
}

test.describe('#123 — orchestrator preset skill embed roundtrip', () => {
    test.setTimeout(180_000);

    test('export attaches skills to JSON; import re-installs them', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchMode(page, 'loop');
        await setOrchEnabled(page, true);
        const lens = await openOrchWorkspace(page, 'setup');

        await createPresetViaSetup(lens, 'RP123-A');
        await installPresetSkillViaHttp(page, {
            mode: 'loop',
            presetName: 'RP123-A',
            skillName: 'test-skill-123',
        });
        expect(await skillsDirExists(server.dataRoot, 'loop', 'RP123-A')).toBe(true);

        // Export preset and accept embedded skills confirm popup.
        const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
        const exportConfirmClicker = (async () => {
            try {
                const popup = page.locator('dialog.popup[open]', {
                    has: page.locator('.luker_skill_export_confirm'),
                }).last();
                await popup.locator('.popup-button-ok').first().click({ timeout: 25_000 });
            } catch { /* download timeout will surface missing export */ }
        })();

        const exportBtn = lens.locator('.ol-setup-bar button').filter({ hasText: /^Export$/i }).first();
        await expect(exportBtn).toBeVisible({ timeout: 10_000 });
        await exportBtn.click();
        await exportConfirmClicker;

        const download = await downloadPromise;
        const exportPath = path.join(tmpExportDir, 'RP123-A.json');
        await download.saveAs(exportPath);

        const raw = await fs.readFile(exportPath, 'utf-8');
        const parsed = JSON.parse(raw);
        expect(
            parsed.extensions?.luker?.embedded_skills_source,
            'export must attach embedded_skills_source when the source scope has skills',
        ).toBeDefined();
        expect(JSON.stringify(parsed.extensions.luker.embedded_skills_source)).toContain('test-skill-123');

        // Delete preset (cascades skill scope deletion).
        await deleteActivePresetViaSetup(lens);
        await expect.poll(
            async () => skillsDirExists(server.dataRoot, 'loop', 'RP123-A'),
            { message: 'cascade delete must remove scope dir before import', timeout: 15_000 },
        ).toBe(false);

        // Import preset via `.ol-setup-bar` Import button + filechooser.
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 15_000 });
        const importBtn = lens.locator('.ol-setup-bar button').filter({ hasText: /^Import$/i }).first();
        await expect(importBtn).toBeVisible({ timeout: 10_000 });
        await importBtn.click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(exportPath);

        // Name prompt uses Orchestra Lens `.ol-dialog`.
        const nameDialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
        await expect(nameDialog).toBeVisible({ timeout: 10_000 });
        await nameDialog.locator('input.ol-input').first().fill('RP123-A');
        await nameDialog.locator('.ol-dialog-foot button.is-primary').first().click();
        await nameDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

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
    });
});
