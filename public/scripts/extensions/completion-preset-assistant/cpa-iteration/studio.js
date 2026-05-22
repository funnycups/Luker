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
    render as ITER_RENDER,
    runner as ITER_RUNNER,
    textDiff as ITER_TEXT_DIFF,
    zoomOverlay as ITER_ZOOM_OVERLAY,
} from '../../../iteration-library/index.js';
import { buildToolCatalog, normalizeToolCallToEdit, TOOL_DISPLAY, EDITABLE_TOOL_NAMES } from './tools.js';
import {
    buildModelSystemPrompt,
    buildPresetSettingsOutlineText,
    buildPresetPromptOutlineText,
    sanitizeSessionMode,
    SESSION_MODES,
    SESSION_MODE_DEFAULT,
} from './system-prompts.js';
import { createCpaIterationSessionStore } from './session-store.js';

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

function createNewSession() {
    const now = Date.now();
    return {
        id: makeSessionId(),
        title: '',
        messages: [],
        surfaceState: {
            historyOpen: false,
            referencePresetName: '',
            sessionMode: SESSION_MODE_DEFAULT,
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
function buildPopupHtml({ popupId, title, historyOpen, historyLabel, newSessionLabel, clearAllLabel, sendLabel, composerPlaceholder, referenceLabel, noneLabel, modeLabel, modeOptions }) {
    return `
<div id="${popupId}" class="cpa_it_popup">
    <div class="cpa_it_title">${escapeHtmlLocal(title)}</div>
    <details class="cpa_it_history" data-cpa-it-history${historyOpen ? ' open' : ''}>
        <summary>${escapeHtmlLocal(historyLabel)}</summary>
        <div class="cpa_it_history_items" data-cpa-it-history-items></div>
        <div class="cpa_it_history_actions">
            <button class="menu_button menu_button_small" data-cpa-it-action="new-session">${escapeHtmlLocal(newSessionLabel)}</button>
            <button class="menu_button menu_button_small" data-cpa-it-action="clear-history">${escapeHtmlLocal(clearAllLabel)}</button>
        </div>
    </details>
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
    <div class="cpa_it_messages" data-cpa-it-messages></div>
    <div class="cpa_it_pending" data-cpa-it-pending hidden></div>
    <div class="cpa_it_composer">
        <textarea class="text_pole" rows="2" data-cpa-it-input placeholder="${escapeHtmlLocal(composerPlaceholder)}"></textarea>
        <button class="menu_button" data-cpa-it-action="send">${escapeHtmlLocal(sendLabel)}</button>
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
        state.session = {
            ...loaded,
            surfaceState: {
                historyOpen: false,
                referencePresetName: '',
                sessionMode: SESSION_MODE_DEFAULT,
                ...(loaded.surfaceState || {}),
            },
        };
        state.session.surfaceState.sessionMode = sanitizeSessionMode(state.session.surfaceState.sessionMode);
        state.pendingEdits = [];
        await reloadReference();
        await sessionStore.setCurrentSessionId(state.session.id);
        await render();
    }

    async function startNewSession() {
        state.session = createNewSession();
        state.pendingEdits = [];
        state.reference = null;
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
    // ──────────────────────────────────────────────────────────────────
    function renderMessage(message) {
        const role = String(message?.role || 'user');
        const content = message?.content || '';
        let bodyHtml;
        if (role === 'assistant') {
            // sanitized by DOMPurify inside renderMessageMarkdown
            bodyHtml = ITER_RENDER.renderMessageMarkdown(content);
        } else {
            bodyHtml = escapeHtml(String(content)).replace(/\n/g, '<br>');
        }
        const roleCls = role === 'user'
            ? 'cpa_it_msg_user'
            : role === 'assistant'
                ? 'cpa_it_msg_assistant'
                : 'cpa_it_msg_system';
        return `<div class="cpa_it_msg ${roleCls}">${bodyHtml}</div>`;
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

        // Messages
        const messagesHtml = (state.session.messages || []).map(renderMessage).join('');
        const $msgs = $root.find('[data-cpa-it-messages]');
        $msgs.html(messagesHtml);
        // Auto-scroll to bottom so newly-appended messages are visible.
        try {
            const node = $msgs[0];
            if (node && typeof node.scrollTop === 'number') {
                node.scrollTop = node.scrollHeight;
            }
        } catch { /* DOM not attached (test) */ }

        // Pending edits
        const $pending = $root.find('[data-cpa-it-pending]');
        if (state.pendingEdits.length > 0) {
            const cardsHtml = state.pendingEdits.map(renderPendingEditCard).join('');
            $pending.html(`
                <div class="cpa_it_pending_title">${escapeHtml(t('Pending changes'))}</div>
                ${cardsHtml}
                <div class="cpa_it_pending_actions">
                    <button class="menu_button" data-cpa-it-action="apply-edits">${escapeHtml(t('Apply'))}</button>
                    <button class="menu_button" data-cpa-it-action="discard-edits">${escapeHtml(t('Discard'))}</button>
                </div>
            `).show().attr('hidden', null);
        } else {
            $pending.html('').hide().attr('hidden', '');
        }

        // Send / Stop button label
        const $sendBtn = $root.find('[data-cpa-it-action="send"]');
        $sendBtn.text(state.isBusy ? t('Stop') : t('Send'));
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

    async function runIterationTurn() {
        const ac = new AbortController();
        state.abortController = ac;

        await loadLive();   // re-read so the next batch sees external edits
        await reloadReference();

        const hasReference = Boolean(state.reference);
        const mode = sanitizeSessionMode(state.session.surfaceState?.sessionMode);
        const systemPrompt = buildModelSystemPrompt({ hasReference, mode });
        const tools = buildToolCatalog({ hasReference });

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
            },
        );

        const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
        const assistantText = String(result?.assistantText || '').trim();

        // Normalize tool calls → edits. Control tools (read / diff /
        // simulate / clone) return [] from the normalizer; we surface them
        // as a system message so the user sees the AI's inspection attempt
        // wasn't wasted, but we do NOT round-trip the result back to the
        // LLM — single-turn architecture per spec.
        const edits = [];
        const controlCalls = [];
        for (const call of toolCalls) {
            const name = String(call?.name || '');
            if (EDITABLE_TOOL_NAMES.has(name)) {
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
                        role: 'system',
                        content: t('Edit error: ') + String(err?.message || err),
                    });
                }
            } else {
                controlCalls.push(call);
            }
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

        // Note control-tool calls inline so the user sees what the AI
        // tried to inspect. The user can re-ask with the inspection data
        // visible (or paste it into the prompt) for follow-up turns.
        if (controlCalls.length > 0) {
            const lines = controlCalls.map(c => {
                const label = TOOL_DISPLAY[String(c?.name || '')] || String(c?.name || '');
                return `${label}: ${JSON.stringify(c?.args ?? {})}`;
            });
            state.session.messages.push({
                role: 'system',
                content: t('AI requested inspection (not auto-executed): ') + '\n' + lines.join('\n'),
            });
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Apply pending edits. `applyEdits(edits, live)` returns
    // `{ newLive, clean, conflicts, alreadyDone }`. Per sub-spec §6 / §9
    // we do NOT surface a conflict UI: just commit `newLive` and silently
    // drop any conflicting / already-done edits. The pre-call live is
    // re-read so a parallel editor (e.g. user saved another preset that
    // overwrote ours) doesn't blow away their work.
    // ──────────────────────────────────────────────────────────────────
    async function applyPendingEdits() {
        if (state.pendingEdits.length === 0) return;
        if (!state.live) await loadLive();
        const result = applyEdits(state.pendingEdits, state.live);
        state.live = result?.newLive ?? state.live;
        state.pendingEdits = [];
        try {
            await commitLiveToPreset();
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] commitLiveToPreset failed`, err);
            state.session.messages.push({
                role: 'system',
                content: t('Failed to save preset: ') + String(err?.message || err),
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
        const $textarea = $root.find('[data-cpa-it-input]');
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
    // Session init. Loads the per-preset "currently open" session if one
    // exists; otherwise creates a fresh one. Reference body is loaded
    // alongside if the saved session had a referencePresetName.
    // ──────────────────────────────────────────────────────────────────
    async function initSession() {
        const currentId = await sessionStore.getCurrentSessionId();
        if (currentId) {
            const loaded = await sessionStore.load(currentId);
            if (loaded) {
                state.session = {
                    ...loaded,
                    surfaceState: {
                        historyOpen: false,
                        referencePresetName: '',
                        sessionMode: SESSION_MODE_DEFAULT,
                        ...(loaded.surfaceState || {}),
                    },
                };
                state.session.surfaceState.sessionMode = sanitizeSessionMode(state.session.surfaceState.sessionMode);
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
        await sessionStore.delete(id);
        if (state.session.id === id) {
            await startNewSession();
        } else {
            await render();
        }
    });

    await render();

    // Block until the user dismisses the popup. Persist one final time so
    // any in-flight composer / surfaceState changes survive close.
    await popupPromise;
    try { state.abortController?.abort(); } catch { /* ignore */ }
    try { zoomOverlayUnbind?.(); } catch { /* ignore */ }
    await persistSession();
}

// Re-export the small surface from peer modules so importers don't need to
// chase three import paths to find the popup, its tools, and its system-
// prompt builders. Used by tests + by main.js's lazy import.
export { SESSION_MODES, SESSION_MODE_DEFAULT } from './system-prompts.js';
export { EDITABLE_TOOL_NAMES, TOOL_DISPLAY } from './tools.js';
