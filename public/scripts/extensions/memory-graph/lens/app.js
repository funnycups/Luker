// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory Lens application shell. Owns state, data loading / live refresh,
// layout (topbar · sidebar · stage · inspector), keyboard shortcuts and the
// responsive mobile drawers.

import { h, clear, debounce, formatTime, put } from '../../lens-shared/util.js';
import { icon } from './icons.js';
import { i18n, i18nFormat } from './i18n.js';
import { buildModel, defaultFilters } from './model.js';
import { createStore, loadPrefs } from './store.js';
import { createGraphView } from './views/graph-view.js';
import { createTimelineView } from './views/timeline-view.js';
import { createTableView } from './views/table-view.js';
import { createSidebar } from './panels/sidebar.js';
import { createInspector } from './panels/inspector.js';
import { createPalette } from './panels/palette.js';
import { tokenPanel } from './panels/token-panel.js';
import { createDialog } from './panels/dialog.js';
import { iconButton, segmented, emptyState, button, kbd, isTouch } from './ui/components.js';
import { createSchemaView } from './schema/schema-view.js';
import { createSettingsView } from './settings/settings-view.js';
import { openCreateNode } from './edit/node-forms.js';
import { buildLabelMaps } from './schema/schema-model.js';
import { setDisplayLabels } from './i18n.js';
import { fromEditText } from './edit/edit-model.js';
import { isEditing } from './edit/inline-edit.js';
import { fitToViewport } from './viewport.js';

const COMPACT_QUERY = '(max-width: 860px)';
const EDIT_UNDO_MS = 10000;
const ERROR_TEXT = { 'no-chat': 'Open a chat first.' };

function detectTheme() {
    const pref = globalThis.matchMedia?.('(prefers-color-scheme: light)').matches;
    return pref ? 'light' : 'dark';
}

/**
 * @param {{ source: object, container?: HTMLElement, onClose?: () => void, cytoscapeSrc?: string, embedded?: boolean }} options
 */
