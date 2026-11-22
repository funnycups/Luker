// Real-UI helpers for embedded Memory Lens (inside Workbench) and
// Variable-Op-Log flows.
//
// MG (Workbench → Memory graph workspace `.mlens`):
//   - openMemoryWorkspace(page, { subview })
//   - setMgSettings(page, settings, { saveScope })
//   - openMgGraphView(page)
//   - openMgSchemaEditor(page)
//   - importMgGraph(page, filePath, { mode })
//   - exportMgGraph(page)
//   - fillMgGraph(page)
//   - rebuildMgIndex(page)
//
// var-ops:
//   - openVarOpsPanel(page, mesid)
//   - getRenderedVarOpsRows(page)
//   - addVarOpRow / saveVarOpsPanel

import { closeWorkbench, openWorkbench, switchWorkbenchTab, workbenchWindow } from './ui-workbench.js';

const SUBVIEW_LABELS = {
    graph: /^(Graph|图谱|圖譜)$/,
    timeline: /^(Timeline|时间线|時間線)$/,
    table: /^(Data table|数据表|資料表)$/,
    schema: /^(Memory structure|记忆结构|記憶結構)$/,
    settings: /^(Settings|设置|設定)$/,
};

const ADVANCED_SAVE_KEYS = new Set([
    'updateEvery',
    'extractBatchTurns',
    'extractContextTurns',
    'extractExcludeRecentTurns',
    'extractMode',
    'extractCrawlMaxRounds',
    'extractCrawlCandidateLimit',
    'extractCrawlMaxReads',
    'persistentInjectionMaxSeqDistance',
    'includeWorldInfoWithPreset',
    'recallMaxIterations',
    'toolCallRetryMax',
    'rpmLimit',
    'recallQueryMessages',
    'llmVisibleRecentMessages',
    'extractConcurrent',
    'extractCrawlSystemPrompt',
    'extractTemplate',
    'extractEdgeRules',
    'recallRouteSystemPrompt',
    'recallFinalizeSystemPrompt',
    'ragRewriteSystemPrompt',
    'configIterSystemPrompt',
    'graphIterSystemPrompt',
]);

const CUSTOM_MODAL_KEYS = new Set([
    'updateEvery',
    'extractBatchTurns',
    'extractContextTurns',
    'extractExcludeRecentTurns',
    'llmVisibleRecentMessages',
    'extractMode',
    'extractCrawlMaxRounds',
    'extractCrawlCandidateLimit',
    'extractCrawlMaxReads',
]);

const TECHNICAL_KEYS = new Set([
    'recallMaxIterations',
    'toolCallRetryMax',
    'rpmLimit',
    'recallQueryMessages',
    'extractConcurrent',
    'extractCrawlSystemPrompt',
    'extractTemplate',
    'extractEdgeRules',
    'recallRouteSystemPrompt',
    'recallFinalizeSystemPrompt',
    'ragRewriteSystemPrompt',
    'configIterSystemPrompt',
    'graphIterSystemPrompt',
]);

async function applyFieldControl(container, key, value, timeoutMs) {
    const field = container.locator(`[data-field-key="${key}"]`).first();
    await field.waitFor({ state: 'visible', timeout: timeoutMs });
    const role = await field.getAttribute('role');
    if (role === 'switch' || role === 'checkbox') {
        const want = Boolean(value);
        const cur = (await field.getAttribute('aria-checked')) === 'true';
        if (cur !== want) {
            await field.click();
        }
        return;
    }
    const checkInside = field.locator('[role="checkbox"]').first();
    if ((await checkInside.count()) > 0) {
        const want = Boolean(value);
        const cur = (await checkInside.getAttribute('aria-checked')) === 'true';
        if (cur !== want) {
            await checkInside.click();
        }
        return;
    }
    const selectEl = field.locator('select').first();
    if ((await selectEl.count()) > 0) {
        await selectEl.selectOption(String(value));
        return;
    }
    const inputEl = field.locator('input, textarea').first();
    await inputEl.fill(String(value));
}

