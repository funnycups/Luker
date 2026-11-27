// i18n — zh-cn translations per plugin configuration.
//
// Real user path for every configuration:
//   1. Extensions → Manage extensions: switch the iteration plugins on or off
//      (the toggle handler saves and reloads). The search-tools case also
//      switches CardApp off so search-tools is the only Luker plugin running.
//   2. User Settings → UI language: zh-cn (the change handler reloads).
//   3. Single-plugin cases: User Settings → Debug Menu → "Track dynamic
//      translation" (takes effect without a reload), drive the plugin
//      surface that renders shared platform UI, then turn on User Settings →
//      "Frontend debug logs" and run Debug Menu → "Get missing translations"
//      and read the dynamic-miss map from the console:
//        search-tools → pre-request agent run panel (run-panel/)
//        Memory Graph → schema studio proposal card (proposal-bus/, ui/)
//        CPA          → studio proposal card (proposal-bus/, ui/diff.js)
//      Assertion: no key from (shared platform call sites ∪ translatable keys
//      used by the enabled plugin) was looked up without a translation.
//   4. All-plugins case: the core loader toast keeps the core wording of
//      "Stop" although the Character Editor Assistant table translates the
//      same key differently, and the orchestrator and Memory Graph injection
//      position help buttons each carry their own plugin's text for one key.
// Expected values come from scripts/check-i18n-coverage.js, the inventory
// `npm run lint:i18n` checks statically.

import { test, expect } from '../../harness/playwright.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, closeExtensionsDrawer, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';
import { closeWorkbench, openMemoryWorkspace, openOrchWorkspace, setOrchMode } from '../_lib/ui-workbench.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const ITERATION_PLUGINS = [
    'orchestrator',
    'memory-graph',
    'character-editor-assistant',
    'completion-preset-assistant',
    'search-tools',
];
const AGENT_SEARCH = 'luker_search_agent_search';
const AGENT_UPSERT = 'luker_search_agent_upsert_lorebook_entry';
const MAIN_REPLY = '*Seraphina sets the lantern on the sill and studies the tide chart.* "The water will turn within the hour. We wait for it."';
const HELP_KEY = 'Injection position help body';

/** @type {ReturnType<typeof import('../../../scripts/check-i18n-coverage.js').collectInventory>} */
let inventory;

test.beforeAll(async () => {
    const checker = await import(pathToFileURL(resolve(REPO_ROOT, 'scripts/check-i18n-coverage.js')).href);
    inventory = checker.collectInventory(REPO_ROOT);
});

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function zhCnJson(key) {
    const value = inventory.json['zh-cn'][key];
    expect(typeof value, `public/locales/zh-cn.json must translate ${JSON.stringify(key)}`).toBe('string');
    return value;
}

function tableValue(owner, locale, key) {
    return inventory.tables.find(t => t.owner === owner && t.locale === locale && t.entries.has(key))?.entries.get(key).value;
}

function scopedTableValue(owner, key) {
    const value = tableValue(owner, 'zh-cn', key);
    expect(value, `${owner} zh-cn table must define ${JSON.stringify(key)}`).toBeTruthy();
    return value;
}

/** zh-cn text a plugin renders for `key`: its own table first, then public/locales. */
function resolveZhCn(plugin, key) {
    const own = tableValue(plugin, 'zh-cn', key);
    if (own) return own;
    const core = inventory.json['zh-cn'][key];
    expect(typeof core === 'string' && core.length > 0, `zh-cn translation for ${JSON.stringify(key)} in the ${plugin} table or public/locales`).toBe(true);
    return core;
}

/** Keys that must resolve at runtime when only `plugin` is enabled. */
function scopeKeysFor(plugin) {
    const translatable = new Set(Object.keys(inventory.json['zh-cn']));
    for (const t of inventory.tables) for (const k of t.entries.keys()) translatable.add(k);
    const keys = new Set();
    for (const k of inventory.sharedCalls.keys()) if (!k.startsWith('sim.')) keys.add(k);
    const prefix = `public/scripts/extensions/${plugin}/`;
    for (const [k, files] of inventory.literalFiles) {
        if (k.startsWith('sim.') || !translatable.has(k)) continue;
        if ([...files].some(f => f.startsWith(prefix))) keys.add(k);
    }
    return keys;
}

