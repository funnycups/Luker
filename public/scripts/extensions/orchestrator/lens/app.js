// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Embedded Orchestra Lens workspace mounted inside Workbench:
// state, loading / live refresh, layout (topbar · stage · inspector),
// keyboard shortcuts, and mobile bottom sheet.

import { h, clear, debounce, put } from '../../../lens-shared/util.js';
import { createRecorder } from '../../../run-panel/recorder.js';
import { icon } from './icons.js';
import { i18n, i18nFormat, agentName, modeInfo, statusLabel, MODE_IDS } from './i18n.js';
import { createStore, loadPrefs } from './store.js';
import { buildFlow } from './model/profile.js';
import { buildRunView, formatDuration } from './model/run.js';
import { createFlowView } from './views/flow-view.js';
import { createRunView } from './views/run-view.js';
import { createHistoryView } from './views/history-view.js';
import { createStatsView } from './views/stats-view.js';
import { createSetupView } from './views/setup-view.js';
import { createSettingsView } from './views/settings-view.js';
import { createNotesView } from './views/notes-view.js';
import { changeList } from './panels/change-list.js';
import { createDrafts } from './model/drafts.js';
import { agentFields, invertChanges } from './model/edit.js';
import { createInspector } from './panels/inspector.js';
import { createDialog } from './panels/dialog.js';
import { iconButton, segmented, emptyState, button, switchControl, isTouch } from './ui/components.js';

const COMPACT_QUERY = '(max-width: 860px)';
const VIEWS = ['flow', 'run', 'history', 'stats', 'setup', 'settings', 'notes'];
const VALID_VIEWS = new Set(VIEWS);
const ERROR_TEXT = { 'no-extension': 'Orchestrator extension not detected. Make sure it is enabled.' };

