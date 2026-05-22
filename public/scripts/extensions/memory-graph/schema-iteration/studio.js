// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Memory Graph Schema — AI iteration popup (plugin-owned).
 *
 * Stage 4 replacement for the legacy iteration-studio adapter
 * (`schema-adapter.js`). Single-column chat surface that wires
 * `iteration-library/*` helpers directly:
 *   - storage  (global-scoped MG session bucket via `session-store.js`)
 *   - runner   (`requestToolCallsWithRetry` from `lib/iter-tool-calling.js`)
 *   - render   (Markdown rendering for assistant messages)
 *   - edits    (`applyEdits` from `lib/edits/`)
 *
 * Layout per sub-spec §4 (Q10 N/A for MG — no reference picker, no mode):
 *
 *   ┌────────────────────────────────────────────┐
 *   │ <details> History … New, Clear </details>  │
 *   │ <div> message list (chat)         </div>   │
 *   │ <div> pending edits (when staged) </div>   │
 *   │ <div> composer textarea + Send    </div>   │
 *   └────────────────────────────────────────────┘
 *
 * The popup is mounted via `new Popup(..., POPUP_TYPE.DISPLAY)` so it has no
 * built-in OK / Cancel buttons; the user dismisses it via the dialog's close
 * button (top-right ✕). Sessions auto-persist on every mutation, so closing
 * mid-conversation is safe.
 *
 * MG-distinctive piece — schema-array-diff (Q8):
 *   The three MG tools (set / remove / reorder node type) all go through the
 *   sandbox-diff pattern in tools.js, which emits a single coarse
 *   `set('', newSchema)` edit per tool call. The pending-edit card therefore
 *   renders an array-diff (added / removed / modified type ids) rather than
 *   the generic `<op> <path>` line that the other plugins use.
 *
 * Entry point:
 *   `openSchemaIterationStudio(deps)`
 *
 * Deps shape:
 *   - context                          SillyTavern context
 *   - settings                         MG settings reference (extension_settings.memory_graph)
 *   - root                             jQuery root for refreshRootUi callback
 *   - normalizeNodeTypeSchema(input)   pure normalizer (primitives.js)
 *   - getEffectiveNodeTypeSchema(ctx, settings)
 *                                       reads schema; per-character override falls through to global
 *   - persistCharacterSchemaOverride(ctx, avatar, normalized)
 *                                       writes per-character override; returns ok/false
 *   - saveSettings()                   persists global settings
 *   - i18n, i18nFormat
 *   - refreshRootUi(uiRoot)            called after each commit to refresh parent UI
 */

import { Popup, POPUP_TYPE } from '../../../popup.js';
import {
    applyEdits,
    bindIterWorkspaceResizer,
    render as ITER_RENDER,
    runner as ITER_RUNNER,
    textDiff as ITER_TEXT_DIFF,
    zoomOverlay as ITER_ZOOM_OVERLAY,
} from '../../../iteration-library/index.js';
import { TOOL_DEFS, TOOL_DISPLAY, normalizeToolCallToEdit } from './tools.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createMgSchemaSessionStore } from './session-store.js';

const MODULE = 'mg-schema-iteration';
const STYLESHEET_ID = 'mg_schema_it_studio_stylesheet';
const STYLESHEET_HREF = '/scripts/extensions/memory-graph/schema-iteration/studio.css';

/**
 * Inject the popup stylesheet on first open. Subsequent opens are no-ops
 * because the link element is reused (id-keyed lookup). Loading is async
 * but the popup doesn't block on it — the first paint may be unstyled for
 * a tick before the browser applies the freshly-injected rules, which is
 * the same trade-off the other plugin-owned popups make.
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
 * Local HTML escape for building the static popup shell + per-render
 * content. MG main.js doesn't ship a deps.escapeHtml, so this is the
 * authoritative escaper for the popup.
 */
