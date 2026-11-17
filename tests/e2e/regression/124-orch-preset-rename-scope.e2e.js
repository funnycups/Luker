// #124 — orchestrator preset rename -> skill scope rename
//
// Verifies wiring: renaming an orchestrator preset triggers renameOrchPresetSkills
// -> context.skills.renameScope -> server renames the on-disk scope directory.
//
// REAL USER FLOW (Unified Workbench / Orchestra Lens):
//   1. Load app, open Workbench -> Orchestration, switch mode to agenda, enable.
//   2. In Setup view, create preset "RP124-Old" via `.ol-setup-bar` New button.
//   3. Install a skill in `orch-preset/agenda/RP124-Old` scope via `/api/skills/...`.
//   4. Verify old scope directory exists on disk.
//   5. Click Rename in `.ol-setup-bar`, enter "RP124-New" in `.ol-dialog`, click OK.
//   6. Verify old directory is gone, new directory exists with intact SKILL.md, and
//      Setup select shows "RP124-New" active.

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

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '124-orch-preset-rename-scope', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
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

async function readSkillMd(dataRoot, mode, name, skillName) {
    const p = path.join(skillsRootFor(dataRoot), 'orch-preset', mode, name, skillName, 'SKILL.md');
    return await fs.readFile(p, 'utf-8');
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
                        content: `---\nname: ${arg.skillName}\ndescription: rename fixture\n---\n\nRename-me body.\n`,
                    }],
                },
            }),
        });
        if (!res.ok) throw new Error(`Skill install failed: ${res.status}`);
    }, { mode, presetName, skillName });
}

test.describe('#124 — orchestrator preset rename -> skill scope rename', () => {
    test.setTimeout(120_000);

    test('renaming a preset renames its skill scope directory on disk', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchMode(page, 'agenda');
        await setOrchEnabled(page, true);
        const lens = await openOrchWorkspace(page, 'setup');

        await createPresetViaSetup(lens, 'RP124-Old');
        await installPresetSkillViaHttp(page, {
            mode: 'agenda',
            presetName: 'RP124-Old',
            skillName: 'test-skill-124',
        });
        expect(await skillsDirExists(server.dataRoot, 'agenda', 'RP124-Old')).toBe(true);

        const renameBtn = lens.locator('.ol-setup-bar button[aria-label="Rename"], .ol-setup-bar button[title="Rename"]').first();
        await expect(renameBtn).toBeVisible({ timeout: 10_000 });
        await renameBtn.click();

        const renameDialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
        await expect(renameDialog).toBeVisible({ timeout: 5000 });
        const renameInput = renameDialog.locator('input.ol-input').first();
        await expect(renameInput).toHaveValue('RP124-Old');
        await renameInput.fill('RP124-New');
        await renameDialog.locator('.ol-dialog-foot button.is-primary').first().click();
        await renameDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

        await expect.poll(
            async () => skillsDirExists(server.dataRoot, 'agenda', 'RP124-Old'),
            { message: 'old scope dir must be gone after rename', timeout: 15_000 },
        ).toBe(false);
        await expect.poll(
            async () => skillsDirExists(server.dataRoot, 'agenda', 'RP124-New'),
            { message: 'new scope dir must exist after rename', timeout: 15_000 },
        ).toBe(true);

        const md = await readSkillMd(server.dataRoot, 'agenda', 'RP124-New', 'test-skill-124');
        expect(md).toContain('name: test-skill-124');
        expect(md).toContain('Rename-me body');

        const select = lens.locator('.ol-setup-bar select.ol-select').first();
        await expect.poll(async () => {
            return await select.evaluate(sel => sel.selectedOptions[0]?.textContent?.trim() || '');
        }, { timeout: 10_000 }).toBe('RP124-New');
    });
});
