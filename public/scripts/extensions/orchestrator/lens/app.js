// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Orchestra Lens application shell: state, loading / live refresh, layout
// (topbar · stage · inspector), keyboard shortcuts, mobile bottom sheet.

import { h, clear, debounce, put } from '../../lens-shared/util.js';
import { icon } from './icons.js';
import { i18n, i18nFormat, modeInfo, MODE_IDS } from './i18n.js';
import { createStore, loadPrefs } from './store.js';
import { buildFlow } from './model/profile.js';
import { buildRunView } from './model/run.js';
import { createRecorder } from './model/recorder.js';
import { createFlowView } from './views/flow-view.js';
import { createRunView } from './views/run-view.js';
import { createHistoryView } from './views/history-view.js';
import { createStatsView } from './views/stats-view.js';
import { createAiPanel } from './panels/ai-panel.js';
import { changeList } from './panels/change-list.js';
import { createDrafts } from './model/drafts.js';
import { agentFields, invertChanges } from './model/edit.js';
import { createInspector } from './panels/inspector.js';
import { createDialog } from './panels/dialog.js';
import { iconButton, segmented, emptyState, button, switchControl, isTouch } from './ui/components.js';
import { fitToViewport } from './viewport.js';

const COMPACT_QUERY = '(max-width: 860px)';
const VIEWS = ['flow', 'run', 'history', 'stats'];
const ERROR_TEXT = { 'no-extension': 'Orchestrator extension not detected. Make sure it is enabled.' };

