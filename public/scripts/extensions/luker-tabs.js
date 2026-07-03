/**
 * luker-tabs.js — Shared tab component for extension drawer/popup panels.
 *
 * Three layers:
 *   Layer 1 (direct):       import { renderLukerTabs } from '/scripts/extensions/luker-tabs.js';
 *   Layer 2 (lukerContext): const { renderLukerTabs } = lukerContext;
 *   Layer 3 (getContext):   const { renderLukerTabs } = Luker.getContext();
 *
 * Persists tab selection to
 *   extension_settings[moduleName].tabState[scope] = tabKey
 * via saveSettingsDebounced. Delegated click handler installed once on module load.
 */

import { escapeHtml } from '../utils.js';
import { extension_settings } from '../extensions.js';
import { saveSettingsDebounced } from '../../script.js';

function resolveInitialTabKey(tabs, defaultTab, moduleName, scope) {
    const bucket = extension_settings?.[moduleName]?.tabState;
    const persisted = bucket && typeof bucket === 'object' ? bucket[scope] : null;
    if (persisted && tabs.some(t => t.key === persisted)) return persisted;
    if (defaultTab && tabs.some(t => t.key === defaultTab)) return defaultTab;
    return tabs[0]?.key ?? '';
}

/**
 * @param {object} opts
 * @param {string} opts.id                        Unique DOM id for the tabs root.
 * @param {string} opts.scope                     Panel scope key (e.g. 'memory-graph-drawer').
 * @param {Array<{key:string,label:string,contentHtml:string}>} opts.tabs
 * @param {string} [opts.defaultTab]              Initial tab if no persisted state.
 * @param {string} opts.moduleName                extension_settings bucket key (e.g. 'memory_graph').
 * @returns {string} HTML string
 */
export function renderLukerTabs({ id, scope, tabs, defaultTab, moduleName }) {
    if (!Array.isArray(tabs) || tabs.length === 0) return '';
    const initial = resolveInitialTabKey(tabs, defaultTab, moduleName, scope);
    const barHtml = tabs.map(t => {
        const active = t.key === initial;
        return `<button type="button" class="luker-tabs-tab${active ? ' active' : ''}" role="tab" aria-selected="${active}" data-luker-tab-key="${escapeHtml(t.key)}" data-luker-tabs-target="${escapeHtml(id)}">${escapeHtml(t.label)}</button>`;
    }).join('');
    const panesHtml = tabs.map(t => {
        const active = t.key === initial;
        const hiddenAttr = active ? '' : ' hidden';
        return `<div class="luker-tabs-pane" id="${escapeHtml(id)}-pane-${escapeHtml(t.key)}" role="tabpanel" data-luker-tab-key="${escapeHtml(t.key)}"${hiddenAttr}>${t.contentHtml}</div>`;
    }).join('');
    return `<div id="${escapeHtml(id)}" class="luker-tabs" data-luker-tabs-scope="${escapeHtml(scope)}" data-luker-tabs-module="${escapeHtml(moduleName)}"><div class="luker-tabs-bar" role="tablist">${barHtml}</div><div class="luker-tabs-panes">${panesHtml}</div></div>`;
}

// One-shot delegated click handler
if (typeof jQuery !== 'undefined') {
    jQuery(document).off('click.lukerTabs').on('click.lukerTabs', '.luker-tabs-tab', function () {
        const $tab = jQuery(this);
        const targetId = $tab.attr('data-luker-tabs-target');
        const key = $tab.attr('data-luker-tab-key');
        if (!targetId || !key) return;
        const $root = jQuery(`#${jQuery.escapeSelector(targetId)}`);
        if (!$root.length) return;
        const moduleName = $root.attr('data-luker-tabs-module');
        const scope = $root.attr('data-luker-tabs-scope');
        $root.find('> .luker-tabs-bar > .luker-tabs-tab').each(function () {
            const isActive = jQuery(this).attr('data-luker-tab-key') === key;
            jQuery(this).toggleClass('active', isActive).attr('aria-selected', String(isActive));
        });
        $root.find('> .luker-tabs-panes > .luker-tabs-pane').each(function () {
            const isActive = jQuery(this).attr('data-luker-tab-key') === key;
            if (isActive) jQuery(this).removeAttr('hidden'); else jQuery(this).attr('hidden', 'hidden');
        });
        if (moduleName && scope) {
            if (!extension_settings[moduleName]) extension_settings[moduleName] = {};
            if (!extension_settings[moduleName].tabState) extension_settings[moduleName].tabState = {};
            extension_settings[moduleName].tabState[scope] = key;
            saveSettingsDebounced();
        }
    });
}

// Layer 2 exposure
if (typeof globalThis.lukerContext === 'object' && globalThis.lukerContext) {
    globalThis.lukerContext.renderLukerTabs = renderLukerTabs;
}