export function mountMemoryLens({ source, container = document.body, onClose = null, cytoscapeSrc, embedded = false }) {
    const prefs = loadPrefs();
    const compactMql = globalThis.matchMedia?.(COMPACT_QUERY);
    const store = createStore({
        theme: prefs.theme === 'light' || prefs.theme === 'dark' ? prefs.theme : detectTheme(),
        view: ['graph', 'timeline', 'table', 'schema', 'settings'].includes(prefs.view) ? prefs.view : 'graph',
        graphLayout: prefs.graphLayout === 'chrono' ? 'chrono' : 'force',
        timelineOrder: prefs.timelineOrder === 'desc' ? 'desc' : 'asc',
        sidebarOpen: prefs.sidebarOpen !== false,
        inspectorOpen: prefs.inspectorOpen !== false,
        compact: Boolean(compactMql?.matches),
        drawer: '', // mobile: '' | 'sidebar' | 'inspector'
        status: 'loading', // loading | ready | error
        error: null,
        syncing: false,
        filters: defaultFilters(),
        selectedId: '',
        matchIds: null,
    });
    let model = null;
    let destroyed = false;

    const root = h('div', { class: 'mlens', role: embedded ? 'region' : 'dialog', 'aria-modal': embedded ? null : 'true', 'aria-label': i18n('Memory Lens'), tabIndex: -1 });
    root.dataset.theme = store.get().theme;
    if (embedded) root.classList.add('is-embedded');

    const app = {
        root,
        cytoscapeSrc,
        state: () => store.get(),
        setState: (patch) => store.set(patch),
        model: () => model,
        isCompact: () => store.get().compact,
        select(id) {
            const next = String(id || '');
            const patch = { selectedId: next };
            if (store.get().compact) patch.drawer = next ? 'inspector' : '';
            else if (next && !store.get().inspectorOpen) patch.inspectorOpen = true;
            store.set(patch);
        },
        setFilter(patch) {
            store.set({ filters: { ...store.get().filters, ...patch } });
        },
        resetFilters() {
            store.set({ filters: defaultFilters() });
        },
        setMatches(ids) {
            store.set({ matchIds: ids && ids.size ? ids : null });
        },
        focusEntity(id) {
            store.set({ filters: { ...store.get().filters, focusEntityId: id }, view: 'timeline', drawer: '' });
        },
        locate(id) {
            const view = views[store.get().view];
            if (store.get().compact) store.set({ drawer: '' });
            view.locate?.(id);
        },
        fitGraph: () => views.graph.fit?.(),
        toggleTheme() {
            store.set({ theme: store.get().theme === 'dark' ? 'light' : 'dark' });
        },
        reload: () => load({ manual: true }),
        canEdit: () => Boolean(source.edit),
        notify: (text) => showToast(text),
        /** Saves one edited value; key '' = title. Offers undo afterwards. */
        async editNode(node, key, text, original, chatKey) {
            if (!source.edit) return;
            const value = key === '' ? String(text).trim() : fromEditText(text, original);
            // An entity's 'title' column is its name; keep the node title in step.
            const patch = key === '' ? { title: value }
                : key === 'title' && String(value).trim() ? { fields: { title: value }, title: String(value).trim() }
                    : { fields: { [key]: value } };
            await app.applyEdit(edit => edit.updateNode(node, patch), i18n('Modified'), chatKey);
        },
        showTokens() {
            const clearLog = source.clearTokens ? () => {
                const previous = source.clearTokens();
                dialog.close();
                showToast(i18n('Cleared'), {
                    action: i18n('Undo'),
                    onAction: () => { source.restoreTokens?.(previous); scheduleReload(); },
                    duration: EDIT_UNDO_MS,
                });
                scheduleReload();
            } : null;
            dialog.open(i18n('Injected tokens'), tokenPanel(model, { onClear: clearLog }));
        },
        showInjection() {
            const recall = model?.lastRecall;
            dialog.open(`${i18n('Latest injected text')}${recall?.at ? ` · ${formatTime(recall.at)}` : ''}`, [
                { title: i18n('Core memory packet'), text: recall?.blocks?.corePacket },
                { title: i18n('Focus memory packet'), text: recall?.blocks?.focusPacket },
            ]);
        },
        openStatus: (title, sections) => dialog.open(title, sections),
        refresh: () => scheduleReload(),
        showToast: (text, options) => showToast(text, options),
        /** Runs one graph edit and offers to undo it. */
        async applyEdit(run, doneText, chatKey = model?.chatKey) {
            if (!source.edit) return null;
            try {
                const edit = source.edit.forChat(chatKey);
                const snapshot = await run(edit);
                showToast(doneText, {
                    action: i18n('Undo'),
                    onAction: async () => {
                        try {
                            await edit.restore(snapshot);
                            showToast(i18n('Undone'));
                        } catch (err) {
                            showToast(i18nFormat('Edit failed: ${0}', String(err?.message || err)), { error: true });
                        }
                        scheduleReload();
                    },
                    duration: EDIT_UNDO_MS,
                });
                scheduleReload();
                return snapshot;
            } catch (err) {
                showToast(i18nFormat('Edit failed: ${0}', String(err?.message || err)), { error: true });
                scheduleReload();
                return null;
            }
        },
    };

    // ----- Layout ---------------------------------------------------------
    const views = {
        graph: createGraphView(app),
        timeline: createTimelineView(app),
        table: createTableView(app),
        schema: createSchemaView(app, source),
        settings: createSettingsView(app, source),
    };
    const isFullView = (view) => view === 'schema' || view === 'settings';
    const sidebar = createSidebar(app);
    const inspector = createInspector(app);
    const palette = createPalette(app);
    const dialog = createDialog();

    const titleChat = h('span', { class: 'ml-brand-chat' });
    const syncDot = h('span', { class: 'ml-sync', role: 'status', 'aria-live': 'polite' });
    const viewSwitch = h('div', { class: 'ml-viewswitch' });
    const topbarRight = h('div', { class: 'ml-topbar-right' });
    const topbar = h('header', { class: 'ml-topbar' },
        h('div', { class: 'ml-topbar-left' },
            iconButton('sidebarLeft', i18n('Sidebar'), () => toggleSidebar(), { className: 'ml-toggle-sidebar' }),
            h('div', { class: 'ml-brand' },
                h('span', { class: 'ml-brand-mark', 'aria-hidden': 'true' }, icon('lens', { size: 18 })),
                h('span', { class: 'ml-brand-name', text: i18n('Memory Lens') }),
                titleChat)),
        viewSwitch,
        topbarRight);

    const stage = h('main', { class: 'ml-stage' }, Object.values(views).map(view => h('div', { class: 'ml-view', dataset: { view: view.id } }, view.el)));
    const stateLayer = h('div', { class: 'ml-statelayer', hidden: true });
    const scrim = h('div', { class: 'ml-scrim', onClick: () => store.set({ drawer: '' }) });
    const bottomNav = h('nav', { class: 'ml-bottomnav', 'aria-label': i18n('Display') });
    const body = h('div', { class: 'ml-body' }, sidebar.el, h('div', { class: 'ml-stagewrap' }, stage, stateLayer), inspector.el, scrim);
    const toast = h('div', { class: 'ml-toast', role: 'status', 'aria-live': 'polite', hidden: true });
    let toastTimer = 0;
    function showToast(text, { action = '', onAction = null, duration = 3500, error = false } = {}) {
        clearTimeout(toastTimer);
        clear(toast);
        toast.classList.toggle('is-error', error);
        put(toast,
            icon(error ? 'alert' : 'check', { size: 15 }),
            h('span', { class: 'ml-toast-text', text }),
            action ? h('button', { type: 'button', class: 'ml-toast-btn', onClick: () => { toast.hidden = true; clearTimeout(toastTimer); onAction?.(); } }, icon('undo', { size: 14 }), h('span', { text: action })) : null);
        toast.hidden = false;
        toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
    }
    put(root, topbar, body, bottomNav, palette.el, dialog.el, toast);

    function renderTopbar() {
        const state = store.get();
        titleChat.textContent = model?.chatLabel ? model.chatLabel : '';
        titleChat.hidden = !model?.chatLabel;
        put(clear(viewSwitch), segmented([
            { value: 'graph', label: i18n('Graph'), icon: 'graph' },
            { value: 'timeline', label: i18n('Timeline'), icon: 'timeline' },
            { value: 'table', label: i18n('Data table'), icon: 'table' },
            { value: 'schema', label: i18n('Memory structure'), icon: 'blocks' },
            { value: 'settings', label: i18n('Settings'), icon: 'gear' },
        ], state.view, (value) => store.set({ view: value }), { ariaLabel: i18n('Display'), iconOnlyMobile: true }));
        put(clear(topbarRight),
            h('button', { type: 'button', class: 'ml-searchbtn', onClick: () => palette.open(), 'aria-label': i18n('Search') },
                icon('search', { size: 15 }), h('span', { class: 'ml-searchbtn-text', text: i18n('Search nodes, characters, events…') }), kbd('Mod', 'K')),
            syncDot,
            iconButton('refresh', i18n('Refresh'), () => load({ manual: true }), { className: state.syncing ? 'is-spinning' : '' }),
            iconButton(state.theme === 'dark' ? 'sun' : 'moon', i18n('Toggle theme'), () => app.toggleTheme()),
            source.edit ? iconButton('plus', i18n('New memory'), () => openCreateNode(app)) : null,
            iconButton('sidebarRight', i18n('Details panel'), () => toggleInspector(), { className: 'ml-toggle-inspector', pressed: state.inspectorOpen }),
            embedded ? null : iconButton('x', i18n('Close'), () => close(), { className: 'ml-close' }));
        renderSync();
    }

    function renderSync() {
        const state = store.get();
        syncDot.dataset.state = state.syncing ? 'syncing' : state.status === 'error' ? 'error' : 'live';
        syncDot.title = state.syncing ? i18n('Syncing') : model ? `${i18n('Synced')} · ${formatTime(model.loadedAt)}` : '';
        syncDot.textContent = '';
        put(syncDot, h('span', { class: 'ml-sync-dot', 'aria-hidden': 'true' }), h('span', { class: 'ml-sync-text', text: state.syncing ? i18n('Syncing') : i18n('Live') }));
    }

    function renderBottomNav() {
        const state = store.get();
        put(clear(bottomNav),
            h('button', { type: 'button', class: 'ml-bn-btn', 'aria-pressed': String(state.drawer === 'sidebar'), onClick: () => toggleSidebar() }, icon('filter', { size: 18 }), h('span', { text: i18n('Filters') })),
            h('button', { type: 'button', class: 'ml-bn-btn', onClick: () => palette.open() }, icon('search', { size: 18 }), h('span', { text: i18n('Search') })),
            h('button', { type: 'button', class: 'ml-bn-btn', 'aria-pressed': String(state.drawer === 'inspector'), onClick: () => toggleInspector() }, icon('doc', { size: 18 }), h('span', { text: i18n('Details') })));
    }

    function toggleSidebar() {
        const state = store.get();
        if (state.compact) store.set({ drawer: state.drawer === 'sidebar' ? '' : 'sidebar' });
        else store.set({ sidebarOpen: !state.sidebarOpen });
    }

    function toggleInspector() {
        const state = store.get();
        if (state.compact) store.set({ drawer: state.drawer === 'inspector' ? '' : 'inspector' });
        else store.set({ inspectorOpen: !state.inspectorOpen });
    }

    function applyLayoutClasses() {
        const state = store.get();
        root.dataset.theme = state.theme;
        root.classList.toggle('is-compact', state.compact);
        root.classList.toggle('is-touch', isTouch());
        root.classList.toggle('sidebar-open', state.compact ? state.drawer === 'sidebar' : state.sidebarOpen);
        root.classList.toggle('inspector-open', state.compact ? state.drawer === 'inspector' : state.inspectorOpen);
        root.classList.toggle('drawer-open', state.compact && Boolean(state.drawer));
        // The structure editor uses the full width (no filter sidebar / inspector).
        root.classList.toggle('is-full-view', isFullView(state.view));
        for (const wrap of stage.children) wrap.hidden = wrap.dataset.view !== state.view;
        renderState();
    }

    function renderState() {
        const state = store.get();
        if (state.status === 'ready') {
            stateLayer.hidden = true;
            return;
        }
        stateLayer.hidden = false;
        clear(stateLayer);
        if (state.status === 'loading') {
            put(stateLayer, h('div', { class: 'ml-loading' }, h('div', { class: 'ml-spinner', 'aria-hidden': 'true' }), h('span', { text: i18n('Reading memory…') })));
        } else {
            const code = state.error?.code;
            put(stateLayer, emptyState('graph', i18n(ERROR_TEXT[code] || 'Failed to read'), code ? '' : String(state.error?.message || ''),
                button(i18n('Refresh'), () => load({ manual: true }), { iconName: 'refresh' })));
        }
        // The structure editor works without an open chat: never cover it.
        if (isFullView(state.view) && state.error?.code === 'no-chat') stateLayer.hidden = true;
    }

    function renderAll() {
        applyLayoutClasses();
        renderTopbar();
        renderBottomNav();
        renderState();
        sidebar.render();
        inspector.render();
        if (model || isFullView(store.get().view)) views[store.get().view].render();
    }

    // ----- Data -----------------------------------------------------------
    let loadToken = 0;
    async function load({ manual = false } = {}) {
        const token = ++loadToken;
        store.set(model ? { syncing: true } : { status: 'loading', syncing: true });
        try {
            const snapshot = await source.load();
            if (token !== loadToken || destroyed) return;
            const chatChanged = model && snapshot.chatKey !== model.chatKey;
            setDisplayLabels(buildLabelMaps(snapshot.schema?.types, snapshot.columnLabels));
            model = buildModel(snapshot);
            for (const view of Object.values(views)) view.invalidate?.();
            const patch = { status: 'ready', error: null, syncing: false };
            if (chatChanged || (store.get().selectedId && !model.nodes.has(store.get().selectedId))) {
                patch.selectedId = '';
                patch.filters = defaultFilters();
            }
            store.set(patch);
            renderAll();
            if (manual && !chatChanged) toastr.success(i18n('Synced'), i18n('Memory Lens'), { timeOut: 1200 });
        } catch (err) {
            if (token !== loadToken || destroyed) return;
            console.warn('[memory-graph/lens] load failed', err);
            model = null;
            views.schema.invalidate?.();
            store.set({ status: 'error', error: { code: err?.code || '', message: String(err?.message || err) }, syncing: false });
            renderAll();
        }
    }
    // Don't yank an open inline editor away mid-typing; retry shortly.
    const scheduleReload = debounce(function retry() {
        if (isEditing()) { setTimeout(() => scheduleReload(), 600); return; }
        load();
    }, 400);
    const unsubscribeSource = source.subscribe?.(() => scheduleReload()) || (() => {});

    // ----- Reactions ------------------------------------------------------
    store.subscribe((state, changed) => {
        if (changed.has('theme')) {
            root.dataset.theme = state.theme;
            views.graph.onThemeChange?.();
        }
        if (changed.has('compact') || changed.has('drawer') || changed.has('sidebarOpen') || changed.has('inspectorOpen') || changed.has('view')) {
            applyLayoutClasses();
            requestAnimationFrame(() => views.graph.onResize?.());
        }
        if (changed.has('view')) {
            const view = views[state.view];
            if (state.view === 'settings' || (model && !isFullView(state.view))) view.render();
            view.onShow?.();
        }
        if (changed.has('graphLayout') || changed.has('timelineOrder')) {
            if (model) views[state.view].render();
        }
        if (changed.has('filters')) {
            if (model) views[state.view].render();
            sidebar.render();
        }
        if (changed.has('selectedId')) {
            inspector.render();
            views[state.view].onSelectionChange?.();
        }
        if (changed.has('matchIds')) views.graph.onMatchesChange?.();
        if (changed.has('syncing') || changed.has('status')) renderSync();
        if (changed.has('theme') || changed.has('view') || changed.has('inspectorOpen') || changed.has('syncing') || changed.has('compact')) renderTopbar();
        if (changed.has('drawer') || changed.has('compact')) renderBottomNav();
    });

    const onCompactChange = () => store.set({ compact: Boolean(compactMql?.matches), drawer: '' });
    compactMql?.addEventListener?.('change', onCompactChange);
    const onResize = debounce(() => views.graph.onResize?.(), 120);
    globalThis.addEventListener('resize', onResize);

    function isTypingTarget(target) {
        return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    }

    function onKeydown(event) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            event.stopPropagation();
            if (palette.isOpen()) palette.close(); else palette.open();
            return;
        }
        if (palette.isOpen()) return;
        if (event.key === 'Escape') {
            event.stopPropagation();
            if (dialog.isOpen()) dialog.close();
            else if (isFullView(store.get().view) && views[store.get().view].onEscape?.()) { /* handled */ } else if (store.get().drawer) store.set({ drawer: '' });
            else if (store.get().matchIds) app.setMatches(null);
            else if (store.get().selectedId) app.select('');
            else if (!embedded) close();
            return;
        }
        if (isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === '/') {
            event.preventDefault();
            palette.open();
        } else if (['1', '2', '3', '4', '5'].includes(event.key)) {
            store.set({ view: ['graph', 'timeline', 'table', 'schema', 'settings'][Number(event.key) - 1] });
        } else if (event.key === '[') {
            toggleSidebar();
        } else if (event.key === ']') {
            toggleInspector();
        }
    }
    root.addEventListener('keydown', onKeydown);
    // Keep host hotkeys (Luker swipes on ←/→, edit-last on ↑, Escape panel
    // closing) from firing while the lens is focused.
    if (!embedded) root.addEventListener('keydown', (event) => event.stopPropagation());

    // Re-renders replace DOM nodes; if the focused element was removed the
    // browser drops focus to <body>, which would leak keys to the host.
    // Pull focus back into the lens in that case (modal overlay only).
    const onFocusOut = (event) => {
        if (embedded) return;
        const next = event.relatedTarget;
        if (next && root.contains(next)) return;
        requestAnimationFrame(() => {
            if (destroyed) return;
            const active = document.activeElement;
            if (!active || active === document.body || !active.isConnected) root.focus({ preventScroll: true });
        });
    };
    root.addEventListener('focusout', onFocusOut);
    // Keydown that arrives at the document while the overlay is open (e.g.
    // focus was lost before the rAF above ran) is redirected to the lens.
    const onDocumentKeydown = (event) => {
        if (embedded || destroyed || root.contains(event.target)) return;
        if (event.target !== document.body && event.target !== document.documentElement) return;
        event.stopImmediatePropagation();
        root.focus({ preventScroll: true });
        onKeydown(event);
    };
    document.addEventListener('keydown', onDocumentKeydown, true);

    // ----- Mount ----------------------------------------------------------
    const previousOverflow = document.documentElement.style.overflow;
    if (!embedded) document.documentElement.style.overflow = 'hidden';
    container.appendChild(root);
    const viewportFit = embedded ? null : fitToViewport(root);
    renderAll();
    root.focus({ preventScroll: true });
    load();

    function close() {
        if (destroyed) return;
        destroyed = true;
        scheduleReload.cancel();
        unsubscribeSource();
        document.removeEventListener('keydown', onDocumentKeydown, true);
        compactMql?.removeEventListener?.('change', onCompactChange);
        globalThis.removeEventListener('resize', onResize);
        viewportFit?.destroy();
        for (const view of Object.values(views)) view.destroy?.();
        root.remove();
        if (!embedded) document.documentElement.style.overflow = previousOverflow;
        onClose?.();
    }

    return {
        close,
        focus: () => root.focus({ preventScroll: true }),
        reload: () => load({ manual: true }),
        app,
    };
}

