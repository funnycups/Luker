/**
 * CEA Character Editor — AI iteration popup (plugin-owned).
 *
 * Stage 2 replacement for the legacy iteration-studio adapter
 * (`character-editor-adapter.js`). Single-column chat surface that wires
 * `iteration-library/*` helpers directly:
 *   - storage  (per-character session bucket via `session-store.js`)
 *   - runner   (`requestToolCallsWithRetry` from `lib/iter-tool-calling.js`)
 *   - render   (Markdown rendering for assistant messages)
 *   - edits    (`applyEdits`, `registerOp` from `lib/edits/`)
 *
 * Layout per sub-spec §4 (Q10 — drop preview pane, diff tab, reference
 * picker):
 *
 *   ┌────────────────────────────────────────────┐
 *   │ <details> History … Clear all </details>   │
 *   │ <div> message list (chat)         </div>   │
 *   │ <div> pending edits (when staged) </div>   │
 *   │ <div> composer textarea + Send    </div>   │
 *   └────────────────────────────────────────────┘
 *
 * The popup is mounted via `new Popup(..., POPUP_TYPE.DISPLAY)` so it
 * has no built-in OK / Cancel buttons; the user dismisses it via the
 * dialog's close button (top-right ✕). Sessions auto-persist on every
 * mutation, so closing mid-conversation is safe.
 *
 * Single-character entry point:
 *   `openCharacterIterationStudio(avatar, deps)`
 *
 * Deps shape (per Stage 2 sub-spec — strictly less than the legacy
 * adapter received):
 *   - avatar, context, i18n, i18nFormat
 *   - readCard, readLorebook, mergeCharacterAttributes, saveLorebook
 *   - getSettings, saveSettingsDebounced
 *   - getRequestPresetOptions → { llmPresetName, apiPresetName }
 *   - escapeHtml
 */

import { lodash } from '../../../../lib.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';
import {
    applyEdits,
    bindIterWorkspaceResizer,
    inverseEdit,
    registerOp,
    render as ITER_RENDER,
    runner as ITER_RUNNER,
    textDiff as ITER_TEXT_DIFF,
    zoomOverlay as ITER_ZOOM_OVERLAY,
} from '../../../iteration-library/index.js';
import {
    createLorebookEntryAddOp,
    createLorebookEntryUpdateOp,
    createLorebookEntryRemoveOp,
} from '../lorebook-ops.js';
import {
    TOOL_DEFS,
    TOOL_DISPLAY,
    normalizeToolCallToEdit,
    CONTROL_TOOL_NAMES,
    CONTROL_TOOL_DEFS,
    isCeaCharControlCall,
} from './tools.js';
import {
    createCharacterIterationSessionStore,
    makeMessageId,
    normalizeMessageShape,
} from './session-store.js';

const MODULE = 'cea-character-iteration';
const STYLESHEET_ID = 'cea_charit_studio_stylesheet';
const STYLESHEET_HREF = '/scripts/extensions/character-editor-assistant/character-iteration/studio.css';

/**
 * Loose AbortError detector. The runner may throw a DOMException with name
 * AbortError, a plain Error with "aborted" in the message, or rethrow our
 * AbortController's signal. Treat any of those as a user-driven Stop so
 * handleSendMessage's catch block doesn't push an error bubble.
 */
function isAbortError(err, signal) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    const msg = String(err?.message || err);
    if (/abort(ed)?/i.test(msg)) return true;
    if (signal?.aborted) return true;
    return false;
}

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
 * Build the popup root HTML. Built once on open; per-render mutations
 * scope to subordinate `[data-cea-charit-*]` slots so we never re-mount
 * the textarea (which would lose focus + the in-progress draft).
 *
 * Workspace shell (luker-iter-workspace): split grid with chat + preview
 * panes on desktop, mobile tab-bar fallback under 900px (driven by
 * shared section 24 in luker-studio.css). The composer hosts the
 * auto-apply checkbox in-line.
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
    autoApply,
    autoApplyLabel,
    chatTabLabel,
    previewTabLabel,
    chatBadgeAriaLabel,
    resizerAriaLabel,
}) {
    return `
<div id="${popupId}" class="cea_charit_popup luker-iter-workspace" data-iter-layout="split" data-iter-active-tab="chat">
    <div class="cea_charit_title">${title}</div>
    <details class="cea_charit_history" data-cea-charit-history${historyOpen ? ' open' : ''}>
        <summary>${escapeHtmlLocal(historyLabel)}</summary>
        <div class="cea_charit_history_items" data-cea-charit-history-items></div>
        <div class="cea_charit_history_clear">
            <button class="menu_button menu_button_small" data-cea-charit-action="new-session">${escapeHtmlLocal(newSessionLabel)}</button>
            <button class="menu_button menu_button_small" data-cea-charit-action="clear-history">${escapeHtmlLocal(clearAllLabel)}</button>
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

    <div class="luker-iter-workspace-grid">
        <div class="luker-iter-workspace-chat" data-iter-pane="chat">
            <div class="cea_charit_messages" data-cea-charit-messages></div>
            <div class="cea_charit_pending" data-cea-charit-pending hidden></div>
            <div class="cea_charit_composer">
                <textarea class="text_pole" rows="2" data-cea-charit-input placeholder="${escapeHtmlLocal(composerPlaceholder)}"></textarea>
                <div class="cea_charit_composer_actions">
                    <label class="cea_charit_composer_auto_apply">
                        <input type="checkbox" data-cea-charit-action="toggle-auto-apply"${autoApply ? ' checked' : ''}>
                        <span>${escapeHtmlLocal(autoApplyLabel)}</span>
                    </label>
                    <div class="cea_charit_composer_buttons">
                        <button class="menu_button" data-cea-charit-action="send">${escapeHtmlLocal(sendLabel)}</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="luker-iter-workspace-resizer" data-iter-resizer aria-label="${escapeHtmlLocal(resizerAriaLabel)}"></div>
        <div class="luker-iter-workspace-preview" data-iter-pane="preview" data-iter-preview-pane></div>
    </div>
</div>`;
}