/**
 * Open Workbench, switch to the Memory graph workspace, and activate `subview`.
 */
export async function openMemoryWorkspace(page, { subview = 'graph', timeoutMs = 15_000 } = {}) {
    await openWorkbench(page, { timeoutMs });
    await switchWorkbenchTab(page, 'ws:memory', { timeoutMs });
    const lens = workbenchWindow(page).locator('.mlens').first();
    await lens.waitFor({ state: 'visible', timeout: timeoutMs });

    if (subview) {
        const pattern = SUBVIEW_LABELS[subview];
        if (!pattern) throw new Error(`unknown memory lens subview: ${subview}`);
        const btn = lens.locator('.ml-viewswitch .lw-seg-btn').filter({ hasText: pattern }).first();
        await btn.waitFor({ state: 'visible', timeout: timeoutMs });
        if ((await btn.getAttribute('aria-pressed')) !== 'true') {
            await btn.click();
        }
        const viewEl = lens.locator(`.ml-view[data-view="${subview}"]`).first();
        await viewEl.waitFor({ state: 'visible', timeout: timeoutMs });
    }
    return lens;
}

/**
 * Configure Memory Graph settings via the real `.ml-settings` controls in
 * Workbench → Memory graph → Settings. Handles switches, selects, inputs,
 * expanding the Technical Tuning section when needed, and saving advanced
 * settings if any advanced/technical key is modified.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, boolean|string|number>} settings
 * @param {{ saveScope?: 'global'|'character', closeAfter?: boolean, timeoutMs?: number }} [opts]
 */
export async function setMgSettings(page, settings, { saveScope = 'global', closeAfter = false, timeoutMs = 15_000 } = {}) {
    const lens = await openMemoryWorkspace(page, { subview: 'settings', timeoutMs });
    const panel = lens.locator('.ml-settings').first();
    await panel.locator('[data-field-key="enabled"]').waitFor({ state: 'visible', timeout: timeoutMs });

    const modalEntries = [];
    const inlineEntries = [];
    for (const [key, value] of Object.entries(settings)) {
        if (CUSTOM_MODAL_KEYS.has(key)) modalEntries.push([key, value]);
        else inlineEntries.push([key, value]);
    }
    // Apply extractMode before crawl-only numeric inputs so crawl inputs are rendered inside the modal.
    modalEntries.sort(([a], [b]) => (a === 'extractMode' ? -1 : b === 'extractMode' ? 1 : 0));

    let touchedAdvanced = false;

    if (modalEntries.length > 0) {
        touchedAdvanced = true;
        const customCard = panel.locator('[data-cadence-custom]').first();
        await customCard.waitFor({ state: 'visible', timeout: timeoutMs });
        await customCard.click();

        const modal = lens.locator('.ml-dialog-backdrop').last();
        await modal.waitFor({ state: 'visible', timeout: timeoutMs });
        for (const [key, value] of modalEntries) {
            await applyFieldControl(modal, key, value, timeoutMs);
        }
        const applyBtn = modal.locator('.ml-schema-modal-foot button').filter({ hasText: /^(Apply|确定|確定)$/ }).first();
        await applyBtn.waitFor({ state: 'visible', timeout: timeoutMs });
        await applyBtn.click();
        await modal.waitFor({ state: 'detached', timeout: timeoutMs });
    }

    let needsTechnical = false;
    for (const [key] of inlineEntries) {
        if (TECHNICAL_KEYS.has(key)) {
            needsTechnical = true;
            break;
        }
    }
    if (needsTechnical) {
        const details = panel.locator('[data-settings-section="technical"]').first();
        await details.waitFor({ state: 'visible', timeout: timeoutMs });
        const isOpen = await details.evaluate((el) => el.hasAttribute('open'));
        if (!isOpen) {
            await details.locator('summary.ml-settings-summary').first().click();
        }
    }

    for (const [key, value] of inlineEntries) {
        if (ADVANCED_SAVE_KEYS.has(key)) touchedAdvanced = true;
        await applyFieldControl(panel, key, value, timeoutMs);
    }

    if (touchedAdvanced) {
        const saveLabel = saveScope === 'character'
            ? /^(Save Advanced to Character|将高级设置保存到角色卡|將進階設定儲存到角色卡|保存高级到当前角色|儲存進階到目前角色)$/
            : /^(Save Advanced to Global|将高级设置保存到全局|將進階設定儲存到全域|保存高级到全局|儲存進階到全域)$/;
        const saveBtn = panel.locator('.ml-settings-sticky button').filter({ hasText: saveLabel }).first();
        await saveBtn.waitFor({ state: 'visible', timeout: timeoutMs });
        await saveBtn.click();
        await panel.locator('.ml-settings-error').waitFor({ state: 'hidden', timeout: timeoutMs }).catch(() => {});
    }

    if (closeAfter) {
        await closeWorkbench(page);
    }
}