function detectTheme() {
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * @param {{ source: object, container?: HTMLElement, onClose?: () => void, recorder?: object, embedded?: boolean }} options
 *   recorder: a long-lived recorder (index.js keeps one so runs are captured
 *   even while the lens is closed). Created here when absent.
 */
export function mountOrchestraLens({ source, container = document.body, onClose = null, recorder = null, takeover = null, embedded = false }) {
    const prefs = loadPrefs();
    const compactMql = globalThis.matchMedia?.(COMPACT_QUERY);
    const store = createStore({
        theme: prefs.theme === 'light' || prefs.theme === 'dark' ? prefs.theme : detectTheme(),
        view: VIEWS.includes(prefs.view) ? prefs.view : 'flow',
        inspectorOpen: prefs.inspectorOpen !== false,
        compact: Boolean(compactMql?.matches),
        sheet: false,
        status: 'loading',
        error: null,
        selectedAgent: '',
        selectedSegment: '',
        pinnedRunId: '', // history run being viewed; '' = live
        modeMenu: false,
        aiOpen: false,
    });
    const drafts = createDrafts();
    let modelOptions = { connections: [], presets: [] };
    let modelOptionsLoaded = false;
    const rec = recorder || createRecorder({ getRunContext: (from) => source.runContext?.(from) || {} });
    const runKey = (raw) => `${raw.source || 'orchestrator'}:${raw.runId}`;
    const runViewOf = (raw) => {
        const view = buildRunView(raw, Object.keys(flow?.agents || {}));
        if (raw.source === 'search') view.mode = 'search';
        view.key = runKey(raw);
        return view;
    };
    // Drafts apply only while they belong to the preset on screen.
    const draftsActive = () => Boolean(snapshot?.target && drafts.isCurrent(snapshot.target));
    function editBlockedReason() {
        if (!source.edit) return i18n('Cannot edit in preview mode');
        const target = snapshot?.target;
        if (!target) return '';
        if (target.scope === 'factory') return i18n('No profile saved yet: save one in the native panel first, then you can edit it here');
        if (!draftsActive()) return i18n('Another profile still has unsaved edits');
        return '';
    }
    const ownsRecorder = !recorder;
    let snapshot = null;
    let flow = null;
    let destroyed = false;

    const root = h('div', { class: 'olens ol-lens', role: embedded ? 'region' : 'dialog', 'aria-modal': embedded ? null : 'true', 'aria-label': i18n('Orchestra Lens'), tabIndex: -1 });
    root.dataset.theme = store.get().theme;
    if (embedded) root.classList.add('is-embedded');

    const app = {
        root,
        state: () => store.get(),
        setState: (patch) => store.set(patch),
        snapshot: () => snapshot,
        flow: () => flow,
        isCompact: () => store.get().compact,
        recorder: rec,
        runKey,
        runViewOf,
        takeover,
        source,
        drafts,
        draftsActive,
        canEdit: () => Boolean(snapshot?.target) && !editBlockedReason(),
        editBlockedReason,
        fieldsOf: (id) => (draftsActive() ? agentFields(snapshot.target.mode, drafts.profile(), id) : []),
        modelOptions: () => modelOptions,
        openAi: (text = '') => openAi(text),
        diagnose: (key, step = 0) => openDiagnose(key, step),
        diagnoseStats: (ctx) => { if (!aiPanel) return; store.set({ aiOpen: true, sheet: false }); aiPanel.diagnoseStats(ctx); },
        focusField: (agentId) => { if (flow?.agents?.[agentId]) store.set({ selectedAgent: agentId, ...(store.get().compact ? {} : { inspectorOpen: true }) }); },
        /** The run shown in the run view: pinned history entry, else the live / latest one. */
        run() {
            const { pinnedRunId } = store.get();
            // The lens is about orchestration: prefer the orchestrator's latest run.
            const raw = pinnedRunId
                ? rec.history().find(item => runKey(item) === pinnedRunId || item.runId === pinnedRunId)
                : (rec.currents().find(item => item.source === 'orchestrator' && !item.quiet) || rec.current());
            const live = raw && (!snapshot?.chatId || !raw.chatId || raw.chatId === snapshot.chatId || pinnedRunId) ? raw : null;
            return live ? runViewOf(live) : null;
        },
        selectAgent(id) {
            const patch = { selectedAgent: String(id || '') };
            if (store.get().compact) patch.sheet = Boolean(id);
            else if (id && !store.get().inspectorOpen) patch.inspectorOpen = true;
            store.set(patch);
        },
        selectSegment(key, agentId) {
            const patch = { selectedSegment: String(key || '') };
            if (agentId) patch.selectedAgent = agentId;
            store.set(patch);
        },
        openRun(runId) {
            store.set({ pinnedRunId: runId || '', selectedSegment: '', view: 'run' });
        },
        showText: (title, sections) => dialog.open(title, sections),
        notify: (text, opts) => showToast(text, opts),
        reload: () => load(),
    };

    const flowView = createFlowView(app);
    const runView = createRunView(app);
    const historyView = createHistoryView(app);
    const statsView = createStatsView(app);
    const views = { flow: flowView, run: runView, history: historyView, stats: statsView };
    const inspector = createInspector(app);
    const dialog = createDialog();

    // ----- Layout ---------------------------------------------------------
    const titleChat = h('span', { class: 'ol-brand-chat' });
    const viewSwitch = h('div', { class: 'ol-viewswitch' });
    const topbarRight = h('div', { class: 'ol-topbar-right' });
    const topbar = h('header', { class: 'ol-topbar' },
        h('div', { class: 'ol-topbar-left' },
            h('div', { class: 'ol-brand' },
                h('span', { class: 'ol-brand-mark', 'aria-hidden': 'true' }, icon('conductor', { size: 17 })),
                h('span', { class: 'ol-brand-name', text: i18n('Orchestra Lens') }),
                titleChat)),
        viewSwitch,
        topbarRight);
    const banner = h('div', { class: 'ol-banner', hidden: true });
    const mobileBar = h('div', { class: 'ol-mobilebar' });
    const stage = h('main', { class: 'ol-stage' }, Object.entries(views).map(([id, view]) => h('div', { class: 'ol-view', dataset: { view: id } }, view.el)));
    const stateLayer = h('div', { class: 'ol-statelayer', hidden: true });
    const scrim = h('div', { class: 'ol-scrim', onClick: () => store.set({ sheet: false }) });
    const savebar = h('div', { class: 'ol-savebar', hidden: true, role: 'status' });
    const aiPanel = source.ai ? createAiPanel(app, { onClose: () => store.set({ aiOpen: false }), openSettings: () => openAiSettings() }) : null;
    const aiPane = h('div', { class: 'ol-aipane' }, aiPanel?.el);
    const body = h('div', { class: 'ol-body' }, h('div', { class: 'ol-stagewrap' }, mobileBar, banner, savebar, stage, stateLayer), inspector.el, aiPane, scrim);
    const toast = h('div', { class: 'ol-toast', role: 'status', 'aria-live': 'polite', hidden: true });
    let toastTimer = 0;
    function showToast(text, { error = false, duration = 3000, action = null } = {}) {
        clearTimeout(toastTimer);
        clear(toast);
        toast.classList.toggle('is-error', error);
        put(toast, icon(error ? 'alert' : 'check', { size: 15 }), h('span', { text }),
            action ? h('button', { type: 'button', class: 'ol-toast-btn', onClick: () => { toast.hidden = true; action.run(); } }, icon('undo', { size: 13 }), h('span', { text: action.label })) : null);
        toast.hidden = false;
        toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
    }
    put(root, topbar, body, dialog.el, toast);

    function liveState() {
        if (store.get().status === 'error') return 'error';
        return rec.isRunning() ? 'running' : 'live';
    }

    function modePicker() {
        const state = store.get();
        const mode = snapshot?.mode || 'spec';
        const trigger = h('button', {
            type: 'button',
            class: 'ol-modebtn',
            'aria-haspopup': 'menu',
            'aria-expanded': String(state.modeMenu),
            title: i18n('Execution mode'),
            disabled: !source.setMode || !snapshot,
            onClick: (event) => { event.stopPropagation(); store.set({ modeMenu: !state.modeMenu }); },
        }, h('span', { class: 'ol-modebtn-label', text: i18n('Execution mode') }), h('span', { class: 'ol-modebtn-value', text: modeInfo(mode).label }), icon('chevronDown', { size: 13 }));
        const menu = state.modeMenu ? h('div', { class: 'ol-menu', role: 'menu' },
            MODE_IDS.map(id => h('button', {
                type: 'button',
                role: 'menuitemradio',
                class: 'ol-menu-item',
                'aria-checked': String(id === mode),
                onClick: async () => {
                    store.set({ modeMenu: false });
                    if (id === mode) return;
                    try {
                        await source.setMode(id);
                        showToast(i18nFormat('${0}: ${1}', i18n('Execution mode'), modeInfo(id).label));
                    } catch (err) {
                        showToast(String(err?.message || err), { error: true });
                    }
                    scheduleReload();
                },
            },
            h('span', { class: 'ol-menu-check', 'aria-hidden': 'true' }, id === mode ? icon('check', { size: 13 }) : null),
            h('span', { class: 'ol-menu-text' }, h('span', { class: 'ol-menu-title', text: modeInfo(id).label }), h('span', { class: 'ol-menu-hint', text: modeInfo(id).hint }))))) : null;
        return h('div', { class: 'ol-modepick' }, trigger, menu);
    }

    function renderTopbar() {
        const state = store.get();
        titleChat.textContent = snapshot?.chatLabel || '';
        titleChat.hidden = !snapshot?.chatLabel;
        const run = rec.current();
        const badge = run?.status === 'running' && !run.quiet ? h('span', { class: 'ol-seg-live', 'aria-hidden': 'true' }) : null;
        put(clear(viewSwitch), segmented([
            { value: 'flow', label: i18n('Flow'), icon: 'flow' },
            { value: 'run', label: i18n('Run'), icon: 'play' },
            { value: 'history', label: i18n('History'), icon: 'history' },
            { value: 'stats', label: i18n('Stats'), icon: 'timeline' },
        ], state.view, (value) => store.set({ view: value, modeMenu: false }), { ariaLabel: i18n('Flow'), iconOnlyMobile: true }));
        if (badge) viewSwitch.querySelectorAll('.ol-seg-btn')[1]?.appendChild(badge);
        const live = liveState();
        const enableSwitch = () => (snapshot && source.setEnabled ? h('div', { class: 'ol-enable' }, switchControl(i18n('Enable orchestration'), snapshot.enabled, async (value) => {
            try {
                await source.setEnabled(value);
                snapshot = { ...snapshot, enabled: value };
                renderAll();
            } catch (err) {
                showToast(String(err?.message || err), { error: true });
            }
        })) : null);
        // Phones get these two in a bar under the topbar (CSS picks one copy).
        put(clear(mobileBar), enableSwitch(), snapshot ? modePicker() : null);
        mobileBar.hidden = !snapshot;
        put(clear(topbarRight),
            enableSwitch(),
            snapshot ? modePicker() : null,
            h('span', { class: 'ol-sync', dataset: { state: live }, role: 'status' },
                h('span', { class: 'ol-sync-dot', 'aria-hidden': 'true' }),
                h('span', { class: 'ol-sync-text', text: live === 'running' ? i18n('Running') : i18n('Live') })),
            aiPanel ? h('button', { type: 'button', class: 'ol-aibtn', 'aria-pressed': String(state.aiOpen), title: i18n('AI assistant'), onClick: () => store.set({ aiOpen: !state.aiOpen }) },
                icon('sparkle', { size: 14 }), h('span', { class: 'ol-aibtn-label', text: 'AI' })) : null,
            iconButton(state.theme === 'dark' ? 'sun' : 'moon', i18n('Toggle theme'), () => store.set({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
            source.openNative ? iconButton('external', i18n('Edit in native panel'), () => openNative(), { className: 'ol-hide-compact' }) : null,
            iconButton('sidebarRight', i18n('Details panel'), () => toggleInspector(), { className: 'ol-toggle-inspector', pressed: state.inspectorOpen }),
            embedded ? null : iconButton('x', i18n('Close'), () => close(), { className: 'ol-close' }));
    }

    function renderBanner() {
        const show = snapshot && !snapshot.enabled;
        banner.hidden = !show;
        if (!show) return;
        put(clear(banner), icon('power', { size: 15 }), h('span', { text: i18n('Orchestration is off, so it will not run when you send a message.') }),
            source.setEnabled ? button(i18n('Enable now'), async () => {
                await source.setEnabled(true);
                snapshot = { ...snapshot, enabled: true };
                renderAll();
            }, { className: 'ol-btn-sm' }) : null);
    }

    // ----- Drafts: save bar, save / undo ------------------------------------
    function renderSavebar() {
        const count = draftsActive() ? drafts.count() : 0;
        const foreign = !draftsActive() && drafts.count() > 0;
        savebar.hidden = !count && !foreign;
        if (savebar.hidden) return;
        clear(savebar);
        if (foreign) {
            put(savebar, icon('alert', { size: 14 }),
                h('span', { class: 'ol-savebar-text', text: i18nFormat('Another profile still has ${0} unsaved edits (the chat or profile changed)', drafts.count()) }),
                button(i18n('Discard these edits'), () => { drafts.discard(); renderAll(); }, { className: 'ol-btn-sm ol-btn-ghost' }));
            return;
        }
        put(savebar, icon('pen', { size: 14 }),
            h('span', { class: 'ol-savebar-text', text: i18nFormat('${0} unsaved edits', count) }),
            button(i18n('View'), () => reviewDrafts(), { className: 'ol-btn-sm ol-btn-ghost' }),
            button(i18n('Drop'), async () => {
                const ok = await dialog.ask(i18n('Discard all edits?'), h('p', { class: 'ol-dialog-text', text: i18nFormat('${0} edits will be lost.', count) }), [{ label: i18n('Cancel'), value: '' }, { label: i18n('Discard edits'), value: 'yes', danger: true }]);
                if (ok) { drafts.discard(); showToast(i18n('Edits discarded')); }
            }, { className: 'ol-btn-sm ol-btn-ghost' }),
            button(i18n('Save'), () => saveDrafts(), { iconName: 'check', className: 'ol-btn-sm ol-btn-primary' }));
    }

    async function reviewDrafts() {
        const list = drafts.list();
        const value = await dialog.ask(i18nFormat('${0} edits', list.length), changeList({ changes: list, state: 'review', onFocus: (c) => app.focusField(c.agentId) }), [
            { label: i18n('Close'), value: '' },
            { label: i18n('Save'), value: 'save', primary: true },
        ]);
        if (value === 'save') saveDrafts();
    }

    function scopeText(target) {
        if (!target) return '';
        if (target.mode === 'single') return i18n('Single-agent settings');
        if (target.scope === 'character') return i18nFormat('profile "${1}" dedicated to "${0}"', snapshot?.characterName || i18n('this character card'), snapshot?.presetName || '');
        if (target.scope === 'chat') return i18n('the dispatch profile dedicated to this chat');
        return i18nFormat('general profile "${0}"', snapshot?.presetName || '');
    }

    let saving = false;
    async function saveDrafts({ force = false } = {}) {
        if (saving || !draftsActive() || !drafts.count()) return;
        saving = true;
        const target = drafts.target();
        const changes = drafts.list();
        try {
            const result = await source.edit.save(target, changes, { force });
            if (!result.saved) {
                const value = await dialog.ask(i18n('These were also changed elsewhere'), h('div', null,
                    h('p', { class: 'ol-dialog-text', text: i18n('After you started editing, the items below were also changed in the native panel. Saving anyway overwrites them with your version.') }),
                    changeList({ changes: result.conflicts.map(c => ({ ...c, before: c.current })), state: 'review' })), [
                    { label: i18n('Cancel'), value: '' },
                    { label: i18n('Overwrite with my version'), value: 'force', danger: true },
                ]);
                saving = false;
                if (value === 'force') await saveDrafts({ force: true });
                return;
            }
            drafts.discard();
            lastSaved = { target, changes };
            showToast(`${i18nFormat('Saved to ${0}', scopeText(target))}${result.missing.length ? i18nFormat(' (skipped ${0}: their agents are no longer in the profile)', result.missing.length) : ''}`, { action: { label: i18n('Undo'), run: () => undoSave() }, duration: 12000 });
            await load();
        } catch (err) {
            showToast(i18nFormat('Save failed: ${0}', String(err?.message || err)), { error: true, duration: 6000 });
        } finally {
            saving = false;
        }
    }

    let lastSaved = null;
    async function undoSave() {
        const saved = lastSaved;
        if (!saved) return;
        lastSaved = null;
        try {
            await source.edit.save(saved.target, invertChanges(saved.changes), { force: true });
            showToast(i18n('The last save was undone'));
            await load();
        } catch (err) {
            showToast(i18nFormat('Undo failed: ${0}', String(err?.message || err)), { error: true });
        }
    }

    // ----- AI -----------------------------------------------------------------
    function openAi(text = '') {
        if (!aiPanel) return;
        store.set({ aiOpen: true, sheet: false });
        aiPanel.ask(text);
    }

    function openDiagnose(key, step = 0) {
        if (!aiPanel) return;
        store.set({ aiOpen: true, sheet: false });
        aiPanel.diagnose(key, step);
    }

    async function openAiSettings() {
        const current = source.ai.settings();
        const opts = await ensureModelOptions();
        const select = (value, names, fallback) => {
            const el = h('select', { class: 'ol-select' }, h('option', { value: '', text: fallback }), [...new Set([...names, value].filter(Boolean))].map(n => h('option', { value: n, text: n })));
            el.value = value;
            return el;
        };
        const api = select(current.api, opts.connections, i18nFormat('Follow the orchestrator iteration AI (${0})', current.orchApi || i18n('current connection')));
        const preset = select(current.preset, opts.presets, i18nFormat('Follow the orchestrator iteration AI (${0})', current.orchPreset || i18n('current preset')));
        const value = await dialog.ask(i18n('Model used by the AI'), h('div', { class: 'ol-form' },
            h('p', { class: 'ol-dialog-text', text: i18n('The AI assistant and AI diagnosis use this connection profile and generation preset. The generation preset (including any jailbreak) still wraps the request as usual. Pick a model that is good at analysis and has enough context.') }),
            h('label', { class: 'ol-form-row' }, h('span', { text: i18n('Connection profile') }), api),
            h('label', { class: 'ol-form-row' }, h('span', { text: i18n('Generation preset') }), preset)), [
            { label: i18n('Cancel'), value: '' },
            { label: i18n('Save'), value: 'save', primary: true },
        ]);
        if (value === 'save') {
            source.ai.saveSettings({ api: api.value, preset: preset.value });
            showToast(i18n('Saved'));
        }
    }

    async function ensureModelOptions() {
        if (!modelOptionsLoaded && source.edit?.options) {
            try { modelOptions = await source.edit.options(); modelOptionsLoaded = true; } catch { /* keep empty */ }
        }
        return modelOptions;
    }

    function openNative() {
        if (!source.openNative?.()) {
            showToast(i18n('Orchestrator panel not found (make sure the extension is enabled)'), { error: true });
            return;
        }
        close();
    }

    function toggleInspector() {
        const state = store.get();
        if (state.compact) store.set({ sheet: !state.sheet });
        else store.set({ inspectorOpen: !state.inspectorOpen });
    }

    function applyLayout() {
        const state = store.get();
        root.dataset.theme = state.theme;
        root.classList.toggle('is-compact', state.compact);
        root.classList.toggle('is-touch', isTouch());
        // The flow needs the width; its inspector only appears for a selected agent.
        const inspectorWanted = state.inspectorOpen && (!['flow', 'stats'].includes(state.view) || Boolean(state.selectedAgent));
        root.classList.toggle('inspector-open', state.compact ? state.sheet : inspectorWanted);
        root.classList.toggle('sheet-open', state.compact && state.sheet);
        root.classList.toggle('ai-open', Boolean(aiPanel) && state.aiOpen);
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
            put(stateLayer, h('div', { class: 'ol-loading' }, h('div', { class: 'ol-spinner', 'aria-hidden': 'true' }), h('span', { text: i18n('Reading orchestration settings…') })));
            return;
        }
        // History still works without the orchestrator (records are local).
        if (state.view === 'history') {
            stateLayer.hidden = true;
            return;
        }
        const code = state.error?.code;
        put(stateLayer, emptyState('flow', i18n(ERROR_TEXT[code] || 'Failed to read'), code ? '' : String(state.error?.message || ''),
            button(i18n('Refresh'), () => load(), { iconName: 'refresh' })));
    }

    function renderAll() {
        applyLayout();
        renderTopbar();
        renderBanner();
        renderSavebar();
        views[store.get().view].render();
        inspector.render();
    }

    // ----- Data -----------------------------------------------------------
    let loadToken = 0;
    async function load() {
        const token = ++loadToken;
        if (!snapshot) store.set({ status: 'loading' });
        try {
            const next = await source.load();
            if (token !== loadToken || destroyed) return;
            const chatChanged = snapshot && next.chatKey !== snapshot.chatKey;
            snapshot = next;
            if (next.target) {
                const prev = drafts.target();
                drafts.setBase(next.target, next.profile);
                if (prev && !drafts.isCurrent(prev)) aiPanel?.refresh();
            }
            rebuildFlow();
            aiPanel?.refresh();
            void ensureModelOptions().then(() => { if (store.get().selectedAgent) inspector.render(); });
            const patch = { status: 'ready', error: null };
            if (chatChanged) Object.assign(patch, { pinnedRunId: '', selectedSegment: '' });
            if (store.get().selectedAgent && !flow.agents[store.get().selectedAgent] && !app.run()?.lanes.some(l => l.agentId === store.get().selectedAgent)) patch.selectedAgent = '';
            store.set(patch);
            if (source.runStore) rec.attach(await source.runStore(), 'orchestrator');
            renderAll();
        } catch (err) {
            if (token !== loadToken || destroyed) return;
            console.warn('[orchestrator/lens] load failed', err);
            snapshot = null;
            flow = null;
            store.set({ status: 'error', error: { code: err?.code || '', message: String(err?.message || err) } });
            renderAll();
        }
    }
    const scheduleReload = debounce(() => load(), 300);
    // The flow shows the draft (unsaved edits included) when it belongs here.
    function rebuildFlow() {
        if (!snapshot) return;
        const next = snapshot;
        flow = buildFlow(draftsActive() ? drafts.profile() : next.profile, {
            mode: next.mode,
            source: next.source,
            presetName: next.presetName,
            settings: next.settings,
            scopeLabel: next.source === 'character' ? i18nFormat('Only for "${0}"', next.characterName) : next.source === 'chat' ? i18n('Only for this chat') : i18n('General settings'),
        });
        flow.edited = new Set(draftsActive() ? drafts.list().map(c => c.agentId) : []);
    }

    const unsubscribeDrafts = drafts.subscribe(() => {
        if (destroyed) return;
        rebuildFlow();
        renderSavebar();
        inspector.render();
        flowView.onRunUpdate?.();
    });
    const unsubscribeSource = source.subscribe?.(() => scheduleReload()) || (() => {});

    // Live run updates: re-render only what shows the run.
    const renderLive = () => {
        if (destroyed) return;
        const view = store.get().view;
        if (view === 'flow') flowView.onRunUpdate?.();
        if (view === 'run' && !store.get().pinnedRunId) runView.render();
        if (view === 'history') historyView.render();
        inspector.onRunUpdate?.();
        renderTopbar();
    };
    const unsubscribeRecorder = rec.subscribe((kind) => {
        if (kind === 'start' && !store.get().pinnedRunId) store.set({ selectedSegment: '' });
        renderLive();
    });
    // Elapsed time keeps moving while a run is live.
    const ticker = setInterval(() => { if (rec.isRunning()) renderLive(); }, 1000);

    store.subscribe((state, changed) => {
        if (changed.has('theme')) root.dataset.theme = state.theme;
        if (changed.has('compact') || changed.has('sheet') || changed.has('inspectorOpen') || changed.has('view')) applyLayout();
        if (changed.has('compact')) flowView.onLayoutChange?.();
        if (changed.has('view') || changed.has('pinnedRunId')) views[state.view].render();
        if (changed.has('view')) views[state.view].onShow?.();
        if (changed.has('selectedAgent') || changed.has('selectedSegment')) {
            if (changed.has('selectedAgent')) applyLayout();
            views[state.view].onSelectionChange?.();
            inspector.render();
        }
        if (changed.has('pinnedRunId')) inspector.render();
        if (changed.has('aiOpen')) applyLayout();
        if (['theme', 'view', 'inspectorOpen', 'compact', 'modeMenu', 'status', 'aiOpen'].some(key => changed.has(key))) renderTopbar();
    });

    const onCompactChange = () => store.set({ compact: Boolean(compactMql?.matches), sheet: false });
    compactMql?.addEventListener?.('change', onCompactChange);
    const onRootClick = (event) => {
        if (store.get().modeMenu && !event.target.closest?.('.ol-modepick')) store.set({ modeMenu: false });
    };
    root.addEventListener('click', onRootClick);

    function isTypingTarget(target) {
        return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    }

    function onKeydown(event) {
        if (event.key === 'Escape') {
            event.stopPropagation();
            const state = store.get();
            if (dialog.isOpen()) dialog.close();
            else if (state.modeMenu) store.set({ modeMenu: false });
            else if (state.aiOpen && state.compact) store.set({ aiOpen: false });
            else if (state.sheet) store.set({ sheet: false });
            else if (state.selectedSegment) store.set({ selectedSegment: '' });
            else if (state.selectedAgent) store.set({ selectedAgent: '' });
            else if (state.pinnedRunId) store.set({ pinnedRunId: '' });
            else if (!embedded) close();
            return;
        }
        if (isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
        if (['1', '2', '3', '4'].includes(event.key)) store.set({ view: VIEWS[Number(event.key) - 1] });
        else if (event.key === ']') toggleInspector();
    }
    root.addEventListener('keydown', onKeydown);
    // Keep Luker's global hotkeys (swipes on ←/→ etc.) out while focused.
    if (!embedded) root.addEventListener('keydown', (event) => event.stopPropagation());
    const onFocusOut = (event) => {
        if (embedded) return;
        if (event.relatedTarget && root.contains(event.relatedTarget)) return;
        requestAnimationFrame(() => {
            if (destroyed) return;
            const active = document.activeElement;
            if (!active || active === document.body || !active.isConnected) root.focus({ preventScroll: true });
        });
    };
    root.addEventListener('focusout', onFocusOut);

    // ----- Mount ----------------------------------------------------------
    const previousOverflow = document.documentElement.style.overflow;
    if (!embedded) document.documentElement.style.overflow = 'hidden';
    container.appendChild(root);
    const viewportFit = embedded ? null : fitToViewport(root);
    renderAll();
    root.focus({ preventScroll: true });
    load();

    async function close() {
        if (destroyed) return;
        if (drafts.count() && !embedded) {
            const value = await dialog.ask(i18n('There are unsaved edits'), h('p', { class: 'ol-dialog-text', text: i18nFormat('${0} edits are not saved and will be lost on close.', drafts.count()) }), [
                { label: i18n('Keep editing'), value: '' },
                { label: i18n('Close without saving'), value: 'close', danger: true },
                draftsActive() ? { label: i18n('Save and close'), value: 'save', primary: true } : null,
            ].filter(Boolean));
            if (!value) return;
            if (value === 'save') {
                await saveDrafts();
                if (drafts.count()) return;
            }
        }
        if (destroyed) return;
        destroyed = true;
        scheduleReload.cancel();
        clearInterval(ticker);
        unsubscribeSource();
        unsubscribeRecorder();
        if (ownsRecorder) rec.detach();
        compactMql?.removeEventListener?.('change', onCompactChange);
        viewportFit?.destroy();
        for (const view of Object.values(views)) view.destroy?.();
        aiPanel?.destroy();
        unsubscribeDrafts();
        root.remove();
        if (!embedded) document.documentElement.style.overflow = previousOverflow;
        onClose?.();
    }

    return { close, focus: () => root.focus({ preventScroll: true }), reload: () => load(), app };
}
