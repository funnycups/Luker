/**
 * Legacy CEA editor session migration.
 *
 * The pre-unification editor persisted its sessions on the character card
 * itself via `getCharacterState(avatar, 'character_editor_assistant_sessions')`
 * — see `normalizeCharacterEditorSession` in
 * `extensions/character-editor-assistant/main.js`. The unified popup
 * persists to `extension_settings.character_editor_assistant.unified_cea_editor_sessions[char_<avatar>]`
 * using the iter-library shape (`messages[]`, `pendingEdits[]`, `live`,
 * `surfaceState`).
 *
 * On first open of the unified popup for an avatar whose new namespace is
 * empty, the loader reads any legacy bundle and rewrites it through this
 * converter so the user still sees their history. Legacy files are NEVER
 * deleted — if migration is buggy the user can revert and try again.
 *
 * Field map (legacy → unified):
 *   id, title, avatar                       → id, title, avatar
 *   conversationMessages[]                  → messages[]
 *     .role                                 → .role
 *     .content                              → .content
 *     .id                                   → .id (regen via makeMessageId if missing)
 *     .at                                   → .at (opts.now() fallback)
 *     .auto                                 → .auto
 *     .tool_calls                           → .toolCalls
 *     .tool_results                         → .toolResults
 *     .diffPreviews                         → .edits (best-effort `{op:'set', path, oldValue, newValue}`)
 *     .operations / .toolSummary / .toolState → dropped (not needed in unified UI)
 *     .executionResults                     → dropped (live state is rebuilt at open time)
 *   pendingApproval.{diffPreviews|operations} → pendingEdits[]
 *   isFinalized / finalizeSummary            → dropped (the unified popup no
 *                                              longer surfaces a finalize banner;
 *                                              legacy sessions silently lose the
 *                                              flag on first load)
 *
 * `live` is intentionally left empty: the legacy popup didn't persist the
 * synthetic apply target, so the unified popup rebuilds it from the active
 * character + lorebook at open time.
 */

import { makeMessageId, normalizeMessageShape } from './session-store.js';

/**
 * Convert a legacy CEA editor session into the unified iter session shape.
 *
 * Idempotent: if `legacy.messages` is an array and there's no
 * `conversationMessages`, the input is treated as already-migrated and passed
 * through (re-normalized via `normalizeMessageShape` so downstream code can
 * trust the per-message field shape).
 *
 * @param {Object} legacy Persisted legacy session bundle, or a new-shape session.
 * @param {Object} [opts]
 * @param {() => number} [opts.now] Clock for testability (default `Date.now`).
 * @returns {Object|null} Unified session, or `null` for non-object/array input.
 */
export function migrateLegacyCeaEditorSession(legacy, opts = {}) {
    if (!legacy || typeof legacy !== 'object') return null;
    if (Array.isArray(legacy)) return null;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

    // Idempotent fast-path: already-new-shape sessions have `messages` (array)
    // and lack the legacy `conversationMessages`. Re-normalize each message so
    // downstream consumers can rely on every field being present.
    if (Array.isArray(legacy.messages) && !legacy.conversationMessages) {
        return {
            id: String(legacy.id || ''),
            title: String(legacy.title || ''),
            avatar: String(legacy.avatar || ''),
            messages: legacy.messages.map(normalizeMessageShape),
            pendingEdits: Array.isArray(legacy.pendingEdits) ? legacy.pendingEdits.slice() : [],
            live: legacy.live && typeof legacy.live === 'object'
                ? {
                    character: legacy.live.character || {},
                    lorebooks: legacy.live.lorebooks || {},
                }
                : { character: {}, lorebooks: {} },
            surfaceState: legacy.surfaceState && typeof legacy.surfaceState === 'object'
                ? { ...legacy.surfaceState }
                : {},
        };
    }

    const legacyMessages = Array.isArray(legacy.conversationMessages) ? legacy.conversationMessages : [];
    const messages = legacyMessages.map(m => convertLegacyMessage(m, now));

    const pendingEdits = convertPendingApproval(legacy.pendingApproval);

    return {
        id: String(legacy.id || ''),
        title: String(legacy.title || ''),
        avatar: String(legacy.avatar || ''),
        messages,
        pendingEdits,
        // Live state was never persisted in the legacy format — it's rebuilt
        // from the active card/lorebook at popup open time.
        live: { character: {}, lorebooks: {} },
        // surfaceState in the unified shape no longer carries `isFinalized` /
        // `finalizeSummary` — the popup's loop self-terminates when the AI
        // stops calling continue, so a separate finalize flag would just be
        // dead persisted state. Legacy values are dropped on load.
        surfaceState: {},
    };
}

/**
 * Convert one legacy `conversationMessages[]` entry. Best-effort: anything
 * absent or off-shape lands on the unified default (empty arrays, null/empty
 * scalars) rather than throwing.
 */
function convertLegacyMessage(m, now) {
    return {
        id: String(m?.id || makeMessageId()),
        role: String(m?.role || 'user'),
        content: String(m?.content ?? ''),
        toolCalls: Array.isArray(m?.tool_calls) ? m.tool_calls.map(c => ({
            id: String(c?.id || ''),
            name: String(c?.name || ''),
            args: (c?.args && typeof c.args === 'object') ? c.args : {},
        })) : [],
        toolResults: Array.isArray(m?.tool_results) ? m.tool_results.map(r => ({
            tool_call_id: String(r?.tool_call_id || ''),
            content: r?.content !== undefined ? r.content : null,
            status: r?.status ? String(r.status) : 'ok',
        })) : [],
        edits: Array.isArray(m?.diffPreviews) ? m.diffPreviews.map(convertDiffPreviewToEdit) : [],
        appliedAt: typeof m?.appliedAt === 'number' ? m.appliedAt : null,
        appliedTarget: typeof m?.appliedTarget === 'string' ? m.appliedTarget : '',
        rolledBackAt: typeof m?.rolledBackAt === 'number' ? m.rolledBackAt : null,
        auto: Boolean(m?.auto),
        at: typeof m?.at === 'number' ? m.at : now(),
    };
}

/**
 * The legacy `diffPreviews[]` entries used `{before, after}` while a small
 * minority used `{oldValue, newValue}`. Accept both and emit the unified
 * `{op:'set', path, oldValue, newValue}` shape.
 */
function convertDiffPreviewToEdit(dp) {
    return {
        op: 'set',
        path: String(dp?.path || ''),
        oldValue: dp?.before !== undefined
            ? dp.before
            : (dp?.oldValue !== undefined ? dp.oldValue : null),
        newValue: dp?.after !== undefined
            ? dp.after
            : (dp?.newValue !== undefined ? dp.newValue : null),
    };
}

/**
 * Convert the legacy `pendingApproval` envelope into `pendingEdits[]`.
 * `diffPreviews` is preferred when present (it's the rendered shape the
 * legacy popup actually showed the user); otherwise fall back to the
 * `operations[]` array and synthesize from its `.args`.
 */
function convertPendingApproval(pendingApproval) {
    if (!pendingApproval || typeof pendingApproval !== 'object') return [];
    const ops = Array.isArray(pendingApproval.operations) ? pendingApproval.operations : [];
    const previews = Array.isArray(pendingApproval.diffPreviews) ? pendingApproval.diffPreviews : [];
    if (previews.length > 0) return previews.map(convertDiffPreviewToEdit);
    return ops.map(op => ({
        op: 'set',
        path: String(op?.path || op?.args?.field || ''),
        oldValue: op?.args?.oldValue ?? null,
        newValue: op?.args?.newValue ?? op?.args?.value ?? null,
    }));
}
