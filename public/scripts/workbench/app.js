// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workbench shell: the floating window, the left rail and page/workspace
// switching, shared state (snapshot, settings), toasts, and live refresh.

import { i18n } from './i18n.js';
import { h, put, clear, debounce, formatTokens } from '../lens-shared/util.js';
import { emptyState } from '../lens-shared/ui.js';
import { icon } from './icons.js';
import { createWindow } from './ui/window.js';
import { loadPrefs, savePrefs } from './prefs.js';
import { createHistory } from './model/history.js';
import { defaultRegistry } from './registry.js';
import { createLukerSource } from './source-luker.js';
import { createHomePage } from './pages/home.js';
import { createAskPage } from './pages/ask.js';
import { createIteratePage } from './pages/iterate.js';
import { createHistoryPage } from './pages/history.js';
import { createSettingsPage } from './pages/settings.js';

const TOKENS_CSS_ID = 'luker-lens-shared-tokens-css';
const WORKBENCH_CSS_ID = 'luker-workbench-style-css';

const CORE_PAGES = [
    { id: 'home', label: () => i18n('Overview'), iconName: 'home' },
    { id: 'ask', label: () => i18n('Q&A'), iconName: 'ask' },
    { id: 'ai', label: () => i18n('AI iteration'), iconName: 'spark' },
    { id: 'hist', label: () => i18n('Change history'), iconName: 'history' },
];

const FOOTER_PAGE = { id: 'settings', label: () => i18n('Settings'), iconName: 'gear' };

export function ensureWorkbenchStyles(doc = globalThis.document) {
    if (!doc?.head) return;
    if (!doc.getElementById(TOKENS_CSS_ID) && !doc.querySelector('link[href*="lens-shared/tokens.css"]')) {
        const link = doc.createElement('link');
        link.id = TOKENS_CSS_ID;
        link.rel = 'stylesheet';
        link.href = new URL('../lens-shared/tokens.css', import.meta.url).href;
        doc.head.appendChild(link);
    }
    if (!doc.getElementById(WORKBENCH_CSS_ID) && !doc.querySelector('link[href*="workbench/style.css"]')) {
        const link = doc.createElement('link');
        link.id = WORKBENCH_CSS_ID;
        link.rel = 'stylesheet';
        link.href = new URL('./style.css', import.meta.url).href;
        doc.head.appendChild(link);
    }
}

