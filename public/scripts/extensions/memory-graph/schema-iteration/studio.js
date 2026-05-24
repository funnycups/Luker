// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Memory Graph Schema — AI iteration popup (plugin-owned).
 *
 * Replacement for the legacy iteration-studio adapter (now removed).
 * Single-column chat surface that wires
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
 *   - getSchemaScopeInfo(ctx, settings)
 *                                       optional; returns { scope, hasOverride, characterName, ... }.
 *                                       Used to drive the appendScopeHintIfNeeded 3-path system-prompt
 *                                       hint and to gate the two reset control tools.
 *   - persistCharacterSchemaOverride(ctx, avatar, normalized)
 *                                       writes per-character override; returns ok/false
 *   - saveSettings()                   persists global settings
 *   - i18n, i18nFormat
 *   - refreshRootUi(uiRoot)            called after each commit to refresh parent UI
 */

import { Popup, POPUP_TYPE } from '../../../popup.js';
import {
    applyEdits,
    inverseEdit,
    bindIterWorkspaceResizer,
    render as ITER_RENDER,
    runner as ITER_RUNNER,
    zoomOverlay as ITER_ZOOM_OVERLAY,
    ui as ITER_UI,
} from '../../../iteration-library/index.js';
import {
    TOOL_DEFS,
    TOOL_DISPLAY,
    buildToolCatalog,
    normalizeToolCallToEdit,
    CONTROL_TOOL_NAMES,
    isMgSchemaControlCall,
} from './tools.js';
import { MG_SCHEMA_TOOL_DISPLAY } from './tool-display.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createMgSchemaSessionStore, makeMessageId, normalizeMessageShape } from './session-store.js';

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
    createNewSession as _testOnly_createNewSession,
};

