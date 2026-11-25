// #94 — Workbench AI iteration splits v1 inline sessions on first read and
// supports deleting single sessions and clearing scope sessions with full
// on-disk body cleanup.

import { test, expect } from '../../harness/playwright.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writePreset } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openIterStudio, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { workbenchWindow } from '../_lib/ui-workbench.js';
import { selectPresetByName, normalizeIterStudioSettings } from '../preset/_helpers.js';

let server;

const PRESET_DIR = ['default-user', 'OpenAI Settings'];

function sidecarPath(dataRoot, namespace) {
    return resolve(dataRoot, ...PRESET_DIR, `Default.luker-state.${namespace}.json`);
}

function plantV1InlineWorkbenchSessions(dataRoot) {
    const doc = {
        sessions: [
            {
                id: 's_alpha',
                kind: 'iterate',
                ws: 'preset',
                scope: 'preset',
                scopeName: 'Default',
                title: 'Tune pacing rhythm',
                createdAt: 1700000001000,
                updatedAt: 1700000002000,
                turns: [
                    { role: 'user', text: 'Tighten pacing', at: 1700000001000 },
                    { role: 'ai', text: 'Adjusted pacing guidelines.', at: 1700000002000 },
                ],
                messages: [
                    { role: 'user', content: 'Tighten pacing' },
                    { role: 'assistant', content: 'Adjusted pacing guidelines.' },
                ],
            },
            {
                id: 's_beta',
                kind: 'iterate',
                ws: 'preset',
                scope: 'preset',
                scopeName: 'Default',
                title: 'Reduce repetition',
                createdAt: 1700000003000,
                updatedAt: 1700000004000,
                turns: [
                    { role: 'user', text: 'Trim repeated rules', at: 1700000003000 },
                    { role: 'ai', text: 'Deduplicated system instructions.', at: 1700000004000 },
                ],
                messages: [
                    { role: 'user', content: 'Trim repeated rules' },
                    { role: 'assistant', content: 'Deduplicated system instructions.' },
                ],
            },
        ],
    };
    writeFileSync(sidecarPath(dataRoot, 'workbench_sessions'), JSON.stringify(doc, null, 4));
}

test.describe('#94 — Workbench session split migration and deletion', () => {
    test.beforeAll(async ({ workerResources }, testInfo) => {
        const scope = await workerResources.scenario(testInfo.file);
        server = await startServer({
            scope,
            batchKey: 'iterstudio',
            scenarioId: '94-workbench-session-delete',
            extraConfig: { storage: { mode: 'fs' } },
        });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:65535' });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:65535' });
        normalizeIterStudioSettings(server.dataRoot);
        writePreset({ dataRoot: server.dataRoot, name: 'Default', overrides: { temperature: 1.0 } });
        plantV1InlineWorkbenchSessions(server.dataRoot);
    });

    test('lazily splits v1 sessions on open, deletes single session and clears remaining sessions on disk and across reload', async ({ page }) => {
        const indexPath = sidecarPath(server.dataRoot, 'workbench_sessions');
        const alphaBodyPath = sidecarPath(server.dataRoot, 'workbench_session_s_alpha');
        const betaBodyPath = sidecarPath(server.dataRoot, 'workbench_session_s_beta');

        await awaitMainUI(page, server.baseURL);
        await selectPresetByName(page, 'Default');

        // Before opening Workbench AI iteration, v1 inline file has NOT been touched (true lazy loading)
        expect(existsSync(alphaBodyPath)).toBe(false);
        expect(existsSync(betaBodyPath)).toBe(false);

        await openIterStudio(page, 'cpa');
        const win = workbenchWindow(page);

        await expect(win.locator('.wb-sess-list')).toContainText('Tune pacing rhythm', { timeout: 10_000 });
        await expect(win.locator('.wb-sess-list')).toContainText('Reduce repetition', { timeout: 10_000 });

        // Opening AI iteration split v1 inline sessions into compact index + per-session body files
        await expect.poll(() => existsSync(alphaBodyPath) && existsSync(betaBodyPath), { timeout: 10_000 }).toBe(true);
        const migratedIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
        expect(migratedIndex.version).toBe(2);
        expect(migratedIndex.sessions.every((s) => s.turns === undefined && s.messages === undefined)).toBe(true);

        // Open Tune pacing rhythm -> lazily reads body from disk
        await win.locator('.wb-sess-row[data-session-id="s_alpha"] .wb-sess-item').click();
        await expect(win.locator('.wb-chat-body')).toContainText('Adjusted pacing guidelines.', { timeout: 10_000 });

        // Click delete on s_alpha -> cancel keeps it intact
        const alphaRow = win.locator('.wb-sess-row[data-session-id="s_alpha"]');
        await alphaRow.hover();
        await alphaRow.locator('.wb-sess-del').click();
        const dialog = page.locator('.lw-dialog').first();
        await expect(dialog).toBeVisible({ timeout: 5_000 });
        await dialog.locator('.lw-dialog-foot .lw-btn.is-ghost').click();
        await expect(alphaRow).toBeVisible();
        expect(existsSync(alphaBodyPath)).toBe(true);

        // Confirm delete on s_alpha -> removed from UI, index, and body file deleted from disk
        await alphaRow.hover();
        await alphaRow.locator('.wb-sess-del').click();
        await expect(dialog).toBeVisible({ timeout: 5_000 });
        await dialog.locator('.lw-dialog-foot .lw-btn.is-danger').click();

        await expect(alphaRow).toHaveCount(0, { timeout: 10_000 });
        await expect(win.locator('.wb-chat-body')).not.toContainText('Adjusted pacing guidelines.');
        await expect.poll(() => existsSync(alphaBodyPath), { timeout: 10_000 }).toBe(false);
        expect(existsSync(betaBodyPath)).toBe(true);

        // Clear all remaining conversations under Preset -> removes s_beta from UI, index, and disk
        await win.locator('.wb-sess-clear').click();
        await expect(dialog).toBeVisible({ timeout: 5_000 });
        await dialog.locator('.lw-dialog-foot .lw-btn.is-danger').click();

        await expect(win.locator('.wb-sess-row')).toHaveCount(0, { timeout: 10_000 });
        await expect.poll(() => existsSync(betaBodyPath), { timeout: 10_000 }).toBe(false);
        const finalIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
        expect(finalIndex.sessions).toEqual([]);

        // Reload and reopen -> deletion persisted
        await closeIterStudio(page);
        await page.reload();
        await awaitMainUI(page, server.baseURL);
        await selectPresetByName(page, 'Default');
        await openIterStudio(page, 'cpa');
        await expect(workbenchWindow(page).locator('.wb-sess-row')).toHaveCount(0, { timeout: 10_000 });
        await closeIterStudio(page);
    });
});