// Local HTML escape for building the static popup shell. Per-render text
// uses `deps.escapeHtml` (from main.js) so the user-supplied implementation
// can stay authoritative for chat / pending-card content.
function escapeHtmlLocal(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function makeSessionId() {
    return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Live target preview — file-local helpers + renderer.
//
// Module-scope so unit tests can `import { _testOnly_renderCeaCharPreviewPane }`
// without instantiating the popup. Pure function: given `live` + pending
// edits, return preview HTML. Snippets B + C from the implementation plan.
//
// `computeChangedPathSet`, `walkDiff`, `truncateForPreview`,
// `fmtPendingChangeInline` are intentionally file-local (duplicated rather
// than extracted to iteration-library per spec §B), mirroring CPA / MG /
// Orchestrator.
//
// Edit shape: CEA char emits FINE-GRAINED edits (`card.<field>`,
// `lorebook.entries`, `lorebook.<key>`) — `applyEdits` handles them via
// lodash.set so the empty-path no-op pattern (orch / MG) is NOT needed.
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
 * Render the right-pane HTML for the CEA Character workspace preview.
 * Pure function — never throws (defensive wraps below).
 *
 * Surfaces the six card fields (name, description, personality, scenario,
 * first_mes, mes_example) followed by a Bound-lorebook section. Each row
 * highlights `.pending-change` when the dotted path (e.g. `card.name`,
 * `lorebook.entries`) matches an emitted edit.
 *
 * @param {{card?: object, lorebook?: object}|null} live
 * @param {Array} pendingEdits  Edits from the latest LLM round.
 * @param {Function} [tFn]      Optional i18n function (string → string).
 * @returns {string} HTML.
 */
function renderCeaCharPreviewPane(live, pendingEdits, tFn) {
    const t = typeof tFn === 'function' ? tFn : (s) => String(s ?? '');
    if (!live || !live.card) {
        return `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No character loaded.'))}</div>`;
    }
    const edits = Array.isArray(pendingEdits) ? pendingEdits : [];
    const changed = computeChangedPathSet(live, edits);
    let next = live;
    if (edits.length > 0) {
        try {
            const cloned = structuredClone(live);
            const r = applyEdits(edits, cloned);
            next = r?.newLive ?? cloned;
        } catch { /* fall back to live */ }
    }

    const fields = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
    const fieldRows = fields.map(f => {
        const path = `card.${f}`;
        const isChanged = changed.has(path);
        const cls = isChanged
            ? 'luker-iter-workspace-preview-row pending-change'
            : 'luker-iter-workspace-preview-row';
        const oldVal = live.card?.[f] ?? '';
        const newVal = next?.card?.[f] ?? '';
        const display = truncateForPreview(isChanged ? newVal : oldVal, 250);
        const inlineDiff = (isChanged && oldVal !== newVal)
            ? fmtPendingChangeInline(oldVal, newVal, t)
            : '';
        const bodyHtml = display
            ? escapeHtmlLocal(display)
            : `<span class="muted">${escapeHtmlLocal(t('(empty)'))}</span>`;
        return `<div class="${cls}"><div class="luker-iter-workspace-preview-row-head"><span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(f)}</span>${inlineDiff}</div><div class="luker-iter-workspace-preview-row-body">${bodyHtml}</div></div>`;
    }).join('');

    const lore = live.lorebook;
    let loreSection = '';
    if (lore) {
        const loreChanged = changed.has('lorebook') || changed.has('lorebook.entries') || changed.has('lorebook.name');
        const loreCls = loreChanged
            ? 'luker-iter-workspace-preview-row pending-change'
            : 'luker-iter-workspace-preview-row';
        const loreName = lore.name || lore.bookName || '?';
        const entryCount = Array.isArray(lore.entries)
            ? lore.entries.length
            : (lore.entries && typeof lore.entries === 'object')
                ? Object.keys(lore.entries).length
                : 0;
        loreSection = `
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Bound lorebook'))}</div>
            <div class="${loreCls}">
                <div class="luker-iter-workspace-preview-row-head">
                    <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(loreName)}</span>
                    <span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(`${entryCount} entries`)}</span>
                </div>
            </div>
        </div>`;
    }

    return `
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Character fields'))}</div>
            ${fieldRows}
        </div>
        ${loreSection}
    `;
}

export { renderCeaCharPreviewPane as _testOnly_renderCeaCharPreviewPane };

function createNewSession() {
    const now = Date.now();
    return {
        id: makeSessionId(),
        title: '',
        messages: [],
        // Per-session surface preferences + finalize state. isFinalized +
        // finalizeSummary ride on surfaceState so popup close / reopen
        // preserves them.
        surfaceState: {
            historyOpen: false,
            autoApply: false,
            isFinalized: false,
            finalizeSummary: '',
        },
        // Top-level mirror of pendingEdits so a popup close mid-turn
        // (before Apply) reloads with the same pending batch.
        pendingEdits: [],
        updatedAt: now,
        createdAt: now,
    };
}

/**
 * Open the CEA Character Editor AI iteration popup for `avatar`.
 *
 * Resolves when the user dismisses the dialog. Sessions are persisted
 * eagerly on every mutation so dismiss-without-save is irrelevant.
 *
 * @param {string} avatar
 * @param {Object} deps
 */
export async function openCharacterIterationStudio(avatar, deps) {
    if (!avatar || typeof avatar !== 'string') {
        throw new TypeError('openCharacterIterationStudio: avatar (string) is required');
    }
    if (!deps || typeof deps !== 'object') {
        throw new TypeError('openCharacterIterationStudio: deps is required');
    }
    ensureStylesheetInjected();
    const {
        context,
        i18n,
        i18nFormat,
        readCard,
        readLorebook,
        mergeCharacterAttributes,
        saveLorebook,
        getSettings,
        saveSettingsDebounced,
        getRequestPresetOptions,
        escapeHtml: depsEscapeHtml,
    } = deps;
    const escapeHtml = typeof depsEscapeHtml === 'function'
        ? depsEscapeHtml
        : escapeHtmlLocal;
    const t = typeof i18n === 'function' ? i18n : (s) => String(s ?? '');
    const tf = typeof i18nFormat === 'function'
        ? i18nFormat
        : (template, ...values) => String(t(template) ?? template).replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));

    // ──────────────────────────────────────────────────────────────────
    // Custom op registration. `registerOp` overwrites if already
    // registered, so re-opens are idempotent. We do this before any
    // `applyEdits` call so the engine knows about our uid-keyed ops.
    // ──────────────────────────────────────────────────────────────────
    registerOp('lorebook_entry_add', createLorebookEntryAddOp());
    registerOp('lorebook_entry_update', createLorebookEntryUpdateOp());
    registerOp('lorebook_entry_remove', createLorebookEntryRemoveOp());

    // Per-character session store (bucket = popupSessionsV2[char_<avatar>]).
    const sessionStore = createCharacterIterationSessionStore({
        getSettings,
        persistSettings: saveSettingsDebounced,
        avatar,
    });
    await sessionStore.clearObsolete();   // sweep `lorebookSyncHistory` / `popupSessions`

    // Prime markdown deps so the first paint has formatted messages
    // rather than escaped fallback (`ensureMarkdownDeps` caches).
    await ITER_RENDER.ensureMarkdownDeps();

    // ──────────────────────────────────────────────────────────────────
    // Closure-local state. Mirrors the legacy adapter's two snapshot
    // refs (prevCardSnapshot / prevLorebookSnapshot) so commit() can
    // compute a minimal card-field patch and skip the lorebook write
    // when nothing changed (avoids spurious saveWorldInfo calls).
    // ──────────────────────────────────────────────────────────────────
    const state = {
        session: createNewSession(),
        live: null,                         // primed on first `ensureLive()`
        pendingEdits: [],                   // [Edit] awaiting Apply
        isBusy: false,
        abortController: null,
        prevCardSnapshot: null,
        prevLorebookSnapshot: null,
    };

    // ──────────────────────────────────────────────────────────────────
    // Live state — read-through cache. Re-read on each turn so a parallel
    // edit (e.g. user manually tweaks the card in another tab) shows up
    // in the next LLM round-trip's `oldValue` capture. Snapshots are
    // also captured for `commitLiveToCharacter`'s diff.
    // ──────────────────────────────────────────────────────────────────
    async function ensureLive(forceReread = false) {
        if (!forceReread && state.live) return state.live;
        const card = structuredClone(await readCard());
        const lorebook = structuredClone(await readLorebook());
        if (state.prevCardSnapshot === null) state.prevCardSnapshot = structuredClone(card);
        if (state.prevLorebookSnapshot === null) state.prevLorebookSnapshot = structuredClone(lorebook);
        state.live = { card, lorebook };
        return state.live;
    }

    // ──────────────────────────────────────────────────────────────────
    // Persistence. Session always carries the latest `surfaceState`,
    // messages, and a derived title (first 50 chars of the first user
    // message). Calling this is cheap — the inner store uses
    // `saveSettingsDebounced` so the actual flush is batched.
    //
    // Mirrors runtime pendingEdits onto the persisted session so popup
    // close mid-batch reloads with the same staged edits.
    // ──────────────────────────────────────────────────────────────────
    async function persistSession() {
        state.session.updatedAt = Date.now();
        try {
            state.session.pendingEdits = Array.isArray(state.pendingEdits)
                ? structuredClone(state.pendingEdits)
                : [];
        } catch {
            state.session.pendingEdits = Array.isArray(state.pendingEdits) ? state.pendingEdits.slice() : [];
        }
        if (!state.session.title) {
            const firstUser = state.session.messages.find(m => m.role === 'user' && !m.auto);
            if (firstUser) {
                state.session.title = String(firstUser.content || '').slice(0, 50);
            }
        }
        await sessionStore.save(state.session);
    }

    async function loadSession(id) {
        const loaded = await sessionStore.load(id);
        if (!loaded) return;
        const fallbackAt = Number(loaded.updatedAt) || Date.now();
        const loadedMessages = Array.isArray(loaded.messages) ? loaded.messages : [];
        state.session = {
            ...loaded,
            surfaceState: {
                historyOpen: false,
                autoApply: false,
                isFinalized: false,
                finalizeSummary: '',
                ...(loaded.surfaceState || {}),
            },
            messages: loadedMessages.map(m => normalizeMessageShape(m, fallbackAt)),
            pendingEdits: Array.isArray(loaded.pendingEdits) ? loaded.pendingEdits.slice() : [],
        };
        state.session.surfaceState.autoApply = !!state.session.surfaceState.autoApply;
        state.pendingEdits = state.session.pendingEdits.slice();
        // Re-read live so a parallel character edit doesn't leave the
        // popup with stale state when the user reopens an older session.
        await ensureLive(true);
        await render();
    }

    async function startNewSession() {
        state.session = createNewSession();
        state.pendingEdits = [];
        await ensureLive(true);
        await sessionStore.save(state.session);
        await render();
    }

    async function clearAllHistory() {
        // eslint-disable-next-line no-alert
        if (!confirm(t('Clear all session history for this character?'))) return;
        const metas = await sessionStore.list();
        for (const meta of metas) {
            await sessionStore.delete(meta.id);
        }
        await startNewSession();
    }

    // ──────────────────────────────────────────────────────────────────
    // Card-and-lorebook diff + write. Ported from the legacy adapter's
    // `commit()` (character-editor-adapter.js L268-L283).
    //
    // Only changed card fields go through `mergeCharacterAttributes`;
    // the lorebook is skipped entirely when nothing changed
    // (saveWorldInfo bumps mtime even on no-op writes, so the guard
    // matters for downstream consumers).
    // ──────────────────────────────────────────────────────────────────
    function cardDiff(before, after) {
        const patch = {};
        const keys = new Set([
            ...Object.keys(before || {}),
            ...Object.keys(after || {}),
        ]);
        for (const k of keys) {
            if (!lodash.isEqual(before?.[k], after?.[k])) {
                patch[k] = after?.[k];
            }
        }
        return patch;
    }

    async function commitLiveToCharacter() {
        const cardBefore = state.prevCardSnapshot ?? structuredClone(await readCard());
        const lorebookBefore = state.prevLorebookSnapshot ?? structuredClone(await readLorebook());

        const cardPatch = cardDiff(cardBefore, state.live.card);
        if (Object.keys(cardPatch).length > 0) {
            await mergeCharacterAttributes(context, avatar, cardPatch);
        }
        if (!lodash.isEqual(lorebookBefore, state.live.lorebook)) {
            await saveLorebook(state.live.lorebook.bookName, { entries: state.live.lorebook.entries });
        }

        state.prevCardSnapshot = structuredClone(state.live.card);
        state.prevLorebookSnapshot = structuredClone(state.live.lorebook);
    }

    // ──────────────────────────────────────────────────────────────────
    // Pending-edit cards — per-op real-diff rendering. Q8 from the
    // sub-spec: the legacy adapter showed `<op> <path>` line items
    // only; the new popup must surface enough context that the user
    // can decide Apply vs. Reject without flipping tabs.
    //
    // Each branch matches the op shape emitted by `tools.js`'s
    // `normalizeToolCallToEdit`.
    //
    // String-shape edits (`set` on a string field, `str_replace`, and
    // long lorebook_entry_update patches) route through the iteration-
    // library's side-by-side LCS diff renderer so the user sees the
    // change in context rather than `<old> → <new>` next to each other.
    // The 120-char threshold matches the original inline form for short
    // values (a name flip, etc.) where the compact `→` arrow already
    // reads well.
    // ──────────────────────────────────────────────────────────────────
    const LIB_DIFF_MIN_LEN = 120;
    const STR_REPLACE_PREVIEW_MAX = 2000;

    function describeValue(v) {
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') {
            return v.length > 80 ? v.slice(0, 80) + '…' : v;
        }
        return String(v);
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
        if (op === 'set') {
            const oldStr = String(edit.oldValue ?? '');
            const newStr = String(edit.newValue ?? '');
            if (shouldUseLibraryDiff(edit.oldValue, edit.newValue)) {
                return `<div class="cea_charit_pending_card">
                    <span class="op">${escapeHtml(t('set'))}</span>
                    <code>${escapeHtml(String(edit.path || ''))}</code>
                    ${renderLibraryDiff(oldStr, newStr, String(edit.path || ''))}
                </div>`;
            }
            return `<div class="cea_charit_pending_card">
                <span class="op">${escapeHtml(t('set'))}</span>
                <code>${escapeHtml(String(edit.path || ''))}</code>:
                <span class="diff_old">${escapeHtml(describeValue(edit.oldValue))}</span>
                <span class="diff_arrow">→</span>
                <span class="diff_new">${escapeHtml(describeValue(edit.newValue))}</span>
            </div>`;
        }
        if (op === 'str_replace') {
            // Surface the change in context: simulate the replace against
            // the live snapshot, then library-diff before-vs-after so the
            // surrounding paragraph shows up too.
            const path = String(edit.path || '');
            const find = String(edit.find ?? '');
            const replaceWith = String(edit.replace ?? '');
            const before = (state.live && path) ? lodash.get(state.live, path) : undefined;
            if (typeof before === 'string') {
                const after = before.replace(find, replaceWith);
                return `<div class="cea_charit_pending_card">
                    <span class="op">${escapeHtml(t('replace'))}</span>
                    <code>${escapeHtml(path)}</code>
                    ${renderLibraryDiff(truncateForDiff(before), truncateForDiff(after), `${path} (str_replace)`)}
                </div>`;
            }
            // Fall back to the legacy inline form when we can't read the
            // field (live snapshot not primed yet, path mismatch, etc.).
            return `<div class="cea_charit_pending_card">
                <span class="op">${escapeHtml(t('replace'))}</span>
                <code>${escapeHtml(path)}</code>:
                <span class="diff_old">${escapeHtml(find)}</span>
                <span class="diff_arrow">→</span>
                <span class="diff_new">${escapeHtml(replaceWith)}</span>
            </div>`;
        }
        if (op === 'lorebook_entry_add') {
            const entry = edit.entry || {};
            const comment = entry.comment || t('(no comment)');
            const content = String(entry.content || '');
            const preview = content.length > 80 ? content.slice(0, 80) + '…' : content;
            return `<div class="cea_charit_pending_card">
                <span class="op">${escapeHtml(t('add entry'))}</span>
                uid ${escapeHtml(String(edit.uid ?? ''))} — <em>${escapeHtml(String(comment))}</em>:
                <span class="diff_new">${escapeHtml(preview)}</span>
            </div>`;
        }
        if (op === 'lorebook_entry_update') {
            const patchKeys = Object.keys(edit.patch || {});
            const rows = patchKeys.map(k => {
                const beforeVal = edit.before?.[k];
                const afterVal = edit.patch?.[k];
                if (shouldUseLibraryDiff(beforeVal, afterVal)) {
                    return `<div class="cea_charit_pending_row">
                        <code>${escapeHtml(k)}</code>
                        ${renderLibraryDiff(String(beforeVal ?? ''), String(afterVal ?? ''), k)}
                    </div>`;
                }
                const before = describeValue(beforeVal);
                const after = describeValue(afterVal);
                return `<div class="cea_charit_pending_row">
                    <code>${escapeHtml(k)}</code>:
                    <span class="diff_old">${escapeHtml(before)}</span>
                    <span class="diff_arrow">→</span>
                    <span class="diff_new">${escapeHtml(after)}</span>
                </div>`;
            }).join('');
            return `<div class="cea_charit_pending_card">
                <span class="op">${escapeHtml(t('update entry'))}</span>
                uid ${escapeHtml(String(edit.uid ?? ''))}: ${rows}
            </div>`;
        }
        if (op === 'lorebook_entry_remove') {
            const entry = edit.entry || {};
            const comment = entry.comment || t('(no comment)');
            return `<div class="cea_charit_pending_card">
                <span class="op">${escapeHtml(t('remove entry'))}</span>
                uid ${escapeHtml(String(edit.uid ?? ''))} — <em>${escapeHtml(String(comment))}</em>
            </div>`;
        }
        // Unknown op fallback — still render the path so users see what
        // the model attempted, even if the engine wouldn't apply it.
        return `<div class="cea_charit_pending_card">
            <span class="op">${escapeHtml(op)}</span>
            <code>${escapeHtml(String(edit.path || ''))}</code>
        </div>`;
    }

    // ──────────────────────────────────────────────────────────────────
    // Chat-message rendering. Q2 + Q7 from the sub-spec:
    //   - assistant messages route through the library's markdown
    //     renderer (`render.renderMessageMarkdown`) which sanitizes via
    //     DOMPurify, so embedding via `innerHTML` is XSS-safe
    //   - user / assistant / system messages get distinct CSS classes
    //     for visual distinction (alignment, background, etc.)
    //
    // Each assistant message also surfaces a collapsible details block
    // listing the round's tool calls + edit cards, plus per-message
    // Regenerate (on non-last assistant) and Rollback (on applied,
    // not-yet-rolled-back) buttons.
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
            <div class="cea_charit_msg_toolcall">
                <div class="cea_charit_msg_toolcall_name">${escapeHtml(label)}</div>
                <pre class="cea_charit_msg_toolcall_args">${escapeHtml(argsText)}</pre>
            </div>`;
    }

    function renderEditChip(edit) {
        // Reuse the pending-card renderer so the per-message audit trail
        // and the active pending block look visually identical.
        return renderPendingEditCard(edit);
    }

    function resolveAppliedTargetLabel(appliedTarget) {
        if (appliedTarget === 'character') return t('character');
        return String(appliedTarget || t('character'));
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
            ? 'cea_charit_msg_user'
            : role === 'assistant'
                ? 'cea_charit_msg_assistant'
                : 'cea_charit_msg_system';
        const autoCls = message.auto ? ' cea_charit_msg_auto' : '';

        const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
        const edits = Array.isArray(message.edits) ? message.edits : [];
        const hasTrail = toolCalls.length > 0 || edits.length > 0;
        const applied = Boolean(message.appliedAt) && !message.rolledBackAt;
        const rolledBack = Boolean(message.rolledBackAt);
        const detailsOpen = hasTrail && !applied && !rolledBack;

        let trailHtml = '';
        if (hasTrail) {
            const headerLabel = tf('Tools and edits this round (${0})', String(toolCalls.length + edits.length));
            const targetLabel = resolveAppliedTargetLabel(message.appliedTarget);
            const statusHtml = rolledBack
                ? `<span class="cea_charit_msg_rolled_back">${escapeHtml(tf('Rolled back at ${0}', formatTime(message.rolledBackAt)))}</span>`
                : (applied
                    ? `
                        <span class="cea_charit_msg_applied">${escapeHtml(tf('✓ Applied to ${0} at ${1}', targetLabel, formatTime(message.appliedAt)))}</span>
                        <button class="menu_button menu_button_small" data-cea-charit-custom-action="rollback-batch" data-cea-charit-msg-id="${escapeHtml(message.id || '')}">
                            ${escapeHtml(t('Rollback'))}
                        </button>
                    `
                    : '');

            const toolsHtml = toolCalls.map(renderToolCallChip).join('');
            const editsHtml = edits.map(renderEditChip).join('');

            trailHtml = `
                <details class="cea_charit_msg_trail" ${detailsOpen ? 'open' : ''}>
                    <summary>${escapeHtml(headerLabel)}</summary>
                    <div class="cea_charit_msg_trail_body">
                        ${toolsHtml}
                        ${editsHtml}
                    </div>
                    ${statusHtml ? `<div class="cea_charit_msg_trail_status">${statusHtml}</div>` : ''}
                </details>
            `;
        }

        // Regenerate is per-assistant-message, only when it's not the
        // current tail (otherwise just hit Send again). Skip auto-continue
        // synthetic assistants; their prompt was synthesized so regen
        // would just truncate to the prior human turn anyway.
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
                <div class="cea_charit_msg_actions">
                    <button class="menu_button menu_button_small" data-cea-charit-custom-action="regenerate" data-cea-charit-msg-id="${escapeHtml(message.id || '')}">
                        ${escapeHtml(t('Regenerate'))}
                    </button>
                </div>`
            : '';

        return `<div class="cea_charit_msg ${roleCls}${autoCls}" data-cea-charit-msg-id="${escapeHtml(message.id || '')}">
            ${bodyHtml}
            ${trailHtml}
            ${actionsHtml}
        </div>`;
    }

    function renderHistoryItem(meta) {
        const id = String(meta?.id || '');
        const title = String(meta?.title || meta?.id || '');
        const active = id === state.session.id ? ' cea_charit_history_item_active' : '';
        return `<div class="cea_charit_history_item${active}" data-cea-charit-action="load-session" data-cea-charit-id="${escapeHtml(id)}">
            <span class="cea_charit_history_title">${escapeHtml(title || t('(untitled)'))}</span>
            <button class="cea_charit_history_delete" data-cea-charit-action="delete-session" data-cea-charit-id="${escapeHtml(id)}" title="${escapeHtml(t('Delete this session'))}">×</button>
        </div>`;
    }

    // ──────────────────────────────────────────────────────────────────
    // Full re-render. Cheap enough to call after every state mutation
    // (the static popup shell + textarea stay mounted, so user input
    // and focus aren't disturbed by re-rendering messages / pending).
    // ──────────────────────────────────────────────────────────────────
    let $root = null;
    async function render() {
        if (!$root) return;
        // History list (and its details open state)
        const $history = $root.find('[data-cea-charit-history]');
        if ($history.length) {
            // Sync open state without firing toggle handler
            const wantOpen = Boolean(state.session.surfaceState?.historyOpen);
            if ($history.prop('open') !== wantOpen) {
                $history.prop('open', wantOpen);
            }
        }

        // Auto-apply checkbox: sync to persisted preference (avoids the
        // checkbox state drifting away from surfaceState across re-renders
        // of the static shell).
        const $autoApply = $root.find('[data-cea-charit-action="toggle-auto-apply"]');
        if ($autoApply.length) {
            const wantChecked = Boolean(state.session.surfaceState?.autoApply);
            if ($autoApply.prop('checked') !== wantChecked) {
                $autoApply.prop('checked', wantChecked);
            }
        }

        const metas = await sessionStore.list();
        const historyHtml = metas.map(renderHistoryItem).join('')
            || `<div class="cea_charit_history_empty">${escapeHtml(t('No saved sessions'))}</div>`;
        $root.find('[data-cea-charit-history-items]').html(historyHtml);

        // Messages — pass index + full array so renderMessageCard can
        // decide whether to render Regenerate (only on non-last assistant
        // turns).
        const allMsgs = state.session.messages || [];
        const messagesHtml = allMsgs.map((m, i) => renderMessageCard(m, i, allMsgs)).join('');
        const $msgs = $root.find('[data-cea-charit-messages]');
        // Loading bubble: append (don't overwrite) so the just-finished
        // user turn stays visible while the LLM call is in flight.
        const loadingHtml = state.isBusy
            ? `<div class="cea_charit_msg cea_charit_msg_assistant cea_charit_msg_loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(t('AI is thinking...'))}</div>`
            : '';
        $msgs.html(messagesHtml + loadingHtml);
        // Auto-scroll to bottom after each render so newly-appended
        // user / assistant messages are visible without manual scroll.
        try {
            const node = $msgs[0];
            if (node && typeof node.scrollTop === 'number') {
                node.scrollTop = node.scrollHeight;
            }
        } catch { /* DOM not attached (test) */ }

        // Pending edits — single Apply button per spec §3.4. The label
        // resolves to the character display name. One handler ('apply')
        // commits to the character.
        const $pending = $root.find('[data-cea-charit-pending]');
        if (state.pendingEdits.length > 0) {
            const cardsHtml = state.pendingEdits.map(renderPendingEditCard).join('');
            const applyLabel = tf('Apply to ${0}', getApplyScopeLabel());
            $pending.html(`
                <div class="cea_charit_pending_title">${escapeHtml(t('Pending changes'))}</div>
                ${cardsHtml}
                <div class="cea_charit_pending_actions">
                    <button class="menu_button luker-iter-pending-apply" data-cea-charit-action="apply-pending">${escapeHtml(applyLabel)}</button>
                    <button class="menu_button menu_button_small" data-cea-charit-action="reject-pending">${escapeHtml(t('Reject'))}</button>
                </div>
            `).show().attr('hidden', null);
        } else {
            $pending.html('').hide().attr('hidden', '');
        }

        // Send / Stop button label
        const $sendBtn = $root.find('[data-cea-charit-action="send"]');
        $sendBtn.text(state.isBusy ? t('Stop') : t('Send'));

        // Live target preview pane (right column on desktop, Preview tab
        // on mobile). Pure render against state.live + pendingEdits — the
        // renderer wraps applyEdits in try/catch so a malformed pending
        // edit shape can't blank the workspace.
        try {
            const $previewPane = $root.find('[data-iter-preview-pane]');
            if ($previewPane.length) {
                const previewHtml = renderCeaCharPreviewPane(
                    state.live,
                    state.pendingEdits || [],
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
    // LLM turn — wires `iteration-library.runner` directly.
    //
    // The runner returns tool calls in the shape `{ name, args, raw }`.
    // `tools.js#normalizeToolCallToEdit` expects OpenAI shape
    // (`call.function.name`, `call.function.arguments` as JSON), so we
    // wrap each call before normalizing. This mirrors how the
    // iteration-studio shell's `buildExecutionToolCalls` converts
    // runner output for adapters — but we're not using the shell, so
    // the wrap lives here.
    // ──────────────────────────────────────────────────────────────────
    function buildSystemPrompt() {
        return `You are the AI assistant for the Character Editor. You may propose edits to:
- Character card fields (name, description, personality, scenario, first_mes, mes_example).
- Lorebook entries (each identified by a numeric uid).
- Lorebook metadata (bookName etc.).
Use the cea_* tools to propose each edit. Each edit becomes a reviewable change the user can apply or reject.

Edit scope:
- Match the user's edit scope. If they ask for a small adjustment ("punchier", "tighten", "5% shorter", "fix this line"), change only what that asks for; leave everything else byte-identical.
- Do not delete, restructure, or rewrite fields or lorebook entries the user did not name. When existing content already covers a topic the user just refined, keep its surrounding text and edit in place.
- Only rewrite broadly when the user explicitly asks for a rewrite / overhaul / redesign.

To drive the multi-round loop:
- Call ${CONTROL_TOOL_NAMES.continue} when more iteration is genuinely needed; the popup will fire one more round after the user has seen this round's output.
- Call ${CONTROL_TOOL_NAMES.finalize} with a concise summary when the work is complete. The popup will stop auto-continuing after this call.`;
    }

    function buildTaskMessages(systemPrompt, userText) {
        const messages = [{ role: 'system', content: systemPrompt }];
        // Replay prior chat turns so the model has context. Only role/
        // content are forwarded — tool-call replays aren't needed since
        // we surface edits in-popup and the LLM doesn't need to inspect
        // them on subsequent turns.
        for (const m of state.session.messages) {
            const role = String(m?.role || '').toLowerCase();
            if (role !== 'user' && role !== 'assistant') continue;
            messages.push({ role, content: String(m?.content || '') });
        }
        if (userText) {
            // The user's text has already been appended to session.messages
            // before runIterationTurn was called (Q6). The loop above already
            // included it, so nothing more to do — `userText` is just for
            // logging context if we needed it.
        }
        return messages;
    }

    function wrapToolCallForNormalize(call) {
        return {
            function: {
                name: String(call?.name || ''),
                arguments: JSON.stringify(call?.args || {}),
            },
        };
    }

    /**
     * Build the catalog the runner advertises to the LLM. CEA's static
     * `TOOL_DEFS` already covers card / lorebook edits; we splice the two
     * popup-side control tools (continue / finalize) alongside. The
     * runner's `isControlCall` predicate routes them to onControlCall so
     * they never reach `normalizeToolCallToEdit`.
     */
    function buildToolCatalog() {
        return [...TOOL_DEFS, ...CONTROL_TOOL_DEFS];
    }

    /**
     * Resolve the apply scope label. CEA char-iter is character-only by
     * design — the scope label is always the character display name
     * (which `state.live.card.name` carries). Fallback to the avatar
     * filename, then a generic 'current character' so the user always
     * sees something meaningful.
     */
    function getApplyScopeLabel() {
        const cardName = String(state.live?.card?.name || '').trim();
        if (cardName) return cardName;
        if (avatar) return String(avatar);
        return t('current character');
    }

    async function runIterationTurn({ autoContinueFromResult = null } = {}) {
        const ac = new AbortController();
        state.abortController = ac;

        await ensureLive(true);   // re-read so the next batch sees external edits

        // Auto-continue prelude: synthesize a follow-up `(auto-continue)`
        // user message marked `auto: true`. The synthesized prompt nudges
        // the model toward iteration vs. echoing the human user text —
        // re-pushing the original prompt verbatim every round causes
        // quadratic token growth and confuses the conversation history.
        if (autoContinueFromResult) {
            const noteLines = [
                'Continue with the next iteration step.',
            ];
            if (autoContinueFromResult?.continueNote) {
                noteLines.push(`Prior note: ${String(autoContinueFromResult.continueNote)}`);
            }
            noteLines.push(`Call ${CONTROL_TOOL_NAMES.finalize} once the request is fully addressed.`);
            state.session.messages.push({
                id: makeMessageId(),
                role: 'user',
                content: noteLines.join('\n'),
                at: Date.now(),
                auto: true,
            });
        }

        const settings = getSettings();
        const presetOptions = typeof getRequestPresetOptions === 'function'
            ? (getRequestPresetOptions() || {})
            : {};
        const apiPresetName = String(presetOptions.apiPresetName || '').trim();
        const llmPresetName = String(presetOptions.llmPresetName || '').trim();

        const systemPrompt = buildSystemPrompt();
        const taskMessages = buildTaskMessages(systemPrompt, '');

        // Per-round callback bookkeeping. The runner fires onAssistantText
        // once and onToolCall once per non-control call in array order.
        // Control tools (continue / finalize) route to onControlCall via
        // the isControlCall predicate so they never pollute the edit-tool
        // list.
        let firstAssistantText = '';
        const collectedToolCalls = [];
        let wantsAutoContinue = false;
        let continueNote = '';
        let sawFinalize = false;
        let finalizeSummary = '';

        const result = await ITER_RUNNER.requestToolCallsWithRetry(
            context,
            { useStreamingTransport: Boolean(settings?.useStreamingTransport), toolCallRetryMax: settings?.toolCallRetryMax, rpmLimit: settings?.rpmLimit },
            {
                taskMessages,
                runtimeWorldInfo: null,
                apiPresetName,
                llmPresetName,
                tools: buildToolCatalog(),
                abortSignal: ac.signal,
                includeAssistantText: true,
                allowNoToolCalls: true,
                isControlCall: isCeaCharControlCall,
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

        // Prefer `collectedToolCalls` — populated by `onToolCall`, which
        // the runner only fires for non-control calls. When the per-event
        // callbacks didn't land (e.g. an older runner version), fall back
        // to `result.toolCalls` but filter out control calls explicitly so
        // they never leak into the persisted `assistantMsg.toolCalls`.
        const editToolCalls = collectedToolCalls.length > 0
            ? collectedToolCalls
            : (Array.isArray(result?.toolCalls)
                ? result.toolCalls.filter(c => !isCeaCharControlCall(c))
                : []);
        const assistantText = firstAssistantText.trim();

        // Normalize tool calls → edits, accumulating per-call output.
        const edits = [];
        for (const call of editToolCalls) {
            try {
                const normalized = await normalizeToolCallToEdit(
                    wrapToolCallForNormalize(call),
                    { live: state.live },
                );
                if (Array.isArray(normalized)) {
                    edits.push(...normalized);
                }
                // null (malformed JSON) or empty array → skip silently
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] normalizeToolCallToEdit failed for ${String(call?.name || '')}`, err);
                state.session.messages.push({
                    id: makeMessageId(),
                    role: 'system',
                    content: tf('Edit error: ${0}', String(err?.message || err)),
                    at: Date.now(),
                });
            }
        }

        // Persist finalize state on surfaceState so popup close / reload
        // retains it.
        if (sawFinalize) {
            state.session.surfaceState = state.session.surfaceState || {};
            state.session.surfaceState.isFinalized = true;
            state.session.surfaceState.finalizeSummary = finalizeSummary;
        }

        // Stage the assistant message with the full per-round audit trail.
        // Falls back to a synthesized summary when the model emitted tool
        // calls without text. The toolCalls + edits + appliedAt fields
        // drive renderMessageCard's collapsible details block.
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

        // Composer-row auto-apply: when enabled AND this turn produced
        // edits AND we are not finalized, apply immediately. Errors land
        // via applyPendingEdits's own try/catch.
        const autoApply = Boolean(state.session.surfaceState?.autoApply);
        if (autoApply && state.pendingEdits.length > 0 && !state.session.surfaceState?.isFinalized) {
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
                assistantText,
                edits,
                editToolCalls,
                continueNote,
                finalized: Boolean(state.session.surfaceState?.isFinalized),
                finalizeSummary: String(state.session.surfaceState?.finalizeSummary || ''),
            },
        };
    }

    // ──────────────────────────────────────────────────────────────────
    // Apply pending edits. `applyEdits(edits, live)` returns
    // `{ newLive, clean, conflicts, alreadyDone }`. Per sub-spec §6 we
    // do NOT surface a conflict UI for CEA Character (edits are
    // sequential, no concurrent writer): just commit `newLive` and
    // drop any conflicting / already-done edits silently.
    //
    // `state.live` is snapshotted before applyEdits so a commit failure
    // restores the pre-apply value — otherwise the preview would lie
    // about what's on disk until the next ensureLive() reload.
    //
    // Scope label is the character's display name (derived via
    // getApplyScopeLabel) — CEA char-iter is character-only by design.
    // On success we toast the user and mark the most recent unapplied
    // assistant message so renderMessageCard can show the Applied label
    // and a Rollback button.
    // ──────────────────────────────────────────────────────────────────
    async function applyPendingEdits({ skipRender = false } = {}) {
        if (!Array.isArray(state.pendingEdits) || state.pendingEdits.length === 0) return;
        const liveSnapshot = state.live;
        try {
            const result = applyEdits(state.pendingEdits, state.live);
            state.live = result?.newLive ?? state.live;
            await commitLiveToCharacter();
        } catch (err) {
            state.live = liveSnapshot;
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] applyPendingEdits failed`, err);
            try { toastr.error(tf('Apply failed: ${0}', String(err?.message || err))); } catch { /* toastr may be unavailable in tests */ }
            state.session.messages.push({
                id: makeMessageId(),
                role: 'system',
                content: tf('Failed to save character: ${0}', String(err?.message || err)),
                at: Date.now(),
            });
            await persistSession();
            if (!skipRender) await render();
            return;
        }

        const scopeLabel = getApplyScopeLabel();
        try { toastr.success(tf('Applied to ${0}', scopeLabel)); } catch { /* ignore */ }

        // Mark the most recent unapplied assistant message that owns these
        // edits. We scan back from the end because the just-rendered turn
        // is the typical target.
        const messages = state.session.messages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role === 'assistant' && Array.isArray(m.edits) && m.edits.length > 0 && !m.appliedAt) {
                m.appliedAt = Date.now();
                m.appliedTarget = 'character';
                break;
            }
        }

        state.pendingEdits = [];
        await persistSession();
        if (!skipRender) await render();
    }

    async function rejectPendingEdits() {
        state.pendingEdits = [];
        await persistSession();
        await render();
    }

    // ──────────────────────────────────────────────────────────────────
    // Per-message actions.
    //
    // regenerateFromMessage(msgId): truncate the chat back to the user
    // turn that prompted this assistant message, drop staged pendingEdits,
    // refill the textarea with the original prompt, and re-fire send.
    //
    // rollbackBatch(msgId): inverse-apply each edit in the message's
    // batch against state.live (right-to-left), commit the result, mark
    // the message rolledBackAt. Builds inverses up-front so an
    // unsupported op fails BEFORE we partial-apply anything.
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
        // Drop finalize state — a regenerate is a "rewind" so surface state
        // should match the pre-finalize point.
        if (state.session.surfaceState) {
            state.session.surfaceState.isFinalized = false;
            state.session.surfaceState.finalizeSummary = '';
        }
        await persistSession();
        await render();
        const $textarea = $root.find('[data-cea-charit-input]');
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

        // Re-read live so a parallel edit doesn't blow the rollback away.
        await ensureLive(true);
        let working = state.live;
        // Build inverses up-front so an unsupported op fails BEFORE we
        // partial-apply anything. Right-to-left handles dependent edits.
        const inverses = [];
        for (const edit of msg.edits.slice().reverse()) {
            try {
                inverses.push(inverseEdit(edit));
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] inverseEdit failed`, edit, err);
                try { toastr.error(tf('Cannot rollback edit type: ${0}', String(edit?.op || 'unknown'))); } catch { /* ignore */ }
                return;
            }
        }
        try {
            const result = applyEdits(inverses, working);
            working = result?.newLive ?? working;
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] applyEdits(inverses) failed`, err);
            try { toastr.error(tf('Apply failed: ${0}', String(err?.message || err))); } catch { /* ignore */ }
            return;
        }
        state.live = working;
        try {
            await commitLiveToCharacter();
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] commit(rollback) failed`, err);
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
    // `luker_cea_charit_continue_iteration`, runIterationTurn returns
    // `wantsAutoContinue: true` and the loop fires another round (after
    // rendering the previous round so the user sees progressive output).
    // The ONLY exits are:
    //   1. The model called `luker_cea_charit_finalize_iteration`.
    //   2. The model did neither (e.g. produced edits + stopped).
    //   3. The user clicked Stop (abortController fires; isAbortError
    //      catches the resulting error in the catch block).
    //   4. The model is staging edits and the user hasn't applied them yet
    //      (pendingEdits non-empty halts the auto-continue so the user gets
    //      to apply before the next round mutates `live`).
    // There is NO hard round cap — runaway loops are the user's problem
    // and a single Stop click ends them.
    // ──────────────────────────────────────────────────────────────────
    async function handleSendMessage() {
        if (state.isBusy) {
            // Stop request: abort the in-flight runner call.
            try { state.abortController?.abort(); } catch { /* ignore */ }
            return;
        }
        if (state.session.surfaceState?.isFinalized) return;
        const $textarea = $root.find('[data-cea-charit-input]');
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
            while (turn?.wantsAutoContinue
                && state.pendingEdits.length === 0
                && !state.session.surfaceState?.isFinalized) {
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
    // Mount popup + bind events. The popup is DISPLAY-type (no built-in
    // OK / Cancel) and `wider` so the chat surface has breathing room.
    //
    // Event delegation lives on `$root` so re-renders that swap inner
    // HTML don't drop handlers. Handlers consume async work then call
    // `render()` themselves.
    // ──────────────────────────────────────────────────────────────────
    const popupId = `cea_charit_${avatar.replace(/[^a-zA-Z0-9_]/g, '_')}_${Date.now()}`;
    const popupHtml = buildPopupHtml({
        popupId,
        title: escapeHtml(t('Character Editor — AI iteration')),
        historyOpen: Boolean(state.session.surfaceState?.historyOpen),
        historyLabel: t('History'),
        newSessionLabel: t('New session'),
        clearAllLabel: t('Clear all'),
        sendLabel: t('Send'),
        composerPlaceholder: t('Type what to change...'),
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

    // Wire the iteration-library zoom overlay so the diff cards' Expand
    // button + splitter + Esc-key affordances work scoped to this popup.
    // Namespace is popup-unique so concurrent popups (rare but possible
    // if the user opens another studio) don't clobber each other.
    const zoomOverlayUnbind = ITER_ZOOM_OVERLAY.attachZoomOverlay($root[0], {
        namespace: `.ceaCharItDiff_${popupId}`,
        i18n: t,
    });

    // Initial live read + persist + render.
    await ensureLive();
    await sessionStore.save(state.session);

    // ── Delegated events ──────────────────────────────────────────────
    $root.on('click.ceaCharIt', '[data-cea-charit-action="send"]', async (e) => {
        e.preventDefault();
        await handleSendMessage();
    });

    // Q5: Plain Enter → newline (textarea default).
    //     Ctrl/Cmd-Enter → send.
    $root.on('keydown.ceaCharIt', '[data-cea-charit-input]', async (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            await handleSendMessage();
        }
    });

    // Q3: history details collapse state persists per-session.
    $root.on('toggle.ceaCharIt', '[data-cea-charit-history]', async (e) => {
        const open = Boolean(e.currentTarget?.open);
        state.session.surfaceState = { ...(state.session.surfaceState || {}), historyOpen: open };
        await persistSession();
    });

    $root.on('click.ceaCharIt', '[data-cea-charit-action="apply-pending"]', async (e) => {
        e.preventDefault();
        await applyPendingEdits();
    });
    $root.on('click.ceaCharIt', '[data-cea-charit-action="reject-pending"]', async (e) => {
        e.preventDefault();
        await rejectPendingEdits();
    });

    // Session-switch handlers — abort in-flight LLM + reset busy flag
    // before the swap so a stale response can't land in the newly-loaded
    // session.
    $root.on('click.ceaCharIt', '[data-cea-charit-action="new-session"]', async (e) => {
        e.preventDefault();
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.abortController = null;
        await startNewSession();
    });
    // Q9: clear-history lives inside the <details>; same delegation root.
    $root.on('click.ceaCharIt', '[data-cea-charit-action="clear-history"]', async (e) => {
        e.preventDefault();
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.abortController = null;
        await clearAllHistory();
    });
    $root.on('click.ceaCharIt', '[data-cea-charit-action="load-session"]', async (e) => {
        // The delete button is a child of the load row — stop the row's
        // click from firing when the user is removing an item.
        const target = e.target;
        if (target && target.matches?.('[data-cea-charit-action="delete-session"]')) return;
        const id = String(e.currentTarget?.dataset?.ceaCharitId || '');
        if (id && id !== state.session.id) {
            try { state.abortController?.abort(); } catch { /* ignore */ }
            state.isBusy = false;
            state.abortController = null;
            await loadSession(id);
        }
    });
    $root.on('click.ceaCharIt', '[data-cea-charit-action="delete-session"]', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = String(e.currentTarget?.dataset?.ceaCharitId || '');
        if (!id) return;
        // Deleting the active session also tears down any in-flight LLM
        // call so the response can't land in the recreated next session.
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
    // `data-cea-charit-custom-action` rather than `data-cea-charit-action`
    // so legacy delegation selectors can't accidentally fire on these —
    // matches the iter-studio shell gotcha pattern.
    $root.on('click.ceaCharIt', '[data-cea-charit-custom-action="regenerate"]', async (e) => {
        e.preventDefault();
        const msgId = String(e.currentTarget?.dataset?.ceaCharitMsgId || '');
        if (!msgId) return;
        await regenerateFromMessage(msgId);
    });
    $root.on('click.ceaCharIt', '[data-cea-charit-custom-action="rollback-batch"]', async (e) => {
        e.preventDefault();
        const msgId = String(e.currentTarget?.dataset?.ceaCharitMsgId || '');
        if (!msgId) return;
        await rollbackBatch(msgId);
    });

    // ── Workspace events ──────────────────────────────────────────────
    // Mobile tab switcher — only relevant when the < 900px media query
    // collapses the grid; on desktop both panes are mounted simultaneously
    // and the tab bar is hidden via CSS.
    $root.on('click.ceaCharIt', '[data-iter-action="switch-tab"]', (e) => {
        const tab = e.currentTarget?.dataset?.iterTab;
        if (!tab) return;
        e.preventDefault();
        setActiveTab(tab);
    });

    // Composer-row auto-apply toggle. Persists per-session via surfaceState.
    // Toggling ON when edits are already pending applies them immediately,
    // matching CPA / Orchestrator's existing behavior.
    $root.on('change.ceaCharIt', '[data-cea-charit-action="toggle-auto-apply"]', async (e) => {
        const checked = Boolean(e.currentTarget?.checked);
        state.session.surfaceState = {
            ...(state.session.surfaceState || {}),
            autoApply: checked,
        };
        await persistSession();
        if (checked && state.pendingEdits.length > 0 && !state.session.surfaceState?.isFinalized) {
            try {
                await applyPendingEdits();
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] auto-apply on toggle failed`, err);
            }
        }
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
