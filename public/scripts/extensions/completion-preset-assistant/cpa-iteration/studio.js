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

const __ctx = Luker.getContext();
const Popup = __ctx.Popup;
const POPUP_TYPE = __ctx.POPUP_TYPE;
const stripOpenAIConnectionFieldsFromPreset = __ctx.openai.stripPresetConnectionFields;
import {
    applyEdits,
    inverseEdit,
    bindIterWorkspaceResizer,
    render as ITER_RENDER,
    runner as ITER_RUNNER,
    zoomOverlay as ITER_ZOOM_OVERLAY,
    ui as ITER_UI,
    proposalBus as ITER_PROPOSAL_BUS,
} from '../../../iteration-library/index.js';
import { createProfileEditHandler } from '../../../iteration-library/proposal-bus/kinds/profile-edit.js';
import { createSkillAuthorHandler } from '../../../iteration-library/proposal-bus/kinds/skill-author.js';
import { createPresetCloneHandler } from '../../../iteration-library/proposal-bus/kinds/preset-clone.js';
import {
    buildToolCatalog,
    normalizeToolCallToEdit,
    runCpaReadTool,
    runCpaSkillTool,
    commitApprovedSkillProposal,
    EDITABLE_TOOL_NAMES,
    CONTROL_TOOL_NAMES,
    isCpaControlCall,
    isCpaReadTool,
    isCpaSkillTool,
} from './tools.js';
import {
    buildModelSystemPrompt,
    buildPresetSettingsOutlineText,
    buildPresetPromptOutlineText,
    sanitizeSessionMode,
    SESSION_MODES,
    SESSION_MODE_DEFAULT,
} from './system-prompts.js';
import { augmentCpaPromptWithSkills } from './skill-prompt.js';
const skillsApi = Luker.getContext().skills;
import { createCpaIterationSessionStore, makeMessageId, normalizeMessageShape } from './session-store.js';
import { CPA_TOOL_DISPLAY } from './tool-display.js';

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
        // Per-card skill authoring proposals from the 7 authoring tools +
        // skill_extract_from_text. Each entry: { id, kind, skillName,
        // scope, path?, before, after, extras?, op:{name,args}, status:
        // 'pending'|'approved'|'rejected', sourceCallId, createdAt }.
        // Reviewed inline on the assistant message that emitted the call;
        // approved entries commit at Apply time through
        // commitApprovedSkillProposal (re-derives against on-disk state so
        // parallel-session drift surfaces as a fresh error). Persisted
        // alongside pendingEdits so closing mid-conversation preserves the
        // staged proposals.
        pendingSkillEdits: [],
        // Per-card preset clone proposals from preset_clone_to_new. Each
        // entry: { id, kind:'clone', sourceName, newName, op:{newName},
        // status, sourceCallId, createdAt }. Approved entries trigger the
        // real `cloneAndSwitchTarget` at Apply time AND migrate the
        // current session from the source preset's bucket into the new
        // preset's bucket so the AI conversation continues uninterrupted
        // under the new target (Bug 2 fix). Multiple approved clones in
        // one batch is rare; commit takes the last approved and reports
        // the earlier ones as superseded.
        pendingCloneEdits: [],
        surfaceState: {
            historyOpen: false,
            referencePresetName: '',
            sessionMode: SESSION_MODE_DEFAULT,
            autoApply: false,
        },
        updatedAt: now,
        createdAt: now,
        summary: '',
        // Skip-persist marker for empty draft sessions. persistSession's
        // guard reads this and short-circuits when the session has no
        // messages + no pending edits — without it, mount-time popup open
        // + close (without sending anything) would write a phantom row to
        // the history list. Cleared in persistSession the first time the
        // session has meaningful content. startNewSession / initSession
        // fallback / loadSession-misses keep the flag explicitly for the
        // same reason. The flag is stripped via `delete` (not set to
        // false) so the persisted JSON stays clean.
        _transient: true,
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
    referenceHelpLabel,
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
            <button type="button" class="cpa_it_help" data-cpa-it-action="help-reference" title="${escapeHtmlLocal(referenceHelpLabel)}" aria-label="${escapeHtmlLocal(referenceHelpLabel)}">
                <i class="fa-solid fa-circle-question"></i>
            </button>
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
            <div class="cpa_it_skl_summary" data-cpa-it-skl-summary></div>
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

    // Optional wiring for the `preset_clone_to_new` tool. When the host plugin
    // supplies a `cloneAndSwitchTarget(newName)` callable, the AI can derive a
    // safe copy before destructive edits. When omitted (e.g. tests, or a host
    // that hasn't implemented the save-as flow yet), the tool returns a
    // structured error to the model so it can fall back to suggesting a
    // manual clone via the preset dropdown.
    const cloneAndSwitchTarget = deps.cloneAndSwitchTarget || null;

    // Optional wiring for the skill tools' scope hint. When the host plugin
    // supplies a `getSkillScopeHint()` callable returning the active
    // presetName, the system prompt's skill block tells the AI to default
    // new skills to that preset scope so they travel with the preset on
    // export. When omitted, the prompt falls back to generic wording and
    // the AI passes scope explicitly per call.
    const getSkillScopeHint = typeof deps.getSkillScopeHint === 'function'
        ? deps.getSkillScopeHint
        : null;

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
    // Inject the shared iteration-library/ui stylesheet so the chip + diff
    // classes (luker_lib_toolcall*, etc.) resolve once renderToolCallChip
    // delegates to the shared component.
    ITER_UI.ensureUiStylesheetInjected();

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
    // Closure-local state. Pending writes (preset profile-edit, skill
    // authoring, preset clone) are owned by the ProposalBus mounted
    // below — no per-bucket arrays on state any more.
    // ──────────────────────────────────────────────────────────────────
    const state = {
        session: createNewSession(),
        live: null,         // current preset body (cloned from getStored)
        reference: null,    // when referencePresetName is set, the loaded reference body
        isBusy: false,
        aborting: false,
        abortController: null,
    };

    // ──────────────────────────────────────────────────────────────────
    // ProposalBus mount. Three kinds:
    //   - 'profile-edit'    — preset sandbox-diff, commits via the
    //                         preset save path (commitLiveToPreset)
    //   - 'skill-author'    — skill authoring writes, re-derives against
    //                         current on-disk state at approve time
    //   - 'preset-clone'    — cloneAndSwitchTarget + migrateCurrentSession
    //                         AcrossClone (afterClone hook)
    // ──────────────────────────────────────────────────────────────────
    const bus = ITER_PROPOSAL_BUS.createProposalBus({
        mode: 'cpa',
        i18n: tf,
        onChange: () => {
            if (state.__suspendBusOnChange) return;
            scheduleBusRender();
        },
    });

    let busRenderScheduled = false;
    function scheduleBusRender() {
        if (busRenderScheduled) return;
        busRenderScheduled = true;
        queueMicrotask(async () => {
            busRenderScheduled = false;
            try { await persistSession(); } catch { /* surface elsewhere */ }
            try { await render(); } catch { /* surface elsewhere */ }
            await drainBusOutcomes();
        });
    }

    bus.registerKind('profile-edit', createProfileEditHandler({
        commitLive: async (newProfile) => {
            state.live = newProfile;
            await commitLiveToPreset();
        },
        readLive: async () => {
            await loadLive();
            return state.live;
        },
        renderDiff: (before, after) => {
            const edit = { op: 'set', path: '', oldValue: before, newValue: after };
            return ITER_UI.diff.renderDiffCard([edit], { i18n: tf, live: state.live });
        },
        label: () => t('Preset change'),
        icon: () => '✏',
        target: () => String(getTargetRef()?.name || ''),
    }));
    bus.registerKind('skill-author', createSkillAuthorHandler({
        commitOp: commitApprovedSkillProposal,
        readFile: async ({ scope, name, path }) => {
            try {
                const raw = await skillsApi.readFile({ scope, name, path });
                if (typeof raw === 'string') return raw;
                if (raw && typeof raw.content === 'string') return raw.content;
                return null;
            } catch (err) {
                if (/404|not found/i.test(String(err?.message || err || ''))) return null;
                throw err;
            }
        },
    }));
    bus.registerKind('preset-clone', createPresetCloneHandler({
        cloneAndSwitchTarget: async (newName) => {
            if (typeof cloneAndSwitchTarget !== 'function') {
                return { ok: false, error: 'cloneAndSwitchTarget unavailable' };
            }
            return cloneAndSwitchTarget(newName);
        },
        readSourceSnapshot: async (op) => {
            const ref = getTargetRef();
            const stored = getContext()?.presets?.getStored?.(ref);
            return {
                sourceName: ref?.name ?? null,
                exists: Boolean(stored?.body),
                requestedNewName: op?.newName ?? null,
            };
        },
        afterClone: async (op, _result) => {
            const newRefRaw = getTargetRef();
            const newRef = newRefRaw ? { collection: newRefRaw.collection, name: newRefRaw.name } : null;
            const oldRef = op?._oldRef || null;
            if (oldRef && newRef && (oldRef.name !== newRef.name || oldRef.collection !== newRef.collection)) {
                await migrateCurrentSessionAcrossClone(oldRef, newRef);
            }
            await loadLive();
        },
    }));
    bus.setMessageResolver((messageId) => {
        const msgs = state.session?.messages || [];
        const m = msgs.find((x) => String(x?.id || '') === String(messageId));
        return m || { id: messageId, toolCalls: [] };
    });

    // Bus drain pump (matches MG/orch shape).
    let drainScheduled = false;
    const __pendingDrainStash = [];
    async function drainBusOutcomes() {
        if (drainScheduled) return;
        const outcomes = bus.drainOutcomes();
        if (!outcomes.length) return;
        if (state.isBusy) {
            __pendingDrainStash.push(...outcomes);
            return;
        }
        const allOutcomes = __pendingDrainStash.length
            ? [...__pendingDrainStash.splice(0), ...outcomes]
            : outcomes;
        const committed = allOutcomes.filter((o) => o.status === 'committed');
        const rejected = allOutcomes.filter((o) => o.status === 'rejected');
        const conflicts = allOutcomes.filter((o) => o.status === 'conflict');
        const rolledBack = allOutcomes.filter((o) => o.status === 'rolledBack');
        if (!committed.length && !rejected.length && !conflicts.length && !rolledBack.length) return;
        const fmt = (o) => `  - ${o.kind}${o.target ? ` (${o.target})` : ''}${o.error ? ` — ${o.error}` : ''}`;
        const total = committed.length + rejected.length + conflicts.length + rolledBack.length;
        const lines = [`[User reviewed ${total} proposal(s):`];
        if (committed.length) { lines.push(`Committed (${committed.length}):`); for (const o of committed) lines.push(fmt(o)); }
        if (rejected.length) { lines.push(`Rejected (${rejected.length}):`); for (const o of rejected) lines.push(fmt(o)); }
        if (conflicts.length) { lines.push(`Conflict — retry or reject (${conflicts.length}):`); for (const o of conflicts) lines.push(fmt(o)); }
        if (rolledBack.length) { lines.push(`Rolled back (${rolledBack.length}):`); for (const o of rolledBack) lines.push(fmt(o)); }
        lines.push('Continue with the next step if more changes are needed; respond with plain text and no tool calls when done.]');
        drainScheduled = true;
        try {
            state.session.messages.push({
                id: makeMessageId(),
                role: 'user',
                content: lines.join('\n'),
                at: Date.now(),
                auto: true,
            });
            state.isBusy = true;
            state.abortController = new AbortController();
            await persistSession();
            await render();
            try {
                let turn = await runIterationTurn();
                while (turn?.hadAnyToolCall && !bus.hasOutstanding()) {
                    await persistSession();
                    await render();
                    if (state.abortController?.signal?.aborted) break;
                    turn = await runIterationTurn({ autoContinueFromResult: turn.executionResult });
                }
            } catch (err) {
                if (!isAbortError(err, state.abortController?.signal)) {
                    // eslint-disable-next-line no-console
                    console.warn(`[${MODULE}] drainBusOutcomes`, err);
                    state.session.messages.push({
                        id: makeMessageId(),
                        role: 'system',
                        content: tf('Error: ${0}', String(err?.message || err)),
                        at: Date.now(),
                    });
                }
            } finally {
                state.isBusy = false;
                state.aborting = false;
                state.abortController = null;
                await persistSession();
                await render();
            }
        } finally {
            drainScheduled = false;
        }
    }

    /**
     * Predicate the iteration loop checks each round: pause as soon as
     * ANY user-reviewable proposal is staged (preset edits OR skill
     * authoring proposals OR preset clone proposals). Delegates to
     * bus.hasOutstanding for the new single-source-of-truth check.
     */
    function hasAnyPendingDecision() {
        return bus.hasOutstanding();
    }

    // ──────────────────────────────────────────────────────────────────
    // Live state — read from presets.getStored on each turn so external
    // edits (user manually saves another preset, or a parallel CPA action
    // mutates this one) show up in the next LLM round-trip's `oldValue`
    // capture.
    // ──────────────────────────────────────────────────────────────────
    async function loadLive() {
        const ref = getTargetRef();
        const stored = getContext()?.presets?.getStored?.(ref);
        state.live = stored?.body ? stripOpenAIConnectionFieldsFromPreset(stored.body) : null;
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
            const refBody = await getReferencePresetBody(name);
            state.reference = refBody ? stripOpenAIConnectionFieldsFromPreset(refBody) : null;
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
        const hasMessages = Array.isArray(state.session.messages) && state.session.messages.length > 0;
        const hasPending = bus.hasOutstanding();
        if (state.session._transient && !hasMessages && !hasPending) {
            return;
        }
        if (state.session._transient) {
            delete state.session._transient;
        }
        state.session.updatedAt = Date.now();
        // Bus owns the staging queue; serialize() returns a v2 blob
        // (entries + outcomeQueue). Drop legacy per-bucket fields if
        // any sneak in from an older session payload.
        state.session.proposalBus = bus.serialize();
        if (state.session.pendingEdits !== undefined) delete state.session.pendingEdits;
        if (state.session.pendingSkillEdits !== undefined) delete state.session.pendingSkillEdits;
        if (state.session.pendingCloneEdits !== undefined) delete state.session.pendingCloneEdits;
        if (!state.session.title) {
            const firstUser = state.session.messages.find(m => m.role === 'user');
            if (firstUser) {
                state.session.title = String(firstUser.content || '').slice(0, 50);
            }
        }
        await sessionStore.save(state.session);
        await sessionStore.setCurrentSessionId(state.session.id);
    }

    async function loadSession(id) {
        const loaded = await sessionStore.load(id);
        if (!loaded) return;
        // Abort any in-flight LLM call from the previous session so a slow
        // response doesn't land in the newly-loaded session's history.
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.aborting = false;
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
        };
        state.session.surfaceState.sessionMode = sanitizeSessionMode(state.session.surfaceState.sessionMode);
        state.session.surfaceState.autoApply = !!state.session.surfaceState.autoApply;
        state.__suspendBusOnChange = true;
        try {
            if (loaded.proposalBus && typeof loaded.proposalBus === 'object') {
                bus.hydrate(loaded.proposalBus);
            } else if (Array.isArray(loaded.pendingEdits) && loaded.pendingEdits.length > 0) {
                // One-shot legacy migration: stage each empty-path edit
                // as a profile-edit proposal so the user can still review
                // + approve them. Legacy skill / clone pending arrays
                // were session-local before — drop them.
                for (const edit of loaded.pendingEdits) {
                    if (edit?.op !== 'set' || edit?.path !== '') continue;
                    await bus.propose({
                        kind: 'profile-edit',
                        op: { op: 'set', path: '', newValue: edit.newValue },
                        snapshot: edit.oldValue ?? null,
                        sourceCallId: null,
                    });
                }
            } else {
                bus.hydrate({ version: 2, entries: [], outcomeQueue: [] });
            }
        } finally {
            state.__suspendBusOnChange = false;
        }
        bus.setAutoApprove(Boolean(state.session.surfaceState?.autoApply));
        delete state.session.pendingEdits;
        delete state.session.pendingSkillEdits;
        delete state.session.pendingCloneEdits;
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
        state.aborting = false;
        state.abortController = null;
        state.session = createNewSession();
        state.session._transient = true;
        state.__suspendBusOnChange = true;
        try {
            bus.hydrate({ version: 2, entries: [], outcomeQueue: [] });
        } finally {
            state.__suspendBusOnChange = false;
        }
        bus.setAutoApprove(Boolean(state.session.surfaceState?.autoApply));
        state.reference = null;
        await loadLive();
        // Don't save the blank session yet — persistSession's _transient
        // guard defers the write until the first user message.
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
    // Pending-edit card. Delegates to `iteration-library/ui/diff` so the
    // visual diff language matches the other three iter-library popups
    // (CEA char, MG schema, Orchestrator) and the upcoming unified CEA
    // editor (M2). The shared component handles `set` ops with whole-
    // object → per-changed-leaf splitting (previously hand-rolled in
    // CPA), and falls back to a compact op + path chip for non-`set`
    // ops. Prompt-aware tools normalize to `set` edits inside
    // `tools.js#buildPromptAwareEdits` before reaching this renderer,
    // so the rich library-diff path covers the common case.
    //
    // For string ops (str_replace / str_insert / str_delete) we forward
    // `state.live` as `opts.live` ONLY on the latest unapplied assistant
    // turn — that turn's edits haven't been folded into live yet, so
    // resolving `edit.path` against live gives the true pre-edit value
    // and the renderer can show full-field before/after. Historical
    // turns (already applied or superseded by a later round) skip the
    // live snapshot and fall back to the focused find→replace card,
    // because `state.live` has moved on past their edits.
    // ──────────────────────────────────────────────────────────────────
    function renderPendingEditCard(edit, message) {
        const isLatestUnapplied = !!message
            && String(message?.id || '') === state.__latestUnappliedAssistantId;
        return ITER_UI.diff.renderDiffCard([edit], {
            i18n: tf,
            live: isLatestUnapplied ? state.live : undefined,
        });
    }


    // ──────────────────────────────────────────────────────────────────
    // Skill authoring proposals. Same per-card approve/reject + Apply-time
    // commit pattern the orchestrator iter-studio uses; the actual disk
    // write happens at Apply time via commitApprovedSkillProposal, which
    // re-derives against current on-disk state so a parallel session that
    // edited the same file between proposal and apply surfaces as a fresh
    // error.
    // ──────────────────────────────────────────────────────────────────
    const SKILL_KIND_META = Object.freeze({
        content: { icon: '✏️', label: () => t('Update skill file') },
        frontmatter: { icon: '🏷️', label: () => t('Update skill frontmatter') },
        create: { icon: '✨', label: () => t('Create skill') },
        rename: { icon: '🔤', label: () => t('Rename skill') },
        change_scope: { icon: '📦', label: () => t('Move skill scope') },
        delete: { icon: '🗑️', label: () => t('Delete skill') },
    });

    function scopeDisplay(scope) {
        if (!scope || typeof scope !== 'object') return t('(unknown scope)');
        if (scope.kind === 'global') return t('global');
        if (scope.kind === 'preset' && scope.name) return tf('preset:${0}', String(scope.name));
        if (scope.kind === 'character' && scope.characterFile) {
            return tf('character:${0}', String(scope.characterFile));
        }
        return String(scope.kind || '?');
    }

    function renderSkillStructuralBody(edit) {
        if (edit.kind === 'rename') {
            return `<div class="cpa_it_skl_meta_row">
                <span class="cpa_it_skl_meta_label">${escapeHtmlLocal(t('Name'))}:</span>
                <span class="cpa_it_skl_meta_was">${escapeHtmlLocal(String(edit.before?.name || edit.skillName || ''))}</span>
                <span class="cpa_it_skl_meta_arrow">→</span>
                <span class="cpa_it_skl_meta_now">${escapeHtmlLocal(String(edit.after?.name || ''))}</span>
            </div>`;
        }
        if (edit.kind === 'change_scope') {
            return `<div class="cpa_it_skl_meta_row">
                <span class="cpa_it_skl_meta_label">${escapeHtmlLocal(t('Scope'))}:</span>
                <span class="cpa_it_skl_meta_was">${escapeHtmlLocal(scopeDisplay(edit.before?.scope))}</span>
                <span class="cpa_it_skl_meta_arrow">→</span>
                <span class="cpa_it_skl_meta_now">${escapeHtmlLocal(scopeDisplay(edit.after?.scope))}</span>
            </div>`;
        }
        if (edit.kind === 'delete') {
            return `<div class="cpa_it_skl_meta_row cpa_it_skl_meta_destructive">
                ${escapeHtmlLocal(tf('Skill "${0}" (${1}) will be deleted on Apply. All files removed; this cannot be undone.',
        String(edit.skillName || ''), scopeDisplay(edit.scope)))}
            </div>`;
        }
        return '';
    }

    function renderSkillDiffBody(edit) {
        const path = String(edit.path || 'SKILL.md');
        const diffEdit = {
            op: 'set',
            path,
            oldValue: typeof edit.before === 'string' ? edit.before : '',
            newValue: typeof edit.after === 'string' ? edit.after : '',
        };
        const html = ITER_UI.diff.renderDiffCard([diffEdit], { i18n: tf });
        if (!html) {
            return `<div class="cpa_it_skl_nochange">${escapeHtmlLocal(t('No content change'))}</div>`;
        }
        const extrasList = edit.kind === 'create' && Array.isArray(edit.extras?.extraFiles) && edit.extras.extraFiles.length > 0
            ? `<div class="cpa_it_skl_extras">${escapeHtmlLocal(tf('Plus ${0} additional file(s): ${1}',
                String(edit.extras.extraFiles.length), edit.extras.extraFiles.join(', ')))}</div>`
            : '';
        return `${html}${extrasList}`;
    }

    function renderSkillPendingCard(edit) {
        const status = String(edit?.status || 'pending');
        const kind = String(edit?.kind || '');
        const meta = SKILL_KIND_META[kind] || { icon: '🔧', label: () => kind };
        const statusLabel = status === 'approved'
            ? `<span class="cpa_it_skl_status approved">✓ ${escapeHtmlLocal(t('Approved'))}</span>`
            : status === 'rejected'
                ? `<span class="cpa_it_skl_status rejected">✗ ${escapeHtmlLocal(t('Rejected'))}</span>`
                : `<span class="cpa_it_skl_status pending">${escapeHtmlLocal(t('Pending approval'))}</span>`;
        const body = (kind === 'rename' || kind === 'change_scope' || kind === 'delete')
            ? renderSkillStructuralBody(edit)
            : renderSkillDiffBody(edit);
        const idAttr = escapeHtmlLocal(String(edit?.id || ''));
        const controls = (status === 'approved' || status === 'rejected')
            ? `<button class="menu_button cpa_it_skl_btn" data-cpa-it-action="reset-skill-decision" data-cpa-it-pending-id="${idAttr}">${escapeHtmlLocal(t('Undo decision'))}</button>`
            : `<button class="menu_button cpa_it_skl_btn cpa_it_skl_btn_approve" data-cpa-it-action="approve-skill" data-cpa-it-pending-id="${idAttr}">${escapeHtmlLocal(t('Approve'))}</button>
               <button class="menu_button cpa_it_skl_btn cpa_it_skl_btn_reject" data-cpa-it-action="reject-skill" data-cpa-it-pending-id="${idAttr}">${escapeHtmlLocal(t('Reject'))}</button>`;
        const target = `${escapeHtmlLocal(String(edit?.skillName || ''))} <span class="cpa_it_skl_scope">(${escapeHtmlLocal(scopeDisplay(edit?.scope))})</span>${edit?.path ? ` <span class="cpa_it_skl_path">${escapeHtmlLocal(String(edit.path))}</span>` : ''}`;
        return `<div class="cpa_it_skl_card cpa_it_skl_card_${escapeHtmlLocal(status)}" data-cpa-it-pending-id="${idAttr}">
            <div class="cpa_it_skl_header">
                <span class="cpa_it_skl_icon">${meta.icon}</span>
                <span class="cpa_it_skl_label">${escapeHtmlLocal(meta.label())}</span>
                <span class="cpa_it_skl_target">${target}</span>
                ${statusLabel}
            </div>
            <div class="cpa_it_skl_body">${body}</div>
            <div class="cpa_it_skl_controls">${controls}</div>
        </div>`;
    }

    function renderSkillPendingForMessage(message) {
        if (!message || message.role !== 'assistant') return '';
        const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
        if (toolCalls.length === 0) return '';
        const callIds = new Set(toolCalls.map(tc => String(tc?.id || '')).filter(Boolean));
        const pending = Array.isArray(state.pendingSkillEdits) ? state.pendingSkillEdits : [];
        const matched = pending.filter(p => callIds.has(String(p?.sourceCallId || '')));
        if (matched.length === 0) return '';
        return `<div class="cpa_it_skl_list">${matched.map(renderSkillPendingCard).join('')}</div>`;
    }

    // ──────────────────────────────────────────────────────────────────
    // Chat-message rendering. CPA delegates to
    // `iteration-library/ui/message.renderMessageCard` (M1.4) so the
    // four iter-library popups (CPA, MG schema, Orch, CEA char) share
    // one visual language for tool-call chips, per-round edit cards,
    // applied/rolled-back stamps, and the Regenerate / Rollback row.
    //
    // CPA preserves only the outer `<div class="cpa_it_msg ...">`
    // wrapper around the shared component, because studio.css's
    // flex-row alignment / accent colors / max-widths key on
    // `.cpa_it_msg_user` / `_assistant` / `_system`. The inner
    // `<div class="luker_lib_message ...">` emitted by the shared
    // component carries the rest of the structure (markdown body,
    // read-only-round hint when all calls are read-type, tool chips,
    // edit cards via renderPendingEditCard, applied/rolled-back stamp,
    // Regenerate button). Click delegation accepts msgId from either
    // `data-cpa-it-msg-id` (outer) or `data-luker-lib-msg-id` (inner).
    // ──────────────────────────────────────────────────────────────────
    function renderMessageCard(message, idx, allMessages) {
        if (!message) return '';
        const role = String(message.role || 'user');
        const roleCls = role === 'user'
            ? 'cpa_it_msg_user'
            : role === 'assistant'
                ? 'cpa_it_msg_assistant'
                : 'cpa_it_msg_system';
        const autoCls = message.auto ? ' cpa_it_msg_auto' : '';

        // Last-assistant predicate: true only when this assistant turn has
        // no later assistant in the visible message list. Trailing user /
        // system / auto-continue turns are skipped so the actual final
        // assistant reply (the one whose prompt is the live tail) hides
        // its Regenerate button — re-sending from the same composer text
        // is semantically equivalent.
        let isLast = false;
        if (role === 'assistant' && !message.auto) {
            isLast = true;
            for (let j = (allMessages?.length || 0) - 1; j > idx; j--) {
                if (allMessages[j]?.role === 'assistant' && !allMessages[j]?.auto) { isLast = false; break; }
            }
        }

        const innerHtml = ITER_UI.message.renderMessageCard(message, {
            toolDisplay: CPA_TOOL_DISPLAY,
            renderEditCard: renderPendingEditCard,
            renderApplyControls: (m) => {
                // Bus owns per-card chrome + turn-actions. Legacy Apply
                // button + per-bucket renderers retired.
                const cards = bus.renderCardsForMessage(m) || '';
                const turn = bus.renderTurnActions(m) || '';
                if (!cards && !turn) return '';
                return cards + turn;
            },
            isLast,
            i18n: tf,
            renderMarkdown: ITER_RENDER.renderMessageMarkdown,
            actionAttribute: 'data-cpa-it-action',
        });

        if (!innerHtml) return '';

        // Preserve CPA's outer flex-row container so the popup's
        // alignment / accent-color / max-width rules in studio.css still
        // apply.
        return `<div class="cpa_it_msg ${roleCls}${autoCls}" data-cpa-it-msg-id="${escapeHtml(message.id || '')}">${innerHtml}</div>`;
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
        // Pre-compute the most recent unapplied assistant message id so
        // Apply / Reject buttons only attach to that one turn — earlier
        // unapplied turns were superseded by a later round and the Apply
        // click handler operates on state.pendingEdits (which mirrors the
        // latest batch).
        // Filter auto-generated continuation prompts out of the rendered
        // chat — they stay in state.session.messages for buildTaskMessages
        // but shouldn't appear as user-visible chat noise.
        const allMsgs = (state.session.messages || []).filter(m => !(m?.role === 'user' && m?.auto));
        // `state.pendingEdits` is the source of truth for "this round is
        // staged and awaiting review". When it's empty (Discard cleared
        // it, or Apply landed with zero clean edits), no message should
        // carry an Apply/Reject row — even though `m.edits` is still
        // retained on the assistant message for diff history / rollback.
        // Short-circuit before scanning so the inline controls disappear
        // the moment the batch is resolved.
        // Latest-unapplied = the most recent assistant turn that still
        // owns at least one pending or conflict ProposalBus entry.
        let latestUnappliedAssistantId = '';
        if (bus.hasOutstanding()) {
            const callIdsToTurn = new Map();
            for (const m of allMsgs) {
                if (m?.role !== 'assistant' || m?.auto) continue;
                if (m.appliedAt || m.rolledBackAt) continue;
                const calls = Array.isArray(m?.toolCalls) ? m.toolCalls : [];
                for (const tc of calls) {
                    const id = String(tc?.id || '');
                    if (id) callIdsToTurn.set(id, String(m.id || ''));
                }
            }
            const busEntries = bus._testOnly_entries();
            for (let i = busEntries.length - 1; i >= 0; i--) {
                const e = busEntries[i];
                if (e.status !== 'pending' && e.status !== 'conflict') continue;
                const owningTurn = callIdsToTurn.get(String(e.sourceCallId || ''));
                if (owningTurn) {
                    latestUnappliedAssistantId = owningTurn;
                    break;
                }
            }
        }
        state.__latestUnappliedAssistantId = latestUnappliedAssistantId;
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

        // Pending edits — delegates the apply/discard row to the shared
        // `iteration-library/ui/apply` component so it stays visually in
        // sync with the other iter-library popups (M1.7). The shared
        // component emits `${actionAttribute}="apply-batch"` and
        // `discard-batch` buttons; CPA's click delegation matches those
        // Pending edits + Apply / Reject affordances now render inline on
        // the assistant message that produced them — see renderMessageCard
        // above (renderApplyControls hook). The legacy bottom region is
        // gone; pending edits live next to the diff cards that introduced
        // them, so the user never has to scroll past the message body to
        // approve them.

        // Send / Stop button label
        const $sendBtn = $root.find('[data-cpa-it-action="send"]');
        $sendBtn.text(state.isBusy ? t('Stop') : t('Send'));
        // Disable Stop while the abort is in-flight so a second click
        // can't queue up before the catch+finally clears state.
        $sendBtn.prop('disabled', Boolean(state.aborting));

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
                const pendingEditsForPreview = [];
                for (const entry of bus._testOnly_entries()) {
                    if (entry.status !== 'pending' && entry.status !== 'conflict') continue;
                    if (entry.kind !== 'profile-edit') continue;
                    const newValue = entry?.op?.newValue;
                    if (typeof newValue === 'undefined') continue;
                    pendingEditsForPreview.push({ op: 'set', path: '', oldValue: entry.snapshot, newValue });
                }
                const previewHtml = renderCpaPreviewPane(
                    state.live,
                    pendingEditsForPreview,
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

        // Skill summary row — same pattern the orchestrator uses. Shows
        // pending counts and exposes a "Commit skill" button when there
        // are approved entries but no preset edits waiting (the regular
        // Apply button covers the common case where both are in flight
        // together).
        try {
            const $summary = $root.find('[data-cpa-it-skl-summary]');
            if ($summary.length) {
                const allPending = Array.isArray(state.pendingSkillEdits) ? state.pendingSkillEdits : [];
                const pendCount = allPending.filter(p => p?.status === 'pending').length;
                const apprCount = allPending.filter(p => p?.status === 'approved').length;
                const rejCount = allPending.filter(p => p?.status === 'rejected').length;
                const presetPending = Array.isArray(state.pendingEdits) && state.pendingEdits.length > 0;
                if (allPending.length === 0) {
                    $summary.empty();
                } else {
                    const parts = [];
                    if (pendCount > 0) parts.push(tf('${0} pending', String(pendCount)));
                    if (apprCount > 0) parts.push(tf('${0} approved', String(apprCount)));
                    if (rejCount > 0) parts.push(tf('${0} rejected', String(rejCount)));
                    const summaryLabel = `${t('Skill proposals')}: ${parts.join(', ')}`;
                    const decisionCount = apprCount + rejCount;
                    const showBtn = decisionCount > 0 && !presetPending;
                    let btnHtml = '';
                    if (showBtn) {
                        const btnLabel = apprCount > 0
                            ? tf('Commit ${0} skill decision(s)', String(decisionCount))
                            : tf('Clear ${0} rejected', String(rejCount));
                        btnHtml = `<button class="menu_button cpa_it_skl_commit_btn" data-cpa-it-action="commit-skill-only">${escapeHtmlLocal(btnLabel)}</button>`;
                    }
                    $summary.html(`<span class="cpa_it_skl_summary_text">${escapeHtmlLocal(summaryLabel)}</span>${btnHtml}`);
                }
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] skill summary render failed`, err);
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
    function serializeToolResultContent(result) {
        if (typeof result === 'string') return result;
        if (result === null || result === undefined) return '';
        // When the executor supplies a `toolResultText` string (e.g. the
        // preset_simulate review's tagged-text envelope), pass it through
        // verbatim so the workbench LLM sees the human-readable
        // `<simulation_result>` / `<annotations>` markup instead of a
        // JSON-stringified blob with escaped angle brackets. Falls back
        // to the original JSON serialization for every other read-tool
        // result.
        if (typeof result === 'object'
            && typeof result.toolResultText === 'string'
            && result.toolResultText) {
            return result.toolResultText;
        }
        try { return JSON.stringify(result, null, 2); } catch { return String(result); }
    }

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
            // OpenAI-protocol replay: if this assistant turn ran read tools,
            // surface them as `tool_calls` on the assistant message + one
            // `role: 'tool'` reply per tool_call_id. Without this, a model
            // that read in round N has no record of WHAT it read by round
            // N+1 and re-emits the same read call (or worse, hallucinates).
            const toolCalls = Array.isArray(m?.toolCalls) ? m.toolCalls : [];
            const toolResults = Array.isArray(m?.toolResults) ? m.toolResults : [];
            const readCallIds = new Set(toolResults.map(r => String(r?.tool_call_id || '')));
            const readToolCalls = toolCalls.filter(c => readCallIds.has(String(c?.id || '')));
            if (role === 'assistant' && readToolCalls.length > 0) {
                messages.push({
                    role: 'assistant',
                    content,
                    tool_calls: readToolCalls.map(c => ({
                        id: String(c.id || ''),
                        type: 'function',
                        function: {
                            name: String(c.name || ''),
                            arguments: JSON.stringify(c.args || {}),
                        },
                    })),
                });
                for (const r of toolResults) {
                    if (!readCallIds.has(String(r?.tool_call_id || ''))) continue;
                    messages.push({
                        role: 'tool',
                        tool_call_id: String(r.tool_call_id || ''),
                        content: serializeToolResultContent(r?.content),
                    });
                }
            } else {
                messages.push({ role, content });
            }
        });
        return messages;
    }

    async function runIterationTurn({ autoContinueFromResult = null } = {}) {
        // Reuse the caller-owned AbortController when present so a Stop
        // click during handleSendMessage / continueAfterReviewDecision's
        // pre-await (persistSession + render) is honored. Fall back to a
        // fresh one for callers that don't pre-seed.
        const ac = state.abortController || new AbortController();
        state.abortController = ac;

        await loadLive();   // re-read so the next batch sees external edits
        await reloadReference();

        const hasReference = Boolean(state.reference);
        const mode = sanitizeSessionMode(state.session.surfaceState?.sessionMode);
        const settings = typeof getSettings === 'function' ? (getSettings() || {}) : {};
        const base = settings.iterBaseSystemPrompt;
        const modeBlock = mode === 'orchestrator-optimize'
            ? settings.iterModePromptOrchestratorOptimize
            : mode === 'jailbreak-only'
                ? settings.iterModePromptJailbreakOnly
                : '';
        const baseSystemPrompt = modeBlock ? `${base}\n${modeBlock}` : base;
        // Skill discipline + catalog augmentation. Only kicks in when mode
        // is 'orchestrator-optimize' — the other modes don't expose skills
        // in their guidance. Failing closed (no augmentation) is fine: the
        // tools are still in the catalog, the AI just lacks the discipline
        // block telling it when to prefer them.
        const skillScopeHint = getSkillScopeHint ? (() => {
            try { return getSkillScopeHint() || {}; } catch { return {}; }
        })() : {};
        const systemPrompt = await augmentCpaPromptWithSkills(
            baseSystemPrompt,
            mode,
            skillScopeHint,
            {
                listSkillsInScope: async () => {
                    try {
                        const all = await skillsApi.list({ scope: 'all' });
                        return Array.isArray(all) ? all : [];
                    } catch {
                        return [];
                    }
                },
            },
        );
        const tools = buildToolCatalog({ hasReference });

        // For auto-continue rounds, splice a synthetic user message into the
        // visible history so the model has a fresh prompt to react to and the
        // chat doesn't look like the model spoke twice in a row. Auto-continue
        // fires whenever the prior round emitted any tool call — the runner
        // already preserves prior tool_calls/tool_results in context, so this
        // synthetic prompt just nudges the model to proceed or stop.
        if (autoContinueFromResult) {
            state.session.messages.push({
                id: makeMessageId(),
                role: 'user',
                content: 'Continue with the next iteration step. Respond with plain text and no tool calls when the request is fully addressed.',
                at: Date.now(),
                auto: true,
            });
        }

        const taskMessages = buildTaskMessages(systemPrompt);

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
        // non-control call in array order. CPA currently has no control
        // tools — `isCpaControlCall` returns false for all names, so every
        // call lands in `collectedToolCalls`. The outer loop continues
        // whenever ANY tool call landed.
        let firstAssistantText = '';
        const collectedToolCalls = [];
        let hadAnyToolCall = false;

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
                    hadAnyToolCall = true;
                },
                onControlCall: () => {
                    // No control tools today; the runner still calls this
                    // hook when isCpaControlCall returns true (it never does
                    // now). Mark `hadAnyToolCall` defensively so any future
                    // control tool participates in the continue signal.
                    hadAnyToolCall = true;
                },
            },
        );

        // Prefer `collectedToolCalls` — populated by `onToolCall`, which the
        // runner only fires for non-control calls (it routes controls through
        // `onControlCall` instead). When the per-event callbacks didn't land
        // (e.g. an older runner version), fall back to `result.toolCalls`, but
        // filter out control calls explicitly so they never leak into the
        // persisted `assistantMsg.toolCalls`.
        const nonControlCalls = collectedToolCalls.length > 0
            ? collectedToolCalls
            : (Array.isArray(result?.toolCalls)
                ? result.toolCalls.filter((c) => !isCpaControlCall(c))
                : []);
        // Split: read tools run inline (synchronously) so their results land
        // in the next round's taskMessages; skill tools also run inline
        // (they hit the skills HTTP API and have no profile mutation); edit
        // tools normalize into pending edits the user reviews + applies later.
        const readCalls = nonControlCalls.filter(c => isCpaReadTool(String(c?.name || '')));
        const skillCalls = nonControlCalls.filter(c => isCpaSkillTool(String(c?.name || '')));
        const editToolCalls = nonControlCalls.filter(c =>
            !isCpaReadTool(String(c?.name || ''))
            && !isCpaSkillTool(String(c?.name || '')));
        const assistantText = firstAssistantText.trim();

        // Execute read tools synchronously. Each result is bound to the
        // call's tool_call_id so the next round's `role: 'tool'` reply
        // matches the assistant's `tool_calls` entry. Failures persist as
        // `{ error }` with status='fail' so the shared chip renders the
        // ❌ status icon and the model sees the error in the next round.
        const persistedToolResults = [];
        const readsForTaskHistory = [];
        const ctxForReads = {
            live: state.live,
            reference: state.reference || null,
            referenceName: String(state.session?.surfaceState?.referencePresetName || ''),
            presetName: String(getTargetRef?.()?.name || ''),
            context: getContext(),
            // Side-effecting clone hook for the `preset_clone_to_new` read
            // tool. Now used only as a presence marker — the dispatcher
            // checks `typeof ctx.cloneAndSwitchTarget === 'function'` to
            // decide whether to propose a clone, but the actual clone is
            // deferred to commitApprovedCloneEditsForCpa at Apply time.
            // We hand over the raw deps.cloneAndSwitchTarget; the
            // re-priming wrap (loadLive + reloadReference + render) lives
            // on the commit path so it fires AFTER the user has approved
            // and the session has been migrated to the new bucket.
            cloneAndSwitchTarget: cloneAndSwitchTarget || null,
            // Optional pre-check that lets the dispatcher reject a clone
            // with a duplicate name BEFORE showing the user a card for a
            // commit that would fail anyway. Resolved synchronously from
            // the host's current preset list.
            checkPresetNameAvailable: typeof deps.checkPresetNameAvailable === 'function'
                ? deps.checkPresetNameAvailable
                : null,
        };
        for (const call of readCalls) {
            const callId = String(call?.id || `read_${persistedToolResults.length}_${Date.now().toString(36)}`);
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            let resultPayload;
            let statusLabel = 'ok';
            try {
                const out = await runCpaReadTool({ id: callId, name: call?.name, args }, ctxForReads);
                if (out?.ok) {
                    resultPayload = out.result;
                    // Lift tagged-text envelopes (e.g. preset_simulate's review
                    // popup) up onto the result payload so the serializer can
                    // emit them verbatim instead of JSON-stringifying. The
                    // legacy `result.*` blob is preserved for any caller still
                    // inspecting structured fields.
                    if (typeof out.toolResultText === 'string' && out.toolResultText) {
                        const base = (resultPayload && typeof resultPayload === 'object' && !Array.isArray(resultPayload))
                            ? resultPayload
                            : { value: resultPayload };
                        resultPayload = { ...base, toolResultText: out.toolResultText };
                    }
                    // Park clone proposals on state.pendingCloneEdits so the
                    // user can review them per-card and the iteration loop
                    // pauses until they Apply / Discard. The actual clone +
                    // session migration runs at Apply time in
                    // commitApprovedCloneEditsForCpa (Bug 1 + Bug 2 fix).
                    // result.proposed / pending_id already explain to the AI
                    // that the new preset doesn't exist yet — same contract
                    // skill authoring uses.
                    if (out.pendingCloneEdit) {
                        const oldRefRaw = getTargetRef();
                        const oldRef = oldRefRaw ? { collection: oldRefRaw.collection, name: oldRefRaw.name } : null;
                        const { id: pendingId } = await bus.propose({
                            kind: 'preset-clone',
                            op: {
                                sourceName: out.pendingCloneEdit.sourceName,
                                newName: out.pendingCloneEdit.newName,
                                _oldRef: oldRef,
                            },
                            snapshot: { sourceName: oldRef?.name ?? null, requestedNewName: out.pendingCloneEdit.newName },
                            sourceCallId: callId,
                            meta: out.pendingCloneEdit,
                        });
                        // Annotate the AI's tool result with the pending_id
                        // so a future tool call could reference it.
                        const base = (resultPayload && typeof resultPayload === 'object' && !Array.isArray(resultPayload))
                            ? resultPayload
                            : { value: resultPayload };
                        resultPayload = { ...base, pending_id: pendingId };
                    }
                } else {
                    // Failures may also carry a tagged-text envelope (e.g. the
                    // simulator caught an LLM error and built a structured
                    // <simulation_result ok="false"> block). Surface it so the
                    // workbench LLM sees the structured error, not a raw
                    // `{ error: "..." }` JSON blob.
                    if (typeof out?.toolResultText === 'string' && out.toolResultText) {
                        resultPayload = { error: String(out?.error || 'simulation failed'), toolResultText: out.toolResultText };
                    } else {
                        resultPayload = { error: String(out?.error || 'unknown error') };
                    }
                    statusLabel = 'fail';
                }
            } catch (err) {
                resultPayload = { error: String(err?.message || err || 'unknown error') };
                statusLabel = 'fail';
            }
            persistedToolResults.push({
                tool_call_id: callId,
                content: resultPayload,
                status: statusLabel,
            });
            readsForTaskHistory.push({ id: callId, name: String(call?.name || ''), args, result: resultPayload });
            // Back-fill call.id so the persisted assistant message references
            // the same id the tool result is keyed under.
            call.id = callId;
        }

        // Execute skill tools inline. Each call hits the skills HTTP API
        // through `runCpaSkillTool`; results are bound to the call's
        // tool_call_id so the next round's `role: 'tool'` reply matches the
        // assistant's `tool_calls` entry.
        //
        // Inventory + verbatim-extract tools resolve to `{ ok, result }` and
        // their result threads back to the LLM unchanged.
        //
        // The 7 authoring tools (+ skill_extract_from_text) resolve to
        // `{ ok, result, pendingSkillEdit }` — we park the pendingSkillEdit
        // on `state.pendingSkillEdits` for per-card user review, and tell
        // the LLM the call was proposed (not yet on disk). Apply-time
        // commit re-derives against current on-disk state through
        // `commitApprovedSkillProposal` so parallel-session drift surfaces
        // as a fresh validation error rather than clobbering with stale
        // before/after snapshots.
        for (const call of skillCalls) {
            const callId = String(call?.id || `skill_${persistedToolResults.length}_${Date.now().toString(36)}`);
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            let resultPayload;
            let statusLabel = 'ok';
            try {
                const out = await runCpaSkillTool({ id: callId, name: call?.name, args });
                if (out?.ok) {
                    if (out.pendingSkillEdit) {
                        // Stage as a ProposalBus skill-author entry. The
                        // handler's readCurrent re-reads the file at
                        // approve time and refuses to commit if it has
                        // drifted; snapshot is the {content} captured by
                        // the tool itself (or null for non-file ops).
                        const snapshot = (out.pendingSkillEdit.before != null
                            && typeof out.pendingSkillEdit.before === 'object'
                            && typeof out.pendingSkillEdit.before.content === 'string')
                            ? { content: out.pendingSkillEdit.before.content }
                            : (typeof out.pendingSkillEdit.before === 'string'
                                ? { content: out.pendingSkillEdit.before }
                                : null);
                        const { id: pendingId } = await bus.propose({
                            kind: 'skill-author',
                            op: out.pendingSkillEdit.op,
                            snapshot,
                            sourceCallId: callId,
                            meta: {
                                skillName: out.pendingSkillEdit.skillName,
                                scope: out.pendingSkillEdit.scope,
                                path: out.pendingSkillEdit.path,
                                before: out.pendingSkillEdit.before,
                                after: out.pendingSkillEdit.after,
                                extras: out.pendingSkillEdit.extras || null,
                            },
                        });
                        // Slim ack to the LLM: keep the dispatcher's own
                        // result fields (proposed:true / kind / skill /
                        // scope / path / tool / message) so the
                        // proposal-mode contract stays intact, and add the
                        // pending_id so a future tool call could reference
                        // it explicitly. The big before/after blobs stay
                        // on the bus's entry meta only — never sent back
                        // through tool_results to avoid bloating prompt
                        // budget round-over-round.
                        const baseResult = (out.result && typeof out.result === 'object' && !Array.isArray(out.result))
                            ? out.result
                            : { value: out.result };
                        resultPayload = {
                            ...baseResult,
                            proposed: true,
                            pending_id: pendingId,
                        };
                    } else {
                        resultPayload = out.result;
                    }
                } else {
                    resultPayload = { error: String(out?.error || 'unknown error') };
                    statusLabel = 'fail';
                }
            } catch (err) {
                resultPayload = { error: String(err?.message || err || 'unknown error') };
                statusLabel = 'fail';
            }
            persistedToolResults.push({
                tool_call_id: callId,
                content: resultPayload,
                status: statusLabel,
            });
            call.id = callId;
        }

        // Normalize edit-tools → edits. Each editable tool runs through
        // `normalizeToolCallToEdit` which can return one or more engine ops
        // (e.g. upsert_prompt_entry returns paired prompts[] + prompt_order
        // edits). Failures and no-op outcomes push a `role: 'tool'`-shaped
        // result onto the assistant message's toolResults so buildTask-
        // Messages re-emits them as tool replies in the next round — that
        // is the ONLY channel the model actually reads. Previous versions
        // pushed a `role: 'system'` chat message on error, which build-
        // TaskMessages filters out, so the model never learned that its
        // tool call failed and would re-emit the same broken call.
        //
        // Chain the `live` baseline across tool calls: each normalize sees
        // the previous call's post-mutation state, not a fresh snapshot.
        // Without this, prompt-aware tools (`preset_upsert_prompt_entry`,
        // `preset_remove_prompt_entry`, `preset_upsert_prompt_order_item`,
        // `preset_remove_prompt_order_item`) emit coarse `path:'prompts'`/
        // `path:'prompt_order'` whole-array sets where the second call's
        // newValue lacks the first call's mutation — apply runs them in
        // order and the second wholesale clobbers the first.
        const edits = [];
        const editToolResults = [];
        let chainedLive = state.live;
        for (const call of editToolCalls) {
            const name = String(call?.name || '');
            if (!EDITABLE_TOOL_NAMES.has(name)) continue; // defensive
            const callId = String(call?.id || `edit_${editToolResults.length}_${Date.now().toString(36)}`);
            // Back-fill call.id so the persisted assistant message and any
            // future replay reference the same id the tool result is keyed
            // under. Mirrors the read-tool branch above.
            call.id = callId;
            try {
                const normalized = await normalizeToolCallToEdit(
                    wrapToolCallForNormalize(call),
                    {
                        live: chainedLive,
                        session: state.session,
                        getReferencePresetBody,
                    },
                );
                if (Array.isArray(normalized) && normalized.length > 0) {
                    edits.push(...normalized);
                    // Advance the baseline by applying just this call's
                    // edits to a clone. The next call's normalize sees the
                    // composed state so its coarse path:'prompts' sandbox
                    // is built on top of, not parallel to, prior work.
                    try {
                        const clone = structuredClone(chainedLive);
                        const result = applyEdits(normalized, clone);
                        chainedLive = result?.newLive ?? clone;
                    } catch (err) {
                        // applyEdits choke shouldn't kill the whole turn;
                        // keep the chain frozen so subsequent calls at
                        // least don't see corrupted state. The edits are
                        // still queued for the user to review/Apply.
                        // eslint-disable-next-line no-console
                        console.warn(`[${MODULE}] chain advance failed after ${name}`, err);
                    }
                    // Don't push a toolResult for queued edits — the
                    // post-review synthetic user message carries the real
                    // outcome (applied vs skipped). Adding a "queued"
                    // reply here would create two pieces of feedback per
                    // tool call and double the prompt budget.
                } else {
                    // No edits emitted. The most common cause for prompt-
                    // aware tools is "sandbox == live" — the desired state
                    // matches what's already on disk. Tell the model so it
                    // doesn't loop re-issuing the same no-op. Most likely
                    // an earlier round already applied this change (e.g.
                    // preset_upsert_prompt_entry with `enabled` now routes
                    // to prompt_order on the AI's behalf, so a follow-up
                    // preset_upsert_prompt_order_item against the same
                    // identifier is redundant). The hint deliberately
                    // avoids prescribing a specific replacement tool —
                    // older copies pointed at preset_upsert_prompt_order_item
                    // which sent the AI into a 4-noop loop.
                    const hint = 'The target state already matches what you requested; an earlier round may have already applied this change. Re-read the live state with preset_read_live_fields before retrying — do not re-issue the same call.';
                    editToolResults.push({
                        tool_call_id: callId,
                        content: { status: 'noop', message: 'No edits produced for this call.', hint },
                        status: 'fail',
                    });
                }
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] normalizeToolCallToEdit failed for ${name}`, err);
                editToolResults.push({
                    tool_call_id: callId,
                    content: { error: String(err?.message || err || 'normalize failed') },
                    status: 'fail',
                });
            }
        }

        // Pure-read rounds (no edits) still count as a tool-call round — the
        // model called read tools whose results are now in taskMessages as
        // `role: 'tool'` entries, so it needs another turn to act on them.
        // `hadAnyToolCall` is already true here because onToolCall fired for
        // each read; this branch only documents the case so future readers
        // understand why no special handling is needed.

        // Stage the assistant message with the full per-round audit trail.
        // The toolCalls + edits + appliedAt fields drive renderMessageCard's
        // collapsible details block, Apply marker, and Rollback button. When
        // the model emitted tool calls without text the chips themselves
        // already display each call's friendly label + args, so we leave
        // `content` empty rather than synthesising a redundant one-liner.
        const content = assistantText;
        const assistantMsg = {
            id: makeMessageId(),
            role: 'assistant',
            content: content || '',
            at: Date.now(),
        };
        const allCallsForMsg = [...readCalls, ...skillCalls, ...editToolCalls];
        if (allCallsForMsg.length > 0) {
            assistantMsg.toolCalls = allCallsForMsg.map(tc => ({
                id: String(tc?.id || ''),
                name: String(tc?.name || ''),
                args: tc?.args ?? {},
            }));
        }
        if (persistedToolResults.length > 0 || editToolResults.length > 0) {
            assistantMsg.toolResults = [...persistedToolResults, ...editToolResults];
        }
        if (edits.length > 0) {
            assistantMsg.edits = edits.slice();
        }
        state.session.messages.push(assistantMsg);

        // Stage this turn's profile sandbox-diff as ONE ProposalBus
        // proposal. The CPA preset sandbox-diff coalesces 1-or-N empty-
        // path-set edits per turn (each call chained off the previous);
        // the user-visible card represents the cumulative replace.
        if (edits.length > 0) {
            const lastEdit = edits[edits.length - 1];
            const firstCallId = (editToolCalls.find((c) => c?.id)?.id) || assistantMsg.id;
            bus.setAutoApprove(Boolean(state.session.surfaceState?.autoApply));
            await bus.propose({
                kind: 'profile-edit',
                op: { op: 'set', path: '', newValue: lastEdit.newValue },
                snapshot: state.live,
                sourceCallId: firstCallId,
            });
        }

        // Mobile workspace: if the user was on the Preview tab, bump the
        // chat-tab badge so they know new assistant content arrived without
        // forcing a tab switch.
        bumpChatBadge();

        return {
            hadAnyToolCall,
            executionResult: {
                finalized: !hadAnyToolCall,
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

    /**
     * Commit approved skill proposals (the 7 authoring tools +
     * skill_extract_from_text) at Apply time. Walks `state.pendingSkillEdits`
     * in order, calling `commitApprovedSkillProposal` per approved entry —
     * that helper replays the original op against current on-disk state
     * through skillsApi so parallel-session drift surfaces as a fresh
     * validation error rather than a clobbering write.
     *
     * Drops rejected entries unconditionally. Approved entries that
     * commit successfully leave the pending list; approved entries that
     * follow a failed one stay so the user can investigate and retry.
     * On per-entry failure pushes a system message + toastr.error and
     * halts the walk.
     *
     * Mirrors orchestrator/iter-studio/studio.js#commitApprovedSkillEdits.
     */

    /**
     * Move the current (non-transient) session from the old preset's
     * bucket into the new preset's bucket so the AI conversation
     * survives a `preset_clone_to_new` Apply uninterrupted. Bug 2 fix:
     * before this hook, the session-store's getTargetRef-based read/
     * write meant post-clone persistSession() wrote into the new
     * bucket while the clone-time snapshot stayed stranded in the old
     * bucket — re-opening either preset showed a partial chat.
     *
     * Skips when the session is still transient (no first message
     * sent, never written to disk) since there's nothing to migrate.
     * Failures don't abort the clone — the clone has already landed
     * on disk; the worst case is the user finding the conversation
     * back in the source preset and re-opening it manually.
     */
    async function migrateCurrentSessionAcrossClone(oldRef, newRef) {
        if (!state.session?.id || state.session?._transient) return;
        let result;
        try {
            result = await sessionStore.moveSessionTo(state.session.id, oldRef, newRef);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] migrateCurrentSessionAcrossClone threw`, err);
            try { toastr.warning(tf('Clone succeeded but session migration failed: ${0}', String(err?.message || err))); } catch { /* ignore */ }
            return;
        }
        if (!result?.ok) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] migrateCurrentSessionAcrossClone reported`, result);
            try { toastr.warning(tf('Clone succeeded but session migration failed: ${0}', String(result?.error || 'unknown'))); } catch { /* ignore */ }
            return;
        }
        if (result.moved) {
            try { toastr.info(tf('Session moved to "${0}"', String(newRef?.name || ''))); } catch { /* ignore */ }
        }
    }

    /**
     * Commit approved clone proposals at Apply time. Walks
     * `state.pendingCloneEdits`; when more than one approved clone
     * exists in a single batch, the LAST approved wins (clones switch
     * the popup target, so chaining them doesn't make sense) and the
     * earlier ones get reported as superseded in the AI verdict.
     *
     * On success: calls the raw `deps.cloneAndSwitchTarget(newName)`
     * (NOT the ctxForReads wrap — that wrap was used in pre-proposal
     * inline-mode and re-primed live / reference / render, which we
     * now do manually here AFTER the session has been migrated). Then
     * runs migrateCurrentSessionAcrossClone before re-priming the
     * popup's live / reference / preview state.
     *
     * Rejected entries are dropped unconditionally so a stale Reject
     * doesn't hang around in the pending list.
     */


    /**
     * Fire the next AI round after the user reviewed a paused batch
     * (clicked Apply or Discard). `handleSendMessage`'s loop exits the
     * moment the round produces pendingEdits, so without this resumer
     * the AI never sees the outcome — even though its prior round was
     * clearly "propose edits, then continue based on review". Pushes a
     * synthetic user message describing the decision and re-enters the
     * loop, mirroring the IDE pattern (approve → tool result lands →
     * agent continues; reject → agent reconsiders).
     */
    /**
     * Build the synthetic user-message text the next round sees after a
     * batch is applied (review-mode click or auto-apply). The model reads
     * this verbatim — keep the per-edit "skipped because X" detail intact
     * so the LLM can correct its next round (fix the anchor, re-read
     * the field, etc) instead of looping the same broken call.
     */


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
        // eslint-disable-next-line no-alert
        if (!confirm(t('Regenerate this turn? Subsequent rounds will be discarded.'))) return;
        const userText = String(messages[userIdx].content || '');
        // Truncate before the user message; the resend will push it again.
        state.session.messages = messages.slice(0, userIdx);
        // Reject bus proposals whose source tool call was just removed.
        const survivingCallIds = new Set();
        for (const m of state.session.messages) {
            if (Array.isArray(m?.toolCalls)) {
                for (const tc of m.toolCalls) if (tc?.id) survivingCallIds.add(String(tc.id));
            }
        }
        state.__suspendBusOnChange = true;
        try {
            for (const entry of bus._testOnly_entries()) {
                const cid = String(entry.sourceCallId || '');
                if (entry.status === 'pending' && cid && !survivingCallIds.has(cid)) {
                    bus.reject(entry.id);
                }
            }
        } finally {
            state.__suspendBusOnChange = false;
        }
        await persistSession();
        await render();
        const $textarea = $root.find('[data-cpa-it-input]');
        $textarea.val(userText);
        await handleSendMessage();
    }


    // ──────────────────────────────────────────────────────────────────
    // Send-message handler. Q6: user message is pushed AND rendered
    // BEFORE the await so the user sees their own input before the LLM
    // wait spinner starts. Errors surface as system messages.
    //
    // Multi-round auto-continue is program-driven by tool-call presence:
    // whenever a round emits any tool call (read OR edit), the loop fires
    // another round (after rendering the previous round so the user sees
    // progressive output). The ONLY exits are:
    //   1. The model responded with plain text and no tool calls.
    //   2. The user clicked Stop (abortController fires; isAbortError
    //      catches the resulting error in the catch block).
    // There is NO hard round cap — runaway loops are the user's problem
    // and a single Stop click ends them.
    // ──────────────────────────────────────────────────────────────────
    async function handleSendMessage() {
        if (state.isBusy) {
            // Stop request: abort the in-flight runner call. Mark
            // `aborting` and re-render immediately so the button visibly
            // reflects the click even when the network takes time to
            // actually drop the request. The original call's finally
            // clears both flags once the abort lands.
            if (!state.aborting) {
                state.aborting = true;
                try { state.abortController?.abort(); } catch { /* ignore */ }
                render().catch(() => { /* ignore — best-effort UI nudge */ });
            }
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
        // Seed the AbortController before the pre-flight awaits so a
        // Stop click during persistSession / render isn't dropped onto
        // a null controller. runIterationTurn reuses this instance.
        state.abortController = new AbortController();
        await persistSession();
        await render();   // Q6: user message visible before LLM wait
        try {
            let turn = await runIterationTurn();
            while (turn?.hadAnyToolCall && !hasAnyPendingDecision()) {
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
            state.aborting = false;
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
                };
                state.session.surfaceState.sessionMode = sanitizeSessionMode(state.session.surfaceState.sessionMode);
                state.session.surfaceState.autoApply = !!state.session.surfaceState.autoApply;
                state.__suspendBusOnChange = true;
                try {
                    if (loaded.proposalBus && typeof loaded.proposalBus === 'object') {
                        bus.hydrate(loaded.proposalBus);
                    } else if (Array.isArray(loaded.pendingEdits) && loaded.pendingEdits.length > 0) {
                        for (const edit of loaded.pendingEdits) {
                            if (edit?.op !== 'set' || edit?.path !== '') continue;
                            await bus.propose({
                                kind: 'profile-edit',
                                op: { op: 'set', path: '', newValue: edit.newValue },
                                snapshot: edit.oldValue ?? null,
                                sourceCallId: null,
                            });
                        }
                    } else {
                        bus.hydrate({ version: 2, entries: [], outcomeQueue: [] });
                    }
                } finally {
                    state.__suspendBusOnChange = false;
                }
                bus.setAutoApprove(Boolean(state.session.surfaceState?.autoApply));
                delete state.session.pendingEdits;
                delete state.session.pendingSkillEdits;
                delete state.session.pendingCloneEdits;
                await reloadReference();
                return;
            }
        }
        state.session = createNewSession();
        state.session._transient = true;
        // Don't persist or set currentSessionId yet — the session becomes
        // durable on first user message via persistSession's _transient
        // guard. This keeps blank drafts from stacking when the user opens
        // and closes the popup without sending anything.
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
        referenceHelpLabel: t('What is a reference preset?'),
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

    // ProposalBus click delegation. Approve / reject / reset / rollback
    // per-card AND approve-all / reject-all / rollback-turn turn-actions
    // are consumed here. Unmatched clicks fall through to the popup's
    // other handlers (session switch, regenerate, etc.).
    $root.on('click.cpaIt', async (e) => {
        await bus.handleClick(e);
    });

    $root.on('click.cpaIt', '[data-cpa-it-action="new-session"]', async (e) => {
        e.preventDefault();
        await startNewSession();
    });

    // Per-proposal approve/reject/undo for pending skill authoring edits.
    // Flips the local status flag; commit happens at apply-batch time
    // (after the preset commit) via commitApprovedSkillProposal.
    $root.on('click.cpaIt', '[data-cpa-it-action="approve-skill"]', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = String($(e.currentTarget).attr('data-cpa-it-pending-id') || '');
        const entry = (state.pendingSkillEdits || []).find(p => p?.id === id);
        if (!entry) return;
        entry.status = 'approved';
        await render();
    });

    $root.on('click.cpaIt', '[data-cpa-it-action="reject-skill"]', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = String($(e.currentTarget).attr('data-cpa-it-pending-id') || '');
        const entry = (state.pendingSkillEdits || []).find(p => p?.id === id);
        if (!entry) return;
        entry.status = 'rejected';
        await render();
    });

    $root.on('click.cpaIt', '[data-cpa-it-action="reset-skill-decision"]', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = String($(e.currentTarget).attr('data-cpa-it-pending-id') || '');
        const entry = (state.pendingSkillEdits || []).find(p => p?.id === id);
        if (!entry) return;
        entry.status = 'pending';
        await render();
    });

    // Commit approved skill proposals when there's no preset commit in
    // flight. Goes through applyPendingEdits' skill-only path.
    $root.on('click.cpaIt', '[data-cpa-it-action="commit-skill-only"]', async (e) => {
        e.preventDefault(); e.stopPropagation();
        await applyPendingEdits();
    });
    $root.on('click.cpaIt', '[data-cpa-it-action="help-reference"]', async (e) => {
        // Sits inside the reference `<label>`; without preventDefault the label
        // delegation also opens the `<select>` dropdown behind the help popup.
        e.preventDefault();
        e.stopPropagation();
        const helpHtml = `
            <div class="cpa_it_help_body">
                <p>${escapeHtmlLocal(t('A reference preset is a separate preset you pick as a comparison baseline. The AI can:'))}</p>
                <ul>
                    <li>${escapeHtmlLocal(t('Read its fields (prompts, sampler settings, etc.) as context.'))}</li>
                    <li>${escapeHtmlLocal(t('Diff your target preset against it to spot differences.'))}</li>
                    <li>${escapeHtmlLocal(t('Copy specific fields from it into your target preset.'))}</li>
                </ul>
                <p>${escapeHtmlLocal(t('You can merge the strengths of different presets, carrying one preset\'s ideas and content into another.'))}</p>
                <p>${escapeHtmlLocal(t('Pick "(none)" to skip — the AI will edit your target preset alone.'))}</p>
            </div>`;
        const helpPopup = new Popup(helpHtml, POPUP_TYPE.TEXT, '', {
            okButton: t('Got it'),
            cancelButton: false,
        });
        await helpPopup.show();
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
            state.aborting = false;
            state.abortController = null;
        }
        await sessionStore.delete(id);
        if (state.session.id === id) {
            await startNewSession();
        } else {
            await render();
        }
    });

    // Per-message Regenerate / Rollback. Both buttons are rendered by
    // `iteration-library/ui/message.renderMessageCard`, which emits them
    // with `data-cpa-it-action="regenerate"` / `="rollback-batch"` (via
    // the actionAttribute opt) and `data-luker-lib-msg-id="..."`. The
    // msgId resolver accepts both attribute names so a future CPA-only
    // override that still tags `data-cpa-it-msg-id` keeps working.
    function resolveMsgId(target) {
        if (!target) return '';
        // dataset is camelCase: cpaItMsgId / lukerLibMsgId
        return String(target.dataset?.cpaItMsgId || target.dataset?.lukerLibMsgId || '');
    }
    $root.on('click.cpaIt', '[data-cpa-it-action="regenerate"]', async (e) => {
        e.preventDefault();
        const msgId = resolveMsgId(e.currentTarget);
        if (!msgId) return;
        await regenerateFromMessage(msgId);
    });
    // Per-batch rollback is now bus-driven via turn-actions on the
    // assistant card; bus.rollbackAllInTurn(message) handles it.

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

    // Composer-row auto-apply toggle. Persists per-session via surfaceState
    // and mirrors into bus.setAutoApprove. Toggling ON kicks each pending
    // proposal through bus.approve immediately.
    $root.on('change.cpaIt', '[data-cpa-it-action="toggle-auto-apply"]', async (e) => {
        const checked = Boolean(e.currentTarget?.checked);
        state.session.surfaceState = {
            ...(state.session.surfaceState || {}),
            autoApply: checked,
        };
        bus.setAutoApprove(checked);
        await persistSession();
        if (checked) {
            try {
                for (const entry of bus._testOnly_entries()) {
                    if (entry.status === 'pending') await bus.approve(entry.id);
                }
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
        state.aborting = false;
        state.abortController = null;
        try { await persistSession(); } catch { /* ignore */ }
    }
}

// Re-export the small surface from peer modules so importers don't need to
// chase three import paths to find the popup, its tools, and its system-
// prompt builders. Used by tests + by main.js's lazy import.
export { SESSION_MODES, SESSION_MODE_DEFAULT } from './system-prompts.js';
export { EDITABLE_TOOL_NAMES, TOOL_DISPLAY } from './tools.js';
