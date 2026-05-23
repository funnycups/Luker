// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * CPA Completion Preset Assistant — AI iteration popup (plugin-owned).
 *
 * Stage 3 replacement for the legacy iteration-studio adapter
 * (`cpa-iteration-adapter.js`). Single-column chat surface that wires
 * `iteration-library/*` helpers directly:
 *   - storage  (per-preset session bucket via `session-store.js`)
 *   - runner   (`requestToolCallsWithRetry` from `lib/iter-tool-calling.js`)
 *   - render   (Markdown rendering for assistant messages)
 *   - edits    (`applyEdits` from `lib/edits/`)
 *
 * Layout per sub-spec §4 (Q10 redesigned — single reference picker):
 *
 *   ┌────────────────────────────────────────────┐
 *   │ <details> History … New, Clear  </details> │
 *   │ <div>  toolbar: reference + mode  </div>   │
 *   │ <div>  message list (chat)        </div>   │
 *   │ <div>  pending edits (when staged)</div>   │
 *   │ <div>  composer textarea + Send   </div>   │
 *   └────────────────────────────────────────────┘
 *
 * The popup is mounted via `new Popup(..., POPUP_TYPE.DISPLAY)` so it has no
 * built-in OK / Cancel buttons; the user dismisses it via the dialog's close
 * button (top-right ✕). Sessions auto-persist on every mutation, so closing
 * mid-conversation is safe.
 *
 * Q10 sub-spec — single reference picker:
 *   The shell-driven adapter exposed TWO dropdowns (reference preset +
 *   editing mode) plus a "Show reference diff" button. CPA legitimately
 *   needs cross-preset comparison, but the legacy double-dropdown UX was
 *   pathology. The redesign keeps ONE reference-preset dropdown in the
 *   toolbar (gates `hasReference` on the tool catalog + system prompt) and
 *   ONE optional mode dropdown (general / orchestrator-optimize /
 *   jailbreak-only). The reference body never feeds applyEdits — it only
 *   affects:
 *     - `buildToolCatalog({hasReference})` — surfaces preset_copy_from_
 *       reference / preset_read_reference_fields / preset_diff_reference
 *     - `buildModelSystemPrompt({hasReference, mode})` — reference-aware
 *       guidance + mode-specific tail block
 *
 * Entry point:
 *   `openCpaIterationStudio(deps)`
 *
 * Deps shape (preserves every field the legacy adapter received):
 *   - i18n, i18nFormat, escapeHtml
 *   - context, getContext()
 *   - getTargetRef()                      → { collection, name }
 *   - getReferencePresets()               → [{ name }, ...]
 *   - getReferencePresetBody(name)        → Promise<body>
 *   - shouldIncludeWorldInfo()            → boolean
 *   - getSettings, saveSettingsDebounced
 *   - getRequestPresetOptions()           → { llmPresetName, apiPresetName }
 */

import { Popup, POPUP_TYPE } from '../../../popup.js';
import { lodash } from '../../../../lib.js';
import {
    applyEdits,
    inverseEdit,
    bindIterWorkspaceResizer,
    render as ITER_RENDER,
    runner as ITER_RUNNER,
    textDiff as ITER_TEXT_DIFF,
    zoomOverlay as ITER_ZOOM_OVERLAY,
} from '../../../iteration-library/index.js';
import {
    buildToolCatalog,
    normalizeToolCallToEdit,
    TOOL_DISPLAY,
    EDITABLE_TOOL_NAMES,
    CONTROL_TOOL_NAMES,
    isCpaControlCall,
} from './tools.js';
import {
    buildModelSystemPrompt,
    buildPresetSettingsOutlineText,
    buildPresetPromptOutlineText,
    sanitizeSessionMode,
    SESSION_MODES,
    SESSION_MODE_DEFAULT,
} from './system-prompts.js';
import { createCpaIterationSessionStore, makeMessageId, normalizeMessageShape } from './session-store.js';

const MODULE = 'cpa-iteration';
const STYLESHEET_ID = 'cpa_it_studio_stylesheet';
const STYLESHEET_HREF = '/scripts/extensions/completion-preset-assistant/cpa-iteration/studio.css';

/**
 * Inject the popup stylesheet on first open. Subsequent opens are no-ops
 * because the link element is reused (id-keyed lookup). Loading is async
 * but the popup doesn't block on it — the first paint may be unstyled for
 * a tick before the browser applies the freshly-injected rules, which is
 * the same trade-off CEA's legacy `card-app-studio-style` makes.
 */
function ensureStylesheetInjected() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLESHEET_ID)) return;
    const link = document.createElement('link');
    link.id = STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.href = STYLESHEET_HREF;
    document.head.appendChild(link);
}

/**
 * Local HTML escape for building the static popup shell. Per-render text uses
 * `deps.escapeHtml` (from main.js) so the user-supplied implementation stays
 * authoritative for chat / pending-card content.
 */
function escapeHtmlLocal(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function makeSessionId() {
    return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Treat AbortController abort and the runner's "Orchestration aborted."
 * error as the user's Stop button rather than an LLM failure. The runner
 * throws a plain Error with that message when the abortSignal trips
 * (see `iter-tool-calling.js#throwIfAborted`).
 */
function isAbortError(err, signal) {
    if (signal?.aborted) return true;
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    const msg = String(err.message || err);
    return /aborted|Aborted/.test(msg);
}

// ──────────────────────────────────────────────────────────────────────────
// Live target preview — shared helpers + CPA renderer.
//
// These run at module scope (not inside `openCpaIterationStudio`) so unit
// tests can import `_testOnly_renderCpaPreviewPane` directly without
// instantiating the popup. The renderer is pure: given `live` + pending
// edits, return preview HTML. Snippets B + C from the implementation plan.
//
// `computeChangedPathSet`, `walkDiff`, `truncateForPreview`,
// `fmtPendingChangeInline` are intentionally file-local. The other 4
// popups (MG schema / Orchestrator / CEA char / CEA editor) duplicate
// them rather than extract to iteration-library, per spec §B.
// ──────────────────────────────────────────────────────────────────────────

function computeChangedPathSet(live, pendingEdits) {
    if (!Array.isArray(pendingEdits) || pendingEdits.length === 0) return new Set();
    let next;
    try {
        const cloned = structuredClone(live);
        const result = applyEdits(pendingEdits, cloned);
        next = result?.newLive ?? cloned;
    } catch {
        return new Set();
    }
    const changed = new Set();
    walkDiff('', live, next, changed);
    return changed;
}

function walkDiff(path, a, b, out) {
    if (a === b) return;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
        out.add(path);
        return;
    }
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
        const childPath = path ? `${path}.${k}` : k;
        walkDiff(childPath, a?.[k], b?.[k], out);
    }
}

function truncateForPreview(str, max = 200) {
    if (typeof str !== 'string') str = String(str ?? '');
    return str.length > max ? str.slice(0, max) + '…' : str;
}

/**
 * Format a `(was oldVal → now newVal)` inline diff span. Substitutes
 * `${0}` / `${1}` against the truncated values; lookup against an
 * optional `tFn` lets the production popup substitute the localized
 * template ("(待修改:..."). When `tFn` is omitted we fall back to the
 * English template so the marker is still legible in tests.
 */
function fmtPendingChangeInline(oldVal, newVal, tFn) {
    const oldDisp = truncateForPreview(String(oldVal ?? '(unset)'), 60);
    const newDisp = truncateForPreview(String(newVal ?? '(unset)'), 60);
    const template = '(was ${0} → now ${1})';
    const localized = typeof tFn === 'function' ? String(tFn(template) ?? template) : template;
    const filled = localized.replace(/\$\{(\d+)\}/g, (_, idx) => String([oldDisp, newDisp][Number(idx)] ?? ''));
    return `<span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(filled)}</span>`;
}

/**
 * Render the right-pane HTML for the CPA workspace preview. Pure function.
 *
 * @param {object|null} live              The current preset body, or null.
 * @param {Array} pendingEdits            Edits from the latest LLM round.
 * @param {string[]} [savedPresets=[]]    Names of presets shown in the aside.
 * @param {string}  [activeRefName='']    Currently-selected reference.
 * @param {Function} [tFn]                Optional i18n function (string → string).
 * @returns {string} HTML.
 */
