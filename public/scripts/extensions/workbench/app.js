// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workbench shell: the floating window, the left rail and page switching,
// shared state (snapshot, settings), toasts and live refresh.
//
// `source` is the Luker source (source-luker.js), with the shape: { loadSnapshot, readSettings, writeSettings, subscribe,
// setMemoryHorizon, openLens, ask?, ai?, history? }.

import { i18n } from './i18n.js';
import { h, put, clear, debounce, formatTokens } from '../lens-shared/util.js';
import { icon } from './icons.js';
import { createWindow } from './ui/window.js';
import { loadPrefs, savePrefs } from './prefs.js';
import { runRules } from './model/suggest.js';
import { createHomePage } from './pages/home.js';
import { createSettingsPage } from './pages/settings.js';
import { createAskPage } from './pages/ask.js';
import { createIteratePage } from './pages/iterate.js';
import { createHistoryPage } from './pages/history.js';
import { createHistory } from './model/history.js';

const PAGES = [
    { id: 'home', label: i18n('Overview'), iconName: 'home' },
    { id: 'ask', label: i18n('Q&A'), iconName: 'ask' },
    { id: 'ai', label: i18n('AI iteration'), iconName: 'spark' },
    { id: 'hist', label: i18n('Change history'), iconName: 'history' },
];

function detectTheme() {
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * @param {{ source: object, container?: HTMLElement, onClose?: () => void, startCollapsed?: boolean }} options
 *   startCollapsed: mount as the corner pill only (the resident entry point).
 */
export function mountWorkbench({ source, container = document.body, onClose = null, startCollapsed = false }) {
    const prefs = loadPrefs();
    let theme = prefs.theme === 'light' || prefs.theme === 'dark' ? prefs.theme : detectTheme();
    let page = PAGES.some(p => p.id === prefs.page) || prefs.page === 'settings' ? prefs.page : 'home';
    let snapshot = null;
    let settings = source.readSettings();
    let suggestions = [];
    let loadError = '';
    let destroyed = false;
    let toastTimer = 0;

    let shown = !startCollapsed;
    const win = createWindow({
        title: i18n('Workbench'),
        theme: () => theme,
        onThemeToggle: () => { theme = theme === 'dark' ? 'light' : 'dark'; savePrefs({ theme }); },
        startCollapsed,
        pillVisible: () => settings.pill !== false,
        onExpand: () => {
            // First open from the pill: paint the page now.
            if (!shown) { shown = true; showPage(); }
            load();
        },
    });
    const rail = h('nav', { class: 'wb-rail', role: 'tablist', 'aria-label': i18n('Workbench') });
    const main = h('main', { class: 'wb-main' });
    put(win.body, rail, main);
    const toast = h('div', { class: 'wb-toast', role: 'status', 'aria-live': 'polite', hidden: true });
    put(win.layer, toast);

    const history = createHistory(source.historyStorage());
    const app = {
        source,
        history,
        sessions: source.createSessions(),
        refreshBadges() { computeSuggestions(); paintRail(); pages.home?.onSnapshot?.(); },
        layer: win.layer,
        snapshot: () => snapshot,
        settings: () => settings,
        suggestions: () => suggestions,
        loadError: () => loadError,
        isCompact: () => win.isCompact(),
        go(id, opts = {}) {
            page = id;
            savePrefs({ page });
            paintRail();
            showPage(opts);
        },
        saveSettings(next) {
            settings = next;
            source.writeSettings(next);
            computeSuggestions();
            paintRail();
            win.refresh();
        },
        toast: showToast,
        reload: () => load(),
        collapse: () => win.collapse(),
    };

    const pages = {
        home: createHomePage(app),
        ask: createAskPage(app),
        ai: createIteratePage(app),
        hist: createHistoryPage(app),
        settings: createSettingsPage(app),
    };

    function pendingCount() {
        return pages.ai.pendingCount?.() || 0;
    }

    function computeSuggestions() {
        const snap = snapshot ? { ...snapshot, card: { ...snapshot.card, ...(pages.ai.pendingInfo?.() || {}) } } : {};
        suggestions = runRules(snap, { enabled: settings.rules, dismissed: settings.dismissed });
    }

    function paintRail() {
        clear(rail);
        const tab = (p) => h('button', {
            type: 'button', role: 'tab', class: 'wb-tab', 'aria-selected': String(page === p.id),
            onClick: () => app.go(p.id),
        }, icon(p.iconName), h('span', { class: 'wb-tab-label', text: p.label }),
        p.id === 'ai' && pendingCount() ? h('span', { class: 'wb-tab-count', text: String(pendingCount()) }) : null);
        put(rail, PAGES.map(tab), h('div', { class: 'wb-rail-foot' }, tab({ id: 'settings', label: i18n('Settings'), iconName: 'gear' })));
        paintPill();
    }

    function paintPill() {
        const todo = suggestions.length;
        win.setPill(
            h('span', null, i18n('Prompt '), h('b', { text: snapshot?.budget ? formatTokens(snapshot.budget.total) : '—' })),
            todo ? h('span', { class: 'wb-pill-todo' }, '· ', h('b', { text: String(todo) }), i18n(' to do')) : null);
    }

    let current = null;
    function showPage(opts = {}) {
        const next = pages[page] || pages.home;
        if (current && current !== next) current.hide?.();
        current = next;
        main.classList.toggle('is-flush', Boolean(next.flush));
        clear(main);
        put(main, next.el);
        next.show?.(opts);
    }

    function showToast(text, { action = '', onAction = null, error = false, duration = 3500 } = {}) {
        clearTimeout(toastTimer);
        clear(toast);
        toast.classList.toggle('is-error', error);
        put(toast,
            icon(error ? 'alert' : 'check', { size: 15 }),
            h('span', { text }),
            action ? h('button', { type: 'button', class: 'wb-toast-btn', onClick: () => { toast.hidden = true; onAction?.(); } }, icon('undo', { size: 13 }), h('span', { text: action })) : null);
        toast.hidden = false;
        toastTimer = setTimeout(() => { toast.hidden = true; }, action ? Math.max(duration, 10000) : duration);
    }

    async function load() {
        try {
            snapshot = await source.loadSnapshot();
            loadError = '';
        } catch (err) {
            loadError = String(err?.message || err);
        }
        if (destroyed) return;
        win.setContext(snapshot?.chat?.label ? `${snapshot.chat.label}` : snapshot ? i18n('No character card selected') : '');
        computeSuggestions();
        paintRail();
        for (const p of Object.values(pages)) p.onSnapshot?.();
    }
    const scheduleLoad = debounce(() => load(), 400);
    const unsubscribe = source.subscribe?.(() => scheduleLoad()) || (() => {});

    function onKeydown(event) {
        if (event.key === 'Escape' && !win.isCollapsed() && win.layer.contains(document.activeElement)) {
            if (current?.onEscape?.()) { event.preventDefault(); return; }
        }
    }
    win.layer.addEventListener('keydown', onKeydown);

    function close() {
        if (destroyed) return;
        destroyed = true;
        unsubscribe();
        scheduleLoad.cancel?.();
        for (const p of Object.values(pages)) p.destroy?.();
        win.destroy();
        onClose?.();
    }

    container.appendChild(win.layer);
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
        isCollapsed: () => win.isCollapsed(),
        reload: () => load(),
    };
}