/**
 * Open the embedded Memory Lens Graph view and wait for `.ml-graph-canvas`.
 */
export async function openMgGraphView(page, { timeoutMs = 15_000 } = {}) {
    const lens = await openMemoryWorkspace(page, { subview: 'graph', timeoutMs });
    const canvas = lens.locator('.ml-graph-canvas').first();
    await canvas.waitFor({ state: 'visible', timeout: timeoutMs });
    return canvas;
}

/**
 * Open the embedded Memory Lens Schema editor (`Memory structure` subview).
 */
export async function openMgSchemaEditor(page, { timeoutMs = 15_000 } = {}) {
    const lens = await openMemoryWorkspace(page, { subview: 'schema', timeoutMs });
    const schema = lens.locator('.ml-schema').first();
    await schema.locator('.ml-schema-list .ml-schema-type').first().waitFor({ state: 'visible', timeout: timeoutMs });
    return schema;
}

/**
 * Import a graph store JSON via the real `Import Graph` button in
 * Memory Lens → Settings → Operations, handling the file chooser and the
 * import-mode popup ("Restore Exported Floor" / "Bind Latest Floor" /
 * "Bind Specific Floor").
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} filePath
 * @param {{ mode?: 'restore'|'bind-latest'|'bind-specific', closeAfter?: boolean, timeoutMs?: number }} [opts]
 */
export async function importMgGraph(page, filePath, { mode = 'bind-latest', closeAfter = false, timeoutMs = 15_000 } = {}) {
    const lens = await openMemoryWorkspace(page, { subview: 'settings', timeoutMs });
    const importBtn = lens.locator('[data-settings-section="operations"] button').filter({ hasText: /^(Import Graph|导入图谱|導入圖譜)$/ }).first();
    await importBtn.waitFor({ state: 'visible', timeout: timeoutMs });

    const chooserPromise = page.waitForEvent('filechooser', { timeout: timeoutMs });
    await importBtn.click();
    const chooser = await chooserPromise;
    await chooser.setFiles(filePath);

    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 10_000 });
    const labelMap = {
        restore: /Restore Exported Floor|恢复导出时楼层|恢復導出時樓層/,
        'bind-latest': /Bind Latest Floor|绑定到当前最新楼层|綁定到目前最新樓層/,
        'bind-specific': /Bind Specific Floor|绑定到指定楼层|綁定到指定樓層/,
    };
    const pattern = labelMap[mode] || labelMap['bind-latest'];
    await popup.locator('.popup-button-custom, button, .popup-button, [role="button"]', { hasText: pattern }).first().click();
    await popup.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});

    if (closeAfter) {
        await closeWorkbench(page);
    }
}

/**
 * Trigger a graph export via the real `Export Graph` button and await download.
 */
export async function exportMgGraph(page, { timeoutMs = 15_000 } = {}) {
    const lens = await openMemoryWorkspace(page, { subview: 'settings', timeoutMs });
    const exportBtn = lens.locator('[data-settings-section="operations"] button').filter({ hasText: /^(Export Graph|导出图谱|導出圖譜)$/ }).first();
    await exportBtn.waitFor({ state: 'visible', timeout: timeoutMs });
    const dl = page.waitForEvent('download', { timeout: timeoutMs });
    await exportBtn.click();
    return dl;
}