function renderCpaPreviewPane(live, pendingEdits, savedPresets = [], activeRefName = '', tFn) {
    const t = typeof tFn === 'function' ? tFn : (s) => String(s ?? '');
    if (!live) {
        return `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No preset loaded.'))}</div>`;
    }
    const edits = Array.isArray(pendingEdits) ? pendingEdits : [];
    const changed = computeChangedPathSet(live, edits);
    let nextLive = live;
    if (edits.length > 0) {
        try {
            const cloned = structuredClone(live);
            const r = applyEdits(edits, cloned);
            nextLive = r?.newLive ?? cloned;
        } catch { /* fall back to live */ }
    }

    const sampleFields = [
        ['temperature', 'Temperature'],
        ['top_p', 'Top P'],
        ['top_k', 'Top K'],
        ['freq_pen', 'Frequency penalty'],
        ['pres_pen', 'Presence penalty'],
        ['max_context_unlocked', 'Max context unlocked'],
        ['stream_openai', 'Stream'],
    ];

    const samplingRows = sampleFields
        .filter(([k]) => Object.prototype.hasOwnProperty.call(live, k))
        .map(([k, label]) => {
            const isChanged = changed.has(k);
            const oldVal = live[k];
            const newVal = nextLive?.[k];
            // When unchanged: render the live value. When pending change:
            // render the NEW value as the main display and decorate with
            // `(was <old>)`, so we don't double-display the old value on
            // both sides of the diff arrow.
            const displayVal = isChanged ? newVal : oldVal;
            const inlineDiff = isChanged ? fmtPendingChangeInline(oldVal, newVal, t) : '';
            const cls = isChanged
                ? 'luker-iter-workspace-preview-row pending-change'
                : 'luker-iter-workspace-preview-row';
            return `<div class="${cls}"><div class="luker-iter-workspace-preview-row-head"><span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(label)}</span><span>${escapeHtmlLocal(String(displayVal ?? ''))}</span>${inlineDiff}</div></div>`;
        }).join('');

    const prompts = Array.isArray(live.prompts) ? live.prompts : [];
    const promptRows = prompts.slice(0, 6).map((p, idx) => {
        const path = `prompts.${idx}.content`;
        const isChanged = changed.has(path) || changed.has(`prompts.${idx}`);
        const cls = isChanged
            ? 'luker-iter-workspace-preview-row pending-change'
            : 'luker-iter-workspace-preview-row';
        const name = p?.name || p?.identifier || `#${idx}`;
        const role = p?.role || '';
        const body = truncateForPreview(p?.content || '', 200);
        const bodyHtml = body
            ? escapeHtmlLocal(body)
            : `<span class="muted">${escapeHtmlLocal(t('(empty)'))}</span>`;
        return `<div class="${cls}"><div class="luker-iter-workspace-preview-row-head"><span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(name)}</span><span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(role)}</span></div><div class="luker-iter-workspace-preview-row-body">${bodyHtml}</div></div>`;
    }).join('');

    const presetNames = Array.isArray(savedPresets) ? savedPresets : [];
    const presetRowsHtml = presetNames.map(name => {
        const isActive = name === activeRefName;
        const cls = isActive
            ? 'luker-iter-workspace-preview-row changed'
            : 'luker-iter-workspace-preview-row';
        return `<div class="${cls}" data-cpa-it-preview-action="ref-pick" data-cpa-it-ref-name="${escapeHtmlLocal(name)}"><div class="luker-iter-workspace-preview-row-head"><span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(name)}</span>${isActive ? `<span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(t('Reference'))}</span>` : ''}</div></div>`;
    }).join('');
    const refsHtml = presetNames.length > 0 ? `
        <div class="luker-iter-workspace-aside">
            <div class="luker-iter-workspace-aside-title">${escapeHtmlLocal(t('Saved presets'))}</div>
            ${presetRowsHtml}
        </div>
    ` : '';

    return `
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Sampling params'))}</div>
            ${samplingRows || `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No data'))}</div>`}
        </div>
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Prompts'))}</div>
            ${promptRows || `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No data'))}</div>`}
        </div>
        ${refsHtml}
    `;
}

export { renderCpaPreviewPane as _testOnly_renderCpaPreviewPane };

function createNewSession() {
    const now = Date.now();
    return {
        id: makeSessionId(),
        title: '',
        messages: [],
        pendingEdits: [],
        surfaceState: {
            historyOpen: false,
            referencePresetName: '',
            sessionMode: SESSION_MODE_DEFAULT,
            autoApply: false,
        },
        updatedAt: now,
        createdAt: now,
        summary: '',
    };
}

/**
 * Build the popup root HTML. Built once on open; per-render mutations scope
 * to subordinate `[data-cpa-it-*]` slots so we never re-mount the textarea
 * (which would lose focus + the in-progress draft).
 */
function buildPopupHtml({
    popupId,
    title,
    historyOpen,
    historyLabel,
    newSessionLabel,
    clearAllLabel,
    sendLabel,
    composerPlaceholder,
    referenceLabel,
    noneLabel,
    modeLabel,
    modeOptions,
    autoApply,
    autoApplyLabel,
    chatTabLabel,
    previewTabLabel,
    chatBadgeAriaLabel,
    resizerAriaLabel,
}) {
    return `
<div id="${popupId}" class="cpa_it_popup luker-iter-workspace" data-iter-layout="split" data-iter-active-tab="chat">
    <div class="cpa_it_title">${escapeHtmlLocal(title)}</div>
    <details class="cpa_it_history" data-cpa-it-history${historyOpen ? ' open' : ''}>
        <summary>${escapeHtmlLocal(historyLabel)}</summary>
        <div class="cpa_it_history_items" data-cpa-it-history-items></div>
        <div class="cpa_it_history_actions">
            <button class="menu_button menu_button_small" data-cpa-it-action="new-session">${escapeHtmlLocal(newSessionLabel)}</button>
            <button class="menu_button menu_button_small" data-cpa-it-action="clear-history">${escapeHtmlLocal(clearAllLabel)}</button>
        </div>
    </details>

    <div class="luker-iter-workspace-tabs" role="tablist">
        <button type="button" class="luker-iter-workspace-tab active" role="tab" aria-selected="true" data-iter-action="switch-tab" data-iter-tab="chat">
            <span class="luker-iter-workspace-tab-label">${escapeHtmlLocal(chatTabLabel)}</span>
            <span class="luker-iter-workspace-tab-badge" data-iter-chat-badge hidden aria-label="${escapeHtmlLocal(chatBadgeAriaLabel)}"></span>
        </button>
        <button type="button" class="luker-iter-workspace-tab" role="tab" aria-selected="false" data-iter-action="switch-tab" data-iter-tab="preview">
            <span class="luker-iter-workspace-tab-label">${escapeHtmlLocal(previewTabLabel)}</span>
        </button>
    </div>

    <div class="cpa_it_toolbar">
        <label class="cpa_it_toolbar_label">
            <span class="cpa_it_toolbar_label_text">${escapeHtmlLocal(referenceLabel)}</span>
            <select class="cpa_it_reference_select" data-cpa-it-action="reference-change">
                <option value="">${escapeHtmlLocal(noneLabel)}</option>
            </select>
        </label>
        <label class="cpa_it_toolbar_label">
            <span class="cpa_it_toolbar_label_text">${escapeHtmlLocal(modeLabel)}</span>
            <select class="cpa_it_mode_select" data-cpa-it-action="mode-change">
                ${modeOptions}
            </select>
        </label>
    </div>

    <div class="luker-iter-workspace-grid">
        <div class="luker-iter-workspace-chat" data-iter-pane="chat">
            <div class="cpa_it_messages" data-cpa-it-messages></div>
            <div class="cpa_it_pending" data-cpa-it-pending hidden></div>
            <div class="cpa_it_composer">
                <textarea class="text_pole" rows="2" data-cpa-it-input placeholder="${escapeHtmlLocal(composerPlaceholder)}"></textarea>
                <div class="cpa_it_composer_actions">
                    <label class="cpa_it_composer_auto_apply">
                        <input type="checkbox" data-cpa-it-action="toggle-auto-apply"${autoApply ? ' checked' : ''}>
                        <span>${escapeHtmlLocal(autoApplyLabel)}</span>
                    </label>
                    <div class="cpa_it_composer_buttons">
                        <button class="menu_button" data-cpa-it-action="send">${escapeHtmlLocal(sendLabel)}</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="luker-iter-workspace-resizer" data-iter-resizer aria-label="${escapeHtmlLocal(resizerAriaLabel)}"></div>
        <div class="luker-iter-workspace-preview" data-iter-pane="preview" data-iter-preview-pane></div>
    </div>