function createNewSession() {
    const now = Date.now();
    return {
        id: makeSessionId(),
        title: '',
        messages: [],
        pendingEdits: [],
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
        getSchemaScopeInfo,
        persistCharacterSchemaOverride,
        saveSettings,
        i18n,
        i18nFormat,
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
    const tf = typeof i18nFormat === 'function'
        ? i18nFormat
        : (s, ...vals) => String(s ?? '').replace(/\$\{(\d+)\}/g, (_m, n) => String(vals[Number(n)] ?? ''));

    // Inject the popup stylesheet on first open. Idempotent; subsequent
    // calls are no-ops because the <link> element is id-keyed.
    ensureStylesheetInjected();
    // Inject the shared iteration-library/ui stylesheet so renderToolCallChip /
    // renderMessageCard / renderDiffCard / renderApplyControls pick up their
    // `luker_lib_*` styles. Idempotent (id-keyed); shared across all four
    // iter-library popups.
    ITER_UI.ensureUiStylesheetInjected();

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
    // Per-turn snapshot. `runIterationTurn` calls this once at the top so
    // every helper that follows (system-prompt scope hint, augmented user
    // prompt, control-tool handlers) reads the SAME view of scope / global
    // schema / character override even if the user swaps a card or edits
    // global settings mid-turn. Helpers that previously re-derived these
    // from context/settings now accept this snapshot as a parameter.
    // ──────────────────────────────────────────────────────────────────
    function captureTurnSnapshot() {
        const avatar = String(context?.characters?.[context?.characterId]?.avatar || '').trim();
        const characterName = avatar
            ? String(context?.characters?.[context?.characterId]?.name || avatar)
            : '';
        const helperSession = buildHelperSession();
        const globalSchema = normalizeNodeTypeSchema(settings?.nodeTypeSchema || []);
        return {
            avatar,
            characterName,
            sourceScope: avatar ? 'character' : 'global',
            helperSession,
            globalSchema,
        };
    }

    // ──────────────────────────────────────────────────────────────────
    // Build a "session-shaped" object that mirrors what Orch / CPA /
    // CEA-editor pass into iteration-library helpers. The MG schema
    // popup's scope is driven by avatar presence (any selected card =
    // character scope), and `hasOverride` reflects whether that card
    // currently has a real `schemaOverride` array in its extension blob.
    // Both are sourced from `getSchemaScopeInfo` when wired by main.js;
    // when the dep is missing we fall back to a global-only worldview so
    // the popup stays usable even on older deps wirings.
    // ──────────────────────────────────────────────────────────────────
    function buildHelperSession() {
        if (typeof getSchemaScopeInfo === 'function') {
            const info = getSchemaScopeInfo(context, settings);
            return {
                scope: info?.scope === 'character' || info?.hasAvatar ? 'character' : 'global',
                hasOverride: Boolean(info?.hasOverride),
                characterDisplayName: String(info?.characterName || ''),
            };
        }
        const avatar = String(context?.characters?.[context?.characterId]?.avatar || '').trim();
        return {
            scope: avatar ? 'character' : 'global',
            hasOverride: false,
            characterDisplayName: avatar
                ? String(context?.characters?.[context?.characterId]?.name || avatar)
                : '',
        };
    }

    // ──────────────────────────────────────────────────────────────────
    // Reset-to-blank shell. Returns an empty schema array — the MG
    // normalizer accepts `[]` as a valid (empty) schema for the working
    // profile. The AI is then expected to call `mg_schema_set_node_type`
    // to add fresh types one at a time. Commit time normalizes again, so
    // a user who abandons mid-author still ends up with a non-empty
    // schema on disk via the normalizer's default fallback.
    // ──────────────────────────────────────────────────────────────────
    function createBlankSchemaShell() {
        return [];
    }

    // ──────────────────────────────────────────────────────────────────
    // Reset-to-global clone. Reads `settings.nodeTypeSchema` directly
    // (the global schema, bypassing the per-character override) and
    // runs it through the normalizer so the working profile has the same
    // shape it would have if the user had no override at all.
    // ──────────────────────────────────────────────────────────────────
    function loadGlobalSchemaForReset() {
        const raw = Array.isArray(settings?.nodeTypeSchema) ? settings.nodeTypeSchema : [];
        return normalizeNodeTypeSchema(structuredClone(raw));
    }

    // ──────────────────────────────────────────────────────────────────
    // System-prompt scope hint. Mirrors the Orch popup's 2-path / 3-path
    // hint append:
    //   - global scope             → no hint, AI sees only base prompt
    //   - character, no override   → 2-path hint (adjust / blank)
    //   - character, has override  → 3-path hint (adjust / blank / global)
    // ──────────────────────────────────────────────────────────────────
    function appendScopeHintIfNeeded(basePrompt, helperSession) {
        if (helperSession?.scope !== 'character') return basePrompt;
        const display = String(helperSession?.characterDisplayName || '').trim() || 'this character';
        if (!helperSession.hasOverride) {
            return [
                basePrompt,
                '',
                '# Iteration scope',
                `You are iterating on the character schema for "${display}". This card has NO schema override yet.`,
                '',
                'Two paths exist; decide from the user\'s first message which applies:',
                '- Adjust the existing setup: the working schema starts as a copy of the GLOBAL schema. Make targeted edits as you normally would. This is the default path.',
                `- Author from scratch: call \`${CONTROL_TOOL_NAMES.resetToBlank}\` once to discard the global copy and start with a minimal blank shell. If you already called it earlier this session, the working schema is already blank — continue authoring from there without calling reset again.`,
                '',
                'Do not call the reset tool unless the user clearly wants a brand-new schema.',
            ].join('\n');
        }
        return [
            basePrompt,
            '',
            '# Iteration scope',
            `You are iterating on the character schema for "${display}". This card ALREADY has a schema override.`,
            '',
            'Three paths exist; default to the first unless the user clearly asks for one of the others:',
            '- Continue adjusting the current override: the working schema starts as a copy of the existing OVERRIDE. Make targeted edits as you normally would. This is the default path.',
            `- Author from scratch: call \`${CONTROL_TOOL_NAMES.resetToBlank}\` once to discard the existing override and start with a minimal blank shell. If you already called it earlier this session, the working schema is already blank — continue authoring from there without calling reset again.`,
            `- Match the global schema: call \`${CONTROL_TOOL_NAMES.resetToGlobal}\` once to discard the existing override and start with a fresh clone of the current global schema. If you already called it earlier this session, the working schema already matches global — continue adjusting from there without calling reset again.`,
            '',
            'Do not call either reset tool unless the user clearly asks for that fresh-start path.',
        ].join('\n');
    }

    // ──────────────────────────────────────────────────────────────────
    // Commit live → MG settings: when a character is active, write to
    // the per-character override path; else
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
        const hasMessages = Array.isArray(state.session.messages) && state.session.messages.length > 0;
        const hasPending = Array.isArray(state.pendingEdits) && state.pendingEdits.length > 0;
        if (state.session._transient && !hasMessages && !hasPending) {
            return;
        }
        if (state.session._transient) {
            delete state.session._transient;
        }
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
        const surface = loaded.surfaceState || {};
        state.session = {
            ...loaded,
            surfaceState: {
                historyOpen: !!surface.historyOpen,
                autoApply: !!surface.autoApply,
            },
            messages: Array.isArray(loaded.messages)
                ? loaded.messages.map(m => normalizeMessageShape(m, fallbackAt))
                : [],
            pendingEdits: Array.isArray(loaded.pendingEdits) ? loaded.pendingEdits.slice() : [],
        };
        state.pendingEdits = state.session.pendingEdits.slice();
        // Re-read the schema so the new session's preview + next-turn
        // oldValue snapshots reflect disk state, not the prior session's
        // staged live (N4 fix).
        await loadLive();
        await render();
    }

    async function startNewSession() {
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.abortController = null;
        // Carry the user's auto-apply preference across to the fresh session
        // so toggling it once persists for the popup lifetime, not just the
        // session that introduced it.
        const priorAutoApply = Boolean(state.session?.surfaceState?.autoApply);
        state.session = createNewSession();
        state.session._transient = true;
        if (priorAutoApply) {
            state.session.surfaceState = {
                ...(state.session.surfaceState || {}),
                autoApply: true,
            };
        }
        state.pendingEdits = [];
        await loadLive();
        // Don't save the blank session yet — persistSession's _transient
        // guard defers the write until the first user message.
        await render();
    }

    async function clearAllHistory() {
        // eslint-disable-next-line no-alert
        if (!confirm(t('Clear all session history?'))) return;
        // Abort any in-flight LLM call BEFORE deleting so a slow response
        // can't land in a session that's about to be wiped.
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.abortController = null;
        const metas = await sessionStore.list();
        for (const meta of metas) {
            await sessionStore.delete(meta.id);
        }
        await startNewSession();
    }

    // ──────────────────────────────────────────────────────────────────
    // Schema-array diff renderer — pending edit cards.
    //
    // MG tools all go through the sandbox-diff pattern, which means a tool
    // call produces a single `{op:'set', path:'', oldValue:<oldSchema>,
    // newValue:<newSchema>}` edit where both values are ARRAYS. The shared
    // `iteration-library/ui/diff.renderDiffCard` only triggers per-leaf
    // splitting when both values are plain objects, so naively passing the
    // schema array would render as one giant stringified diff — screenshot
    // bug #20.
    //
    // The fix: compare the two arrays by node-type id, then for each
    // modified entry synthesize an empty-path `set` edit between the two
    // node-type OBJECTS so renderDiffCard's walk-diff fires per-changed-
    // field within the node type. Added/removed entries get one card each
    // showing the whole new/old node-type body — there's no shared "before"
    // to diff against, so a single-side render is the most truthful view.
    // ──────────────────────────────────────────────────────────────────
    function renderSchemaArrayPendingCards(before, after) {
        const beforeIds = new Map((Array.isArray(before) ? before : []).map(x => [String(x?.id || ''), x]));
        const afterIds = new Map((Array.isArray(after) ? after : []).map(x => [String(x?.id || ''), x]));
        const added = [...afterIds.keys()].filter(id => id && !beforeIds.has(id));
        const removed = [...beforeIds.keys()].filter(id => id && !afterIds.has(id));
        const modified = [...afterIds.keys()].filter(id => {
            if (!id || !beforeIds.has(id)) return false;
            // Stable stringify is overkill here — both sides come from the
            // same normalizer (tools.js calls normalizeNodeTypeSchema before
            // emitting the edit), so key order matches.
            return JSON.stringify(beforeIds.get(id)) !== JSON.stringify(afterIds.get(id));
        });

        const syntheticEdits = [];
        const fieldLabels = {};
        // Modified: empty-path set on the two node-type objects → triggers
        // the shared component's walkDiff → one sub-card per changed leaf.
        for (const id of modified) {
            syntheticEdits.push({
                op: 'set',
                path: '',
                oldValue: beforeIds.get(id),
                newValue: afterIds.get(id),
            });
        }
        // Added / removed: synthesize a path-keyed set so renderDiffCard
        // takes the non-empty-path branch and labels the card by node-type
        // id. Empty-path with one side missing wouldn't trigger per-leaf
        // splitting anyway (the && short-circuits on the missing value), so
        // a single-card render is cleaner than firing a malformed diff. The
        // raw `nodeTypeSchema.<id>` path leaks the storage-internal key into
        // the UI, so a fieldLabels override maps it back to just the id so
        // the shared humanizePath renders "Field updated: <id>".
        for (const id of added) {
            const path = `nodeTypeSchema.${id}`;
            fieldLabels[path] = id;
            syntheticEdits.push({
                op: 'set',
                path,
                oldValue: undefined,
                newValue: afterIds.get(id),
            });
        }
        for (const id of removed) {
            const path = `nodeTypeSchema.${id}`;
            fieldLabels[path] = id;
            syntheticEdits.push({
                op: 'set',
                path,
                oldValue: beforeIds.get(id),
                newValue: undefined,
            });
        }
        if (syntheticEdits.length === 0) {
            return `<div class="mg_schema_it_pending_card"><div class="mg_schema_it_pending_note">${escapeHtmlLocal(t('(no effective change)'))}</div></div>`;
        }
        return ITER_UI.diff.renderDiffCard(syntheticEdits, { i18n: tf, fieldLabels });
    }

    function renderPendingEditCard(edit) {
        // Coarse sandbox-diff path: one {op:'set', path:'', oldValue:<arr>,
        // newValue:<arr>}. Fan out into per-changed-id sub-cards so the
        // model's intent shows up as a small number of focused diffs
        // instead of one massive stringified array (bug #20).
        if (edit?.op === 'set' && edit?.path === ''
            && Array.isArray(edit.oldValue) && Array.isArray(edit.newValue)) {
            return renderSchemaArrayPendingCards(edit.oldValue, edit.newValue);
        }
        // Future fine-grained-op compatibility: anything else flows
        // straight through the shared renderer, which already handles
        // empty-path object sets (per-leaf split) and path-keyed sets.
        return ITER_UI.diff.renderDiffCard([edit], { i18n: tf });
    }

    // ──────────────────────────────────────────────────────────────────
    // Chat-message rendering. MG delegates to
    // `iteration-library/ui/message.renderMessageCard` so the four
    // iter-library popups (CPA, MG schema, Orch, CEA char) share one
    // visual language for tool-call chips, per-round edit cards, applied/
    // rolled-back stamps, and the Regenerate / Rollback row.
    //
    // MG preserves only the outer `<div class="mg_schema_it_msg ...">`
    // wrapper around the shared component, because studio.css's flex-row
    // alignment / accent colors / max-widths key on
    // `.mg_schema_it_msg_user` / `_assistant` / `_system`. The inner
    // `<div class="luker_lib_message ...">` carries the rest of the
    // structure (markdown body, read-only-round hint when all calls are
    // read-type, tool chips, edit cards via renderPendingEditCard,
    // applied/rolled-back stamp, Regenerate button). Click delegation
    // accepts msgId from either `data-mg-schema-it-msg-id` (outer) or
    // `data-luker-lib-msg-id` (inner).
    // ──────────────────────────────────────────────────────────────────
    function renderMessageCard(message, idx, allMessages) {
        if (!message) return '';
        const role = String(message.role || 'user');
        const roleCls = role === 'user'
            ? 'mg_schema_it_msg_user'
            : role === 'assistant'
                ? 'mg_schema_it_msg_assistant'
                : 'mg_schema_it_msg_system';
        const autoCls = message.auto ? ' mg_schema_it_msg_auto' : '';

        // Last-assistant predicate: true only when this assistant turn has
        // no later assistant in the visible message list. Trailing user /
        // system / auto-continue turns are skipped so the actual final
        // assistant reply (whose prompt is the live tail) hides its
        // Regenerate button — re-sending from the same composer text is
        // semantically equivalent.
        let isLast = false;
        if (role === 'assistant' && !message.auto) {
            isLast = true;
            for (let j = (allMessages?.length || 0) - 1; j > idx; j--) {
                if (allMessages[j]?.role === 'assistant' && !allMessages[j]?.auto) { isLast = false; break; }
            }
        }

        const innerHtml = ITER_UI.message.renderMessageCard(message, {
            toolDisplay: MG_SCHEMA_TOOL_DISPLAY,
            renderEditCard: renderPendingEditCard,
            renderApplyControls: (m) => {
                const isLatestUnapplied = String(m?.id || '') === state.__latestUnappliedAssistantId;
                const passthroughEdits = isLatestUnapplied ? m.edits : [];
                return ITER_UI.apply.renderApplyControls(
                    { ...m, edits: passthroughEdits },
                    {
                        i18n: tf,
                        applyLabel: tf('Apply to ${0}', t('schema')),
                        actionAttribute: 'data-mg-schema-it-action',
                    },
                );
            },
            isLast,
            i18n: tf,
            renderMarkdown: ITER_RENDER.renderMessageMarkdown,
            actionAttribute: 'data-mg-schema-it-action',
        });

        // Preserve MG's outer flex-row container so the popup's alignment
        // / accent-color / max-width rules in studio.css still apply.
        return `<div class="mg_schema_it_msg ${roleCls}${autoCls}" data-mg-schema-it-msg-id="${escapeHtmlLocal(message.id || '')}">${innerHtml}</div>`;
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

        // Messages — pass index + full array so renderMessageCard can decide
        // whether to render Regenerate (only on non-last assistant turns).
        // Pre-compute latest-unapplied id so inline Apply/Reject row only
        // attaches to the most recent unapplied assistant turn.
        const allMsgs = state.session.messages || [];
        let latestUnappliedAssistantId = '';
        for (let i = allMsgs.length - 1; i >= 0; i--) {
            const m = allMsgs[i];
            if (m && m.role === 'assistant' && !m.auto
                && Array.isArray(m.edits) && m.edits.length > 0
                && !m.appliedAt && !m.rolledBackAt) {
                latestUnappliedAssistantId = String(m.id || '');
                break;
            }
        }
        state.__latestUnappliedAssistantId = latestUnappliedAssistantId;
        const messagesHtml = allMsgs.map((m, i) => renderMessageCard(m, i, allMsgs)).join('');
        const $msgs = $root.find('[data-mg-schema-it-messages]');
        // Loading bubble: append (don't overwrite) so the just-finished
        // user turn stays visible while the LLM call is in flight.
        const loadingHtml = state.isBusy
            ? `<div class="mg_schema_it_msg mg_schema_it_msg_assistant mg_schema_it_msg_loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtmlLocal(t('AI is thinking...'))}</div>`
            : '';
        $msgs.html(messagesHtml + loadingHtml);
        // Auto-scroll to bottom so newly-appended messages are visible.
        try {
            const node = $msgs[0];
            if (node && typeof node.scrollTop === 'number') {
                node.scrollTop = node.scrollHeight;
            }
        } catch { /* DOM not attached (test) */ }

        // Pending edits — delegates the Apply / Discard row to the shared
        // `iteration-library/ui/apply` component so it stays in visual
        // sync with the other iter-library popups (M1.7). The shared
        // component emits `${actionAttribute}="apply-batch"` and
        // `discard-batch` buttons; MG's click delegation matches those
        // values too (see handler block below). `pendingMessage` is a
        // virtual carrier — the popup's pending block is owned by the
        // Pending edits + Apply / Reject affordances now render inline on
        // the assistant message that produced them via the renderApplyControls
        // hook in renderMessageCard. The legacy bottom region has been
        // retired so Apply stays visible alongside the diff cards it
        // refers to.

        // Send / Stop button label
        const $sendBtn = $root.find('[data-mg-schema-it-action="send"]');
        $sendBtn.text(state.isBusy ? t('Stop') : t('Send'));

        // Sync auto-apply checkbox state — render() is the single source of
        // truth, so a session switch (different auto-apply pref) updates the
        // checkbox without separate plumbing.
        const $autoApply = $root.find('[data-mg-schema-it-action="toggle-auto-apply"]');
        if ($autoApply.length) {
            const want = !!state.session.surfaceState?.autoApply;
            if ($autoApply.prop('checked') !== want) {
                $autoApply.prop('checked', want);
            }
        }

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
     * Build the augmented user prompt. Injects:
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

    function buildAugmentedUserPrompt(userText, snapshot) {
        const sourceScope = snapshot?.sourceScope
            || (String(context?.characters?.[context?.characterId]?.avatar || '').trim() ? 'character' : 'global');
        const characterName = typeof snapshot?.characterName === 'string'
            ? snapshot.characterName
            : (String(context?.characters?.[context?.characterId]?.avatar || '').trim()
                ? String(context?.characters?.[context?.characterId]?.name
                    || context?.characters?.[context?.characterId]?.avatar)
                : '');
        const currentSchema = stringifyForPrompt(state.live);
        const baselineSource = Array.isArray(snapshot?.globalSchema)
            ? snapshot.globalSchema
            : normalizeNodeTypeSchema(settings?.nodeTypeSchema || []);
        const baselineSchema = stringifyForPrompt(baselineSource);
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
    function buildTaskMessages(systemPrompt, snapshot) {
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
                ? buildAugmentedUserPrompt(String(m.content || ''), snapshot)
                : String(m.content || '');
            messages.push({ role, content });
        });
        return messages;
    }

    async function runIterationTurn({ autoContinueFromResult = null } = {}) {
        const ac = new AbortController();
        state.abortController = ac;

        await loadLive();   // re-read so the next batch sees external edits

        // Snapshot scope + global schema ONCE at the start of the turn. All
        // downstream helpers (system-prompt scope hint, augmented user
        // prompt, reset-tool control handlers) read from this snapshot so a
        // mid-turn character swap or settings edit can't slice the turn
        // across two different worldviews.
        const turnSnapshot = captureTurnSnapshot();
        const systemPrompt = appendScopeHintIfNeeded(buildSystemPrompt(), turnSnapshot.helperSession);

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
            noteLines.push('Call luker_mg_schema_finalize_iteration once the request is fully addressed.');
            state.session.messages.push({
                id: makeMessageId(),
                role: 'user',
                content: noteLines.join('\n'),
                at: Date.now(),
                auto: true,
            });
        }

        const taskMessages = buildTaskMessages(systemPrompt, turnSnapshot);

        const apiPresetName = String(settings?.requestApiPresetName || '').trim();
        const llmPresetName = String(settings?.requestLlmPresetName || '').trim();

        const runnerSettings = {
            useStreamingTransport: Boolean(settings?.useStreamingTransport),
            toolCallRetryMax: settings?.toolCallRetryMax,
            rpmLimit: settings?.rpmLimit,
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
            context,
            runnerSettings,
            {
                taskMessages,
                runtimeWorldInfo: null,
                apiPresetName,
                llmPresetName,
                tools: buildToolCatalog(),
                abortSignal: ac.signal,
                includeAssistantText: true,
                allowNoToolCalls: true,
                isControlCall: isMgSchemaControlCall,
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
                    } else if (name === CONTROL_TOOL_NAMES.resetToBlank) {
                        // Accept when scope is character — the system prompt
                        // invites resetToBlank in BOTH the "no override yet"
                        // (fork-from-global → blank) and "has override"
                        // (discard override → blank) paths, so gating only on
                        // scope keeps prompt + handler in agreement. Uses the
                        // turn-snapshot scope so a mid-turn character swap
                        // can't change the decision after the system prompt
                        // already committed to one path.
                        if (turnSnapshot.helperSession.scope === 'character') {
                            state.live = createBlankSchemaShell();
                            state.pendingEdits = [];
                            state.session.messages.push({
                                id: makeMessageId(),
                                role: 'system',
                                content: t('Schema reset to a blank shell — building from scratch.'),
                                at: Date.now(),
                            });
                        }
                    } else if (name === CONTROL_TOOL_NAMES.resetToGlobal) {
                        // Only meaningful when scope is character + an override
                        // exists. The reset replaces the working profile with
                        // a clone of the GLOBAL schema so the AI / user can
                        // re-author from there. Without an override there's
                        // nothing to overwrite — and the no-override prompt
                        // never lists resetToGlobal, so silent-drop is fine.
                        // The global schema clone comes from the turn snapshot
                        // so a mid-turn settings edit doesn't change what
                        // "global" means halfway through.
                        if (turnSnapshot.helperSession.scope === 'character'
                            && turnSnapshot.helperSession.hasOverride) {
                            state.live = normalizeNodeTypeSchema(structuredClone(turnSnapshot.globalSchema || []));
                            state.pendingEdits = [];
                            state.session.messages.push({
                                id: makeMessageId(),
                                role: 'system',
                                content: t('Schema reset to match the current global schema — adjust from there.'),
                                at: Date.now(),
                            });
                        }
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
                ? result.toolCalls.filter((c) => !isMgSchemaControlCall(c))
                : []);
        const assistantText = firstAssistantText.trim();

        // Normalize edit-tools → edits. The MG sandbox-diff emits one bulk
        // `set('', newSchema)` per call; multiple calls in the same turn
        // would stack as separate edits, but Apply collapses them via
        // applyEdits's sequential application.
        const edits = [];
        for (const call of editToolCalls) {
            try {
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
        // apply immediately. Errors are caught locally so the runner's
        // outer finally still resets isBusy + persists the session.
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
    // `state.pendingEdits` is cleared only after `commitLiveToSchema`
    // resolves; on failure the staged batch and the pre-apply `state.live`
    // snapshot are both restored so the user can retry instead of losing
    // the iteration.
    //
    // On success we toast the user, then mark the most recent unapplied
    // assistant message so renderMessageCard can show the Applied label
    // and a Rollback button.
    // ──────────────────────────────────────────────────────────────────
    async function applyPendingEdits({ skipRender = false } = {}) {
        if (!Array.isArray(state.pendingEdits) || state.pendingEdits.length === 0) return;
        if (!state.live) await loadLive();
        const liveSnapshot = state.live;
        // Sandbox-diff emits a coarse {op:'set', path:'', newValue:<whole schema>}
        // per tool call. lodash.set with empty path is a no-op, so the shared
        // applyEdits engine silently skips them. Chain-apply each edit so that
        // batches of 2+ empty-path sets (multiple mg_schema_* calls in one
        // turn) land both — falling back to applyEdits for any non-empty-path
        // edit keeps fine-grained ops working too.
        let liveCursor = state.live;
        for (const edit of state.pendingEdits) {
            if (edit?.op === 'set' && edit?.path === '' && typeof edit?.newValue !== 'undefined') {
                liveCursor = applyEmptyPathSet(liveCursor, edit);
            } else {
                const result = applyEdits([edit], liveCursor);
                liveCursor = result?.newLive ?? liveCursor;
            }
        }
        state.live = liveCursor;
        try {
            await commitLiveToSchema();
        } catch (err) {
            state.live = liveSnapshot;
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] commitLiveToSchema failed`, err);
            try { toastr.error(tf('Apply failed: ${0}', String(err?.message || err))); } catch { /* toastr may be unavailable in tests */ }
            state.session.messages.push({
                id: makeMessageId(),
                role: 'system',
                content: tf('Failed to save schema: ${0}', String(err?.message || err)),
                at: Date.now(),
            });
            await persistSession();
            if (!skipRender) await render();
            return;
        }

        try { toastr.success(tf('Applied to ${0}', t('schema'))); } catch { /* ignore */ }

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
                m.appliedTarget = 'schema';
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
    // would leave the schema in an inconsistent state.
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
        const $textarea = $root.find('[data-mg-schema-it-input]');
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
            // MG sandbox-diff uses empty-path set edits; inverse is the same
            // shape with oldValue/newValue swapped. Chain-apply each inverse
            // (empty-path edits route around lodash.set's empty-path no-op;
            // fine-grained ops fall through to the shared applyEdits engine)
            // so a multi-edit batch unwinds cleanly even when only some edits
            // are coarse-grained.
            for (const inv of inverses) {
                if (inv?.op === 'set' && inv?.path === '' && typeof inv?.newValue !== 'undefined') {
                    working = applyEmptyPathSet(working, inv);
                } else {
                    const result = applyEdits([inv], working);
                    working = result?.newLive ?? working;
                }
            }
        } catch (err) {
            console.warn(`[${MODULE}] applyEdits(inverses) failed`, err);
            try { toastr.error(tf('Apply failed: ${0}', String(err?.message || err))); } catch { /* ignore */ }
            return;
        }
        state.live = working;
        try {
            await commitLiveToSchema();
        } catch (err) {
            console.warn(`[${MODULE}] commitLiveToSchema(rollback) failed`, err);
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
    // `luker_mg_schema_continue_iteration`, runIterationTurn returns
    // `wantsAutoContinue: true` and the loop fires another round (after
    // rendering the previous round so the user sees progressive output).
    // The ONLY exits are:
    //   1. The model called `luker_mg_schema_finalize_iteration` (no continue).
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
        const $textarea = $root.find('[data-mg-schema-it-input]');
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

    // Apply / Discard the staged batch. Selectors use `apply-batch` /
    // `discard-batch` because the row is rendered by
    // `iteration-library/ui/apply.renderApplyControls`, which emits those
    // values via the `actionAttribute: 'data-mg-schema-it-action'` opt —
    // the same convention `renderMessageCard` uses for per-message
    // rollback / regenerate buttons (handlers further down).
    $root.on('click.mgSchemaIt', '[data-mg-schema-it-action="apply-batch"]', async (e) => {
        e.preventDefault();
        await applyPendingEdits();
    });
    $root.on('click.mgSchemaIt', '[data-mg-schema-it-action="discard-batch"]', async (e) => {
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

    // Per-message Regenerate / Rollback. Both buttons are rendered by
    // `iteration-library/ui/message.renderMessageCard`, which emits them
    // with `data-mg-schema-it-action="regenerate"` / `="rollback-batch"`
    // (via the actionAttribute opt) and `data-luker-lib-msg-id="..."`.
    // The msgId resolver accepts both attribute names so a future
    // MG-only override that still tags `data-mg-schema-it-msg-id`
    // keeps working.
    function resolveMsgId(target) {
        if (!target) return '';
        // dataset is camelCase: mgSchemaItMsgId / lukerLibMsgId
        return String(target.dataset?.mgSchemaItMsgId || target.dataset?.lukerLibMsgId || '');
    }
    $root.on('click.mgSchemaIt', '[data-mg-schema-it-action="regenerate"]', async (e) => {
        e.preventDefault();
        const msgId = resolveMsgId(e.currentTarget);
        if (!msgId) return;
        await regenerateFromMessage(msgId);
    });
    $root.on('click.mgSchemaIt', '[data-mg-schema-it-action="rollback-batch"]', async (e) => {
        e.preventDefault();
        const msgId = resolveMsgId(e.currentTarget);
        if (!msgId) return;
        await rollbackBatch(msgId);
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
// prompt builder. Used by tests + by main.js's lazy import.
export { TOOL_DISPLAY } from './tools.js';