function detectTheme() {
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const DEFAULT_PAGE_FACTORIES = {
    home: createHomePage,
    ask: createAskPage,
    ai: createIteratePage,
    hist: createHistoryPage,
    settings: createSettingsPage,
};

function createPlaceholderPage(def) {
    const label = typeof def.label === 'function' ? def.label() : String(def.label || def.id);
    return {
        el: h('div', { class: 'wb-page' }, emptyState(def.iconName || 'mark', label, i18n('Not available yet'), null, { renderIcon: icon })),
    };
}

/**
 * @param {{ source?: object, registry?: object, pages?: Record<string, (app: object) => object>, container?: HTMLElement, onClose?: () => void, startCollapsed?: boolean }} [options]
 */
export function mountWorkbench({
    source = null,
    registry = defaultRegistry,
    pages: pageFactories = null,
    container = document.body,
    onClose = null,
    startCollapsed = false,
} = {}) {
    ensureWorkbenchStyles(container?.ownerDocument || document);
    const activeSource = source || createLukerSource(registry);
    const prefs = loadPrefs();
    let theme = prefs.theme === 'light' || prefs.theme === 'dark' ? prefs.theme : detectTheme();
    const isKnownCore = (id) => CORE_PAGES.some(p => p.id === id) || id === FOOTER_PAGE.id;
    let activeTab = isKnownCore(prefs.page) ? prefs.page : 'home';
    let snapshot = null;
    let settings = activeSource.readSettings?.() || {};
    let suggestions = [];
    let loadError = '';
    let destroyed = false;
    let toastTimer = 0;
    let shown = !startCollapsed;

    const win = createWindow({
        title: i18n('Workbench'),
        theme: () => theme,
        defaultSize: () => settings.defaultSize || 'small',
        onThemeToggle: () => { theme = theme === 'dark' ? 'light' : 'dark'; savePrefs({ theme }); },
        startCollapsed,
        pillVisible: () => settings.pill !== false,
        onExpand: () => {
            if (!shown) { shown = true; showPage(); }
            load();
        },
        onCollapse: () => {
            for (const p of Object.values(corePages)) p.onCollapse?.();
        },
    });

    const rail = h('nav', { class: 'wb-rail', role: 'tablist', 'aria-label': i18n('Workbench') });
    const main = h('main', { class: 'wb-main' });
    put(win.body, rail, main);
    const toast = h('div', { class: 'wb-toast', role: 'status', 'aria-live': 'polite', hidden: true });
    put(win.layer, toast);

    const history = createHistory(activeSource.historyStorage?.() ?? null);
    const workspaceViews = new Map();

    const app = {
        source: activeSource,
        registry,
        history,
        sessions: activeSource.createSessions?.() ?? null,
        refreshBadges() {
            computeSuggestions();
            paintRail();
            corePages.home?.onSnapshot?.();
        },
        layer: win.layer,
        snapshot: () => snapshot,
        settings: () => settings,
        suggestions: () => suggestions,
        loadError: () => loadError,
        isCompact: () => win.isCompact(),
        workspaces: () => registry.getWorkspaces({ enabledOnly: true }),
        iterateTargets: () => registry.getIterateTargets(),
        askProviders: () => registry.getAskProviders(),
        suggestRuleProviders: () => registry.getSuggestRuleProviders(),
        go(id, opts = {}) {
            activeTab = id;
            if (isKnownCore(id)) savePrefs({ page: id });
            paintRail();
            return showPage(opts);
        },
        open(opts = {}) {
            if (win.isCollapsed()) {
                shown = true;
                win.expand();
            }
            const target = resolveNavigationTarget(opts);
            return app.go(target, opts);
        },
        saveSettings(next) {
            settings = next;
            activeSource.writeSettings?.(next);
            computeSuggestions();
            paintRail();
            win.refresh();
        },
        toast: showToast,
        reload: () => load(),
        collapse: () => win.collapse(),
        setWindowSize: (mode) => win.setMaximised(mode === 'large'),
        resetWindowPosition: () => win.resetPosition(),
    };

    const buildCorePage = (def) => {
        const factory = pageFactories?.[def.id] ?? DEFAULT_PAGE_FACTORIES[def.id];
        return typeof factory === 'function' ? factory(app) : createPlaceholderPage(def);
    };

    const corePages = {
        home: buildCorePage(CORE_PAGES[0]),
        ask: buildCorePage(CORE_PAGES[1]),
        ai: buildCorePage(CORE_PAGES[2]),
        hist: buildCorePage(CORE_PAGES[3]),
        settings: buildCorePage(FOOTER_PAGE),
    };

    function resolveNavigationTarget(opts = {}) {
        const reqPage = opts?.page ? String(opts.page) : '';
        const reqWs = opts?.ws ? String(opts.ws) : '';
        if (reqPage && isKnownCore(reqPage)) return reqPage;
        if (reqPage && reqPage.startsWith('ws:')) return reqPage;
        if (reqWs && registry.getWorkspaces({ enabledOnly: true }).some(w => w.id === reqWs)) {
            return `ws:${reqWs}`;
        }
        return activeTab;
    }

    function pendingCount() {
        return corePages.ai?.pendingCount?.() || 0;
    }

    function computeSuggestions() {
        if (typeof activeSource.runRules !== 'function') {
            suggestions = [];
            return;
        }
        const snap = snapshot ? { ...snapshot, card: { ...snapshot.card, ...(corePages.ai?.pendingInfo?.() || {}) } } : {};
        suggestions = activeSource.runRules(snap, {
            enabled: settings.rules,
            dismissed: settings.dismissed,
            providers: registry.getSuggestRuleProviders(),
        });
    }

    function paintRail() {
        clear(rail);
        const coreTab = (def) => h('button', {
            type: 'button',
            role: 'tab',
            class: 'wb-tab',
            'aria-selected': String(activeTab === def.id),
            onClick: () => app.go(def.id),
        },
        icon(def.iconName),
        h('span', { class: 'wb-tab-label', text: def.label() }),
        def.id === 'ai' && pendingCount() ? h('span', { class: 'wb-tab-count', text: String(pendingCount()) }) : null);

        const wsTab = (ws) => {
            const tabId = `ws:${ws.id}`;
            return h('button', {
                type: 'button',
                role: 'tab',
                class: 'wb-tab',
                'aria-selected': String(activeTab === tabId),
                onClick: () => app.go(tabId, { ws: ws.id }),
            },
            ws.icon instanceof Node ? ws.icon.cloneNode(true) : icon(ws.icon || 'mark'),
            h('span', { class: 'wb-tab-label', text: ws.title || ws.id }),
            ws.badge ? h('span', { class: 'wb-tab-count', text: String(ws.badge) }) : null);
        };

        const enabledWorkspaces = registry.getWorkspaces({ enabledOnly: true });
        put(
            rail,
            CORE_PAGES.map(coreTab),
            enabledWorkspaces.map(wsTab),
            h('div', { class: 'wb-rail-foot' }, coreTab(FOOTER_PAGE)),
        );
        if (win.isCompact()) {
            globalThis.requestAnimationFrame?.(() => {
                try {
                    rail.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
                } catch { /* ignore in test DOM */ }
            });
        }
        paintPill();
    }

    function paintPill() {
        const todo = suggestions.length;
        win.setPill(
            h('span', null, i18n('Prompt '), h('b', { text: snapshot?.budget ? formatTokens(snapshot.budget.total) : '—' })),
            todo ? h('span', { class: 'wb-pill-todo' }, '· ', h('b', { text: String(todo) }), i18n(' to do')) : null,
        );
    }

    function unmountWorkspace(wsId) {
        const entry = workspaceViews.get(wsId);
        if (!entry) return;
        workspaceViews.delete(wsId);
        try {
            if (typeof entry.instance === 'function') entry.instance();
            else entry.instance?.destroy?.();
        } catch (err) {
            console.error('[workbench] workspace unmount failed:', wsId, err);
        }
        entry.el.remove();
    }

    function getOrMountWorkspace(ws, opts = {}) {
        const existing = workspaceViews.get(ws.id);
        if (existing) {
            if (typeof existing.instance === 'object' && existing.instance) {
                existing.instance.update?.(opts);
            }
            return existing;
        }
        const host = h('div', { class: 'wb-page wb-ws-host', dataset: { workspace: ws.id } });
        let instance = null;
        if (typeof ws.mount === 'function') {
            instance = ws.mount(host, { app, opts });
        }
        const view = {
            el: host,
            mount: ws.mount,
            flush: Boolean(ws.flush),
            instance,
            show: (showOpts) => {
                if (typeof instance === 'object' && instance) instance.show?.(showOpts);
            },
            hide: () => {
                if (typeof instance === 'object' && instance) instance.hide?.();
            },
            onEscape: () => (typeof instance === 'object' && instance ? instance.onEscape?.() : false),
            onSnapshot: () => {
                if (typeof instance === 'object' && instance) instance.onSnapshot?.();
            },
        };
        workspaceViews.set(ws.id, view);
        return view;
    }

    let current = null;
    function showPage(opts = {}) {
        let next = corePages[activeTab];
        if (!next && activeTab.startsWith('ws:')) {
            const wsId = activeTab.slice(3);
            const ws = registry.getWorkspaces({ enabledOnly: true }).find(w => w.id === wsId);
            if (ws) {
                next = getOrMountWorkspace(ws, opts);
            } else {
                activeTab = 'home';
                next = corePages.home;
                paintRail();
            }
        }
        if (!next) {
            activeTab = 'home';
            next = corePages.home;
        }
        if (current && current !== next) current.hide?.();
        current = next;
        main.classList.toggle('is-flush', Boolean(next.flush));
        clear(main);
        put(main, next.el);
        return next.show?.(opts);
    }

    function showToast(text, { action = '', onAction = null, error = false, duration = 3500 } = {}) {
        clearTimeout(toastTimer);
        clear(toast);
        toast.classList.toggle('is-error', error);
        put(
            toast,
            icon(error ? 'alert' : 'check', { size: 15 }),
            h('span', { text }),
            action
                ? h('button', { type: 'button', class: 'wb-toast-btn', onClick: () => { toast.hidden = true; onAction?.(); } }, icon('undo', { size: 13 }), h('span', { text: action }))
                : null,
        );
        toast.hidden = false;
        toastTimer = setTimeout(() => { toast.hidden = true; }, action ? Math.max(duration, 10000) : duration);
    }

    async function load() {
        try {
            snapshot = await activeSource.loadSnapshot?.() ?? null;
            loadError = '';
        } catch (err) {
            loadError = String(err?.message || err);
        }
        if (destroyed) return;
        win.setContext(snapshot?.chat?.label ? `${snapshot.chat.label}` : snapshot ? i18n('No character card selected') : '');
        computeSuggestions();
        paintRail();
        for (const p of Object.values(corePages)) p.onSnapshot?.();
        for (const w of workspaceViews.values()) w.onSnapshot?.();
    }

    const scheduleLoad = debounce(() => load(), 400);
    const unsubscribeSource = activeSource.subscribe?.(() => scheduleLoad()) || (() => {});

    const unsubscribeRegistry = registry.subscribe(() => {
        if (destroyed) return;
        const enabledWorkspaces = registry.getWorkspaces({ enabledOnly: true });
        const enabledById = new Map(enabledWorkspaces.map(w => [w.id, w]));
        for (const [wsId, entry] of [...workspaceViews.entries()]) {
            const currentDef = enabledById.get(wsId);
            if (!currentDef || currentDef.mount !== entry.mount) {
                unmountWorkspace(wsId);
            }
        }
        if (activeTab.startsWith('ws:') && !enabledById.has(activeTab.slice(3))) {
            activeTab = 'home';
            if (shown) showPage();
        } else if (activeTab.startsWith('ws:') && !workspaceViews.has(activeTab.slice(3)) && shown) {
            showPage();
        }
        computeSuggestions();
        paintRail();
        for (const p of Object.values(corePages)) p.onRegistryUpdate?.();
    });

    function onKeydown(event) {
        if (event.key === 'Escape' && !win.isCollapsed() && win.layer.contains(document.activeElement)) {
            if (current?.onEscape?.()) { event.preventDefault(); }
        }
    }
    win.layer.addEventListener('keydown', onKeydown);

    function close() {
        if (destroyed) return;
        destroyed = true;
        clearTimeout(toastTimer);
        unsubscribeSource();
        unsubscribeRegistry();
        scheduleLoad.cancel?.();
        for (const wsId of [...workspaceViews.keys()]) unmountWorkspace(wsId);
        for (const p of Object.values(corePages)) p.destroy?.();
        win.destroy();
        onClose?.();
    }

    container.appendChild(win.layer);
    win.refresh();
    paintRail();
    if (shown) {
        showPage();
        win.focus();
    }
    load();

    return {
        close,
        toggle: () => win.toggle(),
        expand: () => win.expand(),
        collapse: () => win.collapse(),
        open: (opts = {}) => app.open(opts),
        focus: () => win.focus(),
        isCollapsed: () => win.isCollapsed(),
        reload: () => load(),
    };
}