async function bootServer(scope, scenarioId) {
    const mock = await startMockLLM({});
    const server = await startServer({ scope, batchKey: 'regression', scenarioId, extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    return { mock, server };
}

async function setIterationPlugins(page, baseURL, enabledNames, managedNames = ITERATION_PLUGINS) {
    await openExtensionsDrawer(page);
    await page.locator('#extensions_details').click();
    const managePopup = page.locator('dialog.popup[open]', { hasText: /Installed Extensions|Built-in Extensions/ }).last();
    await managePopup.waitFor({ state: 'visible', timeout: 10_000 });
    let toggled = false;
    for (const name of managedNames) {
        const toggle = managePopup.locator(`.extension_block[data-name="${name}"] .extension_toggle input`);
        await toggle.waitFor({ state: 'attached', timeout: 10_000 });
        const wantEnabled = enabledNames.includes(name);
        if ((await toggle.isChecked()) !== wantEnabled) {
            await toggle.click();
            toggled = true;
        }
    }
    // Read-only barrier: the delegated toggle handler is async; wait until the
    // live settings carry the intended set before closing the popup (closing
    // runs the deferred save and the reload).
    await expect.poll(() => page.evaluate((names) => {
        const disabled = window.Luker.getContext().extensionSettings.disabledExtensions || [];
        return names.filter(n => disabled.includes(n)).sort();
    }, managedNames), { timeout: 10_000 }).toEqual(managedNames.filter(n => !enabledNames.includes(n)).sort());
    const reloaded = toggled ? page.waitForEvent('load', { timeout: 30_000 }) : null;
    await page.keyboard.press('Escape');
    await reloaded;
    await awaitMainUI(page, baseURL);
    const disabledAfterReload = await page.evaluate(() => window.Luker.getContext().extensionSettings.disabledExtensions || []);
    for (const name of managedNames) {
        expect(disabledAfterReload.includes(name), `${name} enabled state after reload`).toBe(!enabledNames.includes(name));
    }
}

async function openUserSettings(page) {
    const closed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count();
    if (closed > 0) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => document.querySelector('#user-settings-button .drawer-icon')?.classList.contains('openIcon'), { timeout: 5000 });
    }
}

async function switchToZhCn(page, baseURL) {
    await openUserSettings(page);
    const select = page.locator('#ui_language_select');
    await select.waitFor({ state: 'visible', timeout: 10_000 });
    await select.scrollIntoViewIfNeeded();
    await select.selectOption({ value: 'zh-cn' });
    await page.waitForFunction(() => document.getElementById('preloader') === null && document.documentElement.lang === 'zh-cn', { timeout: 60_000 });
    await awaitMainUI(page, baseURL);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-cn');
}

async function runDebugFunction(page, functionId) {
    await openUserSettings(page);
    const button = page.locator('#debug_menu');
    await button.scrollIntoViewIfNeeded();
    await button.click();
    const debugPopup = page.locator('dialog.popup[open]').filter({ has: page.locator('#debug_table') }).last();
    await debugPopup.waitFor({ state: 'visible', timeout: 10_000 });
    await debugPopup.locator(`[data-debug-function="${functionId}"]`).click();
    return debugPopup;
}

async function enableDynamicTracking(page, baseURL) {
    const debugPopup = await runDebugFunction(page, 'trackDynamicTranslate');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('trackDynamicTranslate')), { timeout: 5000 }).toBe('true');
    await page.keyboard.press('Escape');
    await debugPopup.waitFor({ state: 'detached', timeout: 5000 });
    await awaitMainUI(page, baseURL);
}

