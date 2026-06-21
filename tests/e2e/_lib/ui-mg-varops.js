// Real-UI helpers for Memory-Graph and Variable-Op-Log flows.
//
// MG:
//   - openMgGraphView: click #luker_rpg_memory_view_graph, assert cytoscape canvas
//   - openMgSchemaEditor: click #luker_rpg_memory_open_schema_editor
//   - importMgGraph: click #luker_rpg_memory_import → setInputFiles
//   - exportMgGraph: click #luker_rpg_memory_export → waitForEvent('download')
//   - rebuildMgIndex: click #luker_rpg_memory_rebuild + accept confirm
//
// var-ops:
//   - openVarOpsPanel(page, mesid): click the flask icon
//   - getRenderedVarOpsRows: read .var-ops-panel__row from DOM
//   - addVarOpRow / deleteVarOpRow / saveVarOpsPanel

import { expect } from '@playwright/test';
import { openExtensionsDrawer, openInlineDrawer } from './page.js';

async function openMgSettingsPanel(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => { /* may already be open */ });
}

/**
 * Open the View Graph popup via the real button and assert the cytoscape
 * canvas (`.luker-rpg-memory-graph-cy`) renders.
 */
export async function openMgGraphView(page, { timeoutMs = 15_000 } = {}) {
    await openMgSettingsPanel(page);
    await page.locator('#luker_rpg_memory_view_graph').click();
    const cy = page.locator('.luker-rpg-memory-graph-cy').first();
    await cy.waitFor({ state: 'visible', timeout: timeoutMs });
    return cy;
}

/**
 * Open the Schema Editor popup via the real button.
 */
export async function openMgSchemaEditor(page, { timeoutMs = 15_000 } = {}) {
    await openMgSettingsPanel(page);
    await page.locator('#luker_rpg_memory_open_schema_editor').click();
    // Schema editor mounts inside a Luker popup; wait for at least one
    // schema field row to render or the popup to be visible.
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: timeoutMs });
    return popup;
}

/**
 * Import a graph store JSON via the real #luker_rpg_memory_import button +
 * its hidden file input. The import flow prompts the user with a custom
 * 3-button popup: "Restore Exported Floor" / "Bind Latest Floor" /
 * "Bind Specific Floor" — `mode` selects which to click (default
 * 'bind-latest' is the safe choice when seeding into a fresh chat).
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {'restore'|'bind-latest'|'bind-specific'} [opts.mode='bind-latest']
 */
export async function importMgGraph(page, filePath, { mode = 'bind-latest' } = {}) {
    await openMgSettingsPanel(page);
    await page.locator('#luker_rpg_memory_import').click().catch(() => { /* visible icon */ });
    await page.locator('#luker_rpg_memory_import_file').setInputFiles(filePath);
    // Wait for the custom-button popup to render, then click the chosen
    // button by its visible text (i18n stable text).
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    const labelMap = {
        restore: 'Restore Exported Floor',
        'bind-latest': 'Bind Latest Floor',
        'bind-specific': 'Bind Specific Floor',
    };
    const label = labelMap[mode] || labelMap['bind-latest'];
    await popup.locator('button, .popup-button, [role="button"]', { hasText: label }).first().click();
    await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
}

/**
 * Trigger a graph export via the real #luker_rpg_memory_export button and
 * await the download.
 */
export async function exportMgGraph(page, { timeoutMs = 15_000 } = {}) {
    await openMgSettingsPanel(page);
    const dl = page.waitForEvent('download', { timeout: timeoutMs });
    await page.locator('#luker_rpg_memory_export').click();
    return dl;
}

/**
 * Trigger a full rebuild via the real #luker_rpg_memory_rebuild button.
 * Accepts the confirm popup.
 */
export async function rebuildMgIndex(page, { timeoutMs = 60_000 } = {}) {
    await openMgSettingsPanel(page);
    await page.locator('#luker_rpg_memory_rebuild').click();
    const popup = page.locator('.popup:visible').last();
    if (await popup.isVisible({ timeout: 2000 }).catch(() => false)) {
        await popup.locator('.popup-button-ok').first().click();
    }
    // Rebuild progress shows via toastr; wait for it to settle. Conservative
    // wait — chat-derived rebuilds with many turns can take several seconds.
    await page.waitForTimeout(2000);
}

// ──────────────────────────────────────────────────────────────────────────
// Variable-op-log panel
// ──────────────────────────────────────────────────────────────────────────

/**
 * Click the flask icon on a message to open the var-ops panel. The flask
 * is hidden by default (display:none) on messages with no ops, so this
 * forces the click after asserting the icon is in the DOM.
 *
 * Returns the panel locator.
 */
export async function openVarOpsPanel(page, mesid) {
    const flask = page.locator(`.mes[mesid="${mesid}"] .mes_var_ops`).first();
    await flask.waitFor({ state: 'attached', timeout: 5000 });
    // The icon is hidden when var_ops is empty/absent on the message, but
    // tests typically open it on a message with ops — flip the display
    // inline if needed so click() works regardless of the visibility race.
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
 * Click "Add operation" + populate a row. Suitable for testing manual
 * additions via the panel.
 */
export async function addVarOpRow(page, { op = 'setvar', key, value = '' }) {
    const panel = page.locator('.var-ops-panel').last();
    await panel.locator('.var-ops-panel__add-button').first().click();
    // The new row is appended last; populate its fields.
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
        // Value textarea renders only for value-bearing ops.
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
