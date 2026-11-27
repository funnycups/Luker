import { test, expect } from '../../harness/playwright.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';
import {
    clickOrchSetupBarButton,
    editOrchAgentField,
    enableOrchestratorMode,
    getOrchRuntimeLimitInput,
    openOrchAddCustomToolPopup,
    readOrchAgentField,
    saveOrchDrafts,
} from '../_lib/ui-orchestrator.js';
import { closeWorkbench, openOrchWorkspace, setOrchMode } from '../_lib/ui-workbench.js';
import { configureMg, openMemoryWorkspace, openMgSchemaEditor } from '../_lib/ui-mg-varops.js';

const NAME = 'Keeper of the Settings Ledger';
let server;
const disk = () => JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'orchestrator', scenarioId: '88-settings-outcomes', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'settings-ledger.png', overrides: { name: NAME } });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'matching-ledger.png', overrides: { name: 'Keeper of the Matching Ledger', extensions: { orchestrator: {
        override: { mode: 'loop' }, presetLibraries: { loop: { default: { name: 'Card ledger', system_prompt: 'Keep the distinct matching card ledger.', max_rounds: 7, customTools: [], seededDefaultCustomTools: true } } },
        activePresetIds: { loop: 'default' },
    } } } });
});

async function open(page) {
    await awaitMainUI(page, server.baseURL);
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('[init] complete').some(entry => entry.entryType === 'mark'))).toBe(true);
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
}

async function forceSaveViaSlash(page) {
    await page.locator('#send_textarea').fill('/forcesave');
    await page.locator('#send_but').click();
    const toast = page.locator('#toast-container .toast-success', { hasText: 'Chat and settings saved.' });
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await toast.click();
    await expect(toast).toHaveCount(0, { timeout: 5_000 });
}

async function prepareDraft(page, kind) {
    await open(page);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await enableOrchestratorMode(page, 'loop');
    // Ensure the seeded loop preset library and activePresetIds are persisted on disk
    // before capturing `before` or making the user directory read-only.
    const hasPersistedLoopSource = () => {
        const orch = disk().extension_settings?.orchestrator;
        const activeId = orch?.activePresetIds?.loop;
        return Boolean(activeId && orch?.presetLibraries?.loop?.[activeId]);
    };
    if (!hasPersistedLoopSource()) {
        await forceSaveViaSlash(page);
        await expect.poll(hasPersistedLoopSource, { timeout: 15_000 }).toBe(true);
    }
    await editOrchAgentField(page, 'loop_agent', 'Keep the unwritten ledger observations.');
    if (kind === 'save') {
        return async () => saveOrchDrafts(page);
    }
    if (kind === 'limits') {
        const field = await getOrchRuntimeLimitInput(page, /Loop max rounds|Loop 最大轮数|Loop 最大輪數/i);
        const trigger = async () => {
            trigger.expectedLimit = Number(await field.inputValue()) + 1;
            await field.fill(String(trigger.expectedLimit)); await field.press('Tab');
        };
        return trigger;
    }
    const popup = await openOrchAddCustomToolPopup(page);
    const toolName = `read_ledger_${randomUUID().replaceAll('-', '_')}`;
    await popup.locator('[data-orch-ct-name]').fill(toolName);
    await popup.locator('[data-orch-ct-description]').fill('Read the ledger.');
    const trigger = async () => { await popup.locator('.popup-button-ok').click(); await popup.waitFor({ state: 'detached' }); };
    trigger.expectedTool = { name: toolName, displayName: '', description: 'Read the ledger.', mode: 'write', parameters: { type: 'object' }, body: '', simulateBody: '' };
    return trigger;
}

for (const kind of ['save', 'limits', 'tools']) {
    test(`global ${kind} failed save retains unrelated unsaved draft through a real host refresh`, async ({ page }) => {
        const trigger = await prepareDraft(page, kind);
        const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
        const before = disk().extension_settings.orchestrator.presetLibraries.loop;
        chmodSync(root, 0o555);
        try {
            const response = page.waitForResponse(r => r.url().endsWith('/api/settings/save'));
            await trigger(); await response;
            await expect(page.locator('#toast-container')).toContainText('Settings could not be saved');
            await setOrchMode(page, 'spec');
            await setOrchMode(page, 'loop');
            await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the unwritten ledger observations.');
            expect(disk().extension_settings.orchestrator.presetLibraries.loop).toEqual(before);
            await expect(page.locator('#toast-container')).not.toContainText('Global orchestration profile saved.');
        } finally { chmodSync(root, mode); }
    });
}

