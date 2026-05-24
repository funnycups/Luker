/**
 * Unified CEA editor — per-character session store.
 *
 * The unified editor popup replaces the legacy character-editor popup that
 * used `getCharacterState` / `setCharacterState` against the
 * `character_editor_assistant_sessions` namespace on the character card.
 *
 * The new store is plugin-owned: sessions live in
 *   extension_settings.character_editor_assistant.unified_cea_editor_sessions[char_<avatar>]
 * Each session persists:
 *   { id, title, avatar, messages, pendingEdits, live, surfaceState, updatedAt }
 * where:
 *   - `messages[]` items match `normalizeMessageShape` below
 *   - `pendingEdits[]` items carry `{ ..., target: { kind, bookName? } }` so a
 *     single batch can mix character edits and lorebook edits
 *   - `live` is the apply target: `{ character, lorebooks: { [bookName]: { entries, meta } } }`
 *
 * This is a thin wrapper around
 * `iteration-library/storage.createExtensionSettingsSessionStorage`. The
 * wrapper binds the per-avatar bucket path so the popup doesn't need to
 * know about extension_settings layout.
 */

import { createExtensionSettingsSessionStorage } from '../../../iteration-library/storage.js';

/** Bucket key on the CEA extension settings root. */
const UNIFIED_CEA_EDITOR_NAMESPACE = 'unified_cea_editor_sessions';

/**
 * Generate a stable per-message id. Mirrors the sibling popup conventions
 * (`cea_editor_msg_*`, `orch_msg_*`, `cpa_msg_*`, `mg_msg_*`) — downstream
 * code that walks session messages can fingerprint by prefix if it needs
 * to know origin (it usually doesn't).
 */