function escapeHtmlLocal(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function makeSessionId() {
    return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Workspace preview-pane renderer + diff helpers (file-local).
//
// These run at module scope (not inside `openSchemaIterationStudio`) so unit
// tests can import `_testOnly_renderMgSchemaPreviewPane` directly without
// instantiating the popup. The renderer is pure: given `live` (schema array)
// + pending edits, return preview HTML. Snippets B + C from the
// implementation plan; duplicated rather than extracted per spec §B because
// the other 4 popups (CPA / Orchestrator / CEA char / CEA editor) each get
// their own copy.
//
// MG sandbox-diff caveat: a single tool call produces one coarse
// `set('', newSchema)` edit. `computeChangedPathSet` therefore returns
// `Set([''])` for any non-empty edit batch; the renderer must fall back to
// per-category JSON equality to figure out which row is actually changed.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Apply a single coarse `{ op: 'set', path: '', newValue }` edit by replacing
 * `live` outright with a deep clone of `newValue`. The shared `applyEdits`
 * engine is lodash-backed and `lodash.set(target, '', value)` is a no-op, so
 * sandbox-diff edits would otherwise silently skip — leaving both the manual
 * Apply button and composer-row auto-apply as UI-only with no commit. Pure
 * function; caller owns the resulting object.
 *
 * @param {*} _live   Current live value (unused; only the new value matters
 *                    when the engine emits a full-replacement edit).
 * @param {{op:string, path:string, newValue:*}} edit  The empty-path set edit.
 * @returns {*} A `structuredClone` of `edit.newValue`.
 */
function applyEmptyPathSet(_live, edit) {
    return structuredClone(edit.newValue);
}

function computeChangedPathSet(live, pendingEdits) {
    if (!Array.isArray(pendingEdits) || pendingEdits.length === 0) return new Set();
    // MG sandbox-diff emits `{ op: 'set', path: '', oldValue, newValue }` for
    // every tool call. The engine's lodash-backed apply treats path=='' as a
    // no-op (lodash.set on empty path), and detectConflict reports
    // `value_drifted`. To get a usable diff for the preview, short-circuit:
    // if any edit has `path === ''` and a `newValue`, walk `live` vs that
    // value directly. This bypass is renderer-local — the actual apply path
    // is unaffected.
    const emptyPathEdit = pendingEdits.find(e => e?.op === 'set' && e?.path === '' && typeof e?.newValue !== 'undefined');
    if (emptyPathEdit) {
        const changed = new Set();
        walkDiff('', live, emptyPathEdit.newValue, changed);
        return changed;
    }
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
 * Render the right-pane HTML for the MG schema workspace preview. Pure
 * function. Tolerates both the unit-test fixture shape (`name`, `fields[]`
 * objects) and the real production shape (`label`, `tableColumns[]` strings)
 * — the latter is what `normalizeNodeTypeSchema` actually emits.
 *
 * @param {Array|null} live         The current schema array, or null.
 * @param {Array} pendingEdits      Edits from the latest LLM round.
 * @param {Function} [tFn]          Optional i18n function (string → string).
 * @returns {string} HTML.
 */
function renderMgSchemaPreviewPane(live, pendingEdits, tFn) {
    const t = typeof tFn === 'function' ? tFn : (s) => String(s ?? '');
    if (!live || (Array.isArray(live) && live.length === 0)) {
        return `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No schema loaded.'))}</div>`;
    }
    const edits = Array.isArray(pendingEdits) ? pendingEdits : [];
    const changed = computeChangedPathSet(live, edits);
    let next = live;
    const emptyPathEdit = edits.find(e => e?.op === 'set' && e?.path === '' && typeof e?.newValue !== 'undefined');
    if (emptyPathEdit) {
        next = emptyPathEdit.newValue;
    } else {
        try {
            if (edits.length > 0) {
                const cloned = structuredClone(live);
                const r = applyEdits(edits, cloned);
                next = r?.newLive ?? cloned;
            }
        } catch { /* fall back to live */ }
    }

    const categories = Array.isArray(live) ? live : [];
    // For MG sandbox-diff: any change marks the whole schema dirty;
    // also do a per-category JSON-equality check against `next`.
    function categoryChanged(cat, idx) {
        if (changed.size === 0) return false;
        if (!changed.has('')) {
            // Granular diff was emitted — defer to it.
            // Any path starting with the category index counts.
            for (const p of changed) {
                if (p === '' || p === String(idx) || p.startsWith(`${idx}.`)) return true;
            }
            return false;
        }
        // Coarse sandbox-diff: compare this category against the corresponding
        // slot in `next` (matched by id when possible, else by index).
        let nextCat = null;
        if (Array.isArray(next)) {
            const id = cat?.id;
            if (id) {
                nextCat = next.find(c => c?.id === id) || null;
            }
            if (!nextCat) {
                nextCat = next[idx] || null;
            }
        }
        try { return JSON.stringify(cat) !== JSON.stringify(nextCat); } catch { return true; }
    }

    function fieldEntries(cat) {
        if (Array.isArray(cat?.fields)) return cat.fields;
        if (Array.isArray(cat?.tableColumns)) {
            return cat.tableColumns.map((col) => ({
                id: col,
                label: col,
                type: 'string',
                description: '',
            }));
        }
        return [];
    }

    const catBlocks = categories.slice(0, 50).map((cat, idx) => {
        const isChanged = categoryChanged(cat, idx);
        const cls = isChanged
            ? 'luker-iter-workspace-preview-row pending-change'
            : 'luker-iter-workspace-preview-row';
        const fields = fieldEntries(cat);
        const fieldRows = fields.slice(0, 30).map((f) => {
            const fid = typeof f === 'string' ? f : (f?.id || '');
            const label = typeof f === 'string' ? f : (f?.label || '');
            const type = typeof f === 'string' ? 'string' : (f?.type || '');
            const desc = truncateForPreview(typeof f === 'string' ? '' : (f?.description || ''), 80);
            return `<div class="luker-iter-workspace-preview-row-body" style="margin:2px 0 2px 12px;">${escapeHtmlLocal(fid)} <span class="luker-iter-workspace-preview-row-meta">[${escapeHtmlLocal(type)}]</span> - ${escapeHtmlLocal(label)}${desc ? `<br><span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(desc)}</span>` : ''}</div>`;
        }).join('');
        const catName = cat?.name || cat?.label || cat?.id || '?';
        const fieldCount = fields.length;
        const fieldsTpl = t('${0} fields');
        const fieldsLabel = String(fieldsTpl).replace(/\$\{(\d+)\}/g, (_, i) => Number(i) === 0 ? String(fieldCount) : '');
        return `<details class="${cls}"${idx < 5 ? ' open' : ''}><summary><span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(catName)}</span> <span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(fieldsLabel)}</span></summary>${fieldRows}</details>`;
    }).join('');

    return `
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Schema'))}</div>
            ${catBlocks}
        </div>
    `;
}

export {
    renderMgSchemaPreviewPane as _testOnly_renderMgSchemaPreviewPane,
    applyEmptyPathSet as _testOnly_applyEmptyPathSet,
};

function createNewSession() {
    const now = Date.now();
    return {
        id: makeSessionId(),
        title: '',
        messages: [],
        surfaceState: { historyOpen: false, autoApply: false },
        updatedAt: now,
        createdAt: now,
        summary: '',
    };
}

/**
 * Build the popup root HTML. Built once on open; per-render mutations scope
 * to subordinate `[data-mg-schema-it-*]` slots so we never re-mount the
 * textarea (which would lose focus + the in-progress draft).
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
<div id="${popupId}" class="mg_schema_it_popup luker-iter-workspace" data-iter-layout="split" data-iter-active-tab="chat">
    <div class="mg_schema_it_title">${escapeHtmlLocal(title)}</div>
    <details class="mg_schema_it_history" data-mg-schema-it-history${historyOpen ? ' open' : ''}>
        <summary>${escapeHtmlLocal(historyLabel)}</summary>
        <div class="mg_schema_it_history_items" data-mg-schema-it-history-items></div>
        <div class="mg_schema_it_history_actions">
            <button class="menu_button menu_button_small" data-mg-schema-it-action="new-session">${escapeHtmlLocal(newSessionLabel)}</button>
            <button class="menu_button menu_button_small" data-mg-schema-it-action="clear-history">${escapeHtmlLocal(clearAllLabel)}</button>
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
            <div class="mg_schema_it_messages" data-mg-schema-it-messages></div>
            <div class="mg_schema_it_pending" data-mg-schema-it-pending hidden></div>
            <div class="mg_schema_it_composer">
                <textarea class="text_pole" rows="2" data-mg-schema-it-input placeholder="${escapeHtmlLocal(composerPlaceholder)}"></textarea>
                <div class="mg_schema_it_composer_actions">
                    <label class="mg_schema_it_composer_auto_apply">
                        <input type="checkbox" data-mg-schema-it-action="toggle-auto-apply"${autoApply ? ' checked' : ''}>
                        <span>${escapeHtmlLocal(autoApplyLabel)}</span>
                    </label>
                    <div class="mg_schema_it_composer_buttons">
                        <button class="menu_button" data-mg-schema-it-action="send">${escapeHtmlLocal(sendLabel)}</button>
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
 * Open the Memory Graph schema AI iteration popup.
 *
 * Resolves when the user dismisses the dialog. Sessions are persisted eagerly
 * on every mutation so dismiss-without-save is irrelevant.
 *
 * @param {object} deps See module header for shape.
 */
export async function openSchemaIterationStudio(deps) {
    if (!deps || typeof deps !== 'object') {
        throw new TypeError('openSchemaIterationStudio: deps is required');
    }
    const {
        context,
        settings,
        root,
        normalizeNodeTypeSchema,
        getEffectiveNodeTypeSchema,
        persistCharacterSchemaOverride,
        saveSettings,
        i18n,
        refreshRootUi,
    } = deps;

    if (typeof normalizeNodeTypeSchema !== 'function') {
        throw new TypeError('openSchemaIterationStudio: deps.normalizeNodeTypeSchema is required');
    }
    if (typeof getEffectiveNodeTypeSchema !== 'function') {
        throw new TypeError('openSchemaIterationStudio: deps.getEffectiveNodeTypeSchema is required');
    }
    if (typeof saveSettings !== 'function') {
        throw new TypeError('openSchemaIterationStudio: deps.saveSettings is required');
    }

    const t = typeof i18n === 'function' ? i18n : (s) => String(s ?? '');

    // Inject the popup stylesheet on first open. Idempotent; subsequent
    // calls are no-ops because the <link> element is id-keyed.
    ensureStylesheetInjected();

    // ──────────────────────────────────────────────────────────────────
    // Session store — global-scoped MG bucket
    // (`extension_settings.memory_graph[SESSIONS_BUCKET_KEY]`).
    // Persistence flushes through deps.saveSettings (which is the host's
    // `saveSettings` from script.js; it covers both the eager and the
    // debounced paths internally).
    // ──────────────────────────────────────────────────────────────────
    const sessionStore = createMgSchemaSessionStore({
        getMgSettingsRoot: () => settings || {},
        persistSettings: () => {
            // Fire-and-forget; the session store calls this synchronously after
            // each save/delete, so we don't await here. The host's saveSettings
            // is debounced under the hood; the popup's own commit path awaits
            // saveSettings() separately, so this overlap is intentional.
            try { saveSettings(); } catch { /* host save errors surface elsewhere */ }
        },
    });
    await sessionStore.clearObsolete();

    // Prime markdown deps so the first paint has formatted messages
    // rather than escaped fallback (`ensureMarkdownDeps` caches).
    await ITER_RENDER.ensureMarkdownDeps();

    // ──────────────────────────────────────────────────────────────────
    // Closure-local state. `live` is the schema array (not an object like
    // CEA Character's card+lorebook); the MG sandbox-diff pattern operates
    // on it directly. `pendingEdits` always contains 0 or 1 entries since
    // the sandbox-diff emits one coarse `set('', newSchema)` per tool call
    // (and Apply collapses them all in one shot).
    // ──────────────────────────────────────────────────────────────────
    const state = {
        session: createNewSession(),
        live: [],
        pendingEdits: [],
        isBusy: false,
        abortController: null,
    };

    // ──────────────────────────────────────────────────────────────────
    // Live state — re-read on each turn so external edits (user manually
    // swaps a character that has a different override) show up in the
    // next sandbox-diff's `oldValue` capture.
    // ──────────────────────────────────────────────────────────────────
    async function loadLive() {
        const effective = getEffectiveNodeTypeSchema(context, settings);
        state.live = normalizeNodeTypeSchema(effective);
    }

    // ──────────────────────────────────────────────────────────────────
    // Commit live → MG settings. Ported from schema-adapter.js L190-L204:
    // when a character is active, write to per-character override; else
    // fall through to global. After commit, deps.refreshRootUi refreshes
    // the schema summary / scope indicator in the host UI.
    // ──────────────────────────────────────────────────────────────────
    async function commitLiveToSchema() {
        const normalized = normalizeNodeTypeSchema(state.live);
        const avatar = String(context?.characters?.[context?.characterId]?.avatar || '').trim();
        if (avatar && typeof persistCharacterSchemaOverride === 'function') {
            const ok = await persistCharacterSchemaOverride(context, avatar, normalized);
            if (ok) {
                try { refreshRootUi?.(root); } catch { /* host UI refresh errors surface elsewhere */ }
                return;
            }
            // Fall through to global if the override write was rejected.
        }
        settings.nodeTypeSchema = normalized;
        await saveSettings();
        try { refreshRootUi?.(root); } catch { /* ignore */ }
    }

    // ──────────────────────────────────────────────────────────────────
    // Persistence. Session carries the latest surfaceState, messages, and
    // a derived title (first 50 chars of the first user message).
    // ──────────────────────────────────────────────────────────────────
    async function persistSession() {
        state.session.updatedAt = Date.now();
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
        const surface = loaded.surfaceState || {};
        state.session = {
            ...loaded,
            surfaceState: {
                historyOpen: !!surface.historyOpen,
                autoApply: !!surface.autoApply,
            },
        };
        state.pendingEdits = [];
        await render();
    }

    async function startNewSession() {
        state.session = createNewSession();
        state.pendingEdits = [];
        await sessionStore.save(state.session);
        await render();
    }

    async function clearAllHistory() {
        // eslint-disable-next-line no-alert
        if (!confirm(t('Clear all session history?'))) return;
        const metas = await sessionStore.list();
        for (const meta of metas) {
            await sessionStore.delete(meta.id);
        }
        await startNewSession();
    }

    // ──────────────────────────────────────────────────────────────────
    // Schema-array diff renderer — Q8.
    //
    // MG tools all go through the sandbox-diff pattern, which means a tool
    // call produces a single `set('', newSchema)` edit. The legacy
    // adapter-driven popup would have shown that as "SET  : <huge JSON>"
    // which is useless; instead we compare the before/after by id and
    // emit added/removed/modified counts plus the id lists.
    //
    // For modified entries we additionally embed a per-entry JSON diff
    // rendered by the iteration-library so the user can see exactly which
    // fields changed inside the entry, surrounded by context.
    // ──────────────────────────────────────────────────────────────────
    function renderPerEntryJsonDiff(beforeEntry, afterEntry, id) {
        const beforeJson = JSON.stringify(beforeEntry ?? null, null, 2);
        const afterJson = JSON.stringify(afterEntry ?? null, null, 2);
        return ITER_TEXT_DIFF.renderInlineTextDiffHtml(beforeJson, afterJson, {
            fileLabel: `nodeTypeSchema entry: ${id}`,
            i18n: t,
            forceOpen: true,
        });
    }

    function renderSchemaArrayDiff(before, after) {
        const beforeIds = new Map((Array.isArray(before) ? before : []).map(t => [String(t?.id || ''), t]));
        const afterIds = new Map((Array.isArray(after) ? after : []).map(t => [String(t?.id || ''), t]));
        const added = [...afterIds.keys()].filter(id => id && !beforeIds.has(id));
        const removed = [...beforeIds.keys()].filter(id => id && !afterIds.has(id));
        const modified = [...afterIds.keys()].filter(id => {
            if (!id || !beforeIds.has(id)) return false;
            // Stable stringify is overkill here — both sides come from the
            // same normalizer (tools.js calls normalizeNodeTypeSchema before
            // emitting the edit), so key order matches.
            return JSON.stringify(beforeIds.get(id)) !== JSON.stringify(afterIds.get(id));
        });
        const parts = [];
        if (added.length > 0) {
            parts.push(`<div><span class="diff_new">${escapeHtmlLocal(t('added'))} (${added.length}):</span> ${added.map(escapeHtmlLocal).join(', ')}</div>`);
        }
        if (removed.length > 0) {
            parts.push(`<div><span class="diff_old">${escapeHtmlLocal(t('removed'))} (${removed.length}):</span> ${removed.map(escapeHtmlLocal).join(', ')}</div>`);
        }
        if (modified.length > 0) {
            parts.push(`<div><span class="op">${escapeHtmlLocal(t('modified'))} (${modified.length}):</span> ${modified.map(escapeHtmlLocal).join(', ')}</div>`);
            for (const id of modified) {
                parts.push(`<details class="mg_schema_it_pending_entry_diff">
                    <summary><code>${escapeHtmlLocal(id)}</code></summary>
                    ${renderPerEntryJsonDiff(beforeIds.get(id), afterIds.get(id), id)}
                </details>`);
            }
        }
        if (parts.length === 0) {
            parts.push(`<div class="mg_schema_it_pending_note">${escapeHtmlLocal(t('(no effective change)'))}</div>`);
        }
        return `<div class="mg_schema_it_pending_card">${parts.join('')}</div>`;
    }

    function renderPendingEditCard(edit) {
        if (edit?.op === 'set' && edit?.path === ''
            && Array.isArray(edit.oldValue) && Array.isArray(edit.newValue)) {
            return renderSchemaArrayDiff(edit.oldValue, edit.newValue);
        }
        // Defensive fallback — MG normally only emits bulk-set edits
        // through tools.js, but a future refactor could introduce
        // fine-grained ops; surface them with the same `<op> <path>` line
        // the other plugin-owned popups use.
        return `<div class="mg_schema_it_pending_card">
            <span class="op">${escapeHtmlLocal(String(edit?.op || t('(unknown op)')))}</span>
            <code>${escapeHtmlLocal(String(edit?.path || ''))}</code>
        </div>`;
    }

    // ──────────────────────────────────────────────────────────────────
    // Chat-message rendering. Q2 + Q7:
    //   - assistant messages route through the library's markdown
    //     renderer (`render.renderMessageMarkdown`) which sanitizes via
    //     DOMPurify, so embedding via `innerHTML` is XSS-safe.
    //   - user / assistant / system messages get distinct CSS classes for
    //     visual distinction (alignment, background, etc.).
    // ──────────────────────────────────────────────────────────────────
    function renderMessage(message) {
        const role = String(message?.role || 'user');
        const content = message?.content || '';
        let bodyHtml;
        if (role === 'assistant') {
            // sanitized by DOMPurify inside renderMessageMarkdown
            bodyHtml = ITER_RENDER.renderMessageMarkdown(content);
        } else {
            bodyHtml = escapeHtmlLocal(String(content)).replace(/\n/g, '<br>');
        }
        const roleCls = role === 'user'
            ? 'mg_schema_it_msg_user'
            : role === 'assistant'
                ? 'mg_schema_it_msg_assistant'
                : 'mg_schema_it_msg_system';
        return `<div class="mg_schema_it_msg ${roleCls}">${bodyHtml}</div>`;
    }

    function renderHistoryItem(meta) {
        const id = String(meta?.id || '');
        const title = String(meta?.title || meta?.id || '');
        const active = id === state.session.id ? ' mg_schema_it_history_item_active' : '';
        return `<div class="mg_schema_it_history_item${active}" data-mg-schema-it-action="load-session" data-mg-schema-it-id="${escapeHtmlLocal(id)}">
            <span class="mg_schema_it_history_title">${escapeHtmlLocal(title || t('(untitled)'))}</span>
            <button class="mg_schema_it_history_delete" data-mg-schema-it-action="delete-session" data-mg-schema-it-id="${escapeHtmlLocal(id)}" title="${escapeHtmlLocal(t('Delete this session'))}">×</button>
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
        // History details: sync open state without firing toggle handler.
        const $history = $root.find('[data-mg-schema-it-history]');
        if ($history.length) {
            const wantOpen = Boolean(state.session.surfaceState?.historyOpen);
            if ($history.prop('open') !== wantOpen) {
                $history.prop('open', wantOpen);
            }
        }
        const metas = await sessionStore.list();
        const historyHtml = metas.map(renderHistoryItem).join('')
            || `<div class="mg_schema_it_history_empty">${escapeHtmlLocal(t('No saved sessions'))}</div>`;
        $root.find('[data-mg-schema-it-history-items]').html(historyHtml);

        // Messages
        const messagesHtml = (state.session.messages || []).map(renderMessage).join('');
        const $msgs = $root.find('[data-mg-schema-it-messages]');
        $msgs.html(messagesHtml);
        // Auto-scroll to bottom so newly-appended messages are visible.
        try {
            const node = $msgs[0];
            if (node && typeof node.scrollTop === 'number') {
                node.scrollTop = node.scrollHeight;
            }
        } catch { /* DOM not attached (test) */ }

        // Pending edits
        const $pending = $root.find('[data-mg-schema-it-pending]');
        if (state.pendingEdits.length > 0) {
            const cardsHtml = state.pendingEdits.map(renderPendingEditCard).join('');
            $pending.html(`
                <div class="mg_schema_it_pending_title">${escapeHtmlLocal(t('Pending changes'))}</div>
                <div class="mg_schema_it_pending_list">${cardsHtml}</div>
                <div class="mg_schema_it_pending_actions">
                    <button class="menu_button" data-mg-schema-it-action="apply-edits">${escapeHtmlLocal(t('Apply'))}</button>
                    <button class="menu_button" data-mg-schema-it-action="discard-edits">${escapeHtmlLocal(t('Discard'))}</button>
                </div>
            `).show().attr('hidden', null);
        } else {
            $pending.html('').hide().attr('hidden', '');
        }

        // Send / Stop button label
        const $sendBtn = $root.find('[data-mg-schema-it-action="send"]');
        $sendBtn.text(state.isBusy ? t('Stop') : t('Send'));

        // Workspace preview pane. Wrapped in try/catch so a malformed live
        // schema or edit shape can't blank the workspace.
        try {
            const $previewPane = $root.find('[data-iter-preview-pane]');
            if ($previewPane.length) {
                const previewHtml = renderMgSchemaPreviewPane(
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
    // Runner integration. The runner returns tool calls in the shape
    // `{ name, args, raw }`. `tools.js#normalizeToolCallToEdit` expects
    // OpenAI shape (`call.function.name`, `call.function.arguments` as
    // JSON string), so we wrap each call before normalizing.
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
     * Build the augmented user prompt — mirrors the legacy adapter's
     * `buildUserPrompt` (schema-adapter.js L446-L465). Injects:
     *   - iteration scope (character override vs global)
     *   - current working schema (JSON, what the AI is editing)
     *   - global baseline schema (only when it differs from the current)
     *   - the user's actual request
     * The model sees this as part of the conversation so it doesn't have
     * to call tools just to see what's already there.
     */
    function stringifyForPrompt(value) {
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }

    function buildAugmentedUserPrompt(userText) {
        const avatar = String(context?.characters?.[context?.characterId]?.avatar || '').trim();
        const sourceScope = avatar ? 'character' : 'global';
        const characterName = avatar
            ? String(context?.characters?.[context?.characterId]?.name || avatar)
            : '';
        const currentSchema = stringifyForPrompt(state.live);
        const baselineSchema = stringifyForPrompt(normalizeNodeTypeSchema(settings?.nodeTypeSchema || []));
        const lines = [
            `[Iteration scope] ${sourceScope}${characterName ? ` — ${characterName}` : ''}`,
            '',
            '[Current working schema]',
            currentSchema,
        ];
        if (baselineSchema && baselineSchema !== currentSchema) {
            lines.push('', '[Global baseline schema for reference]', baselineSchema);
        }
        lines.push('', '[User request]', String(userText || '').trim());
        return lines.join('\n');
    }

    /**
     * Build the conversation history sent to the runner. Replays prior
     * user/assistant turns so the model has context. Only the last user
     * turn gets the augmented schema-outline prefix so the prompt budget
     * doesn't bloat on every turn.
     */
    function buildTaskMessages(systemPrompt) {
        const messages = [{ role: 'system', content: systemPrompt }];
        const history = (state.session.messages || []).filter(m => {
            const role = String(m?.role || '').toLowerCase();
            return role === 'user' || role === 'assistant';
        });
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

    async function runIterationTurn() {
        const ac = new AbortController();
        state.abortController = ac;

        await loadLive();   // re-read so the next batch sees external edits

        const systemPrompt = buildSystemPrompt();
        const taskMessages = buildTaskMessages(systemPrompt);

        const apiPresetName = String(settings?.schemaIterationApiPresetName || '').trim();
        const llmPresetName = String(settings?.schemaIterationPresetName || '').trim();

        const runnerSettings = {
            useStreamingTransport: Boolean(settings?.useStreamingTransport),
            toolCallRetryMax: settings?.toolCallRetryMax,
            rpmLimit: settings?.rpmLimit,
        };

        const result = await ITER_RUNNER.requestToolCallsWithRetry(
            context,
            runnerSettings,
            {
                taskMessages,
                runtimeWorldInfo: null,
                apiPresetName,
                llmPresetName,
                tools: TOOL_DEFS,
                abortSignal: ac.signal,
                includeAssistantText: true,
                allowNoToolCalls: true,
            },
        );

        const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
        const assistantText = String(result?.assistantText || '').trim();

        // Normalize tool calls → edits. The MG sandbox-diff emits one bulk
        // `set('', newSchema)` per call; multiple calls in the same turn
        // would stack as separate edits, but Apply collapses them via
        // applyEdits's sequential application.
        const edits = [];
        for (const call of toolCalls) {
            const normalized = await normalizeToolCallToEdit(
                wrapToolCallForNormalize(call),
                {
                    live: state.live,
                    normalizeNodeTypeSchema,
                },
            );
            if (Array.isArray(normalized)) {
                edits.push(...normalized);
            }
            // null (executor failure) → skip silently; the AI can retry.
        }
        state.pendingEdits = edits;

        // Push assistant message. If the model returned text, use it; if
        // not but produced tool calls, synthesize a brief stand-in so the
        // chat doesn't have empty bubbles between user inputs.
        if (assistantText) {
            state.session.messages.push({ role: 'assistant', content: assistantText });
        } else if (toolCalls.length > 0) {
            const names = toolCalls.map(c => TOOL_DISPLAY[String(c?.name || '')] || String(c?.name || '')).join(', ');
            state.session.messages.push({
                role: 'assistant',
                content: t('Suggested actions: ') + names,
            });
        }

        // Mobile workspace: if the user was on the Preview tab, bump the
        // chat-tab badge so they know new assistant content arrived without
        // forcing a tab switch.
        bumpChatBadge();

        // Composer-row auto-apply: if enabled AND this turn produced edits,
        // apply immediately. Errors are caught locally so the runner's
        // outer finally still resets isBusy + persists the session.
        const autoApplyOn = Boolean(state.session.surfaceState?.autoApply);
        if (autoApplyOn && state.pendingEdits.length > 0) {
            try {
                await applyPendingEdits();
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] auto-apply failed`, err);
            }
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Apply pending edits. `applyEdits(edits, live)` returns
    // `{ newLive, clean, conflicts, alreadyDone }`. Per sub-spec §6 / §9
    // we do NOT surface a conflict UI: just commit `newLive` and silently
    // drop any conflicting / already-done edits. The pre-call live is
    // re-read so a parallel editor (e.g. user swapped characters) doesn't
    // blow away their work.
    // ──────────────────────────────────────────────────────────────────
    async function applyPendingEdits() {
        if (state.pendingEdits.length === 0) return;
        await loadLive();
        // Sandbox-diff emits a single coarse {op:'set', path:'', newValue:<whole schema>}.
        // lodash.set with empty path is a no-op, so route empty-path edits
        // around the engine via applyEmptyPathSet — otherwise auto-apply and
        // the manual Apply button both silently skip the commit.
        const onlyEdit = state.pendingEdits.length === 1 ? state.pendingEdits[0] : null;
        const emptyPathEdit = onlyEdit && onlyEdit.op === 'set' && onlyEdit.path === '' && typeof onlyEdit.newValue !== 'undefined'
            ? onlyEdit
            : null;
        if (emptyPathEdit) {
            state.live = applyEmptyPathSet(state.live, emptyPathEdit);
        } else {
            const result = applyEdits(state.pendingEdits, state.live);
            state.live = result?.newLive ?? state.live;
        }
        state.pendingEdits = [];
        try {
            await commitLiveToSchema();
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] commitLiveToSchema failed`, err);
            state.session.messages.push({
                role: 'system',
                content: t('Failed to save schema: ') + String(err?.message || err),
            });
        }
        await persistSession();
        await render();
    }

    async function discardPendingEdits() {
        state.pendingEdits = [];
        await render();
    }

    // ──────────────────────────────────────────────────────────────────
    // Send-message handler. Q6: user message is pushed AND rendered
    // BEFORE the await so the user sees their own input before the LLM
    // wait spinner starts. Errors surface as system messages.
    // ──────────────────────────────────────────────────────────────────
    async function handleSendMessage() {
        if (state.isBusy) {
            // Stop request: abort the in-flight runner call.
            try { state.abortController?.abort(); } catch { /* ignore */ }
            return;
        }
        const $textarea = $root.find('[data-mg-schema-it-input]');
        const text = String($textarea.val() || '').trim();
        if (!text) return;
        $textarea.val('');
        state.session.messages.push({ role: 'user', content: text });
        state.isBusy = true;
        await persistSession();
        await render();   // Q6: user message visible before LLM wait
        try {
            await runIterationTurn();
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}]`, err);
            state.session.messages.push({
                role: 'system',
                content: t('Error: ') + String(err?.message || err),
            });
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
    // HTML don't drop handlers.
    // ──────────────────────────────────────────────────────────────────
    await loadLive();

    const popupId = `mg_schema_it_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const popupHtml = buildPopupHtml({
        popupId,
        title: t('Memory Graph Schema Studio'),
        historyOpen: Boolean(state.session.surfaceState?.historyOpen),
        historyLabel: t('History'),
        newSessionLabel: t('New session'),
        clearAllLabel: t('Clear all'),
        sendLabel: t('Send'),
        composerPlaceholder: t('Describe what to change in the schema...'),
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

    // Wire the iteration-library zoom overlay so per-entry JSON diff
    // Expand button + splitter + Esc-key affordances work scoped to
    // this popup.
    const zoomOverlayUnbind = ITER_ZOOM_OVERLAY.attachZoomOverlay($root[0], {
        namespace: `.mgSchemaItDiff_${popupId}`,
        i18n: t,
    });

    // Initial persist so the session shows up in the history list right
    // away (the user might dismiss without sending a message and still
    // want the empty session as a checkpoint).
    await sessionStore.save(state.session);

    // ── Delegated events ──────────────────────────────────────────────
    $root.on('click.mgSchemaIt', '[data-mg-schema-it-action="send"]', async (e) => {
        e.preventDefault();
        await handleSendMessage();
    });

    // Q5: Plain Enter → newline (textarea default).
    //     Ctrl/Cmd-Enter → send.
    $root.on('keydown.mgSchemaIt', '[data-mg-schema-it-input]', async (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            await handleSendMessage();
        }
    });

    // Q3: history details collapse state persists per-session.
    $root.on('toggle.mgSchemaIt', '[data-mg-schema-it-history]', async (e) => {
        const open = Boolean(e.currentTarget?.open);
        state.session.surfaceState = { ...(state.session.surfaceState || {}), historyOpen: open };
        await persistSession();
    });

    $root.on('click.mgSchemaIt', '[data-mg-schema-it-action="apply-edits"]', async (e) => {
        e.preventDefault();
        await applyPendingEdits();
    });
    $root.on('click.mgSchemaIt', '[data-mg-schema-it-action="discard-edits"]', async (e) => {
        e.preventDefault();
        await discardPendingEdits();
    });
    $root.on('click.mgSchemaIt', '[data-mg-schema-it-action="new-session"]', async (e) => {
        e.preventDefault();
        await startNewSession();
    });
    // Q9: clear-history lives inside the <details>; same delegation root.
    $root.on('click.mgSchemaIt', '[data-mg-schema-it-action="clear-history"]', async (e) => {
        e.preventDefault();
        await clearAllHistory();
    });
    $root.on('click.mgSchemaIt', '[data-mg-schema-it-action="load-session"]', async (e) => {
        // The delete button is a child of the load row — stop the row's
        // click from firing when the user is removing an item.
        const target = e.target;
        if (target && target.matches?.('[data-mg-schema-it-action="delete-session"]')) return;
        const id = String(e.currentTarget?.dataset?.mgSchemaItId || '');
        if (id && id !== state.session.id) {
            await loadSession(id);
        }
    });
    $root.on('click.mgSchemaIt', '[data-mg-schema-it-action="delete-session"]', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = String(e.currentTarget?.dataset?.mgSchemaItId || '');
        if (!id) return;
        await sessionStore.delete(id);
        if (state.session.id === id) {
            await startNewSession();
        } else {
            await render();
        }
    });

    // ── Workspace events ──────────────────────────────────────────────
    // Mobile tab switcher — only relevant when the < 900px media query
    // collapses the grid; on desktop both panes are mounted simultaneously
    // and the tab bar is hidden via CSS.
    $root.on('click.mgSchemaIt', '[data-iter-action="switch-tab"]', (e) => {
        const tab = e.currentTarget?.dataset?.iterTab;
        if (!tab) return;
        e.preventDefault();
        setActiveTab(tab);
    });

    // Composer-row auto-apply toggle. Persists per-session via surfaceState.
    // Toggling ON when edits are already pending applies them immediately,
    // matching the orchestrator's existing behavior.
    $root.on('change.mgSchemaIt', '[data-mg-schema-it-action="toggle-auto-apply"]', async (e) => {
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
    const unbindResizer = bindIterWorkspaceResizer($root[0]);

    await render();

    // Block until the user dismisses the popup. Persist one final time so
    // any in-flight composer / surfaceState changes survive close.
    try {
        await popupPromise;
    } finally {
        try { unbindResizer(); } catch { /* ignore */ }
    }
    try { state.abortController?.abort(); } catch { /* ignore */ }
    try { zoomOverlayUnbind?.(); } catch { /* ignore */ }
    await persistSession();
}

// Re-export the small surface from peer modules so importers don't need to
// chase three import paths to find the popup, its tools, and its system-
// prompt builder. Used by tests + by main.js's lazy import.
export { TOOL_DISPLAY } from './tools.js';