for (const kind of ['limits', 'tools']) {
    test(`global ${kind} successful auto-save preserves unrelated unsaved editor content`, async ({ page }) => {
        const trigger = await prepareDraft(page, kind);
        const before = JSON.parse(JSON.stringify(activeLoop()));
        const sent = page.waitForResponse(r => r.url().endsWith('/api/settings/patch') || r.url().endsWith('/api/settings/save'));
        await trigger(); expect((await sent).ok()).toBe(true);
        await setOrchMode(page, 'spec');
        await setOrchMode(page, 'loop');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the unwritten ledger observations.');
        const orch = disk().extension_settings.orchestrator;
        const saved = orch.presetLibraries.loop[orch.activePresetIds.loop];
        expect(saved).toEqual(kind === 'limits'
            ? { ...before, max_rounds: trigger.expectedLimit }
            : { ...before, customTools: [...before.customTools, trigger.expectedTool] });
    });
}

test('forcesave never reports settings success after a real storage failure', async ({ page }) => {
    await open(page);
    await selectCharacterByName(page, 'Seraphina');
    await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
    const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
    chmodSync(root, 0o555);
    try {
        await page.locator('#send_textarea').fill('/forcesave'); await page.locator('#send_but').click();
        await expect(page.locator('#toast-container')).toContainText('Settings could not be saved');
        await expect(page.locator('#toast-container')).not.toContainText('Chat and settings saved.');
    } finally { chmodSync(root, mode); }
});

test('global Memory Graph schema failure keeps the edited popup without a success notification', async ({ page }) => {
    await open(page);
    await configureMg(page, { enabled: true, closeAfter: false });
    const schema = await openMgSchemaEditor(page);
    await schema.locator('.ml-schema-list .ml-schema-type').first().click();
    await schema.locator('.ml-schema-additem').first().click();
    const field = schema.locator('.ml-schema-item .ml-schema-itemname').last();
    await field.fill('ledger_note');
    await expect(schema.locator('.ml-schema-state.is-dirty')).toBeVisible();
    const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
    const before = disk().extension_settings.memory_graph.nodeTypeSchema;
    chmodSync(root, 0o555);
    try {
        const response = page.waitForResponse(r => r.url().endsWith('/api/settings/save'));
        await schema.locator('.ml-schema-bar').getByRole('button', { name: /^(Save|保存|儲存)$/ }).click();
        const modal = page.locator('.wbench .mlens .ml-dialog-backdrop').last();
        await expect(modal).toBeVisible();
        await modal.locator('.ml-schema-modal-foot button').last().click();
        expect((await response).status()).toBe(500);
        await expect(field).toHaveValue('ledger_note');
        await expect(schema.locator('.ml-schema-state.is-dirty')).toBeVisible();
        await expect(schema.locator('.ml-schema-toast')).not.toHaveText(/^(Saved|已保存|已儲存)$/);
        expect(disk().extension_settings.memory_graph.nodeTypeSchema).toEqual(before);
    } finally { chmodSync(root, mode); }
});

async function orchPresetSelect(page) {
    const lens = await openOrchWorkspace(page, 'setup');
    const select = lens.locator('.ol-setup-bar select[aria-label]').first();
    await expect(select).toBeVisible({ timeout: 10_000 });
    return { lens, select };
}

test('switching the active global preset during a save cannot overwrite the newly selected draft', async ({ page, context }) => {
    await open(page);
    await enableOrchestratorMode(page, 'loop', { closeAfter: false });
    await presetAction(page, 'new', 'Evening Ledger');
    const { select } = await orchPresetSelect(page);
    await expect(select.locator('option')).not.toHaveCount(1);
    await expect.poll(async () => select.locator('option:checked').textContent()).toBe('Evening Ledger');
    const eveningValue = await select.inputValue();
    const evening = eveningValue.replace(/^global:/, '');
    const otherValue = await select.locator('option').evaluateAll((options, current) => options.find(o => o.value !== current && o.value.startsWith('global:'))?.value, eveningValue);
    expect(otherValue).toBeTruthy();
    const other = otherValue.replace(/^global:/, '');
    await select.selectOption(otherValue);
    await expect.poll(() => page.evaluate(async () => {
        const { uiState } = await import('/scripts/extensions/orchestrator/editor-state.js');
        return uiState.globalActivePresetIds.loop;
    })).toBe(other);
    await editOrchAgentField(page, 'loop_agent', 'Keep the old watch ledger.');
    await setOrchMode(page, 'director');
    await editOrchAgentField(page, 'main', 'Keep the unsent director ledger.');
    await setOrchMode(page, 'loop');
    await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the old watch ledger.');
    const { select: loopSelect } = await orchPresetSelect(page);
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
    try {
        const sent = page.waitForRequest(r => r.url().endsWith('/api/settings/patch') || r.url().endsWith('/api/settings/save'));
        await saveOrchDrafts(page); await sent;
        await loopSelect.selectOption(eveningValue);
        await expect.poll(() => disk().extension_settings.orchestrator.activePresetIds.loop).toBe(evening);
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).not.toBe('Keep the old watch ledger.');
        expect(disk().extension_settings.orchestrator.presetLibraries.loop[other].system_prompt).toBe('Keep the old watch ledger.');
        await setOrchMode(page, 'director');
        await expect.poll(() => readOrchAgentField(page, 'main')).toBe('Keep the unsent director ledger.');
    } finally { await cdp.detach(); }
});

