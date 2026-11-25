import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, openExtensionsDrawer, closeExtensionsDrawer } from '../_lib/page.js';
import { writeEmbeddedCharacter } from './_helpers.js';

const NAME = 'Keeper of the Archive';
const PRESET = 'Archive watch';
const FRESH = '---\nname: fresh-watch\ndescription: Keep the archive watch.\n---\nRecord the current bell.\n';
const STALE = { version: 1, items: [{ bundleFormat: 'inline-files-v1', name: 'old-watch', files: [{ path: 'SKILL.md', encoding: 'utf8', content: 'Old archive notes.' }] }] };
const SOURCE = { format: 'PORTABLE_PROFILE_V4', mode: 'loop', name: PRESET, profile: { system_prompt: 'Keep the archive watch.', skills: { visible: ['fresh-watch'], deny: [] } }, extensions: { luker: { embedded_skills_source: STALE, keep: 'archive' } } };
// A consumer of the public core export hook. All skills, popup and extension
// registry implementations come from the real browser context, including when
// the orchestrator is genuinely disabled through Manage extensions.
const ENTRY = `import { maybeAttachSkillsToOrchPresetExport } from '/scripts/skills/embed-export-hook.js';
export function init(ctx) {
    let source;
    const input = document.createElement('input'); input.type = 'file'; input.id = 'archive-import';
    const out = document.createElement('pre'); out.id = 'archive-result';
    input.addEventListener('change', async () => { source = JSON.parse(await input.files[0].text()); out.textContent = 'loaded'; });
    const button = document.createElement('button'); button.id = 'archive-export'; button.textContent = 'Export the archive watch';
    button.addEventListener('click', async () => {
        const payload = JSON.parse(JSON.stringify(source));
        const attached = await maybeAttachSkillsToOrchPresetExport({ context: ctx.lukerContext, payload });
        const link = document.createElement('a'); const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
        link.href = url; link.download = 'archive-watch.json'; link.click(); URL.revokeObjectURL(url);
        out.textContent = JSON.stringify({ attached, source });
    });
    ctx.container.append(input, button, out);
}`;
let server, sourcePath;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'character', scenarioId: '41-cardapp-orchestrator-export-hook', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'archive-keeper.png', overrides: {
        name: NAME, extensions: { card_app: { enabled: true, entry: 'index.js', files: { 'index.js': ENTRY } } },
    } });
    const appDir = resolve(server.dataRoot, 'default-user', 'card-apps', 'archive-keeper');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(resolve(appDir, 'index.js'), ENTRY);
    sourcePath = resolve(server.dataRoot, 'archive-source.json');
    writeFileSync(sourcePath, JSON.stringify(SOURCE));
    const skillDir = resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', PRESET, 'fresh-watch');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, 'SKILL.md'), FRESH);
});



async function choices(page) {
    await selectCharacterByName(page, NAME);
    await page.locator('#archive-import').setInputFiles(sourcePath);
    await expect(page.locator('#archive-result')).toHaveText('loaded');
    for (const decision of ['skip', 'include']) {
        const download = page.waitForEvent('download');
        await page.locator('#archive-export').click();
        const popup = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_export_confirm') });
        await expect(popup.locator('.luker_skill_export_confirm_list li')).toHaveText(['fresh-watch']);
        await expect(popup.locator('.luker_skill_export_confirm_scope')).toContainText(PRESET);
        await popup.locator(decision === 'include' ? '.popup-button-ok' : '.popup-button-cancel').click();
        const target = resolve(server.dataRoot, `archive-${decision}.json`);
        await (await download).saveAs(target);
        const exported = JSON.parse(readFileSync(target, 'utf8'));
        const expected = structuredClone(SOURCE);
        if (decision === 'skip') delete expected.extensions.luker.embedded_skills_source;
        else expected.extensions.luker.embedded_skills_source = { version: 1, items: [{ bundleFormat: 'inline-files-v1', name: 'fresh-watch', files: [{ path: 'SKILL.md', encoding: 'utf8', content: FRESH }] }] };
        expect(exported).toEqual(expected);
        expect(JSON.parse(readFileSync(sourcePath, 'utf8'))).toEqual(SOURCE);
        expect(JSON.parse(await page.locator('#archive-result').textContent())).toEqual({ attached: decision === 'include', source: SOURCE });
    }
}

test('stored orchestrator source strips stale skills on Skip and replaces them on Include', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await expect.poll(() => page.evaluate(() => typeof window.Luker.getContext().getExtensionApi('orchestrator')?.collectResolvedSkillsForOrchPreset)).toBe('function');
    await choices(page);
});

test('plugin-unavailable fallback exports actual scope skills after genuine popup acceptance', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openExtensionsDrawer(page);
    await page.locator('#extensions_details').click();
    const popup = page.locator('dialog.popup[open]', { has: page.locator('.extensions_info') });
    await popup.locator('.extension_block[data-name="orchestrator"] .extension_toggle input[type="checkbox"]').uncheck();
    const loaded = page.waitForEvent('load');
    await popup.locator('.popup-button-ok').click();
    await loaded;
    await awaitMainUI(page, server.baseURL);
    expect(await page.evaluate(() => window.Luker.getContext().getExtensionApi('orchestrator') === undefined)).toBe(true);
    await closeExtensionsDrawer(page);
    await choices(page);
});
