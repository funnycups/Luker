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
import { TOOL_DEFS, TOOL_DISPLAY, normalizeToolCallToEdit } from './tools.js';
import { createCharacterIterationSessionStore } from './session-store.js';

const MODULE = 'cea-character-iteration';
const STYLESHEET_ID = 'cea_charit_studio_stylesheet';
const STYLESHEET_HREF = '/scripts/extensions/character-editor-assistant/character-iteration/studio.css';

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
 */
function buildPopupHtml({ popupId, title, historyOpen, historyLabel, newSessionLabel, clearAllLabel, sendLabel, composerPlaceholder }) {
    return `
<div id="${popupId}" class="cea_charit_popup">
    <div class="cea_charit_title">${title}</div>
    <details class="cea_charit_history" data-cea-charit-history${historyOpen ? ' open' : ''}>
        <summary>${escapeHtmlLocal(historyLabel)}</summary>
        <div class="cea_charit_history_items" data-cea-charit-history-items></div>
        <div class="cea_charit_history_clear">
            <button class="menu_button menu_button_small" data-cea-charit-action="new-session">${escapeHtmlLocal(newSessionLabel)}</button>
            <button class="menu_button menu_button_small" data-cea-charit-action="clear-history">${escapeHtmlLocal(clearAllLabel)}</button>
        </div>
    </details>
    <div class="cea_charit_messages" data-cea-charit-messages></div>
    <div class="cea_charit_pending" data-cea-charit-pending hidden></div>
    <div class="cea_charit_composer">
        <textarea class="text_pole" rows="2" data-cea-charit-input placeholder="${escapeHtmlLocal(composerPlaceholder)}"></textarea>
        <button class="menu_button" data-cea-charit-action="send">${escapeHtmlLocal(sendLabel)}</button>
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

function createNewSession() {
    const now = Date.now();
    return {
        id: makeSessionId(),
        title: '',
        messages: [],
        surfaceState: { historyOpen: false },
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
        i18nFormat: _i18nFormat,   // reserved for future use; not consumed in single-column layout
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
            surfaceState: loaded.surfaceState || { historyOpen: false },
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
            ? 'cea_charit_msg_user'
            : role === 'assistant'
                ? 'cea_charit_msg_assistant'
                : 'cea_charit_msg_system';
        return `<div class="cea_charit_msg ${roleCls}">${bodyHtml}</div>`;
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
        const metas = await sessionStore.list();
        const historyHtml = metas.map(renderHistoryItem).join('')
            || `<div class="cea_charit_history_empty">${escapeHtml(t('No saved sessions'))}</div>`;
        $root.find('[data-cea-charit-history-items]').html(historyHtml);

        // Messages
        const messagesHtml = (state.session.messages || []).map(renderMessage).join('');
        const $msgs = $root.find('[data-cea-charit-messages]');
        $msgs.html(messagesHtml);
        // Auto-scroll to bottom after each render so newly-appended
        // user / assistant messages are visible without manual scroll.
        try {
            const node = $msgs[0];
            if (node && typeof node.scrollTop === 'number') {
                node.scrollTop = node.scrollHeight;
            }
        } catch { /* DOM not attached (test) */ }

        // Pending edits
        const $pending = $root.find('[data-cea-charit-pending]');
        if (state.pendingEdits.length > 0) {
            const cardsHtml = state.pendingEdits.map(renderPendingEditCard).join('');
            $pending.html(`
                <div class="cea_charit_pending_title">${escapeHtml(t('Pending changes'))}</div>
                ${cardsHtml}
                <div class="cea_charit_pending_actions">
                    <button class="menu_button" data-cea-charit-action="apply-pending">${escapeHtml(t('Apply'))}</button>
                    <button class="menu_button" data-cea-charit-action="reject-pending">${escapeHtml(t('Reject'))}</button>
                </div>
            `).show().attr('hidden', null);
        } else {
            $pending.html('').hide().attr('hidden', '');
        }

        // Send / Stop button label
        const $sendBtn = $root.find('[data-cea-charit-action="send"]');
        $sendBtn.text(state.isBusy ? t('Stop') : t('Send'));
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
Use the cea_* tools to propose each edit. Each edit becomes a reviewable change the user can apply or reject.`;
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

    async function runIterationTurn() {
        const ac = new AbortController();
        state.abortController = ac;

        await ensureLive(true);   // re-read so the next batch sees external edits

        const settings = getSettings();
        const presetOptions = typeof getRequestPresetOptions === 'function'
            ? (getRequestPresetOptions() || {})
            : {};
        const apiPresetName = String(presetOptions.apiPresetName || '').trim();
        const llmPresetName = String(presetOptions.llmPresetName || '').trim();

        const systemPrompt = buildSystemPrompt();
        const taskMessages = buildTaskMessages(systemPrompt, '');

        const result = await ITER_RUNNER.requestToolCallsWithRetry(
            context,
            { useStreamingTransport: Boolean(settings?.useStreamingTransport), toolCallRetryMax: settings?.toolCallRetryMax, rpmLimit: settings?.rpmLimit },
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

        // Normalize tool calls → edits, accumulating per-call output.
        const edits = [];
        for (const call of toolCalls) {
            const normalized = await normalizeToolCallToEdit(
                wrapToolCallForNormalize(call),
                { live: state.live },
            );
            if (Array.isArray(normalized)) {
                edits.push(...normalized);
            }
            // null (malformed JSON) or empty array → skip silently
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
                content: t('Suggested edits: ') + names,
            });
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Apply pending edits. `applyEdits(edits, live)` returns
    // `{ newLive, clean, conflicts, alreadyDone }`. Per sub-spec §6 we
    // do NOT surface a conflict UI for CEA Character (edits are
    // sequential, no concurrent writer): just commit `newLive` and
    // drop any conflicting / already-done edits silently.
    // ──────────────────────────────────────────────────────────────────
    async function applyPendingEdits() {
        if (state.pendingEdits.length === 0) return;
        const result = applyEdits(state.pendingEdits, state.live);
        state.live = result.newLive;
        state.pendingEdits = [];
        await commitLiveToCharacter();
        await render();
    }

    async function rejectPendingEdits() {
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
        const $textarea = $root.find('[data-cea-charit-input]');
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
    $root.on('click.ceaCharIt', '[data-cea-charit-action="new-session"]', async (e) => {
        e.preventDefault();
        await startNewSession();
    });
    // Q9: clear-history lives inside the <details>; same delegation root.
    $root.on('click.ceaCharIt', '[data-cea-charit-action="clear-history"]', async (e) => {
        e.preventDefault();
        await clearAllHistory();
    });
    $root.on('click.ceaCharIt', '[data-cea-charit-action="load-session"]', async (e) => {
        // The delete button is a child of the load row — stop the row's
        // click from firing when the user is removing an item.
        const target = e.target;
        if (target && target.matches?.('[data-cea-charit-action="delete-session"]')) return;
        const id = String(e.currentTarget?.dataset?.ceaCharitId || '');
        if (id && id !== state.session.id) {
            await loadSession(id);
        }
    });
    $root.on('click.ceaCharIt', '[data-cea-charit-action="delete-session"]', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = String(e.currentTarget?.dataset?.ceaCharitId || '');
        if (!id) return;
        await sessionStore.delete(id);
        if (state.session.id === id) {
            await startNewSession();
        } else {
            await render();
        }
    });

    await render();

    // Block until the user dismisses the popup. Persist one final time
    // so any in-flight composer / surfaceState changes survive close.
    await popupPromise;
    try { state.abortController?.abort(); } catch { /* ignore */ }
    try { zoomOverlayUnbind?.(); } catch { /* ignore */ }
    await persistSession();
}