/**
 * Click `Fill Graph` in Memory Lens → Settings → Operations.
 */
export async function fillMgGraph(page, { closeAfter = false, timeoutMs = 15_000 } = {}) {
    const lens = await openMemoryWorkspace(page, { subview: 'settings', timeoutMs });
    const fillBtn = lens.locator('[data-settings-section="operations"] button').filter({ hasText: /^(Fill Graph|补全图谱|補全圖譜)$/ }).first();
    await fillBtn.waitFor({ state: 'visible', timeout: timeoutMs });
    await fillBtn.click();
    if (closeAfter) {
        await closeWorkbench(page);
    }
}

/**
 * Click `Rebuild Graph` in Memory Lens → Settings → Operations and accept the
 * confirmation modal.
 */
export async function rebuildMgIndex(page, { closeAfter = false, timeoutMs = 60_000 } = {}) {
    const lens = await openMemoryWorkspace(page, { subview: 'settings', timeoutMs });
    const rebuildBtn = lens.locator('[data-settings-section="operations"] button').filter({ hasText: /^(Rebuild Graph|重建图谱|重建圖譜)$/ }).first();
    await rebuildBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await rebuildBtn.click();

    const modal = lens.locator('.ml-dialog-backdrop').last();
    await modal.waitFor({ state: 'visible', timeout: 5000 });
    await modal.locator('.ml-schema-modal-foot button').filter({ hasText: /^(Rebuild Graph|重建图谱|重建圖譜)$/ }).first().click();
    await modal.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});

    if (closeAfter) {
        await closeWorkbench(page);
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Variable-op-log panel (unchanged)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Click the flask icon on a message to open the var-ops panel.
 */
export async function openVarOpsPanel(page, mesid) {
    const flask = page.locator(`.mes[mesid="${mesid}"] .mes_var_ops`).first();
    await flask.waitFor({ state: 'attached', timeout: 5000 });
    await flask.dispatchEvent('click');
    const panel = page.locator('.var-ops-panel').last();
    await panel.waitFor({ state: 'visible', timeout: 10_000 });
    return panel;
}

/**
 * Read the rendered op rows from the open var-ops panel. Returns an array
 * of `{ op, key, value, path }`.
 */
export async function getRenderedVarOpsRows(page) {
    return page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.var-ops-panel__row'));
        return rows.map(r => {
            const opSel = r.querySelector('.var-ops-panel__op');
            const keyIn = r.querySelector('.var-ops-panel__key');
            const valIn = r.querySelector('.var-ops-panel__value');
            const pathIn = r.querySelector('.var-ops-panel__path');
            return {
                op: opSel?.value || '',
                key: keyIn?.value || '',
                value: valIn?.value || '',
                path: pathIn?.value || '',
            };
        });
    });
}

/**
 * Click "Add operation" + populate a row.
 */
export async function addVarOpRow(page, { op = 'setvar', key, value = '' }) {
    const panel = page.locator('.var-ops-panel').last();
    await panel.locator('.var-ops-panel__add-button').first().click();
    const row = panel.locator('.var-ops-panel__row').last();
    await row.waitFor({ state: 'visible', timeout: 5000 });
    if (op !== 'setvar') {
        await row.locator('.var-ops-panel__op').first().selectOption(op);
    }
    if (key != null) {
        const ki = row.locator('.var-ops-panel__key').first();
        await ki.fill(String(key));
        await ki.dispatchEvent('change');
    }
    if (value != null && (op === 'setvar' || op === 'addvar' || op === 'pushvar')) {
        const vi = row.locator('.var-ops-panel__value').first();
        if (await vi.isVisible({ timeout: 500 }).catch(() => false)) {
            await vi.fill(String(value));
            await vi.dispatchEvent('change');
        }
    }
}

/**
 * Click "Save" on the var-ops panel popup to commit edits.
 */
export async function saveVarOpsPanel(page) {
    const popup = page.locator('.popup:visible').last();
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
}
