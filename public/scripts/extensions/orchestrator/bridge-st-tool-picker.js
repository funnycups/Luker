/**
 * Popup that lets the user pick which SillyTavern function tools to bridge
 * into the orchestrator's Layer-2 extension registry. Each bridged tool
 * becomes a callable orchestration tool named `st_<original>` (the prefix
 * keeps the two namespaces from colliding even when a future ST tool
 * happens to share an orchestration tool name).
 *
 * The picker UI lists every ST tool currently in `ToolManager.tools` plus
 * any tools already bridged from a previous session (rehydrated at startup
 * from `settings.bridgedSillyTavernTools`). Per-row read/write mode picker
 * + checkbox; Save diffs the current selection against the persisted list
 * and converges via `bridgeSillyTavernTool` / `unbridgeSillyTavernTool`.
 */

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../popup.js';
import {
    listAvailableSillyTavernTools,
    bridgeSillyTavernTool,
    unbridgeSillyTavernTool,
    listExtensionTools,
} from './register-custom-tool.js';
import { escapeHtml as esc } from './html-escape.js';

const ST_BRIDGE_PREFIX = 'st_';

/**
 * Build the popup body. `available` is the list of ST tools that are NOT
 * currently bridged; `bridged` is the list of already-bridged entries
 * sourced from settings (each carries its original `name` and `mode`).
 */
function buildHtml(available, bridged, t) {
    const all = [
        ...bridged.map(b => ({
            name: String(b?.name || ''),
            displayName: String(b?.displayName || b?.name || ''),
            description: String(b?.description || ''),
            mode: b?.mode === 'read' ? 'read' : 'write',
            isBridged: true,
        })),
        ...available.map(a => ({
            name: String(a?.name || ''),
            displayName: String(a?.displayName || a?.name || ''),
            description: String(a?.description || ''),
            mode: 'write',
            isBridged: false,
        })),
    ].filter(it => it.name);

    if (all.length === 0) {
        return `
<div class="luker_orch_st_picker">
    <div class="luker_orch_st_picker_empty">${esc(t('No SillyTavern tools available'))}</div>
</div>
        `;
    }

    const renderRow = (item) => `
        <div class="luker_orch_st_picker_row" data-orch-st-row="${esc(item.name)}">
            <label class="checkbox_label luker_orch_st_picker_check">
                <input type="checkbox" data-orch-st-name="${esc(item.name)}" ${item.isBridged ? 'checked' : ''}>
                <span class="luker_orch_st_picker_name">${esc(item.displayName)}</span>
            </label>
            <div class="luker_orch_st_picker_mode">
                <label class="checkbox_label"><input type="radio" name="orch_st_mode_${esc(item.name)}" value="read" ${item.mode === 'read' ? 'checked' : ''}> read</label>
                <label class="checkbox_label"><input type="radio" name="orch_st_mode_${esc(item.name)}" value="write" ${item.mode !== 'read' ? 'checked' : ''}> write</label>
            </div>
            ${item.description ? `<div class="luker_orch_st_picker_desc">${esc(item.description)}</div>` : ''}
        </div>
    `;
    return `
<div class="luker_orch_st_picker">
    <div class="luker_orch_st_picker_title">${esc(t('Available SillyTavern tools'))}</div>
    ${all.map(renderRow).join('')}
</div>
    `;
}

/**
 * Read the checked rows out of the popup DOM and return the desired
 * post-save state: an array of `{ name, mode }`.
 */
function readDesiredSelection(dlg) {
    const $el = $(dlg);
    const desired = [];
    $el.find('[data-orch-st-name]').each(function () {
        const name = String($(this).attr('data-orch-st-name') || '');
        if (!name || !this.checked) return;
        const mode = $el.find(`input[name="orch_st_mode_${name}"]:checked`).val() === 'read' ? 'read' : 'write';
        desired.push({ name, mode });
    });
    return desired;
}

/**
 * Open the bridge picker. Resolves once Save / Cancel closes the popup.
 *
 * @param {object} opts
 * @param {object} opts.settings The orchestrator settings object —
 *        `settings.bridgedSillyTavernTools` is the persisted list, mutated
 *        in place after a successful Save.
 * @param {(s: string) => string} opts.t i18n helper.
 * @param {() => void} opts.persist Callback that flushes `settings` to
 *        disk (typically `saveSettingsDebounced`).
 */
export async function openBridgeStToolPicker({ settings, t, persist }) {
    const available = await listAvailableSillyTavernTools();
    const bridgedFromSettings = Array.isArray(settings?.bridgedSillyTavernTools)
        ? settings.bridgedSillyTavernTools.map(b => ({
            name: String(b?.name || ''),
            mode: b?.mode === 'read' ? 'read' : 'write',
        })).filter(b => b.name)
        : [];
    // Enrich bridged entries with the live extension metadata so the row
    // shows the display name + description the user authored. Fall back to
    // bare name if the extension entry has gone missing (e.g. ST tool no
    // longer registered — rehydration would have skipped it too).
    const extTools = listExtensionTools().filter(e => e.source === 'st-bridge');
    const bridged = bridgedFromSettings.map(b => {
        const ext = extTools.find(e => e.name === `${ST_BRIDGE_PREFIX}${b.name}`);
        return {
            name: b.name,
            displayName: ext?.displayName || b.name,
            description: ext?.description || '',
            mode: b.mode,
        };
    });

    const html = buildHtml(available, bridged, t);
    const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: t('Save'),
        cancelButton: t('Cancel'),
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const desired = readDesiredSelection(popup.dlg);
    const desiredMap = new Map(desired.map(d => [d.name, d.mode]));
    const currentMap = new Map(bridgedFromSettings.map(b => [b.name, b.mode]));

    // Remove anything that's no longer desired
    for (const [name] of currentMap) {
        if (!desiredMap.has(name)) {
            unbridgeSillyTavernTool(name);
        }
    }
    // (Re-)bridge anything that's new or changed mode
    for (const { name, mode } of desired) {
        const oldMode = currentMap.get(name);
        if (oldMode === mode) continue;
        if (oldMode) unbridgeSillyTavernTool(name);
        try {
            await bridgeSillyTavernTool(name, { mode });
        } catch (err) {
            console.warn(`[orchestrator] bridge failed for ST tool '${name}':`, err?.message || err);
        }
    }

    settings.bridgedSillyTavernTools = desired;
    if (typeof persist === 'function') {
        persist();
    }
}
