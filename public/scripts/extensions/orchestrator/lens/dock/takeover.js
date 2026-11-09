// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Finds every run-panel store in Luker (the orchestrator's and the search
// agent's) and hides their built-in panels while our dock is in charge.
//
// The search agent's store isn't exported, but every built-in panel renders
// through the shared PanelRenderer class, and each renderer keeps its store
// on `this.store`. Wrapping PanelRenderer.prototype.handle hands us each store
// the first time its panel sees an event. The original handle still runs, so
// turning the takeover off restores the native panels as-is.

import { PanelRenderer } from '../../../../run-panel/render-incremental.js';

const HIDE_CLASS = 'ol-takeover';
const SOURCES = {
    'luker-orch-run-panel': 'orchestrator',
    'luker-search-tools-run-panel': 'search',
};

/**
 * @param {{ onStore: (store, source: string) => void, onNativeOpen?: (source: string) => void }} hooks
 */
export function installTakeover({ onStore, onNativeOpen = null }) {
    const seen = new WeakSet();
    const report = (store, rootId) => {
        if (!store || seen.has(store)) return;
        seen.add(store);
        onStore(store, SOURCES[rootId] || rootId || 'other');
    };

    const proto = PanelRenderer.prototype;
    if (!proto.__olensWrapped) {
        const original = proto.handle;
        proto.handle = function handle(event) {
            try { report(this.store, this.root?.id); } catch { /* never break the host panel */ }
            return original.call(this, event);
        };
        Object.defineProperty(proto, '__olensWrapped', { value: true });
    }

    // Luker's own "show run panel" buttons open the native panel; send those
    // to the dock instead while the takeover is on.
    const watched = new WeakSet();
    const watch = (el) => {
        if (watched.has(el) || !el.classList?.contains('luker-run-panel')) return;
        watched.add(el);
        new MutationObserver(() => {
            if (el.dataset.state === 'open' && document.documentElement.classList.contains(HIDE_CLASS)) onNativeOpen?.(SOURCES[el.id] || el.id);
        }).observe(el, { attributes: true, attributeFilter: ['data-state'] });
    };
    document.querySelectorAll('.luker-run-panel').forEach(watch);
    new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) watch(node);
    }).observe(document.body, { childList: true });
}

export function setNativeHidden(hidden) {
    document.documentElement.classList.toggle(HIDE_CLASS, Boolean(hidden));
}