// Luker routes console.log through the frontend log manager, which emits it
// only while the diagnostics menu's "Frontend debug logs" toggle is on; each
// emitted call gains a leading timestamp argument.
async function enableFrontendDebugLogs(page) {
    await openUserSettings(page);
    await page.locator('#debug-export-btn').click();
    const toggle = page.locator('#debug-menu-list [data-debug-action="toggle-frontend-debug-log"]');
    await toggle.waitFor({ state: 'visible', timeout: 5000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.locator('#debug-export-btn').click();
}

/** Runs "Get missing translations" and returns the dynamic-miss keys it logs. */
async function collectDynamicMisses(page) {
    await enableFrontendDebugLogs(page);
    /** @type {import('@playwright/test').ConsoleMessage[]} */
    const messages = [];
    const onConsole = msg => messages.push(msg);
    page.on('console', onConsole);
    try {
        const debugPopup = await runDebugFunction(page, 'getMissingTranslations');
        const headerAt = () => messages.findIndex(m => m.text().includes('Dynamic translations missing ('));
        await expect.poll(() => headerAt() !== -1 && messages.length > headerAt() + 1, { timeout: 30_000 }).toBe(true);
        const map = await messages[headerAt() + 1].args().at(-1).jsonValue();
        await page.keyboard.press('Escape');
        await debugPopup.waitFor({ state: 'detached', timeout: 5000 });
        return Object.keys(map || {});
    } finally {
        page.off('console', onConsole);
    }
}

function expectNoScopedMisses(missed, plugin) {
    const scope = scopeKeysFor(plugin);
    const offending = missed.filter(k => scope.has(k)).sort();
    expect(offending, `keys looked up without a zh-cn translation while only ${plugin} is enabled`).toEqual([]);
}

async function prepareSinglePlugin(page, server, plugin, { alsoDisable = [] } = {}) {
    await awaitMainUI(page, server.baseURL);
    await setIterationPlugins(page, server.baseURL, [plugin], [...ITERATION_PLUGINS, ...alsoDisable]);
    await switchToZhCn(page, server.baseURL);
    await enableDynamicTracking(page, server.baseURL);
}

async function enablePreRequestAgent(page) {
    await openExtensionsDrawer(page);
    await page.locator('#search_tools_settings').waitFor({ state: 'attached', timeout: 10_000 });
    await page.locator('#search_tools_settings .inline-drawer-toggle').first().click();
    await page.locator('#search_tools_settings .inline-drawer-content').first().waitFor({ state: 'visible' });
    await page.locator('#search_tools_agent_api_preset_name').selectOption('');
    await page.locator('#search_tools_agent_preset_name').selectOption('');
    const checkbox = page.locator('#search_tools_pre_request_enabled');
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await closeExtensionsDrawer(page);
}

test.describe('i18n — zh-cn translations per plugin configuration', () => {
    test.setTimeout(300_000);

    test('search-tools only: the run panel renders every lookup translated', async ({ resources, page }) => {
        const { mock, server } = await bootServer(resources, 'i18n-search-tools-only');
        try {
            await prepareSinglePlugin(page, server, 'search-tools', { alsoDisable: ['card-app'] });
            await selectCharacterByName(page, 'Seraphina');
            await enablePreRequestAgent(page);

            let agentTurn = 0;
            mock.clearScriptedCompletion();
            mock.scriptCompletion(({ toolNames }) => {
                const isAgent = Array.isArray(toolNames) && toolNames.includes(AGENT_SEARCH);
                if (!isAgent) return { text: MAIN_REPLY };
                agentTurn += 1;
                if (agentTurn === 1) {
                    return {
                        tool: AGENT_UPSERT,
                        arguments: {
                            title: 'Bryn Tide Ledger',
                            content: 'The Bryn watchpost ledger records each turning of the reef tide and the lantern trimming that follows it.',
                            always_inject: true,
                        },
                    };
                }
                return { text: 'The managed entries already cover this turn; no further search is needed.' };
            });

            await page.locator('#send_textarea').fill('*She taps the ledger.* "When does the reef tide turn tonight?"');
            await page.locator('#send_but').click();

            const panel = page.locator('.rpdock.rp-dock');
            await expect(panel).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
            await expect(panel.locator('.rp-status')).toHaveAttribute('data-status', 'committed', { timeout: 90_000 });
            await panel.locator('.rp-dock-more').click();
            await expect(panel.getByRole('menuitem', { name: scopedTableValue('core:run-panel/locale-data', 'Export trace'), exact: true })).toBeVisible();

            const missed = await collectDynamicMisses(page);
            expectNoScopedMisses(missed, 'search-tools');
        } finally {

            await mock.stop();
        }
    });

    test('Memory Graph only: the schema studio proposal card renders every lookup translated', async ({ resources, page }) => {
        const { mock, server } = await bootServer(resources, 'i18n-memory-graph-only');
        try {
            await prepareSinglePlugin(page, server, 'memory-graph');
            await openIterStudio(page, 'mg');
            mock.scriptToolCall({
                name: 'mg_schema_set_node_type',
                arguments: {
                    node_type: {
                        id: 'tide_ledger',
                        label: 'Tide Ledger Entry',
                        tableName: 'tide_ledger_table',
                        tableColumns: ['entry', 'tide_state'],
                        embeddingColumns: ['entry'],
                        requiredColumns: ['entry'],
                        keywords: ['tide', 'ledger', 'reef'],
                        extractEveryN: 2,
                    },
                },
            });
            await sendIterPrompt(page, 'mg', 'Add a node type for the watchpost tide ledger.');
            const studio = page.locator('.wbench .wb-win');
            await expect(studio.locator('.wb-chg.is-pending .wb-chg-foot button.is-primary')).toHaveText(
                scopedTableValue('core:workbench/locale-data', 'Apply selected (${0})').replace('${0}', '2'));
            await closeIterStudio(page);

            const missed = await collectDynamicMisses(page);
            expectNoScopedMisses(missed, 'memory-graph');
        } finally {

            await mock.stop();
        }
    });

    test('CPA only: the preset studio proposal card renders every lookup translated', async ({ resources, page }) => {
        const { mock, server } = await bootServer(resources, 'i18n-cpa-only');
        try {
            await prepareSinglePlugin(page, server, 'completion-preset-assistant');
            await openIterStudio(page, 'cpa');
            mock.scriptToolCall({
                name: 'preset_set_field',
                arguments: {
                    path: 'temperature',
                    value_json: JSON.stringify(0.55),
                    reason: 'A steadier voice for the long watch scenes.',
                },
            });
            await sendIterPrompt(page, 'cpa', 'Lower the temperature a little for the long watch scenes.');
            const studio = page.locator('.wbench .wb-win');
            await expect(studio.locator('.wb-chg.is-pending .wb-chg-foot button.is-primary')).toHaveText(
                scopedTableValue('core:workbench/locale-data', 'Apply selected (${0})').replace('${0}', '1'));
            await closeIterStudio(page);

            const missed = await collectDynamicMisses(page);
            expectNoScopedMisses(missed, 'completion-preset-assistant');
        } finally {

            await mock.stop();
        }
    });

    test('every plugin enabled: core keeps core wording and each plugin keeps its own', async ({ resources, page }) => {
        const orchHelpBody = scopedTableValue('orchestrator', HELP_KEY);
        const mgHelpBody = scopedTableValue('memory-graph', HELP_KEY);
        expect(orchHelpBody, 'the orchestrator and Memory Graph help texts must differ for this case to discriminate').not.toBe(mgHelpBody);
        expect(scopedTableValue('character-editor-assistant', 'Stop'), 'the Character Editor Assistant must word Stop differently from the core for this case to discriminate').not.toBe(zhCnJson('Stop'));

        const { mock, server } = await bootServer(resources, 'i18n-all-plugins');
        try {
            await awaitMainUI(page, server.baseURL);
            const hasScopedI18nApi = await page.evaluate(() => typeof window.Luker?.getContext?.()?.createScopedI18n === 'function');
            expect(hasScopedI18nApi).toBe(true);
            await setIterationPlugins(page, server.baseURL, ITERATION_PLUGINS);
            await switchToZhCn(page, server.baseURL);
            await selectCharacterByName(page, 'Seraphina');

            await page.locator('#send_textarea').fill('/loader-wrap blocking=false {: /delay 8000 :}');
            await page.locator('#send_but').click();
            const stop = page.locator('.action-loader-toast .action-loader-stop').first();
            await stop.waitFor({ state: 'visible', timeout: 15_000 });
            await expect(stop).toHaveAttribute('title', zhCnJson('Stop'));
            await stop.click();
            await stop.waitFor({ state: 'detached', timeout: 15_000 });

            await setOrchMode(page, 'spec');
            const orchestration = await openOrchWorkspace(page, 'settings');
            const orchHelp = orchestration.locator('label.ol-form-row', {
                hasText: resolveZhCn('orchestrator', 'Injection position'),
            }).locator('.luker-field-help').first();
            await orchHelp.waitFor({ state: 'attached', timeout: 15_000 });
            await expect(orchHelp).toHaveAttribute('data-luker-field-help-body', escapeHtml(orchHelpBody));
            await orchHelp.click();
            const orchPopup = page.locator('dialog.popup[open]').last();
            await expect(orchPopup).toContainText(orchHelpBody);
            await orchPopup.locator('.popup-button-ok').click();
            await expect(orchPopup).toHaveCount(0);

            await closeWorkbench(page);
            const memory = await openMemoryWorkspace(page, { view: 'settings' });
            const mgHelp = memory.locator('[data-field-key="recallInjectPosition"] .luker-field-help');
            await mgHelp.waitFor({ state: 'attached', timeout: 15_000 });
            await expect(mgHelp).toHaveAttribute('data-luker-field-help-body', escapeHtml(mgHelpBody));
            await mgHelp.click();
            const memoryPopup = page.locator('dialog.popup[open]').last();
            await expect(memoryPopup).toContainText(mgHelpBody);
            await memoryPopup.locator('.popup-button-ok').click();
            await expect(memoryPopup).toHaveCount(0);
        } finally {

            await mock.stop();
        }
    });
});