export function makeMessageId() {
    return `cea_editor_msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize a single tool call entry. Tool calls land in `assistant` messages
 * and are paired with `toolResults` (next message, by `tool_call_id`).
 */
function normalizeToolCall(tc) {
    const t = tc && typeof tc === 'object' ? tc : {};
    return {
        id: String(t.id || ''),
        name: String(t.name || ''),
        args: (t.args && typeof t.args === 'object') ? t.args : {},
    };
}

/**
 * Normalize a tool-result entry. The unified editor surfaces both the tool's
 * structured response (`content`) and a coarse status string so the UI can
 * mark failed calls without re-parsing the payload.
 */
function normalizeToolResult(tr) {
    const r = tr && typeof tr === 'object' ? tr : {};
    return {
        tool_call_id: String(r.tool_call_id || ''),
        content: r.content !== undefined ? r.content : null,
        status: r.status ? String(r.status) : 'ok',
    };
}

/**
 * Normalize an edit entry. Multi-target edits carry a `target` discriminator:
 *   - `{ kind: 'character' }`                   — applies to the active character
 *   - `{ kind: 'lorebook', bookName: 'Book' }`  — applies to a named world book
 *
 * Unknown `target.kind` values are dropped (the resulting edit is treated as
 * character-scoped by downstream apply logic — matching the legacy behavior
 * where edits had no target at all).
 *
 * Op-specific fields (`find`, `replace`, `uid`, `entry`, `patch`, `before`,
 * `insert_text`, `after_text`, `expected_count`) are preserved when present —
 * stripping them would empty out the diff card for `str_replace` and
 * `lorebook_entry_*` ops, and would also break rollback because `inverseEdit`
 * needs `patch`/`before` and `entry` to rebuild the inverse op.
 */
function normalizeEdit(e) {
    if (!e || typeof e !== 'object') return e;
    const out = {
        op: String(e.op || 'set'),
        path: typeof e.path === 'string' ? e.path : String(e.path || ''),
    };
    if ('oldValue' in e) out.oldValue = e.oldValue;
    if ('newValue' in e) out.newValue = e.newValue;
    // Op-specific fields — present on str_replace / lorebook_entry_* edits.
    // Use property-presence checks (not truthiness) so falsy-but-set values
    // (`''`, `0`, `null`) round-trip intact.
    if ('find' in e) out.find = e.find;
    if ('replace' in e) out.replace = e.replace;
    if ('insert_text' in e) out.insert_text = e.insert_text;
    if ('after_text' in e) out.after_text = e.after_text;
    if ('uid' in e) out.uid = e.uid;
    if ('entry' in e) out.entry = e.entry;
    if ('patch' in e) out.patch = e.patch;
    if ('before' in e) out.before = e.before;
    if ('expected_count' in e) out.expected_count = e.expected_count;
    if (e.target && typeof e.target === 'object') {
        const kind = String(e.target.kind || '');
        if (kind === 'character') {
            out.target = { kind: 'character' };
        } else if (kind === 'lorebook') {
            out.target = e.target.bookName
                ? { kind: 'lorebook', bookName: String(e.target.bookName) }
                : { kind: 'lorebook' };
        }
    }
    return out;
}

/**
 * Normalize a persisted message into the canonical shape rendered by the
 * unified editor studio. Tolerant of:
 *   - sparse legacy entries (`{role, content}` only)
 *   - missing arrays (defaulted to `[]`, not `undefined` — visibility gates
 *     in the renderer use `Array.isArray && .length > 0`)
 *   - missing `id` / `at` (regenerated / set to `Date.now()`)
 *
 * Unlike the older `character-iteration` shape, this:
 *   - always returns `toolCalls`, `toolResults`, and `edits` as arrays
 *   - includes `toolResults` (linked to `toolCalls` by `tool_call_id`)
 *   - carries `appliedTarget` as a free-form string (e.g. `'character'`,
 *     `'lorebook:BookA'`, `'character + 2 lorebooks'`) — the popup decides
 *     how to render it
 */
export function normalizeMessageShape(message) {
    const m = message && typeof message === 'object' ? message : {};
    const role = String(m.role || 'user');
    return {
        id: typeof m.id === 'string' && m.id ? m.id : makeMessageId(),
        role,
        content: String(m.content ?? ''),
        toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls.map(normalizeToolCall) : [],
        toolResults: Array.isArray(m.toolResults) ? m.toolResults.map(normalizeToolResult) : [],
        edits: Array.isArray(m.edits) ? m.edits.map(normalizeEdit) : [],
        appliedAt: typeof m.appliedAt === 'number' ? m.appliedAt : null,
        appliedTarget: typeof m.appliedTarget === 'string' ? m.appliedTarget : '',
        rolledBackAt: typeof m.rolledBackAt === 'number' ? m.rolledBackAt : null,
        auto: Boolean(m.auto),
        at: typeof m.at === 'number' ? m.at : Date.now(),
    };
}

/**
 * Per-character unified-editor session store factory.
 *
 * Two equivalent call shapes are accepted:
 *
 *   // 1. Plugin-direct (mirrors character-iteration sibling — production caller):
 *   createUnifiedCeaEditorSessionStore({
 *       getSettings: () => extension_settings.character_editor_assistant,
 *       persistSettings: saveSettingsDebounced,
 *       avatar: 'alice.png',
 *   });
 *
 *   // 2. Context-bundle (test caller / future ctx-driven plugins):
 *   createUnifiedCeaEditorSessionStore({
 *       context: { extensionSettings: {...}, saveSettingsDebounced },
 *       avatar: 'alice.png',
 *       computeScope: () => 'character', // reserved; currently unused
 *   });
 *
 * Form 2 derives `getSettings` from `context.extensionSettings` (creating a
 * `character_editor_assistant` namespace if missing) and `persistSettings`
 * from `context.saveSettingsDebounced` (falling back to `saveSettings`, then
 * a no-op). The `computeScope` hook is reserved for future scope strategies
 * (e.g. per-chat sessions) and is currently ignored.
 *
 * Both shapes return the same `{ list, load, save, delete, remove }` interface
 * (`remove` is an alias of `delete` so destructuring callers can avoid the
 * reserved word).
 *
 * @returns {{
 *   list:   () => Promise<Array<{ id: string, title: string, updatedAt: number }>>,
 *   load:   (id: string) => Promise<object | null>,
 *   save:   (session: object) => Promise<void>,
 *   delete: (id: string) => Promise<void>,
 *   remove: (id: string) => Promise<void>,
 * }}
 */
export function createUnifiedCeaEditorSessionStore(opts = {}) {
    const avatar = opts && opts.avatar;
    if (!avatar) {
        throw new TypeError('createUnifiedCeaEditorSessionStore: avatar is required');
    }

    const { getSettings, persistSettings } = resolveSettingsAccessors(opts);
    const scope = `char_${avatar}`;

    const inner = createExtensionSettingsSessionStorage({
        getBucket: () => {
            const settings = getSettings();
            if (!settings[UNIFIED_CEA_EDITOR_NAMESPACE] || typeof settings[UNIFIED_CEA_EDITOR_NAMESPACE] !== 'object') {
                settings[UNIFIED_CEA_EDITOR_NAMESPACE] = {};
            }
            const root = settings[UNIFIED_CEA_EDITOR_NAMESPACE];
            if (!root[scope] || typeof root[scope] !== 'object') {
                root[scope] = {};
            }
            return root[scope];
        },
        persistSettings,
    });

    const deleteFn = (id) => inner.deleteSession(scope, id);
    return {
        list: () => inner.listSessions(scope),
        load: (id) => inner.loadSession(scope, id),
        save: (session) => inner.saveSession(scope, session),
        // `delete` mirrors the character-iteration sibling so existing callers
        // can be ported with a one-line import swap. `remove` is an alias that
        // dodges the reserved-word footgun for callers that destructure (e.g.
        // `const { remove } = store;`).
        delete: deleteFn,
        remove: deleteFn,
    };
}

/**
 * Resolve `{ getSettings, persistSettings }` from either form-1 or form-2
 * options. Centralizes the small dance of "use what the caller gave us, fall
 * back gracefully" so the factory body stays focused on bucket plumbing.
 */
function resolveSettingsAccessors(opts) {
    if (typeof opts.getSettings === 'function') {
        const persistSettings = typeof opts.persistSettings === 'function' ? opts.persistSettings : noop;
        return { getSettings: opts.getSettings, persistSettings };
    }
    const ctx = opts.context;
    if (ctx && typeof ctx === 'object') {
        const root = (ctx.extensionSettings && typeof ctx.extensionSettings === 'object')
            ? ctx.extensionSettings
            : {};
        const getSettings = () => {
            if (!root.character_editor_assistant || typeof root.character_editor_assistant !== 'object') {
                root.character_editor_assistant = {};
            }
            return root.character_editor_assistant;
        };
        const persistSettings = typeof ctx.saveSettingsDebounced === 'function'
            ? ctx.saveSettingsDebounced
            : (typeof ctx.saveSettings === 'function' ? ctx.saveSettings : noop);
        return { getSettings, persistSettings };
    }
    throw new TypeError('createUnifiedCeaEditorSessionStore: provide either { getSettings, persistSettings } or { context }');
}

function noop() {}
