// #122 — orchestrator preset skill cascade delete
//
// Verifies wiring: deleting an orchestrator preset that owns skills in scope
// `{kind:'orch-preset', mode, name}` cascades a skill-scope-directory delete
// on the server via ORCH_PRESET_DELETED -> onOrchPresetDeletedCascade ->
// context.skills.deleteScope.
//
// REAL USER FLOW (Unified Workbench / Orchestra Lens):
//   1. Load app, open Workbench -> Orchestration, switch mode to director, enable.
//   2. Open Setup view and create preset "RP122-A" via `.ol-setup-bar` New button
//      + `.ol-dialog` prompt.
//   3. Install a skill in `orch-preset/director/RP122-A` scope via `/api/skills/...`.
//   4. Verify skill directory exists on server.
//   5. Delete "RP122-A" via `.ol-setup-bar` Delete button + `.ol-dialog` confirm.
//   6. Verify skill directory is gone on server (cascade fired).

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
    server = await startServer({ batchKey: 'regression', scenarioId: '122-orch-preset-skill-cascade', extraConfig: { 'storage.mode': 'fs' } });
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

async function createPresetViaSetup(page, lens, name) {
    const newBtn = lens.locator('.ol-setup-bar button[aria-label="New"], .ol-setup-bar button[title="New"]').first();
    await expect(newBtn).toBeVisible({ timeout: 10_000 });
    await newBtn.click();

    const dialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
    await expect(dialog).toBeVisible({ timeout: 5000 });
    const input = dialog.locator('input.ol-input').first();
    await input.fill(name);
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

async function installPresetSkillViaHttp(page, { mode, presetName, skillName, body = 'Body.\n' }) {
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
                        content: `---\nname: ${arg.skillName}\ndescription: cascade fixture\n---\n\n${arg.body}`,
                    }],
                },
            }),
        });
        if (!res.ok) throw new Error(`Skill install failed: ${res.status}`);
    }, { mode, presetName, skillName, body });
}

test.describe('#122 — orchestrator preset skill cascade delete', () => {
    test.setTimeout(120_000);

    test('deleting an orch preset cascade-deletes its skill scope directory', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchMode(page, 'director');
        await setOrchEnabled(page, true);
        const lens = await openOrchWorkspace(page, 'setup');

        await createPresetViaSetup(page, lens, 'RP122-A');

        await installPresetSkillViaHttp(page, {
            mode: 'director',
            presetName: 'RP122-A',
            skillName: 'test-skill-122',
        });

        expect(await skillsDirExists(server.dataRoot, 'director', 'RP122-A')).toBe(true);
        const md = await readSkillMd(server.dataRoot, 'director', 'RP122-A', 'test-skill-122');
        expect(md).toContain('name: test-skill-122');

        await deleteActivePresetViaSetup(lens);

        await expect.poll(
            async () => skillsDirExists(server.dataRoot, 'director', 'RP122-A'),
            {
                message: 'skill scope directory must be cascade-deleted when its owning orch preset is deleted',
                timeout: 15_000,
            },
        ).toBe(false);
    });
});
