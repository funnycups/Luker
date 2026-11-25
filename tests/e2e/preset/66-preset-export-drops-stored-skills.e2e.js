// #66 — A chat completion preset imported with bundled skills exports them
// only when the user chooses Include.
//
// REAL USER-GESTURE flow:
//   1. Import a preset whose JSON carries a bundled skill → Install in the
//      skill import dialog. A second skill lands in the preset scope.
//   2. Export → the confirm lists both skills → Skip → the file carries no
//      bundled skills. Export → Include → the file carries the two installed
//      skills, freshly packed.
//   3. Import another preset with a bundled skill → Cancel the dialog →
//      export shows no confirm and the file carries no bundled skills.
//   4. Both stored presets keep their original bundled payload.

import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { selectPresetByName, openAiResponseConfigDrawer } from './_helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const INSTALLED_PRESET = 'harbour-watch';
const DECLINED_PRESET = 'salt-flats';
const BUNDLED_SKILL = 'swell-reading';
const LOCAL_SKILL = 'bell-count';

let server, mock, scratchDir;

function skillMd(name, description, body) {
    return ['---', `name: ${name}`, `description: ${description}`, '---', '', body, ''].join('\n');
}

const BUNDLED_MD = skillMd(BUNDLED_SKILL, 'Reading the swell before the harbour bar.', 'Name the bar passable only after three even sets of swell.');
const LOCAL_MD = skillMd(LOCAL_SKILL, 'Counting the harbour bell.', 'Count the bell strokes aloud before answering the boats.');

function bundledPayload() {
    return {
        version: 1,
        items: [{ bundleFormat: 'inline-files-v1', name: BUNDLED_SKILL, files: [{ path: 'SKILL.md', encoding: 'utf8', content: BUNDLED_MD }] }],
    };
}

function writePresetFile(name) {
    const body = JSON.parse(readFileSync(resolve(REPO_ROOT, 'default/content/presets/openai/Default.json'), 'utf8'));
    body.extensions = { ...(body.extensions || {}), luker: { embedded_skills_source: bundledPayload() } };
    const filePath = resolve(scratchDir, `${name}.json`);
    writeFileSync(filePath, JSON.stringify(body, null, 4));
    return filePath;
}

function storedPreset(name) {
    return JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'OpenAI Settings', `${name}.json`), 'utf8'));
}

async function importPreset(page, name, decision) {
    await openAiResponseConfigDrawer(page);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#import_oai_preset').click();
    await (await chooser).setFiles(writePresetFile(name));
    const dialog = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_import_dialog') });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.locator(`tr[data-skill-import-name="${BUNDLED_SKILL}"]`)).toHaveAttribute('data-skill-import-conflict', 'new');
    await dialog.locator(decision === 'install' ? '.popup-button-ok' : '.popup-button-cancel').click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => {
        try { return storedPreset(name).extensions?.luker?.embedded_skills_source?.items?.length; } catch { return 0; }
    }, { timeout: 15_000 }).toBe(1);
}

// decision 'none' expects the export to download without any confirm.
async function exportPreset(page, name, decision, listed = []) {
    await selectPresetByName(page, name);
    await openAiResponseConfigDrawer(page);
    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator('#export_oai_preset').click();
    const confirm = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_export_confirm') });
    if (decision !== 'none') {
        await expect(confirm).toBeVisible({ timeout: 15_000 });
        await expect(confirm.locator('.luker_skill_export_confirm_list li')).toHaveText(listed);
        await expect(confirm.locator('.luker_skill_export_confirm_scope')).toContainText(name);
        await confirm.locator(decision === 'include' ? '.popup-button-ok' : '.popup-button-cancel').click();
        await expect(confirm).toBeHidden();
    }
    const file = await download;
    await expect(confirm).toHaveCount(0);
    const target = resolve(scratchDir, `${name}-${decision}-export.json`);
    await file.saveAs(target);
    return JSON.parse(readFileSync(target, 'utf8'));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'preset',
        scenarioId: '66-preset-export-drops-stored-skills',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    scratchDir = (await scope.directory('stored preset skills export files')).path;
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#66 — preset export drops stored bundled skills unless Include', () => {
    test('Skip and no-confirm exports carry no bundled skills; Include carries the installed ones', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);

        await importPreset(page, INSTALLED_PRESET, 'install');
        const scopeDir = resolve(server.dataRoot, 'default-user', 'skills', 'preset', INSTALLED_PRESET);
        await expect.poll(() => {
            try { return readFileSync(resolve(scopeDir, BUNDLED_SKILL, 'SKILL.md'), 'utf8'); } catch { return ''; }
        }, { timeout: 15_000 }).toBe(BUNDLED_MD);
        mkdirSync(resolve(scopeDir, LOCAL_SKILL), { recursive: true });
        writeFileSync(resolve(scopeDir, LOCAL_SKILL, 'SKILL.md'), LOCAL_MD);
        const installedStored = storedPreset(INSTALLED_PRESET).extensions.luker.embedded_skills_source;

        const skipped = await exportPreset(page, INSTALLED_PRESET, 'skip', [LOCAL_SKILL, BUNDLED_SKILL]);
        expect(skipped.extensions?.luker?.embedded_skills_source).toBeUndefined();

        const included = await exportPreset(page, INSTALLED_PRESET, 'include', [LOCAL_SKILL, BUNDLED_SKILL]);
        const fresh = included.extensions.luker.embedded_skills_source;
        expect(fresh.items.map(item => item.name).sort()).toEqual([LOCAL_SKILL, BUNDLED_SKILL]);
        expect(fresh.items.find(item => item.name === LOCAL_SKILL).files.find(f => f.path === 'SKILL.md').content).toBe(LOCAL_MD);

        await importPreset(page, DECLINED_PRESET, 'cancel');
        const declinedStored = storedPreset(DECLINED_PRESET).extensions.luker.embedded_skills_source;
        const noConfirm = await exportPreset(page, DECLINED_PRESET, 'none');
        expect(noConfirm.extensions?.luker?.embedded_skills_source).toBeUndefined();

        expect(storedPreset(INSTALLED_PRESET).extensions.luker.embedded_skills_source).toEqual(installedStored);
        expect(storedPreset(DECLINED_PRESET).extensions.luker.embedded_skills_source).toEqual(declinedStored);
    });

    test('a transport failure during packing exports without stale bundled skills', async ({ page, context }) => {
        const preset = 'offline-harbour-watch';
        await awaitMainUI(page, server.baseURL);
        await importPreset(page, preset, 'install');
        await expect.poll(() => readFileSync(resolve(server.dataRoot, 'default-user', 'skills', 'preset', preset, BUNDLED_SKILL, 'SKILL.md'), 'utf8')).toBe(BUNDLED_MD);
        await selectPresetByName(page, preset);
        await openAiResponseConfigDrawer(page);
        const download = page.waitForEvent('download');
        await page.locator('#export_oai_preset').click();
        const confirm = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_export_confirm') });
        await expect(confirm).toBeVisible();
        await expect(confirm.locator('.luker_skill_export_confirm_list li')).toHaveText([BUNDLED_SKILL]);
        const source = storedPreset(preset);
        await context.setOffline(true);
        try {
            await confirm.locator('.popup-button-ok').click();
            await expect(page.locator('#toast-container .toast-error')).toBeVisible();
            const target = resolve(scratchDir, 'failed-pack.json');
            await (await download).saveAs(target);
            expect(JSON.parse(readFileSync(target, 'utf8')).extensions?.luker?.embedded_skills_source).toBeUndefined();
            expect(storedPreset(preset)).toEqual(source);
        } finally { await context.setOffline(false); }
    });
});