test('a delayed explicit global save does not replace edits made after its captured payload', async ({ page, context }) => {
    const trigger = await prepareDraft(page, 'save');
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
    try {
        const sent = page.waitForRequest(r => r.url().endsWith('/api/settings/patch') || r.url().endsWith('/api/settings/save'));
        const response = page.waitForResponse(r => r.url().endsWith('/api/settings/patch') || r.url().endsWith('/api/settings/save'));
        await trigger(); await sent;
        await editOrchAgentField(page, 'loop_agent', 'Keep the later unsent ledger observations.');
        expect((await response).ok()).toBe(true);
        const orch = disk().extension_settings.orchestrator;
        expect(orch.presetLibraries.loop[orch.activePresetIds.loop].system_prompt).toBe('Keep the unwritten ledger observations.');
        await setOrchMode(page, 'spec');
        await setOrchMode(page, 'loop');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the later unsent ledger observations.');
    } finally { await cdp.detach(); }
});

const ACTION_TITLE_PATTERNS = {
    new: /^(New|新建)$/i,
    duplicate: /^(Duplicate|复制|複製)$/i,
    rename: /^(Rename|重命名|重新命名)$/i,
    delete: /^(Delete|删除|刪除)$/i,
};

async function presetAction(page, action, name) {
    const lens = await openOrchWorkspace(page, 'setup');
    const pattern = ACTION_TITLE_PATTERNS[action];
    const buttons = lens.locator('.ol-setup-bar button');
    const count = await buttons.count();
    let clicked = false;
    for (let i = 0; i < count; i++) {
        const b = buttons.nth(i);
        const label = (await b.getAttribute('aria-label')) || (await b.getAttribute('title')) || '';
        if (pattern.test(label.trim())) {
            await b.click();
            clicked = true;
            break;
        }
    }
    expect(clicked, `preset bar button for ${action}`).toBe(true);
    const dialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    if (action !== 'delete') {
        await dialog.locator('input.ol-input').first().fill(name);
        await dialog.locator('.ol-dialog-foot button.is-primary').first().click();
    } else {
        await dialog.locator('.ol-dialog-foot button.is-danger').first().click();
    }
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
}