</div>`;
}

/**
 * Open the CPA AI iteration popup against the current preset target.
 *
 * Resolves when the user dismisses the dialog. Sessions are persisted eagerly
 * on every mutation so dismiss-without-save is irrelevant.
 *
 * @param {object} deps  See module header for shape.
 */
export async function openCpaIterationStudio(deps) {
    if (!deps || typeof deps !== 'object') {
        throw new TypeError('openCpaIterationStudio: deps is required');
    }
    const {
        i18n,
        i18nFormat,
        escapeHtml: depsEscapeHtml,
        getContext,
        getTargetRef,
        getReferencePresets,
        getReferencePresetBody,
        getSettings,
        getRequestPresetOptions,
    } = deps;

    if (typeof getTargetRef !== 'function') {
        throw new TypeError('openCpaIterationStudio: deps.getTargetRef is required');
    }
    if (typeof getContext !== 'function') {
        throw new TypeError('openCpaIterationStudio: deps.getContext is required');
    }

    const escapeHtml = typeof depsEscapeHtml === 'function' ? depsEscapeHtml : escapeHtmlLocal;
    const t = typeof i18n === 'function' ? i18n : (s) => String(s ?? '');
    const tf = typeof i18nFormat === 'function'
        ? i18nFormat
        : (s, ...vals) => String(s ?? '').replace(/\$\{(\d+)\}/g, (_m, n) => String(vals[Number(n)] ?? ''));

    // Inject the popup stylesheet on first open. Idempotent; subsequent
    // calls are no-ops because the <link> element is id-keyed.
    ensureStylesheetInjected();

    // ──────────────────────────────────────────────────────────────────
    // Per-preset session store (bucket = presets.state[SESSION_NAMESPACE]).
    // ──────────────────────────────────────────────────────────────────
    const sessionStore = createCpaIterationSessionStore({
        getContext,
        getTargetRef,
    });
    await sessionStore.clearObsolete();

    // Prime markdown deps so the first paint has formatted messages
    // rather than escaped fallback (`ensureMarkdownDeps` caches).
    await ITER_RENDER.ensureMarkdownDeps();

    // ──────────────────────────────────────────────────────────────────
    // Closure-local state.
    // ──────────────────────────────────────────────────────────────────
    const state = {
        session: createNewSession(),
        live: null,         // current preset body (cloned from getStored)
        reference: null,    // when referencePresetName is set, the loaded reference body
        pendingEdits: [],
        isBusy: false,
        abortController: null,
    };

    // ──────────────────────────────────────────────────────────────────
    // Live state — read from presets.getStored on each turn so external
    // edits (user manually saves another preset, or a parallel CPA action
    // mutates this one) show up in the next LLM round-trip's `oldValue`
    // capture.
    // ──────────────────────────────────────────────────────────────────
    async function loadLive() {
        const ref = getTargetRef();
        const stored = getContext()?.presets?.getStored?.(ref);
        state.live = stored?.body ? structuredClone(stored.body) : null;
    }

    /**
     * Load the reference preset body when `referencePresetName` is set.
     * Refresh on every reference change, on session load, and on first open.
     */
    async function reloadReference() {
        const name = String(state.session.surfaceState?.referencePresetName || '').trim();
        if (!name) { state.reference = null; return; }
        if (typeof getReferencePresetBody !== 'function') { state.reference = null; return; }
        try {
            state.reference = await getReferencePresetBody(name);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] Failed to load reference preset "${name}"`, err);
            state.reference = null;
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Persistence. Session carries the latest surfaceState, messages, and
    // a derived title (first 50 chars of the first user message). Calling
    // this is cheap — the store wraps writes in a presets.state.update
    // call which batches with saveSettingsDebounced under the hood.
    // ──────────────────────────────────────────────────────────────────
    async function persistSession() {
        state.session.updatedAt = Date.now();
        // Mirror the top-level pendingEdits cache into the persisted bucket
        // so closing mid-conversation preserves staged-but-not-applied edits
        // (e.g. AI proposed changes, user closes the popup without clicking
        // Apply or Discard — reopening shows the same pending block).
        state.session.pendingEdits = Array.isArray(state.pendingEdits) ? state.pendingEdits.slice() : [];
        if (!state.session.title) {
            const firstUser = state.session.messages.find(m => m.role === 'user');
            if (firstUser) {
                state.session.title = String(firstUser.content || '').slice(0, 50);
            }
        }
        await sessionStore.save(state.session);
    }

    async function loadSession(id) {
        const loaded = await sessionStore.load(id);
        if (!loaded) return;
        // Abort any in-flight LLM call from the previous session so a slow
        // response doesn't land in the newly-loaded session's history.
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.abortController = null;

        const fallbackAt = Number(loaded.updatedAt) || Date.now();
        state.session = {
            ...loaded,
            surfaceState: {
                historyOpen: false,
                referencePresetName: '',
                sessionMode: SESSION_MODE_DEFAULT,
                autoApply: false,
                ...(loaded.surfaceState || {}),
            },
            messages: Array.isArray(loaded.messages)
                ? loaded.messages.map(m => normalizeMessageShape(m, fallbackAt))
                : [],
            pendingEdits: Array.isArray(loaded.pendingEdits) ? loaded.pendingEdits.slice() : [],
        };
        state.session.surfaceState.sessionMode = sanitizeSessionMode(state.session.surfaceState.sessionMode);
        state.session.surfaceState.autoApply = !!state.session.surfaceState.autoApply;
        state.pendingEdits = state.session.pendingEdits.slice();
        // Re-read the preset body so the new session's preview + next-turn
        // oldValue snapshots reflect disk state, not the prior session's
        // staged live (N4 fix).
        await loadLive();
        await reloadReference();
        await sessionStore.setCurrentSessionId(state.session.id);
        await render();
    }

    async function startNewSession() {
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.abortController = null;
        state.session = createNewSession();
        state.pendingEdits = [];
        state.reference = null;
        await loadLive();
        await sessionStore.save(state.session);
        await sessionStore.setCurrentSessionId(state.session.id);
        await render();
    }

    async function clearAllHistory() {
        // eslint-disable-next-line no-alert
        if (!confirm(t('Clear all session history for this preset?'))) return;
        const metas = await sessionStore.list();
        for (const meta of metas) {
            await sessionStore.delete(meta.id);
        }
        await startNewSession();
    }

    // ──────────────────────────────────────────────────────────────────
    // Commit live → preset save. Same shape as the adapter's `commit()`
    // (cpa-iteration-adapter.js L902-L905): a single ctx.presets.save
    // call that the preset manager debounces.
    // ──────────────────────────────────────────────────────────────────
    async function commitLiveToPreset() {
        if (!state.live) return;
        const ref = getTargetRef();
        await getContext().presets.save(ref, state.live, { select: true });
    }

    // ──────────────────────────────────────────────────────────────────
    // Pending-edit cards — Q8: per-op real-diff rendering. CPA has more
    // edit shapes than CEA Character; each branch matches the op shape
    // emitted by `tools.js#normalizeToolCallToEdit`.
    //
    // String-shape edits (`set` on a string field, `str_replace`,
    // `str_insert`) route through the iteration-library's side-by-side
    // LCS diff renderer so the user sees the change in context rather
    // than `<old> → <new>` next to each other. The 120-char threshold
    // matches the original inline form for short values where the
    // compact `→` arrow already reads well.
    // ──────────────────────────────────────────────────────────────────
    const LIB_DIFF_MIN_LEN = 120;
    const STR_REPLACE_PREVIEW_MAX = 2000;

    function truncateValue(v, max = 80) {
        if (v === null || v === undefined) return '';
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        return s.length > max ? s.slice(0, max) + '…' : s;
    }

    function truncateForDiff(text) {
        const s = String(text ?? '');
        return s.length > STR_REPLACE_PREVIEW_MAX
            ? s.slice(0, STR_REPLACE_PREVIEW_MAX) + '\n…(truncated)'
            : s;
    }

    function shouldUseLibraryDiff(oldValue, newValue) {
        if (typeof oldValue !== 'string' || typeof newValue !== 'string') return false;
        return oldValue.length > LIB_DIFF_MIN_LEN || newValue.length > LIB_DIFF_MIN_LEN;
    }

    function renderLibraryDiff(before, after, fileLabel) {
        return ITER_TEXT_DIFF.renderInlineTextDiffHtml(before, after, {
            fileLabel,
            i18n: t,
            forceOpen: true,
        });
    }

    function renderPendingEditCard(edit) {
        const op = String(edit?.op || '');
        const path = String(edit?.path || '');
        if (op === 'set') {
            if (shouldUseLibraryDiff(edit.oldValue, edit.newValue)) {
                return `<div class="cpa_it_pending_card">
                    <span class="op">${escapeHtml(t('set'))}</span>
                    <code>${escapeHtml(path)}</code>
                    ${renderLibraryDiff(String(edit.oldValue ?? ''), String(edit.newValue ?? ''), path)}
                </div>`;
            }
            const oldStr = truncateValue(edit.oldValue);
            const newStr = truncateValue(edit.newValue);
            return `<div class="cpa_it_pending_card">
                <span class="op">${escapeHtml(t('set'))}</span>
                <code>${escapeHtml(path)}</code>:
                <span class="diff_old">${escapeHtml(oldStr)}</span>
                <span class="diff_arrow">→</span>
                <span class="diff_new">${escapeHtml(newStr)}</span>
            </div>`;
        }
        if (op === 'str_replace') {
            const find = String(edit.find ?? '');
            const replaceWith = String(edit.replace ?? '');
            // Surface the change in context: simulate the replace against
            // the live snapshot (lodash.get handles bracket-notation paths
            // like `prompts[0].content`), then library-diff before-vs-after
            // so the surrounding paragraph shows up too.
            const before = path && state.live ? lodash.get(state.live, path) : undefined;
            if (typeof before === 'string') {
                const after = before.replace(find, replaceWith);
                const count = Number(edit?.expected_count);
                const countNote = Number.isInteger(count) && count > 0
                    ? ` <span class="cpa_it_pending_note">(×${count})</span>`
                    : '';
                return `<div class="cpa_it_pending_card">
                    <span class="op">${escapeHtml(t('replace'))}</span>
                    <code>${escapeHtml(path)}</code>${countNote}
                    ${renderLibraryDiff(truncateForDiff(before), truncateForDiff(after), `${path} (str_replace)`)}
                </div>`;
            }
            const count = Number(edit?.expected_count);
            const countNote = Number.isInteger(count) && count > 0
                ? ` <span class="cpa_it_pending_note">(×${count})</span>`
                : '';
            return `<div class="cpa_it_pending_card">
                <span class="op">${escapeHtml(t('replace'))}</span>
                <code>${escapeHtml(path)}</code>${countNote}:
                <span class="diff_old">${escapeHtml(truncateValue(find))}</span>
                <span class="diff_arrow">→</span>
                <span class="diff_new">${escapeHtml(truncateValue(replaceWith))}</span>
            </div>`;
        }
        if (op === 'str_insert') {
            const afterText = String(edit.after_text ?? '');
            const insertText = String(edit.insert_text ?? '');
            // Same simulate-the-replacement approach as str_replace: paste
            // the insert_text immediately after the first occurrence of
            // after_text in the live value. When the field isn't a string
            // we fall through to the legacy inline form.
            const beforeRaw = path && state.live ? lodash.get(state.live, path) : undefined;
            if (typeof beforeRaw === 'string') {
                const at = beforeRaw.indexOf(afterText);
                const after = at >= 0
                    ? beforeRaw.slice(0, at + afterText.length) + insertText + beforeRaw.slice(at + afterText.length)
                    : beforeRaw + insertText;
                return `<div class="cpa_it_pending_card">
                    <span class="op">${escapeHtml(t('insert'))}</span>
                    <code>${escapeHtml(path)}</code>
                    ${renderLibraryDiff(truncateForDiff(beforeRaw), truncateForDiff(after), `${path} (str_insert)`)}
                </div>`;
            }
            return `<div class="cpa_it_pending_card">
                <span class="op">${escapeHtml(t('insert'))}</span>
                <code>${escapeHtml(path)}</code>:
                <div class="cpa_it_pending_row">
                    ${escapeHtml(t('after'))}:
                    <span class="diff_anchor">${escapeHtml(truncateValue(edit.after_text))}</span>
                </div>
                <div class="cpa_it_pending_row">
                    ${escapeHtml(t('insert'))}:
                    <span class="diff_new">${escapeHtml(truncateValue(edit.insert_text))}</span>
                </div>
            </div>`;
        }
        if (op === 'str_delete') {
            return `<div class="cpa_it_pending_card">
                <span class="op">${escapeHtml(t('delete text'))}</span>
                <code>${escapeHtml(path)}</code>:
                <span class="diff_old">${escapeHtml(truncateValue(edit.find))}</span>
            </div>`;
        }
        if (op === 'list_insert') {
            const anchor = edit?.anchor || {};
            const anchorDesc = Object.hasOwn(anchor, 'after')
                ? t('after index ') + String(anchor.after)
                : Object.hasOwn(anchor, 'before')
                    ? t('before index ') + String(anchor.before)
                    : '';
            return `<div class="cpa_it_pending_card">
                <span class="op">${escapeHtml(t('list insert'))}</span>
                <code>${escapeHtml(path)}</code>
                ${escapeHtml(anchorDesc)}:
                <span class="diff_new">${escapeHtml(truncateValue(edit.value))}</span>
            </div>`;
        }
        if (op === 'list_remove') {
            return `<div class="cpa_it_pending_card">
                <span class="op">${escapeHtml(t('list remove'))}</span>
                <code>${escapeHtml(path)}</code>
                ${escapeHtml(t('index ') + String(edit?.index ?? ''))}:
                <span class="diff_old">${escapeHtml(truncateValue(edit.expected_value))}</span>
            </div>`;
        }
        if (op === 'list_move') {
            return `<div class="cpa_it_pending_card">
                <span class="op">${escapeHtml(t('list move'))}</span>
                <code>${escapeHtml(path)}</code>:
                ${escapeHtml(t('from ') + String(edit?.from_index ?? ''))}
                <span class="diff_arrow">→</span>
                ${escapeHtml(t('to ') + String(edit?.to_index ?? ''))}
                <span class="diff_old">${escapeHtml(truncateValue(edit.expected_value))}</span>
            </div>`;
        }
        // Prompt-aware tools translate into coarse `set` edits on
        // prompts / prompt_order in `tools.js#buildPromptAwareEdits`, so
        // they hit the `set` branch above. The branches below cover the
        // direct opcodes in case future refactors emit them.
        if (op === 'upsert_prompt_entry') {
            const content = String(edit.content ?? '');
            if (content.length > LIB_DIFF_MIN_LEN) {
                return `<div class="cpa_it_pending_card">
                    <span class="op">${escapeHtml(t('upsert prompt entry'))}</span>
                    <code>${escapeHtml(String(edit.identifier || ''))}</code>
                    ${renderLibraryDiff('', content, String(edit.identifier || 'content'))}
                </div>`;
            }
            return `<div class="cpa_it_pending_card">
                <span class="op">${escapeHtml(t('upsert prompt entry'))}</span>
                <code>${escapeHtml(String(edit.identifier || ''))}</code>:
                <span class="diff_new">${escapeHtml(truncateValue(edit.content))}</span>
            </div>`;
        }
        if (op === 'remove_prompt_entry') {
            return `<div class="cpa_it_pending_card">
                <span class="op">${escapeHtml(t('remove prompt entry'))}</span>
                <code>${escapeHtml(String(edit.identifier || ''))}</code>
            </div>`;
        }
        if (op === 'upsert_prompt_order_item') {
            return `<div class="cpa_it_pending_card">
                <span class="op">${escapeHtml(t('place in prompt order'))}</span>
                <code>${escapeHtml(String(edit.identifier || ''))}</code>
                @ ${escapeHtml(t('group ') + String(edit.character_id ?? '(default)'))}
                ${edit.enabled === false ? `<span class="cpa_it_pending_note">${escapeHtml(t('(disabled)'))}</span>` : ''}
            </div>`;
        }
        if (op === 'remove_prompt_order_item') {
            return `<div class="cpa_it_pending_card">
                <span class="op">${escapeHtml(t('remove from prompt order'))}</span>
                <code>${escapeHtml(String(edit.identifier || ''))}</code>
                @ ${escapeHtml(t('group ') + String(edit.character_id ?? '(default)'))}
            </div>`;
        }
        // Unknown op fallback — still render the path so users see what
        // the model attempted, even if the engine wouldn't apply it.
        return `<div class="cpa_it_pending_card">
            <span class="op">${escapeHtml(op || t('(unknown op)'))}</span>
            <code>${escapeHtml(path)}</code>
        </div>`;
    }

    // ──────────────────────────────────────────────────────────────────
    // Chat-message rendering. Q2 + Q7:
    //   - assistant messages route through the library's markdown renderer
    //     (`render.renderMessageMarkdown`) which sanitizes via DOMPurify, so
    //     embedding via `innerHTML` is XSS-safe.
    //   - user / assistant / system messages get distinct CSS classes for
    //     visual distinction (alignment, background, etc.).
    //
    // Assistant messages may carry persisted `toolCalls` + `edits` arrays;
    // when present, they render inside a collapsible <details> block so
    // the per-round audit trail stays browseable after Apply. The block
    // also hosts the per-message Rollback button (visible when applied)
    // and the Regenerate button (visible on non-last assistant turns).
    // ──────────────────────────────────────────────────────────────────
    function formatTime(ts) {
        try {
            const d = new Date(Number(ts) || Date.now());
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        } catch { return ''; }
    }

    function renderToolCallChip(tc) {
        const name = String(tc?.name || '');
        const label = TOOL_DISPLAY[name] || name || t('(tool)');
        let argsText;
        try { argsText = JSON.stringify(tc?.args ?? {}, null, 2); } catch { argsText = String(tc?.args ?? ''); }
        return `
            <div class="cpa_it_msg_toolcall">
                <div class="cpa_it_msg_toolcall_name">${escapeHtml(label)}</div>
                <pre class="cpa_it_msg_toolcall_args">${escapeHtml(argsText)}</pre>
            </div>`;
    }

    function renderEditChip(edit) {
        // Reuse the pending-card renderer so the per-message audit trail
        // and the active pending block look visually identical — the user
        // doesn't have to learn two diff visual languages.
        return renderPendingEditCard(edit);
    }

    function renderMessageCard(message, idx, allMessages) {
        if (!message) return '';
        const role = String(message.role || 'user');
        const content = String(message.content || '');
        let bodyHtml;
        if (role === 'assistant') {
            // sanitized by DOMPurify inside renderMessageMarkdown
            bodyHtml = ITER_RENDER.renderMessageMarkdown(content);
        } else {
            bodyHtml = escapeHtml(content).replace(/\n/g, '<br>');
        }
        const roleCls = role === 'user'
            ? 'cpa_it_msg_user'
            : role === 'assistant'
                ? 'cpa_it_msg_assistant'
                : 'cpa_it_msg_system';
        const autoCls = message.auto ? ' cpa_it_msg_auto' : '';

        const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
        const edits = Array.isArray(message.edits) ? message.edits : [];
        const hasTrail = toolCalls.length > 0 || edits.length > 0;
        const applied = Boolean(message.appliedAt) && !message.rolledBackAt;
        const rolledBack = Boolean(message.rolledBackAt);
        const detailsOpen = hasTrail && !applied && !rolledBack;

        let trailHtml = '';
        if (hasTrail) {
            const headerLabel = tf('Tools and edits this round (${0})', String(toolCalls.length + edits.length));
            const statusHtml = rolledBack
                ? `<span class="cpa_it_msg_rolled_back">${escapeHtml(tf('Rolled back at ${0}', formatTime(message.rolledBackAt)))}</span>`
                : (applied
                    ? `
                        <span class="cpa_it_msg_applied">${escapeHtml(tf('✓ Applied to ${0} at ${1}', t('preset'), formatTime(message.appliedAt)))}</span>
                        <button class="menu_button menu_button_small" data-cpa-it-custom-action="rollback-batch" data-cpa-it-msg-id="${escapeHtml(message.id || '')}">
                            ${escapeHtml(t('Rollback'))}
                        </button>
                    `
                    : '');

            const toolsHtml = toolCalls.map(renderToolCallChip).join('');
            const editsHtml = edits.map(renderEditChip).join('');

            trailHtml = `
                <details class="cpa_it_msg_trail" ${detailsOpen ? 'open' : ''}>
                    <summary>${escapeHtml(headerLabel)}</summary>
                    <div class="cpa_it_msg_trail_body">
                        ${toolsHtml}
                        ${editsHtml}
                    </div>
                    ${statusHtml ? `<div class="cpa_it_msg_trail_status">${statusHtml}</div>` : ''}
                </details>
            `;
        }

        // Regenerate is per-assistant-message, only when it's not the
        // current tail (otherwise just hit Send again to re-run from the
        // same prompt). We also skip auto-continue synthetic assistants;
        // their prompt was synthesized so regen would just truncate to
        // the prior human turn anyway — semantically identical to
        // regenerating that prior turn.
        const isLastAssistant = (() => {
            if (role !== 'assistant') return false;
            for (let j = (allMessages?.length || 0) - 1; j > idx; j--) {
                if (allMessages[j]?.role === 'assistant') return false;
            }
            return true;
        })();
        const showRegenerate = role === 'assistant' && !isLastAssistant && !message.auto;
        const actionsHtml = showRegenerate
            ? `
                <div class="cpa_it_msg_actions">
                    <button class="menu_button menu_button_small" data-cpa-it-custom-action="regenerate" data-cpa-it-msg-id="${escapeHtml(message.id || '')}">
                        ${escapeHtml(t('Regenerate'))}
                    </button>
                </div>`
            : '';

        return `<div class="cpa_it_msg ${roleCls}${autoCls}" data-cpa-it-msg-id="${escapeHtml(message.id || '')}">
            ${bodyHtml}
            ${trailHtml}
            ${actionsHtml}
        </div>`;
    }

    function renderHistoryItem(meta) {
        const id = String(meta?.id || '');
        const title = String(meta?.title || meta?.id || '');
        const active = id === state.session.id ? ' cpa_it_history_item_active' : '';
        return `<div class="cpa_it_history_item${active}" data-cpa-it-action="load-session" data-cpa-it-id="${escapeHtml(id)}">
            <span class="cpa_it_history_title">${escapeHtml(title || t('(untitled)'))}</span>
            <button class="cpa_it_history_delete" data-cpa-it-action="delete-session" data-cpa-it-id="${escapeHtml(id)}" title="${escapeHtml(t('Delete this session'))}">×</button>
        </div>`;
    }

    // ──────────────────────────────────────────────────────────────────
    // Toolbar — reference picker + mode picker.
    //
    // Q10 redesign: ONE reference dropdown drives both the system prompt's
    // `hasReference` flag and the tool catalog. No double-dropdown, no
    // separate "Show diff" button (the LLM's preset_diff_reference tool
    // covers that need when the user asks).
    // ──────────────────────────────────────────────────────────────────
    function renderReferenceOptions() {
        if (!$root) return;
        const $select = $root.find('.cpa_it_reference_select');
        if (!$select.length) return;
        const currentName = getTargetRef()?.name;
        const presets = typeof getReferencePresets === 'function'
            ? (getReferencePresets() || [])
            : [];
        const filtered = presets.filter(p => p && p.name && p.name !== currentName);
        const selected = String(state.session.surfaceState?.referencePresetName || '');
        const options = [
            `<option value="">${escapeHtml(t('(none)'))}</option>`,
            ...filtered.map(p => {
                const name = String(p.name);
                const sel = name === selected ? ' selected' : '';
                return `<option value="${escapeHtml(name)}"${sel}>${escapeHtml(name)}</option>`;
            }),
        ].join('');
        $select.html(options);
    }

    function syncModeSelect() {
        if (!$root) return;
        const $select = $root.find('.cpa_it_mode_select');
        if (!$select.length) return;
        const mode = sanitizeSessionMode(state.session.surfaceState?.sessionMode);
        $select.val(mode);
    }

    // ──────────────────────────────────────────────────────────────────
    // Full re-render. Cheap enough to call after every state mutation
    // (the static popup shell + textarea stay mounted, so user input and
    // focus aren't disturbed by re-rendering messages / pending).
    // ──────────────────────────────────────────────────────────────────
    let $root = null;
    async function render() {
        if (!$root) return;
        // History details: sync open state without firing toggle handler.
        const $history = $root.find('[data-cpa-it-history]');
        if ($history.length) {
            const wantOpen = Boolean(state.session.surfaceState?.historyOpen);
            if ($history.prop('open') !== wantOpen) {
                $history.prop('open', wantOpen);
            }
        }
        const metas = await sessionStore.list();
        const historyHtml = metas.map(renderHistoryItem).join('')
            || `<div class="cpa_it_history_empty">${escapeHtml(t('No saved sessions'))}</div>`;
        $root.find('[data-cpa-it-history-items]').html(historyHtml);

        // Toolbar selects (rebuild reference options each render so newly-
        // saved presets show up without reopening the popup).
        renderReferenceOptions();
        syncModeSelect();

        // Messages — pass index + full array so renderMessageCard can decide
        // whether to render Regenerate (only on non-last assistant turns).
        const allMsgs = state.session.messages || [];
        const messagesHtml = allMsgs.map((m, i) => renderMessageCard(m, i, allMsgs)).join('');
        const $msgs = $root.find('[data-cpa-it-messages]');
        // Loading bubble: append (don't overwrite) so the just-finished
        // user turn stays visible while the LLM call is in flight.
        const loadingHtml = state.isBusy
            ? `<div class="cpa_it_msg cpa_it_msg_assistant cpa_it_msg_loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(t('AI is thinking...'))}</div>`
            : '';
        $msgs.html(messagesHtml + loadingHtml);
        // Auto-scroll to bottom so newly-appended messages are visible.
        try {
            const node = $msgs[0];
            if (node && typeof node.scrollTop === 'number') {
                node.scrollTop = node.scrollHeight;
            }
        } catch { /* DOM not attached (test) */ }

        // Pending edits — single Apply button per spec §3.4 (CPA scope is
        // always "preset" since CPA edits preset bodies; no character /
        // global split). Discard stays available as a per-batch escape
        // hatch for users who don't trust the AI's proposed change.
        const $pending = $root.find('[data-cpa-it-pending]');
        if (state.pendingEdits.length > 0) {
            const cardsHtml = state.pendingEdits.map(renderPendingEditCard).join('');
            const applyLabel = tf('Apply to ${0}', t('preset'));
            $pending.html(`
                <div class="cpa_it_pending_title">${escapeHtml(t('Pending changes'))}</div>
                ${cardsHtml}
                <div class="cpa_it_pending_actions">
                    <button class="menu_button luker-iter-pending-apply" data-cpa-it-action="apply-edits">${escapeHtml(applyLabel)}</button>
                    <button class="menu_button menu_button_small" data-cpa-it-action="discard-edits">${escapeHtml(t('Discard'))}</button>
                </div>
            `).show().attr('hidden', null);
        } else {
            $pending.html('').hide().attr('hidden', '');
        }

        // Send / Stop button label
        const $sendBtn = $root.find('[data-cpa-it-action="send"]');
        $sendBtn.text(state.isBusy ? t('Stop') : t('Send'));

        // Sync auto-apply checkbox state — render() is the single source of
        // truth, so a session switch (different auto-apply pref) updates the
        // checkbox without separate plumbing.
        const $autoApply = $root.find('[data-cpa-it-action="toggle-auto-apply"]');
        if ($autoApply.length) {
            const want = !!state.session.surfaceState?.autoApply;
            if ($autoApply.prop('checked') !== want) {
                $autoApply.prop('checked', want);
            }
        }

        // Live target preview pane (right column on desktop, Preview tab on
        // mobile). Pure render against state.live + pendingEdits — the
        // renderer wraps applyEdits in try/catch so a malformed pending
        // edit shape can't blank the workspace.
        try {
            const $previewPane = $root.find('[data-iter-preview-pane]');
            if ($previewPane.length) {
                const savedPresetNames = typeof getReferencePresets === 'function'
                    ? (getReferencePresets() || []).map(p => p?.name || '').filter(Boolean)
                    : [];
                const activeRef = state.session.surfaceState?.referencePresetName || '';
                const previewHtml = renderCpaPreviewPane(
                    state.live,
                    state.pendingEdits || [],
                    savedPresetNames,
                    activeRef,
                    t,
                );
                $previewPane.html(previewHtml);
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] preview render failed`, err);
            $root.find('[data-iter-preview-pane]').html(
                `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('Preview unavailable'))}</div>`,
            );
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Build the augmented user prompt — same shape as the adapter's
    // `buildUserPrompt` (cpa-iteration-adapter.js L1223-L1256). Injects:
    //   - target preset name
    //   - live preset settings outline
    //   - live preset prompt-layout outline
    //   - reference-preset context (or "none")
    //   - the user's actual text
    // The model sees this as part of the conversation, so it doesn't need
    // to spend tool calls just to see what's already in the live preset.
    // ──────────────────────────────────────────────────────────────────
    function buildAugmentedUserPrompt(userText) {
        const live = state.live || {};
        const referenceName = String(state.session.surfaceState?.referencePresetName || '').trim();
        const referenceSection = referenceName
            ? [
                `Selected reference preset: ${referenceName}`,
                'You can read it via preset_read_reference_fields or preset_diff_reference.',
                'preset_copy_from_reference can pull one field from the reference into the live preset.',
            ].join('\n')
            : 'Selected reference preset: none.';
        return [
            `Target preset: ${getTargetRef()?.name || ''}`,
            '',
            buildPresetSettingsOutlineText(live),
            '',
            buildPresetPromptOutlineText(live),
            '',
            referenceSection,
            '',
            'User request:',
            String(userText || '').trim(),
        ].join('\n');
    }

    // ──────────────────────────────────────────────────────────────────
    // Runner integration. The runner returns tool calls in the shape
    // `{ name, args, raw }`. `tools.js#normalizeToolCallToEdit` expects
    // OpenAI shape (`call.function.name`, `call.function.arguments` as
    // JSON string), so we wrap each call before normalizing. Same bridge
    // pattern as Stage 2 (CEA Character).
    // ──────────────────────────────────────────────────────────────────
    function wrapToolCallForNormalize(call) {
        return {
            function: {
                name: String(call?.name || ''),
                arguments: typeof call?.args === 'string'
                    ? call.args
                    : JSON.stringify(call?.args ?? {}),
            },
        };
    }

    /**
     * Build the conversation history sent to the runner. Replays prior
     * user/assistant turns so the model has context. The last user turn is
     * replaced with the augmented version (live state outline + request)
     * the first time it appears in the array — subsequent turns reuse the
     * raw user text since they're already part of an ongoing conversation
     * the model has been steering.
     */
    function buildTaskMessages(systemPrompt) {
        const messages = [{ role: 'system', content: systemPrompt }];
        const history = (state.session.messages || []).filter(m => {
            const role = String(m?.role || '').toLowerCase();
            return role === 'user' || role === 'assistant';
        });
        // Find the last user message — only that one gets the augmented
        // outline prefix, so the prompt budget isn't bloated on every turn.
        let lastUserIdx = -1;
        for (let i = history.length - 1; i >= 0; i--) {
            if (String(history[i].role).toLowerCase() === 'user') {
                lastUserIdx = i;
                break;
            }
        }
        history.forEach((m, idx) => {
            const role = String(m.role).toLowerCase();
            const content = idx === lastUserIdx && role === 'user'
                ? buildAugmentedUserPrompt(String(m.content || ''))
                : String(m.content || '');
            messages.push({ role, content });
        });
        return messages;
    }

    async function runIterationTurn({ autoContinueFromResult = null } = {}) {
        const ac = new AbortController();
        state.abortController = ac;

        await loadLive();   // re-read so the next batch sees external edits
        await reloadReference();

        const hasReference = Boolean(state.reference);
        const mode = sanitizeSessionMode(state.session.surfaceState?.sessionMode);
        const systemPrompt = buildModelSystemPrompt({ hasReference, mode });
        const tools = buildToolCatalog({ hasReference });

        // For auto-continue rounds, splice a synthetic user message into the
        // visible history so the model has a fresh prompt to react to and the
        // chat doesn't look like the model spoke twice in a row. The prompt
        // is conservative — auto-continue is the AI's request, so we just
        // ask it to proceed; the model's prior tool calls/results stay in
        // the context window.
        if (autoContinueFromResult) {
            const noteLines = [
                'Continue with the next iteration step.',
            ];
            if (autoContinueFromResult?.continueNote) {
                noteLines.push(`Prior note: ${String(autoContinueFromResult.continueNote)}`);
            }
            noteLines.push('Call luker_cpa_finalize_iteration once the request is fully addressed.');
            state.session.messages.push({
                id: makeMessageId(),
                role: 'user',
                content: noteLines.join('\n'),
                at: Date.now(),
                auto: true,
            });
        }

        const taskMessages = buildTaskMessages(systemPrompt);

        const settings = typeof getSettings === 'function' ? (getSettings() || {}) : {};
        const presetOptions = typeof getRequestPresetOptions === 'function'
            ? (getRequestPresetOptions() || {})
            : {};
        const apiPresetName = String(presetOptions.apiPresetName || '').trim();
        const llmPresetName = String(presetOptions.llmPresetName || '').trim();

        const runnerSettings = {
            useStreamingTransport: Boolean(settings.useStreamingTransport),
            toolCallRetryMax: settings.toolCallRetryMax,
            rpmLimit: settings.rpmLimit,
        };

        // Per-round callback bookkeeping. The runner fires onAssistantText
        // once (after validation, before return) and onToolCall once per
        // non-control call in array order. Control tools (continue /
        // finalize) route to onControlCall via the isControlCall predicate,
        // so they never pollute the edit-tool list.
        let firstAssistantText = '';
        const collectedToolCalls = [];
        let wantsAutoContinue = false;
        let sawFinalize = false;
        let finalizeSummary = '';
        let continueNote = '';

        const result = await ITER_RUNNER.requestToolCallsWithRetry(
            getContext(),
            runnerSettings,
            {
                taskMessages,
                runtimeWorldInfo: null,
                apiPresetName,
                llmPresetName,
                tools,
                abortSignal: ac.signal,
                includeAssistantText: true,
                allowNoToolCalls: true,
                isControlCall: isCpaControlCall,
                onAssistantText: (text) => {
                    firstAssistantText = String(text || '');
                },
                onToolCall: (call) => {
                    collectedToolCalls.push(call);
                },
                onControlCall: (call) => {
                    const name = String(call?.name || '');
                    if (name === CONTROL_TOOL_NAMES.continue) {
                        // Finalize is sticky: if the model emits both controls
                        // in one turn (continue, finalize OR finalize, continue)
                        // the iteration ends. Order of call arrival should not
                        // change the outcome.
                        if (!sawFinalize) {
                            wantsAutoContinue = true;
                            continueNote = String(call?.args?.note || '');
                        }
                    } else if (name === CONTROL_TOOL_NAMES.finalize) {
                        sawFinalize = true;
                        wantsAutoContinue = false;
                        finalizeSummary = String(call?.args?.summary || '');
                    }
                },
            },
        );

        // Prefer `collectedToolCalls` — populated by `onToolCall`, which the
        // runner only fires for non-control calls (it routes controls through
        // `onControlCall` instead). When the per-event callbacks didn't land
        // (e.g. an older runner version), fall back to `result.toolCalls`, but
        // filter out control calls explicitly so they never leak into the
        // persisted `assistantMsg.toolCalls`.
        const editToolCalls = collectedToolCalls.length > 0
            ? collectedToolCalls
            : (Array.isArray(result?.toolCalls)
                ? result.toolCalls.filter((c) => !isCpaControlCall(c))
                : []);
        const assistantText = firstAssistantText.trim();

        // Normalize edit-tools → edits. Each editable tool runs through
        // `normalizeToolCallToEdit` which can return one or more engine ops
        // (e.g. upsert_prompt_entry returns paired prompts[] + prompt_order
        // edits). Failures push a system message so the user sees the
        // attempted operation didn't translate cleanly.
        const edits = [];
        for (const call of editToolCalls) {
            const name = String(call?.name || '');
            if (!EDITABLE_TOOL_NAMES.has(name)) continue; // defensive
            try {
                const normalized = await normalizeToolCallToEdit(
                    wrapToolCallForNormalize(call),
                    {
                        live: state.live,
                        session: state.session,
                        getReferencePresetBody,
                    },
                );
                if (Array.isArray(normalized)) {
                    edits.push(...normalized);
                }
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] normalizeToolCallToEdit failed for ${name}`, err);
                state.session.messages.push({
                    id: makeMessageId(),
                    role: 'system',
                    content: tf('Edit error: ${0}', String(err?.message || err)),
                    at: Date.now(),
                });
            }
        }

        // Stage the assistant message with the full per-round audit trail.
        // Falls back to a synthesized summary when the model emitted tool
        // calls without text so the chat doesn't have empty bubbles. The
        // toolCalls + edits + appliedAt fields drive renderMessageCard's
        // collapsible details block, Apply marker, and Rollback button.
        let content = assistantText;
        if (!content && editToolCalls.length > 0) {
            const names = editToolCalls
                .map(c => TOOL_DISPLAY[String(c?.name || '')] || String(c?.name || ''))
                .filter(Boolean)
                .join(', ');
            content = tf('Suggested actions: ${0}', names);
        }
        if (!content && (wantsAutoContinue || finalizeSummary)) {
            content = finalizeSummary || t('Continuing...');
        }
        const assistantMsg = {
            id: makeMessageId(),
            role: 'assistant',
            content: content || '',
            at: Date.now(),
        };
        if (editToolCalls.length > 0) {
            assistantMsg.toolCalls = editToolCalls.map(tc => ({
                id: String(tc?.id || ''),
                name: String(tc?.name || ''),
                args: tc?.args ?? {},
            }));
        }
        if (edits.length > 0) {
            assistantMsg.edits = edits.slice();
        }
        state.session.messages.push(assistantMsg);

        // Replace pendingEdits with this round's batch. We don't append:
        // staging is per-round so the user can Apply or Discard cleanly
        // before the next AI request fires.
        state.pendingEdits = edits;

        // Mobile workspace: if the user was on the Preview tab, bump the
        // chat-tab badge so they know new assistant content arrived without
        // forcing a tab switch.
        bumpChatBadge();

        // Composer-row auto-apply: if enabled AND this turn produced edits,
        // apply immediately. Errors land in the chat as a system note —
        // applyPendingEdits already wraps commitLiveToPreset in try/catch.
        const autoApplyOn = Boolean(state.session.surfaceState?.autoApply);
        if (autoApplyOn && state.pendingEdits.length > 0) {
            try {
                await applyPendingEdits({ skipRender: true });
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] auto-apply failed`, err);
            }
        }

        return {
            wantsAutoContinue,
            executionResult: {
                finalized: Boolean(finalizeSummary) || (!wantsAutoContinue && edits.length === 0),
                finalizeSummary,
                continueRequested: wantsAutoContinue,
                continueNote,
                changed: edits.length > 0,
                hasPending: edits.length > 0,
            },
        };
    }

    // ──────────────────────────────────────────────────────────────────
    // Apply pending edits. `applyEdits(edits, live)` returns
    // `{ newLive, clean, conflicts, alreadyDone }`. Per sub-spec §6 / §9
    // we do NOT surface a conflict UI: just commit `newLive` and silently
    // drop any conflicting / already-done edits.
    //
    // `state.pendingEdits` is cleared only after `commitLiveToPreset`
    // resolves, so a failed save leaves the staged edits in place for the
    // user to retry instead of vanishing into the void. `state.live`
    // snapshot is taken upfront for the same reason on the catch path.
    //
    // On success we toast the user, then mark the most recent unapplied
    // assistant message so renderMessageCard can show the Applied label
    // and a Rollback button.
    // ──────────────────────────────────────────────────────────────────
    async function applyPendingEdits({ skipRender = false } = {}) {
        if (!Array.isArray(state.pendingEdits) || state.pendingEdits.length === 0) return;
        if (!state.live) await loadLive();
        const liveSnapshot = state.live;
        const editsBatch = state.pendingEdits.slice();
        const result = applyEdits(editsBatch, state.live);
        state.live = result?.newLive ?? state.live;
        try {
            await commitLiveToPreset();
        } catch (err) {
            state.live = liveSnapshot;
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] commitLiveToPreset failed`, err);
            try { toastr.error(tf('Apply failed: ${0}', String(err?.message || err))); } catch { /* toastr may be unavailable in tests */ }
            state.session.messages.push({
                id: makeMessageId(),
                role: 'system',
                content: tf('Failed to save preset: ${0}', String(err?.message || err)),
                at: Date.now(),
            });
            await persistSession();
            if (!skipRender) await render();
            return;
        }

        try { toastr.success(tf('Applied to ${0}', t('preset'))); } catch { /* ignore */ }

        // Mark the most recent unapplied assistant message that owns these
        // edits. We scan back from the end because the just-rendered turn
        // is the typical target; rare cases (user clicks Apply on a stale
        // session reopened with persisted pendingEdits) still hit a sane
        // candidate as long as one exists.
        const messages = state.session.messages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role === 'assistant' && Array.isArray(m.edits) && m.edits.length > 0 && !m.appliedAt) {
                m.appliedAt = Date.now();
                m.appliedTarget = 'preset';
                break;
            }
        }

        state.pendingEdits = [];
        await persistSession();
        if (!skipRender) await render();
    }

    async function discardPendingEdits() {
        state.pendingEdits = [];
        await persistSession();
        await render();
    }

    // ──────────────────────────────────────────────────────────────────
    // Per-message actions.
    //
    // regenerateFromMessage(msgId): truncate the chat back to the user
    // turn that prompted this assistant message, drop staged pendingEdits
    // (they belonged to the discarded turn), refill the textarea with the
    // original prompt, and re-fire the send pipeline.
    //
    // rollbackBatch(msgId): inverse-apply each edit in the message's
    // batch against state.live (right-to-left, so dependent ops unwind in
    // creation order), commit the result, mark the message rolledBackAt.
    // Bails on the first edit whose op lacks an inverse — partial rollback
    // would leave the preset in an inconsistent state.
    // ──────────────────────────────────────────────────────────────────
    async function regenerateFromMessage(messageId) {
        if (state.isBusy) return;
        const messages = state.session.messages || [];
        const idx = messages.findIndex(m => m && m.id === messageId);
        if (idx < 0) return;
        // Walk back to the user message that prompted this assistant turn.
        // Skip auto-continue synthetic users (`m.auto === true`) so the
        // resend refills the textarea with the human's original text.
        let userIdx = -1;
        for (let i = idx - 1; i >= 0; i--) {
            const m = messages[i];
            if (m && m.role === 'user' && !m.auto) { userIdx = i; break; }
        }
        if (userIdx < 0) return;
        const userText = String(messages[userIdx].content || '');
        // Truncate before the user message; the resend will push it again.
        state.session.messages = messages.slice(0, userIdx);
        state.pendingEdits = [];
        state.session.pendingEdits = [];
        await persistSession();
        await render();
        const $textarea = $root.find('[data-cpa-it-input]');
        $textarea.val(userText);
        await handleSendMessage();
    }

    async function rollbackBatch(messageId) {
        if (state.isBusy) return;
        const msg = (state.session.messages || []).find(m => m && m.id === messageId);
        if (!msg) return;
        if (!msg.appliedAt || msg.rolledBackAt) return;
        if (!Array.isArray(msg.edits) || msg.edits.length === 0) return;
        // eslint-disable-next-line no-alert
        if (!confirm(t('Roll back this batch? The changes will be reversed in the target.'))) return;

        await loadLive();
        let working = state.live;
        // Build inverses up-front so an unsupported op fails BEFORE we
        // partial-apply anything. Right-to-left inversion handles dependent
        // edits (e.g. set then list_insert) cleanly.
        const inverses = [];
        for (const edit of msg.edits.slice().reverse()) {
            try {
                inverses.push(inverseEdit(edit));
            } catch (err) {
                console.warn(`[${MODULE}] inverseEdit failed`, edit, err);
                try { toastr.error(tf('Cannot rollback edit type: ${0}', String(edit?.op || 'unknown'))); } catch { /* ignore */ }
                return;
            }
        }
        try {
            const result = applyEdits(inverses, working);
            working = result?.newLive ?? working;
        } catch (err) {
            console.warn(`[${MODULE}] applyEdits(inverses) failed`, err);
            try { toastr.error(tf('Apply failed: ${0}', String(err?.message || err))); } catch { /* ignore */ }
            return;
        }
        state.live = working;
        try {
            await commitLiveToPreset();
        } catch (err) {
            console.warn(`[${MODULE}] commitLiveToPreset(rollback) failed`, err);
            try { toastr.error(tf('Apply failed: ${0}', String(err?.message || err))); } catch { /* ignore */ }
            return;
        }
        msg.rolledBackAt = Date.now();
        await persistSession();
        try { toastr.success(t('Rolled back')); } catch { /* ignore */ }
        await render();
    }

    // ──────────────────────────────────────────────────────────────────
    // Send-message handler. Q6: user message is pushed AND rendered
    // BEFORE the await so the user sees their own input before the LLM
    // wait spinner starts. Errors surface as system messages.
    //
    // Multi-round auto-continue: when the AI emits
    // `luker_cpa_continue_iteration`, runIterationTurn returns
    // `wantsAutoContinue: true` and the loop fires another round (after
    // rendering the previous round so the user sees progressive output).
    // The ONLY exits are:
    //   1. The model called `luker_cpa_finalize_iteration` (no continue).
    //   2. The model did neither (e.g. produced edits + stopped).
    //   3. The user clicked Stop (abortController fires; isAbortError
    //      catches the resulting error in the catch block).
    // There is NO hard round cap — runaway loops are the user's problem
    // and a single Stop click ends them.
    // ──────────────────────────────────────────────────────────────────
    async function handleSendMessage() {
        if (state.isBusy) {
            // Stop request: abort the in-flight runner call.
            try { state.abortController?.abort(); } catch { /* ignore */ }
            return;
        }
        const $textarea = $root.find('[data-cpa-it-input]');
        const text = String($textarea.val() || '').trim();
        if (!text) return;
        $textarea.val('');
        state.session.messages.push({
            id: makeMessageId(),
            role: 'user',
            content: text,
            at: Date.now(),
        });
        state.isBusy = true;
        await persistSession();
        await render();   // Q6: user message visible before LLM wait
        try {
            let turn = await runIterationTurn();
            while (turn?.wantsAutoContinue) {
                await persistSession();
                await render();   // progressive: prior round visible before next
                if (state.abortController?.signal?.aborted) break;
                turn = await runIterationTurn({ autoContinueFromResult: turn.executionResult });
            }
        } catch (err) {
            // Stop button → don't push an error bubble; user knows they cancelled.
            if (!isAbortError(err, state.abortController?.signal)) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}]`, err);
                state.session.messages.push({
                    id: makeMessageId(),
                    role: 'system',
                    content: tf('Error: ${0}', String(err?.message || err)),
                    at: Date.now(),
                });
            }
        } finally {
            state.isBusy = false;
            state.abortController = null;
            await persistSession();
            await render();
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Session init. Loads the per-preset "currently open" session if one
    // exists; otherwise creates a fresh one. Reference body is loaded
    // alongside if the saved session had a referencePresetName.
    // ──────────────────────────────────────────────────────────────────
    async function initSession() {
        const currentId = await sessionStore.getCurrentSessionId();
        if (currentId) {
            const loaded = await sessionStore.load(currentId);
            if (loaded) {
                const fallbackAt = Number(loaded.updatedAt) || Date.now();
                state.session = {
                    ...loaded,
                    surfaceState: {
                        historyOpen: false,
                        referencePresetName: '',
                        sessionMode: SESSION_MODE_DEFAULT,
                        autoApply: false,
                        ...(loaded.surfaceState || {}),
                    },
                    messages: Array.isArray(loaded.messages)
                        ? loaded.messages.map(m => normalizeMessageShape(m, fallbackAt))
                        : [],
                    pendingEdits: Array.isArray(loaded.pendingEdits) ? loaded.pendingEdits.slice() : [],
                };
                state.session.surfaceState.sessionMode = sanitizeSessionMode(state.session.surfaceState.sessionMode);
                state.session.surfaceState.autoApply = !!state.session.surfaceState.autoApply;
                state.pendingEdits = state.session.pendingEdits.slice();
                await reloadReference();
                return;
            }
        }
        state.session = createNewSession();
        await sessionStore.save(state.session);
        await sessionStore.setCurrentSessionId(state.session.id);
    }

    // ──────────────────────────────────────────────────────────────────
    // Mount popup + bind events. The popup is DISPLAY-type (no built-in
    // OK / Cancel) and `wider` so the chat surface has breathing room.
    //
    // Event delegation lives on `$root` so re-renders that swap inner HTML
    // don't drop handlers. Handlers consume async work then call `render()`
    // themselves.
    // ──────────────────────────────────────────────────────────────────
    await initSession();
    await loadLive();

    const targetName = String(getTargetRef()?.name || '');
    const popupId = `cpa_it_${targetName.replace(/[^a-zA-Z0-9_]/g, '_')}_${Date.now()}`;
    const modeOptions = SESSION_MODES.map(m => {
        const label = m === 'general'
            ? t('General editing')
            : m === 'orchestrator-optimize'
                ? t('Adapt for orchestrator')
                : m === 'jailbreak-only'
                    ? t('Jailbreak-only')
                    : m;
        const sel = sanitizeSessionMode(state.session.surfaceState?.sessionMode) === m ? ' selected' : '';
        return `<option value="${escapeHtmlLocal(m)}"${sel}>${escapeHtmlLocal(label)}</option>`;
    }).join('');

    const popupHtml = buildPopupHtml({
        popupId,
        title: t('Completion Preset Assistant — AI iteration'),
        historyOpen: Boolean(state.session.surfaceState?.historyOpen),
        historyLabel: t('History'),
        newSessionLabel: t('New session'),
        clearAllLabel: t('Clear all'),
        sendLabel: t('Send'),
        composerPlaceholder: t('Describe what to change in the preset...'),
        referenceLabel: t('Reference preset:'),
        noneLabel: t('(none)'),
        modeLabel: t('Editing mode:'),
        modeOptions,
        autoApply: Boolean(state.session.surfaceState?.autoApply),
        autoApplyLabel: t('Auto-apply edits'),
        chatTabLabel: t('Chat'),
        previewTabLabel: t('Preview'),
        chatBadgeAriaLabel: t('New messages while you were on Preview'),
        resizerAriaLabel: t('Resize columns'),
    });
    const popup = new Popup(popupHtml, POPUP_TYPE.DISPLAY, '', {
        wider: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: false,
    });
    const popupPromise = popup.show();
    $root = jQuery(`#${popupId}`);

    // Wire the iteration-library zoom overlay so diff cards' Expand
    // button + splitter + Esc-key affordances work scoped to this popup.
    const zoomOverlayUnbind = ITER_ZOOM_OVERLAY.attachZoomOverlay($root[0], {
        namespace: `.cpaItDiff_${popupId}`,
        i18n: t,
    });

    // ── Delegated events ──────────────────────────────────────────────
    $root.on('click.cpaIt', '[data-cpa-it-action="send"]', async (e) => {
        e.preventDefault();
        await handleSendMessage();
    });

    // Q5: Plain Enter → newline (textarea default).
    //     Ctrl/Cmd-Enter → send.
    $root.on('keydown.cpaIt', '[data-cpa-it-input]', async (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            await handleSendMessage();
        }
    });

    // Q3: history details collapse state persists per-session.
    $root.on('toggle.cpaIt', '[data-cpa-it-history]', async (e) => {
        const open = Boolean(e.currentTarget?.open);
        state.session.surfaceState = { ...(state.session.surfaceState || {}), historyOpen: open };
        await persistSession();
    });

    // Q10: reference-preset dropdown change — reload reference body,
    // persist, re-render (system prompt + tool catalog rebuild on next
    // turn).
    $root.on('change.cpaIt', '.cpa_it_reference_select', async (e) => {
        const value = String(e.target?.value || '');
        state.session.surfaceState = {
            ...(state.session.surfaceState || {}),
            referencePresetName: value,
        };
        await reloadReference();
        await persistSession();
        await render();
    });

    // Mode select — same wire-up as reference, but cheap (no async load).
    $root.on('change.cpaIt', '.cpa_it_mode_select', async (e) => {
        const value = sanitizeSessionMode(e.target?.value);
        state.session.surfaceState = {
            ...(state.session.surfaceState || {}),
            sessionMode: value,
        };
        await persistSession();
    });

    $root.on('click.cpaIt', '[data-cpa-it-action="apply-edits"]', async (e) => {
        e.preventDefault();
        await applyPendingEdits();
    });
    $root.on('click.cpaIt', '[data-cpa-it-action="discard-edits"]', async (e) => {
        e.preventDefault();
        await discardPendingEdits();
    });
    $root.on('click.cpaIt', '[data-cpa-it-action="new-session"]', async (e) => {
        e.preventDefault();
        await startNewSession();
    });
    // Q9: clear-history lives inside the <details>; same delegation root.
    $root.on('click.cpaIt', '[data-cpa-it-action="clear-history"]', async (e) => {
        e.preventDefault();
        await clearAllHistory();
    });
    $root.on('click.cpaIt', '[data-cpa-it-action="load-session"]', async (e) => {
        // The delete button is a child of the load row — stop the row's
        // click from firing when the user is removing an item.
        const target = e.target;
        if (target && target.matches?.('[data-cpa-it-action="delete-session"]')) return;
        const id = String(e.currentTarget?.dataset?.cpaItId || '');
        if (id && id !== state.session.id) {
            await loadSession(id);
        }
    });
    $root.on('click.cpaIt', '[data-cpa-it-action="delete-session"]', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = String(e.currentTarget?.dataset?.cpaItId || '');
        if (!id) return;
        // Deleting the active session also tears down any in-flight LLM call
        // so the response can't land in the recreated next session.
        if (id === state.session?.id) {
            try { state.abortController?.abort(); } catch { /* ignore */ }
            state.isBusy = false;
            state.abortController = null;
        }
        await sessionStore.delete(id);
        if (state.session.id === id) {
            await startNewSession();
        } else {
            await render();
        }
    });

    // Per-message custom actions (Regenerate / Rollback). Use
    // `data-cpa-it-custom-action` rather than `data-cpa-it-action` so the
    // legacy delegation selectors above can't accidentally fire on these
    // — matches the iter-studio shell gotcha pattern.
    $root.on('click.cpaIt', '[data-cpa-it-custom-action="regenerate"]', async (e) => {
        e.preventDefault();
        const msgId = String(e.currentTarget?.dataset?.cpaItMsgId || '');
        if (!msgId) return;
        await regenerateFromMessage(msgId);
    });
    $root.on('click.cpaIt', '[data-cpa-it-custom-action="rollback-batch"]', async (e) => {
        e.preventDefault();
        const msgId = String(e.currentTarget?.dataset?.cpaItMsgId || '');
        if (!msgId) return;
        await rollbackBatch(msgId);
    });

    // ── Workspace events ──────────────────────────────────────────────
    // Mobile tab switcher — only relevant when the < 900px media query
    // collapses the grid; on desktop both panes are mounted simultaneously
    // and the tab bar is hidden via CSS.
    $root.on('click.cpaIt', '[data-iter-action="switch-tab"]', (e) => {
        const tab = e.currentTarget?.dataset?.iterTab;
        if (!tab) return;
        e.preventDefault();
        setActiveTab(tab);
    });

    // Composer-row auto-apply toggle. Persists per-session via surfaceState.
    // Toggling ON when edits are already pending applies them immediately,
    // matching the orchestrator's existing behavior.
    $root.on('change.cpaIt', '[data-cpa-it-action="toggle-auto-apply"]', async (e) => {
        const checked = Boolean(e.currentTarget?.checked);
        state.session.surfaceState = {
            ...(state.session.surfaceState || {}),
            autoApply: checked,
        };
        await persistSession();
        if (checked && state.pendingEdits.length > 0) {
            try {
                await applyPendingEdits();
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] auto-apply on toggle failed`, err);
            }
        }
    });

    // Preview aside — clicking a saved-preset row switches the reference
    // (same effect as picking from the toolbar dropdown).
    $root.on('click.cpaIt', '[data-cpa-it-preview-action="ref-pick"]', async (e) => {
        const name = String(e.currentTarget?.dataset?.cpaItRefName || '');
        if (!name) return;
        state.session.surfaceState = {
            ...(state.session.surfaceState || {}),
            referencePresetName: name,
        };
        await reloadReference();
        await persistSession();
        await render();
    });

    function setActiveTab(tab) {
        const root = $root?.[0];
        if (!root) return;
        root.dataset.iterActiveTab = tab;
        root.querySelectorAll('[data-iter-action="switch-tab"]').forEach(btn => {
            const isActive = btn.dataset.iterTab === tab;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
        });
        if (tab === 'chat') {
            const badge = root.querySelector('[data-iter-chat-badge]');
            if (badge) {
                badge.hidden = true;
                badge.textContent = '';
            }
        }
    }

    function bumpChatBadge() {
        const root = $root?.[0];
        if (!root || root.dataset?.iterActiveTab !== 'preview') return;
        const badge = root.querySelector('[data-iter-chat-badge]');
        if (!badge) return;
        const next = (Number(badge.textContent) || 0) + 1;
        badge.textContent = String(next);
        badge.hidden = false;
    }

    // Bind the column resizer. Returns a no-op when grid/splitter are
    // missing (e.g. during teardown), so the unbind call below is safe
    // regardless of mount state.
    //
    // Both the bind and the initial render are inside the try block so a
    // throw at either step still hits the finally cleanup (no leaked
    // resizer / pending abortController / unpersisted session).
    let unbindResizer = () => {};
    try {
        unbindResizer = bindIterWorkspaceResizer($root[0]);
        await render();
        // Block until the user dismisses the popup. The single try/finally
        // ensures every teardown step (resizer unbind, zoom-overlay unbind,
        // in-flight abort, final persist) runs even if rendering throws or
        // the popup is force-closed; ordering puts persistSession LAST so
        // the abort flag is cleared before disk write.
        await popupPromise;
    } finally {
        try { unbindResizer(); } catch { /* ignore */ }
        try { zoomOverlayUnbind?.(); } catch { /* ignore */ }
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.abortController = null;
        try { await persistSession(); } catch { /* ignore */ }
    }
}

// Re-export the small surface from peer modules so importers don't need to
// chase three import paths to find the popup, its tools, and its system-
// prompt builders. Used by tests + by main.js's lazy import.
export { SESSION_MODES, SESSION_MODE_DEFAULT } from './system-prompts.js';
export { EDITABLE_TOOL_NAMES, TOOL_DISPLAY } from './tools.js';