function detectTheme() {
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function buildDiagnoseDraft({ runKey, step = 0, runView = null } = {}) {
    if (!runView) {
        return runKey ? i18nFormat('Diagnose orchestration run ${0} and fix any issues found.', runKey) : '';
    }
    const seg = step > 0 ? runView.segments?.[step - 1] : null;
    if (seg) {
        return i18nFormat(
            'Diagnose step ${0} (${1}, ${2}) in orchestration run ${3} (${4} · ${5}). Inspect the run details via luker_orch_read_run and fix any prompt or routing issue.',
            step,
            agentName(seg.agentId),
            statusLabel(seg.status),
            runKey || runView.runId,
            modeInfo(runView.mode).label,
            formatDuration(runView.duration),
        );
    }
    return i18nFormat(
        'Diagnose orchestration run ${0} (${1} · ${2} · ${3}${4}). Inspect the run details via luker_orch_read_run and fix what caused the problem.',
        runKey || runView.runId,
        modeInfo(runView.mode).label,
        statusLabel(runView.status),
        formatDuration(runView.duration),
        runView.error ? ` · ${runView.error}` : '',
    );
}

export function buildStatsDiagnoseDraft({ stats, mode, focus = '' } = {}) {
    if (!stats) return '';
    if (focus) {
        const agent = stats.agents?.find(a => a.agentId === focus);
        return i18nFormat(
            'Diagnose why "${0}" (${1}) is slow or failing across the recent ${2} "${3}" runs (avg ${4}, ${5} errors). Inspect recent run details via luker_orch_read_run and optimize its settings.',
            agentName(focus),
            focus,
            stats.runs,
            modeInfo(mode).label,
            formatDuration(agent?.avg || 0),
            agent?.failed || 0,
        );
    }
    return i18nFormat(
        'Diagnose the slowest and most error-prone agents across the recent ${0} "${1}" runs (avg ${2}, ${3} failed runs). Inspect recent runs via luker_orch_read_run and optimize the bottlenecks.',
        stats.runs,
        modeInfo(mode).label,
        formatDuration(stats.avgDuration),
        stats.failedRuns,
    );
}

/**
 * @param {{ source: object, container?: HTMLElement, hostApp?: object | null, opts?: object | null, onClose?: () => void, recorder?: object, embedded?: boolean }} options
 */
export function mountOrchestraLens({ source, container = document.body, hostApp = null, opts = null, onClose = null, recorder = null, embedded = true }) {
    const prefs = loadPrefs();
    const compactMql = globalThis.matchMedia?.(COMPACT_QUERY);
    const initialView = VALID_VIEWS.has(opts?.subview)
        ? opts.subview
        : (opts?.runKey ? 'run' : (VIEWS.includes(prefs.view) ? prefs.view : 'flow'));
    const store = createStore({
        theme: prefs.theme === 'light' || prefs.theme === 'dark' ? prefs.theme : detectTheme(),
        view: initialView,
        inspectorOpen: prefs.inspectorOpen !== false,
        compact: Boolean(compactMql?.matches || hostApp?.isCompact?.()),
        sheet: false,
        status: 'loading',
        error: null,
        selectedAgent: '',
        selectedSegment: '',
        pinnedRunId: opts?.runKey ? String(opts.runKey) : '',
        modeMenu: false,
    });
    const drafts = createDrafts();
    let modelOptions = { connections: [], presets: [] };
    let modelOptionsLoaded = false;
    const ctxRef = () => globalThis.Luker?.getContext?.() ?? null;
    const rec = recorder || ctxRef()?.runPanel?.getRunRecorder?.() || createRecorder({ getRunContext: (from) => source.runContext?.(from) || {} });
    const runKey = (raw) => `${raw.source || 'orchestrator'}:${raw.runId}`;
    const runViewOf = (raw) => {
        const view = buildRunView(raw, Object.keys(flow?.agents || {}));
        if (raw.source === 'search') view.mode = 'search';
        view.key = runKey(raw);
        return view;
    };
    const draftsActive = () => Boolean(snapshot?.target && drafts.isCurrent(snapshot.target));
    function editBlockedReason() {
        if (!source.edit) return i18n('Cannot edit in preview mode');
        const target = snapshot?.target;
        if (!target) return '';
        if (!draftsActive()) return i18n('Another profile still has unsaved edits');
        return '';
    }
    let snapshot = null;
    let flow = null;
    let destroyed = false;

    const root = h('div', {
        class: `olens ol-lens${embedded ? ' is-embedded' : ''}`,
        role: embedded ? 'region' : 'dialog',
        'aria-modal': embedded ? null : 'true',
        'aria-label': i18n('Orchestra Lens'),
        tabIndex: -1,
    });
    if (!hostApp) {
        root.dataset.theme = store.get().theme;
    }

    const openWorkbenchAi = (draft = '') => {
        const nav = { page: 'ai', ws: 'orch', ...(draft ? { draft } : {}) };
        if (typeof hostApp?.go === 'function') {
            hostApp.go('ai', { ws: 'orch', ...(draft ? { draft } : {}) });
            return true;
        }
        const wb = ctxRef()?.workbench;
        if (typeof wb?.open === 'function') {
            void wb.open(nav);
            return true;
        }
        return false;
    };

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
        source,
        drafts,
        draftsActive,
        canEdit: () => Boolean(snapshot?.target) && !editBlockedReason(),
        canAi: () => Boolean(hostApp?.go || ctxRef()?.workbench?.open),
        editBlockedReason,
        fieldsOf: (id) => (draftsActive() ? agentFields(snapshot.target.mode, drafts.profile(), id) : []),
        modelOptions: () => modelOptions,
        reloadModelOptions: () => reloadModelOptions(),
        openAi: (text = '') => openWorkbenchAi(text),
        diagnose(key, step = 0) {
            const raw = rec.history().find(item => runKey(item) === key || item.runId === key)
                || rec.currents().find(item => runKey(item) === key || item.runId === key)
                || null;
            const view = raw ? runViewOf(raw) : app.run();
            openWorkbenchAi(buildDiagnoseDraft({ runKey: key, step, runView: view }));
        },
        diagnoseStats: (diagCtx) => {
            openWorkbenchAi(buildStatsDiagnoseDraft(diagCtx));
        },
        focusField: (agentId) => { if (flow?.agents?.[agentId]) store.set({ selectedAgent: agentId, ...(store.get().compact ? {} : { inspectorOpen: true }) }); },
        run() {
            const { pinnedRunId } = store.get();
            const raw = pinnedRunId
                ? (rec.history().find(item => runKey(item) === pinnedRunId || item.runId === pinnedRunId)
                    || rec.currents().find(item => runKey(item) === pinnedRunId || item.runId === pinnedRunId))
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
        openRun(targetRunId) {
            store.set({ pinnedRunId: targetRunId || '', selectedSegment: '', view: 'run' });
        },
        showText: (title, sections) => dialog.open(title, sections),
        notify: (text, notifyOpts) => showToast(text, notifyOpts),
        reload: () => {
            setupView.invalidate?.();
            return load();
        },
    };

    const flowView = createFlowView(app);
    const runView = createRunView(app);
    const historyView = createHistoryView(app);
    const statsView = createStatsView(app);
    const setupView = createSetupView(app);
    const settingsView = createSettingsView(app);
    const notesView = createNotesView(app);
    const views = { flow: flowView, run: runView, history: historyView, stats: statsView, setup: setupView, settings: settingsView, notes: notesView };
    const inspector = createInspector(app);
    const dialog = createDialog();
    Object.assign(app, {
        dialog,
        promptText,
        async guard(fn) {
            try { await fn(); await app.reload(); } catch (err) { showToast(String(err?.message || err), { error: true }); }
        },
    });

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
    const body = h('div', { class: 'ol-body' }, h('div', { class: 'ol-stagewrap' }, mobileBar, banner, savebar, stage, stateLayer), inspector.el, scrim);
    const modeMenuEl = h('div', { class: 'ol-menu', role: 'menu', hidden: true });
    const toast = h('div', { class: 'ol-toast', role: 'status', 'aria-live': 'polite', hidden: true });
    let toastTimer = 0;
    function showToast(text, { error = false, duration = 3000, action = null } = {}) {
        if (typeof hostApp?.toast === 'function') {
            hostApp.toast(text, {
                error,
                duration,
                action: action?.label || '',
                onAction: action?.run || null,
            });
            return;
        }
        clearTimeout(toastTimer);
        clear(toast);
        toast.classList.toggle('is-error', error);
        put(toast, icon(error ? 'alert' : 'check', { size: 15 }), h('span', { text }),
            action ? h('button', { type: 'button', class: 'ol-toast-btn', onClick: () => { toast.hidden = true; action.run(); } }, icon('undo', { size: 13 }), h('span', { text: action.label })) : null);
        toast.hidden = false;
        toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
    }
    put(root, topbar, body, modeMenuEl, dialog.el, toast);

    function liveState() {
        if (store.get().status === 'error') return 'error';
        return rec.isRunning() ? 'running' : 'live';
    }

    function enableSwitch() {
        return snapshot && source.setEnabled ? h('div', { class: 'ol-enable' }, switchControl(i18n('Enable orchestration'), snapshot.enabled, async (value) => {
            try {
                await source.setEnabled(value);
                snapshot = { ...snapshot, enabled: value };
                renderAll();
            } catch (err) {
                showToast(String(err?.message || err), { error: true });
            }
        })) : null;
    }

    function modePicker({ withDesc = false } = {}) {
        const state = store.get();
        const mode = snapshot?.mode || 'spec';
        const info = modeInfo(mode);
        const trigger = h('button', {
            type: 'button',
            class: 'ol-modebtn',
            'aria-haspopup': 'menu',
            'aria-expanded': String(state.modeMenu),
            title: `${i18n('Execution mode')}: ${info.hint}`,
            disabled: !source.setMode || !snapshot,
            onClick: (event) => { event.stopPropagation(); store.set({ modeMenu: !store.get().modeMenu }); },
        }, h('span', { class: 'ol-modebtn-label', text: i18n('Execution mode') }), h('span', { class: 'ol-modebtn-value', text: info.label }), icon('chevronDown', { size: 13 }));
        return h('div', { class: 'ol-modepick' },
            trigger,
            withDesc ? h('span', { class: 'ol-mode-desc', text: info.hint, title: info.hint }) : null);
    }

    function positionModeMenu() {
        if (modeMenuEl.hidden) return;
        const compact = store.get().compact;
        const trigger = (compact ? mobileBar : topbarRight).querySelector('.ol-modebtn');
        if (!trigger) return;
        const rootRect = root.getBoundingClientRect();
        const trigRect = trigger.getBoundingClientRect();
        if (rootRect.width <= 0 || rootRect.height <= 0 || trigRect.height <= 0) return;
        const gap = 6;
        const margin = 10;
        const top = Math.max(margin, Math.round(trigRect.bottom - rootRect.top + gap));
        const availHeight = Math.max(120, Math.round(rootRect.height - top - margin));
        modeMenuEl.style.top = `${top}px`;
        modeMenuEl.style.maxHeight = `${availHeight}px`;
        if (compact) {
            modeMenuEl.style.left = `${margin}px`;
            modeMenuEl.style.right = `${margin}px`;
        } else {
            modeMenuEl.style.left = '';
            const right = Math.max(margin, Math.round(rootRect.right - trigRect.right));
            modeMenuEl.style.right = `${right}px`;
        }
    }

    function renderModeMenu() {
        const state = store.get();
        const open = Boolean(state.modeMenu && snapshot);
        for (const btn of root.querySelectorAll('.ol-modebtn')) {
            btn.setAttribute('aria-expanded', String(open));
        }
        if (!open) {
            modeMenuEl.hidden = true;
            clear(modeMenuEl);
            return;
        }
        const mode = snapshot.mode || 'spec';
        put(clear(modeMenuEl), MODE_IDS.map(id => h('button', {
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
        h('span', { class: 'ol-menu-text' }, h('span', { class: 'ol-menu-title', text: modeInfo(id).label }), h('span', { class: 'ol-menu-hint', text: modeInfo(id).hint })))));
        modeMenuEl.hidden = false;
        positionModeMenu();
    }

    let lastMobileBarKey = '';
    function renderMobileBar() {
        const state = store.get();
        if (!state.compact || !snapshot) {
            if (lastMobileBarKey !== '' || !mobileBar.hidden) {
                clear(mobileBar);
                mobileBar.hidden = true;
                lastMobileBarKey = '';
            }
            return;
        }
        const key = `${Boolean(snapshot.enabled)}|${snapshot.mode || 'spec'}|${Boolean(source.setEnabled)}|${Boolean(source.setMode)}`;
        if (key === lastMobileBarKey && !mobileBar.hidden) return;
        lastMobileBarKey = key;
        put(clear(mobileBar), enableSwitch(), modePicker());
        mobileBar.hidden = false;
    }

    let lastLiveBarKey = '';
    function renderTopbar() {
        const state = store.get();
        titleChat.textContent = snapshot?.chatLabel || '';
        titleChat.hidden = !snapshot?.chatLabel;
        const run = rec.current();
        const hasRunningBadge = Boolean(run?.status === 'running' && !run.quiet);
        const badge = hasRunningBadge ? h('span', { class: 'ol-seg-live', 'aria-hidden': 'true' }) : null;
        put(clear(viewSwitch), segmented([
            { value: 'flow', label: i18n('Flow'), icon: 'flow' },
            { value: 'run', label: i18n('Run'), icon: 'play' },
            { value: 'history', label: i18n('History'), icon: 'history' },
            { value: 'stats', label: i18n('Stats'), icon: 'timeline' },
            { value: 'setup', label: i18n('Setup'), icon: 'layers' },
            { value: 'settings', label: i18n('Settings'), icon: 'gear' },
            { value: 'notes', label: i18n('Notes'), icon: 'doc' },
        ], state.view, (value) => store.set({ view: value, modeMenu: false }), { ariaLabel: i18n('Flow'), iconOnlyMobile: true }));
        if (badge) viewSwitch.querySelectorAll('.lw-seg-btn')[1]?.appendChild(badge);
        const live = liveState();
        lastLiveBarKey = `${live}|${hasRunningBadge}`;
        renderMobileBar();
        put(clear(topbarRight),
            !state.compact ? enableSwitch() : null,
            !state.compact && snapshot ? modePicker({ withDesc: true }) : null,
            h('span', { class: 'ol-sync', dataset: { state: live }, role: 'status' },
                h('span', { class: 'ol-sync-dot', 'aria-hidden': 'true' }),
                h('span', { class: 'ol-sync-text', text: live === 'running' ? i18n('Running') : i18n('Live') })),
            app.canAi() ? button('AI', () => openWorkbenchAi(), { iconName: 'sparkle', small: true, title: i18n('Open AI Iteration Studio') }) : null,
            !hostApp ? iconButton(state.theme === 'dark' ? 'sun' : 'moon', i18n('Toggle theme'), () => store.set({ theme: state.theme === 'dark' ? 'light' : 'dark' })) : null,
            iconButton('sidebarRight', i18n('Details panel'), () => toggleInspector(), { className: 'ol-toggle-inspector', pressed: state.inspectorOpen }),
            embedded ? null : iconButton('x', i18n('Close'), () => destroy(), { className: 'ol-close' }));
        renderModeMenu();
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
    let lastReportedDraftCount = 0;
    function renderSavebar() {
        const totalDrafts = drafts.count();
        if (totalDrafts !== lastReportedDraftCount) {
            lastReportedDraftCount = totalDrafts;
            hostApp?.refreshBadges?.();
        }
        const count = draftsActive() ? totalDrafts : 0;
        const foreign = !draftsActive() && totalDrafts > 0;
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
                    h('p', { class: 'ol-dialog-text', text: i18n('After you started editing, the items below were also changed elsewhere. Saving anyway overwrites them with your version.') }),
                    changeList({ changes: result.conflicts.map(c => ({ ...c, before: c.current })), state: 'review' })), [
                    { label: i18n('Cancel'), value: '' },
                    { label: i18n('Overwrite with my version'), value: 'force', danger: true },
                ]);
                saving = false;
                if (value === 'force') await saveDrafts({ force: true });
                return;
            }
            drafts.discard();
            lastSaved = { target, changes: result.applied };
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
        try {
            const result = await source.edit.save(saved.target, invertChanges(saved.changes), { requireAll: true });
            if (!result.saved || result.missing.length) throw new Error(i18n('These were also changed elsewhere'));
            lastSaved = null;
            showToast(i18n('The last save was undone'));
            await load();
        } catch (err) {
            showToast(i18nFormat('Undo failed: ${0}', String(err?.message || err)), { error: true });
        }
    }

    /** Asks for one line of text; null when dismissed. */
    async function promptText(heading, initial = '') {
        const input = h('input', { class: 'ol-input', value: initial });
        const value = await dialog.ask(heading, h('div', { class: 'ol-form' }, input), [{ label: i18n('Cancel'), value: '' }, { label: i18n('OK'), value: 'ok', primary: true }]);
        return value ? input.value.trim() : null;
    }

    async function ensureModelOptions() {
        if (!modelOptionsLoaded && source.edit?.options) {
            try { modelOptions = await source.edit.options(); modelOptionsLoaded = true; } catch (err) { console.warn('[orchestrator/lens] ensureModelOptions failed:', err); }
        }
        return modelOptions;
    }

    async function reloadModelOptions() {
        modelOptionsLoaded = false;
        return ensureModelOptions();
    }

    function toggleInspector() {
        const state = store.get();
        if (state.compact) store.set({ sheet: !state.sheet });
        else store.set({ inspectorOpen: !state.inspectorOpen });
    }

    function applyLayout() {
        const state = store.get();
        if (!hostApp) root.dataset.theme = state.theme;
        root.classList.toggle('is-compact', state.compact);
        root.classList.toggle('is-touch', isTouch());
        const inspectorWanted = state.inspectorOpen && (!['flow', 'stats'].includes(state.view) || Boolean(state.selectedAgent));
        root.classList.toggle('inspector-open', state.compact ? state.sheet : inspectorWanted);
        root.classList.toggle('sheet-open', state.compact && state.sheet);
        for (const wrap of stage.children) wrap.hidden = wrap.dataset.view !== state.view;
        renderState();
    }

    let loadingFrame = 0;
    function renderState() {
        const state = store.get();
        cancelAnimationFrame(loadingFrame);
        loadingFrame = 0;
        if (state.status === 'ready') {
            stateLayer.hidden = true;
            return;
        }
        if (state.status === 'loading') {
            loadingFrame = requestAnimationFrame(() => {
                loadingFrame = 0;
                if (destroyed || store.get().status !== 'loading') return;
                stateLayer.hidden = false;
                clear(stateLayer);
                put(stateLayer, h('div', { class: 'ol-loading' }, h('div', { class: 'ol-spinner', 'aria-hidden': 'true' }), h('span', { text: i18n('Reading orchestration settings…') })));
            });
            return;
        }
        stateLayer.hidden = false;
        clear(stateLayer);
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
                drafts.setBase(next.target, next.profile);
            }
            rebuildFlow();
            void ensureModelOptions().then(() => { if (store.get().selectedAgent) inspector.render(); });
            const patch = { status: 'ready', error: null };
            if (chatChanged) Object.assign(patch, { pinnedRunId: '', selectedSegment: '' });
            if (store.get().selectedAgent && !flow.agents[store.get().selectedAgent] && !app.run()?.lanes.some(l => l.agentId === store.get().selectedAgent)) patch.selectedAgent = '';
            store.set(patch);
            renderAll();
        } catch (err) {
            if (token !== loadToken || destroyed) return;
            console.warn('[orchestrator/lens] load failed', err);
            const code = err?.code || '';
            const message = String(err?.message || err);
            if (!snapshot) {
                flow = null;
                store.set({ status: 'error', error: { code, message } });
            } else {
                store.set({ error: { code, message } });
                showToast(message || i18n('Failed to read'), { error: true });
            }
            renderAll();
        }
    }
    const scheduleReload = debounce(() => load(), 300);

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
        if (store.get().view === 'setup') setupView.onDraftChange();
    });
    const unsubscribeSource = source.subscribe?.(() => scheduleReload()) || (() => {});

    const renderLive = () => {
        if (destroyed) return;
        const view = store.get().view;
        if (view === 'flow') flowView.onRunUpdate?.();
        if (view === 'run' && !store.get().pinnedRunId) runView.render();
        if (view === 'history') historyView.render();
        inspector.onRunUpdate?.();
        const run = rec.current();
        const nextLiveKey = `${liveState()}|${Boolean(run?.status === 'running' && !run.quiet)}`;
        if (nextLiveKey !== lastLiveBarKey) renderTopbar();
    };
    const unsubscribeRecorder = rec.subscribe((kind) => {
        if (kind === 'start' && !store.get().pinnedRunId) store.set({ selectedSegment: '' });
        renderLive();
    });
    const ticker = setInterval(() => { if (rec.isRunning()) renderLive(); }, 1000);

    store.subscribe((state, changed) => {
        if (changed.has('theme') && !hostApp) root.dataset.theme = state.theme;
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
        if (['theme', 'view', 'inspectorOpen', 'compact', 'status'].some(key => changed.has(key))) renderTopbar();
        else if (changed.has('modeMenu')) renderModeMenu();
    });

    const computeCompact = () => {
        const w = root.clientWidth;
        if (w > 0) return w <= 860;
        return Boolean(compactMql?.matches || hostApp?.isCompact?.());
    };
    const syncWidthTier = () => {
        const w = root.clientWidth;
        if (w <= 0) return;
        root.dataset.widthTier = w <= 1120 ? 'narrow' : (w <= 1380 ? 'mid' : 'wide');
    };
    const syncCompact = () => {
        syncWidthTier();
        const next = computeCompact();
        if (next !== store.get().compact) store.set({ compact: next, sheet: false, modeMenu: false });
        else if (store.get().modeMenu) positionModeMenu();
    };
    compactMql?.addEventListener?.('change', syncCompact);
    const onResize = debounce(syncCompact, 120);
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => onResize()) : null;
    resizeObserver?.observe(root);

    const onRootClick = (event) => {
        if (store.get().modeMenu && !event.target.closest?.('.ol-modepick, .ol-menu')) store.set({ modeMenu: false });
    };
    root.addEventListener('click', onRootClick);

    function isTypingTarget(target) {
        return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    }

    function handleEscape() {
        const state = store.get();
        if (dialog.isOpen()) { dialog.close(); return true; }
        if (state.modeMenu) { store.set({ modeMenu: false }); return true; }
        if (state.sheet) { store.set({ sheet: false }); return true; }
        if (state.selectedSegment) { store.set({ selectedSegment: '' }); return true; }
        if (state.selectedAgent) { store.set({ selectedAgent: '' }); return true; }
        if (state.pinnedRunId) { store.set({ pinnedRunId: '' }); return true; }
        return false;
    }

    function onKeydown(event) {
        if (event.key === 'Escape') {
            if (handleEscape()) event.stopPropagation();
            return;
        }
        if (isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
        if (['1', '2', '3', '4', '5', '6', '7'].includes(event.key)) store.set({ view: VIEWS[Number(event.key) - 1] });
        else if (event.key === ']') toggleInspector();
    }
    root.addEventListener('keydown', onKeydown);

    container.appendChild(root);
    syncWidthTier();
    renderAll();
    load();

    function applyOpts(nextOpts) {
        if (!nextOpts || typeof nextOpts !== 'object') return;
        if (nextOpts.runKey) {
            store.set({ pinnedRunId: String(nextOpts.runKey), selectedSegment: '', view: 'run' });
        } else if (VALID_VIEWS.has(nextOpts.subview)) {
            store.set({ view: nextOpts.subview });
        }
        if (nextOpts.focusId) {
            app.selectAgent(nextOpts.focusId);
        }
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        cancelAnimationFrame(loadingFrame);
        clearTimeout(toastTimer);
        scheduleReload.cancel();
        onResize.cancel?.();
        resizeObserver?.disconnect();
        clearInterval(ticker);
        unsubscribeSource();
        unsubscribeRecorder();
        compactMql?.removeEventListener?.('change', syncCompact);
        for (const view of Object.values(views)) view.destroy?.();
        unsubscribeDrafts();
        root.remove();
        onClose?.();
    }

    return {
        show(showOpts) {
            applyOpts(showOpts);
            syncCompact();
            flowView.onShow?.();
        },
        hide() {},
        update(nextOpts) {
            applyOpts(nextOpts);
        },
        onEscape: handleEscape,
        onSnapshot() {
            setupView.invalidate?.();
            scheduleReload();
        },
        unsavedCount: () => drafts.count(),
        destroy,
        reload: () => app.reload(),
        app,
    };
}