async function importLoop(page) {
    const name = 'Imported ' + randomUUID();
    const lens = await openOrchWorkspace(page, 'setup');
    const importBtn = lens.locator('.ol-setup-bar button').filter({ hasText: /^(Import|导入|導入)$/i }).first();
    const chooser = page.waitForEvent('filechooser');
    await importBtn.click();
    await (await chooser).setFiles({ name: name + '.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'luker_orchestrator_profile_v4', mode: 'loop', name, profile: { mode: 'loop', system_prompt: 'Keep the imported ledger.', max_rounds: 9 } })) });
    const dialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.locator('input.ol-input').first().fill(name);
    await dialog.locator('.ol-dialog-foot button.is-primary').first().click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
}

async function globalSetup(page) {
    await open(page); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await enableOrchestratorMode(page, 'loop');
    if (!disk().extension_settings?.orchestrator?.activePresetIds?.loop) {
        await forceSaveViaSlash(page);
    }
    await expect.poll(() => disk().extension_settings.orchestrator?.activePresetIds?.loop).toBeTruthy();
    const initialId = disk().extension_settings.orchestrator.activePresetIds.loop;
    await selectGlobalPreset(page, initialId);
    await expect.poll(() => page.evaluate(() => {
        const c = window.Luker.getContext(); return c.characters[c.characterId]?.data?.extensions?.orchestrator?.activePresetIds?.loop || '';
    })).toBe('');
    const name = 'First ' + randomUUID();
    await presetAction(page, 'new', name);
    await expect.poll(() => activeLoop().name).toBe(name);
    const globalId = disk().extension_settings.orchestrator.activePresetIds.loop;
    await selectGlobalPreset(page, globalId);
    await expect.poll(() => page.evaluate(() => {
        const c = window.Luker.getContext(); return c.characters[c.characterId]?.data?.extensions?.orchestrator?.activePresetIds?.loop || '';
    })).toBe('');
    const { select } = await orchPresetSelect(page);
    await expect.poll(() => select.locator('option:checked').textContent()).toBe(name);
    await editOrchAgentField(page, 'loop_agent', 'Keep the first ledger.');
    await saveOrchDrafts(page);
    await expect.poll(() => activeLoop().system_prompt).toBe('Keep the first ledger.');
    return globalId;
}
async function selectGlobalPreset(page, id) {
    const { select } = await orchPresetSelect(page);
    await select.selectOption(`global:${id}`);
}
function activeLoop() { const orch = disk().extension_settings.orchestrator; return orch.presetLibraries.loop[orch.activePresetIds.loop]; }

for (const failure of [false, true]) {
    test(`card to already-active global binds the requested source with storage failure ${failure}`, async ({ page }) => {
        await globalSetup(page);
        const global = JSON.parse(JSON.stringify(activeLoop()));
        const globalId = disk().extension_settings.orchestrator.activePresetIds.loop;
        await editOrchAgentField(page, 'loop_agent', 'Keep the separate card ledger.');
        await clickOrchSetupBarButton(page, /Save To Character Override|保存为角色覆盖|儲存為角色覆寫/i);
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/extensions/orchestrator/editor-state.js')).uiState.characterLoopEditor.system_prompt)).toBe('Keep the separate card ledger.');
        const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
        if (failure) chmodSync(root, 0o555);
        try {
            await selectGlobalPreset(page, globalId);
            if (failure) {
                await expect(page.locator('#toast-container')).toContainText('Settings could not be saved');
                await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the separate card ledger.');
            } else {
                await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(global.system_prompt);
            }
        } finally { chmodSync(root, mode); }
        if (failure) {
            await selectGlobalPreset(page, globalId);
            await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(global.system_prompt);
        }
        await editOrchAgentField(page, 'loop_agent', 'Keep the later global ledger.');
        await saveOrchDrafts(page);
        await expect.poll(() => activeLoop()).toEqual({ ...global, system_prompt: 'Keep the later global ledger.' });
    });
}

test('equal card and global opaque ids still select the explicit global source', async ({ page }) => {
    await open(page);
    await selectCharacterByName(page, 'Keeper of the Matching Ledger');
    await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Matching Ledger');
    await enableOrchestratorMode(page, 'loop', { closeAfter: false });
    await selectGlobalPreset(page, 'default');
    await expect.poll(() => disk().extension_settings.orchestrator.activePresetIds.loop).toBe('default');
    const global = JSON.parse(JSON.stringify(activeLoop()));
    const { select } = await orchPresetSelect(page);
    await select.selectOption('character:default');
    await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the distinct matching card ledger.');
    const card = JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', 'matching-ledger.png')))).data.extensions.orchestrator;
    expect(card.activePresetIds.loop).toBe(disk().extension_settings.orchestrator.activePresetIds.loop);
    expect(card.activePresetIds.loop).toBe('default');
    await selectGlobalPreset(page, 'default');
    await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(global.system_prompt);
    await clickOrchSetupBarButton(page, /Save To Character Override|保存为角色覆盖|儲存為角色覆寫/i);
    await selectGlobalPreset(page, 'default');
    await expect.poll(() => activeLoop()).toEqual(global);
});

for (const action of ['rename', 'delete']) {
    for (const move of ['selection', 'avatar']) {
        test(`held ${action} retains skill operation ownership across unrelated ${move}`, async ({ page, context }) => {
            await globalSetup(page);
            const original = activeLoop(); const id = disk().extension_settings.orchestrator.activePresetIds.loop;
            const before = JSON.parse(JSON.stringify(disk().extension_settings.orchestrator.presetLibraries.loop));
            const other = Object.keys(before).find(key => key !== id);
            const name = 'Renamed ' + randomUUID();
            const scopeDir = resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', original.name);
            const content = '---\nname: ledger\ndescription: Read ledger\n---\nKeep the ledger.\n';
            mkdirSync(resolve(scopeDir, 'ledger'), { recursive: true }); writeFileSync(resolve(scopeDir, 'ledger', 'SKILL.md'), content);
            const cdp = await context.newCDPSession(page);
            await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/settings/patch', requestStage: 'Response' }] });
            try {
                const paused = new Promise(resolve => cdp.once('Fetch.requestPaused', resolve));
                await presetAction(page, action, name); const pending = await paused;
                expect(pending.responseStatusCode).toBe(200);
                expect(existsSync(scopeDir)).toBe(true);
                if (move === 'selection') {
                    await selectGlobalPreset(page, other);
                    await expect.poll(() => page.evaluate(() => {
                        const c = window.Luker.getContext(); return c.characters[c.characterId]?.data?.extensions?.orchestrator?.activePresetIds?.loop || '';
                    })).toBe('');
                } else {
                    await closeWorkbench(page);
                    await selectCharacterByName(page, 'Seraphina');
                    await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
                    await enableOrchestratorMode(page, 'loop', { closeAfter: false });
                }
                await editOrchAgentField(page, 'loop_agent', 'Keep the unrelated unsaved ledger.');
                await cdp.send('Fetch.continueRequest', { requestId: pending.requestId }); await cdp.send('Fetch.disable');
                await expect.poll(() => existsSync(scopeDir)).toBe(false);
                const expected = { ...before }; if (action === 'rename') expected[id] = { ...original, name }; else delete expected[id];
                expect(disk().extension_settings.orchestrator.presetLibraries.loop).toEqual(expected);
                if (action === 'rename') expect(readFileSync(resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', name, 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
                await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the unrelated unsaved ledger.');
            } finally { await cdp.detach(); }
        });
    }
}

for (const action of ['select', 'new', 'duplicate', 'import']) {
    test(`failed global ${action} cannot attach the old draft to the desired target`, async ({ page }) => {
        const first = await globalSetup(page);
        await presetAction(page, 'new', 'Second ' + randomUUID());
        await expect.poll(() => activeLoop().name.startsWith('Second ')).toBe(true);
        const { select } = await orchPresetSelect(page);
        const second = (await select.inputValue()).replace(/^global:/, '');
        await selectGlobalPreset(page, first);
        await expect.poll(() => disk().extension_settings.orchestrator.activePresetIds.loop).toBe(first);
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/extensions/orchestrator/editor-state.js')).uiState.globalLoopEditor.system_prompt)).toBe('Keep the first ledger.');
        const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
        chmodSync(root, 0o555);
        try {
            if (action === 'select') await selectGlobalPreset(page, second);
            else if (action === 'import') await importLoop(page);
            else await presetAction(page, action, 'Target ' + randomUUID());
            await expect(page.locator('#toast-container')).toContainText('Settings could not be saved');
        } finally { chmodSync(root, mode); }
        const desired = await page.evaluate(() => { const s = window.Luker.getContext().extensionSettings.orchestrator; return s.presetLibraries.loop[s.activePresetIds.loop]; });
        await setOrchMode(page, 'spec'); await setOrchMode(page, 'loop');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(desired.system_prompt);
        await closeWorkbench(page);
        await forceSaveViaSlash(page);
        await expect.poll(() => activeLoop()).toEqual(desired);
    });
}

for (const finalAction of ['rename', 'delete']) {
    test(`same-target acknowledged rename chain composes through ${finalAction}`, async ({ page, context }) => {
        await globalSetup(page);
        const original = activeLoop(); const id = disk().extension_settings.orchestrator.activePresetIds.loop;
        const middle = 'Middle ' + randomUUID(); const last = 'Last ' + randomUUID();
        const scope = name => resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', name);
        const content = '---\nname: ledger\ndescription: Read ledger\n---\nKeep ledger.\n';
        mkdirSync(resolve(scope(original.name), 'ledger'), { recursive: true }); writeFileSync(resolve(scope(original.name), 'ledger', 'SKILL.md'), content);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/settings/patch', requestStage: 'Response' }] });
        try {
            const paused = new Promise(resolve => cdp.once('Fetch.requestPaused', resolve));
            await presetAction(page, 'rename', middle); const pending = await paused;
            await presetAction(page, finalAction, last);
            expect(existsSync(scope(original.name))).toBe(true);
            await cdp.send('Fetch.continueRequest', { requestId: pending.requestId }); await cdp.send('Fetch.disable');
            await expect.poll(() => existsSync(scope(original.name))).toBe(false);
            await expect.poll(() => existsSync(scope(middle))).toBe(false);
            if (finalAction === 'rename') {
                await expect.poll(() => existsSync(scope(last))).toBe(true);
                expect(disk().extension_settings.orchestrator.presetLibraries.loop[id]).toEqual({ ...original, name: last });
                expect(readFileSync(resolve(scope(last), 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
            } else expect(disk().extension_settings.orchestrator.presetLibraries.loop[id]).toBeUndefined();
        } finally { await cdp.detach(); }
    });
}

test('failed rename followed by an acknowledged rename uses the last real skill scope', async ({ page }) => {
    await globalSetup(page);
    const original = activeLoop(); const id = disk().extension_settings.orchestrator.activePresetIds.loop;
    const middle = 'Unwritten ' + randomUUID(); const last = 'Written ' + randomUUID();
    const scope = name => resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', name);
    const content = '---\nname: ledger\ndescription: Read ledger\n---\nKeep ledger.\n';
    mkdirSync(resolve(scope(original.name), 'ledger'), { recursive: true }); writeFileSync(resolve(scope(original.name), 'ledger', 'SKILL.md'), content);
    const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
    chmodSync(root, 0o555);
    try { await presetAction(page, 'rename', middle); await expect(page.locator('#toast-container')).toContainText('Settings could not be saved'); }
    finally { chmodSync(root, mode); }
    expect(existsSync(scope(original.name))).toBe(true);
    await presetAction(page, 'rename', last);
    await expect.poll(() => existsSync(scope(last))).toBe(true);
    expect(existsSync(scope(original.name))).toBe(false); expect(existsSync(scope(middle))).toBe(false);
    expect(disk().extension_settings.orchestrator.presetLibraries.loop[id]).toEqual({ ...original, name: last });
    expect(readFileSync(resolve(scope(last), 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
});

for (const rename of ['failed', 'held']) {
    test(`duplicate resolves its actual source after a ${rename} rename`, async ({ page, context }) => {
        const sourceId = await globalSetup(page);
        const original = JSON.parse(JSON.stringify(activeLoop()));
        const before = JSON.parse(JSON.stringify(disk().extension_settings.orchestrator.presetLibraries.loop));
        const renamed = 'Source ' + randomUUID(); const duplicate = 'Copy ' + randomUUID();
        const scope = name => resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', name);
        const content = '---\nname: ledger\ndescription: Read the source ledger\n---\nRetain the exact source ledger.\n';
        mkdirSync(resolve(scope(original.name), 'ledger'), { recursive: true });
        writeFileSync(resolve(scope(original.name), 'ledger', 'SKILL.md'), content);
        const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
        const cdp = await context.newCDPSession(page);
        try {
            if (rename === 'failed') {
                chmodSync(root, 0o555);
                try { await presetAction(page, 'rename', renamed); await expect(page.locator('#toast-container')).toContainText('Settings could not be saved'); }
                finally { chmodSync(root, mode); }
            } else {
                await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/settings/patch', requestStage: 'Response' }] });
            }
            const paused = rename === 'held' ? new Promise(resolve => cdp.once('Fetch.requestPaused', resolve)) : null;
            if (rename === 'held') await presetAction(page, 'rename', renamed);
            const pending = paused ? await paused : null;
            if (pending) expect(pending.responseStatusCode).toBe(200);
            expect(readFileSync(resolve(scope(original.name), 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
            expect(existsSync(scope(renamed))).toBe(false);
            await presetAction(page, 'duplicate', duplicate);
            const { select } = await orchPresetSelect(page);
            await expect(select).not.toHaveValue(`global:${sourceId}`);
            const destinationId = (await select.inputValue()).replace(/^global:/, '');
            if (pending) {
                expect(existsSync(scope(duplicate))).toBe(false);
                await cdp.send('Fetch.continueRequest', { requestId: pending.requestId }); await cdp.send('Fetch.disable');
            }
            await expect.poll(() => existsSync(resolve(scope(duplicate), 'ledger', 'SKILL.md'))).toBe(true);
            expect(readFileSync(resolve(scope(duplicate), 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
            expect(disk().extension_settings.orchestrator.presetLibraries.loop).toEqual({
                ...before,
                [sourceId]: { ...original, name: rename === 'held' ? renamed : original.name },
                [destinationId]: { ...original, name: duplicate },
            });
            expect(readFileSync(resolve(scope(rename === 'held' ? renamed : original.name), 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
        } finally { chmodSync(root, mode); await cdp.detach(); }
    });
}

for (const action of ['rename', 'new', 'import']) {
    test(`delayed global ${action} completion preserves a later same-mode edit`, async ({ page, context }) => {
        await globalSetup(page);
        const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
        try {
            const sent = page.waitForRequest(r => /\/api\/settings\/(save|patch)$/.test(r.url()));
            const settled = page.waitForResponse(r => /\/api\/settings\/(save|patch)$/.test(r.url()));
            if (action === 'import') await importLoop(page);
            else await presetAction(page, action, 'Later ' + randomUUID());
            await sent;
            await editOrchAgentField(page, 'loop_agent', 'Keep the later unsaved ledger.');
            expect((await settled).ok()).toBe(true);
            await openOrchWorkspace(page, 'setup');
            await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the later unsaved ledger.');
        } finally { await cdp.detach(); }
    });
}

test('overlapping desired selections keep the latest owned draft while requests settle', async ({ page, context }) => {
    await globalSetup(page);
    const first = disk().extension_settings.orchestrator.activePresetIds.loop;
    await presetAction(page, 'new', 'Second ' + randomUUID());
    const { select } = await orchPresetSelect(page);
    const second = (await select.inputValue()).replace(/^global:/, '');
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
    try {
        await select.selectOption(`global:${first}`);
        await select.selectOption(`global:${second}`);
        await select.selectOption(`global:${first}`);
        await editOrchAgentField(page, 'loop_agent', 'Keep the latest selected unsaved ledger.');
        await expect.poll(() => disk().extension_settings.orchestrator.activePresetIds.loop).toBe(first);
        await openOrchWorkspace(page, 'setup');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the latest selected unsaved ledger.');
    } finally { await cdp.detach(); }
});

test('pending global rename cannot reload a new avatar draft after its unsaved edit', async ({ page, context }) => {
    await globalSetup(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/settings/patch', requestStage: 'Response' }] });
    try {
        let settled = false;
        const name = 'Renamed ' + randomUUID();
        const requested = page.waitForRequest(r => r.url().endsWith('/api/settings/patch') && r.postData().includes(JSON.stringify(name)));
        const response = requested.then(async request => {
            const renamed = await request.response();
            expect(renamed).not.toBeNull();
            await renamed.finished();
            settled = true;
            return renamed;
        });
        const paused = new Promise(resolve => cdp.once('Fetch.requestPaused', resolve));
        await presetAction(page, 'rename', name); const pending = await paused;
        expect(pending.request.postData).toBe((await requested).postData());
        await closeWorkbench(page);
        await selectCharacterByName(page, 'Seraphina');
        await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
        await enableOrchestratorMode(page, 'loop', { closeAfter: false });
        await editOrchAgentField(page, 'loop_agent', 'Keep the new watch unsaved ledger.');
        expect(settled).toBe(false);
        await cdp.send('Fetch.continueRequest', { requestId: pending.requestId }); await cdp.send('Fetch.disable');
        expect((await response).ok()).toBe(true);
        await openOrchWorkspace(page, 'setup');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the new watch unsaved ledger.');
    } finally { await cdp.detach(); }
});

for (const action of ['rename', 'delete']) {
    test(`failed global ${action} leaves the dependent real skill directory unchanged`, async ({ page }) => {
        await globalSetup(page);
        const original = activeLoop();
        const skillDir = resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', original.name, 'ledger');
        const content = '---\nname: ledger\ndescription: Read the ledger\n---\nKeep the watch ledger.\n';
        mkdirSync(skillDir, { recursive: true }); writeFileSync(resolve(skillDir, 'SKILL.md'), content);
        const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
        chmodSync(root, 0o555);
        try {
            await presetAction(page, action, 'Renamed ' + randomUUID());
            await expect(page.locator('#toast-container')).toContainText('Settings could not be saved');
            expect(existsSync(resolve(skillDir, 'SKILL.md'))).toBe(true);
            expect(readFileSync(resolve(skillDir, 'SKILL.md'), 'utf8')).toBe(content);
            expect(Object.values(disk().extension_settings.orchestrator.presetLibraries.loop)).toContainEqual(original);
        } finally { chmodSync(root, mode); }
    });
}

for (const action of ['rename', 'delete']) {
    test(`acknowledged global ${action} runs its dependent real skill operation afterward`, async ({ page }) => {
        await globalSetup(page);
        const original = activeLoop(); const name = 'Renamed ' + randomUUID();
        const scopeDir = resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', original.name);
        const skillDir = resolve(scopeDir, 'ledger'); const content = '---\nname: ledger\ndescription: Read the ledger\n---\nKeep the ledger.\n';
        mkdirSync(skillDir, { recursive: true }); writeFileSync(resolve(skillDir, 'SKILL.md'), content);
        await presetAction(page, action, name);
        await expect.poll(() => existsSync(scopeDir)).toBe(false);
        if (action === 'rename') {
            expect(activeLoop().name).toBe(name);
            expect(readFileSync(resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', name, 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
        } else expect(Object.values(disk().extension_settings.orchestrator.presetLibraries.loop).some(p => p.name === original.name)).toBe(false);
    });
}

async function openMgTechnicalPanel(page) {
    const lens = await openMemoryWorkspace(page, { subview: 'settings' });
    const panel = lens.locator('.ml-settings').first();
    const details = panel.locator('[data-settings-section="technical"]').first();
    await details.waitFor({ state: 'visible', timeout: 15_000 });
    if (!(await details.evaluate(el => el.hasAttribute('open')))) {
        await details.locator('summary.ml-settings-summary').first().click();
    }
    return panel;
}

test('a delayed advanced save cannot clear a later editor revision through host hydration', async ({ page, context }) => {
    await open(page);
    await configureMg(page, { enabled: true, closeAfter: false });
    let panel = await openMgTechnicalPanel(page);
    let field = panel.locator('[data-field-key="recallQueryMessages"] input');
    await field.fill('7'); await field.press('Tab');
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
    try {
        const sent = page.waitForRequest(r => /\/api\/settings\/(save|patch)$/.test(r.url()));
        const response = page.waitForResponse(r => /\/api\/settings\/(save|patch)$/.test(r.url()));
        await panel.locator('.ml-settings-sticky button').filter({ hasText: /^(Save Advanced to Global|保存高级到全局|儲存進階到全域)$/ }).first().click();
        await sent;
        await field.fill('8'); await field.press('Tab');
        expect((await response).ok()).toBe(true);
        expect(disk().extension_settings.memory_graph.recallQueryMessages).toBe(7);
        await expect(panel.locator('.ml-settings-dirty-pill')).toBeVisible();
        await expect(field).toHaveValue('8');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await closeWorkbench(page);
        await selectCharacterByName(page, 'Seraphina');
        await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
        panel = await openMgTechnicalPanel(page);
        field = panel.locator('[data-field-key="recallQueryMessages"] input');
        await field.fill('9'); await field.press('Tab');
        await closeWorkbench(page);
        panel = await openMgTechnicalPanel(page);
        await expect(panel.locator('.ml-settings-dirty-pill')).toBeVisible();
        await expect(panel.locator('[data-field-key="recallQueryMessages"] input')).toHaveValue('9');
    } finally { await cdp.detach(); }
});

test('clear card override then global tool auto-save supplies the actual inherited tools to character copy', async ({ page }) => {
    await globalSetup(page);
    await clickOrchSetupBarButton(page, /Save To Character Override|保存为角色覆盖|儲存為角色覆寫/i);
    await expect.poll(() => page.evaluate(() => {
        const c = window.Luker.getContext(); return c.characters[c.characterId].data.extensions.orchestrator?.activePresetIds?.loop;
    })).toBeTruthy();
    const storedCard = JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', 'settings-ledger.png'))));
    expect(storedCard.data.extensions.orchestrator.activePresetIds.loop).toBeTruthy();
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/extensions/orchestrator/editor-state.js')).uiState.characterLoopEditor.enabled)).toBe(true);
    const originalPopup = await openOrchAddCustomToolPopup(page);
    const cardTool = 'read_card_' + randomUUID().replaceAll('-', '_');
    await originalPopup.locator('[data-orch-ct-name]').fill(cardTool); await originalPopup.locator('[data-orch-ct-description]').fill('Read the card ledger.');
    await originalPopup.locator('.popup-button-ok').click(); await originalPopup.waitFor({ state: 'detached' });
    await expect.poll(() => JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', 'settings-ledger.png')))).data.extensions.orchestrator.presetLibraries.loop).toBeTruthy();
    await closeWorkbench(page);
    await selectCharacterByName(page, 'Seraphina');
    await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
    await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await enableOrchestratorMode(page, 'loop', { closeAfter: false });
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/extensions/orchestrator/editor-state.js')).uiState.characterLoopEditor.customTools.map(t => t.name))).toContain(cardTool);
    const lens = await openOrchWorkspace(page, 'setup');
    await clickOrchSetupBarButton(page, /Clear presets from this card|清除此卡预设|清除此卡預設/i);
    const confirmDialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
    await expect(confirmDialog).toBeVisible({ timeout: 10_000 });
    await confirmDialog.locator('.ol-dialog-foot button.is-danger').first().click();
    await confirmDialog.waitFor({ state: 'hidden', timeout: 5000 });
    await expect.poll(() => page.evaluate(() => {
        const c = window.Luker.getContext(); return c.characters[c.characterId].data.extensions.orchestrator?.activePresetIds?.loop || '';
    })).toBe('');
    const popup = await openOrchAddCustomToolPopup(page);
    const name = 'read_inherited_' + randomUUID().replaceAll('-', '_');
    await popup.locator('[data-orch-ct-name]').fill(name); await popup.locator('[data-orch-ct-description]').fill('Read inherited ledger.');
    await popup.locator('.popup-button-ok').click(); await popup.waitFor({ state: 'detached' });
    await expect.poll(() => activeLoop().customTools.map(t => t.name)).toContain(name);
    const intended = activeLoop().customTools;
    await clickOrchSetupBarButton(page, /Save To Character Override|保存为角色覆盖|儲存為角色覆寫/i);
    await expect.poll(() => page.evaluate(() => {
        const c = window.Luker.getContext(); const s = c.characters[c.characterId].data.extensions.orchestrator;
        return s?.presetLibraries?.loop?.[s?.activePresetIds?.loop]?.customTools;
    })).toEqual(intended);
    const savedCard = JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', 'settings-ledger.png')))).data.extensions.orchestrator;
    expect(savedCard.presetLibraries.loop[savedCard.activePresetIds.loop].customTools).toEqual(intended);
});
