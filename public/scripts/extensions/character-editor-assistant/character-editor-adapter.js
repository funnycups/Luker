import lodash from 'lodash';
import { defineAdapter } from '../../iteration-studio/index.js';
import {
    createLorebookEntryAddOp,
    createLorebookEntryUpdateOp,
    createLorebookEntryRemoveOp,
} from './lorebook-ops.js';

/**
 * Parse a tool-call's JSON arguments. Returns `null` if the JSON is malformed
 * so the caller can short-circuit and emit no edits (the orchestrator treats
 * `null` distinctly from `[]`, which means "valid call but no edits").
 */
function parseArgs(call) {
    try {
        return JSON.parse(call?.function?.arguments ?? '{}');
    } catch {
        return null;
    }
}

/**
 * Static tool catalog for the CEA Character Editor adapter.
 *
 * Six tools span the two halves of `live`:
 *   - card-field tools route to the built-in `set` / `str_replace` ops
 *   - lorebook-entry tools route to the CEA-registered custom ops keyed by uid
 *   - `cea_set_lorebook_metadata` covers top-level lorebook fields (e.g. bookName)
 *
 * Each tool definition is OpenAI-style JSON-schema so the catalog can be
 * forwarded to any provider that consumes the function-calling format.
 */
const TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'cea_set_card_field',
            description: 'Set a character card field to a new value.',
            parameters: {
                type: 'object',
                properties: {
                    field: { type: 'string', description: 'Card field name (e.g. name, description, personality).' },
                    value: { type: 'string', description: 'New value for the field.' },
                },
                required: ['field', 'value'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_str_replace_card_field',
            description: 'Find-and-replace a substring inside a character card field.',
            parameters: {
                type: 'object',
                properties: {
                    field: { type: 'string', description: 'Card field name.' },
                    find: { type: 'string', description: 'Substring to locate.' },
                    replace: { type: 'string', description: 'Replacement text.' },
                },
                required: ['field', 'find', 'replace'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_add_lorebook_entry',
            description: 'Add a new lorebook entry. The entry object must include uid.',
            parameters: {
                type: 'object',
                properties: {
                    entry: {
                        type: 'object',
                        description: 'The new entry, including uid, key, content, and any other lorebook fields.',
                    },
                },
                required: ['entry'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_update_lorebook_entry',
            description: 'Patch fields of an existing lorebook entry, identified by uid.',
            parameters: {
                type: 'object',
                properties: {
                    uid: { type: 'integer', description: 'uid of the entry to update.' },
                    patch: {
                        type: 'object',
                        description: 'Object of fields to merge into the entry (shallow merge).',
                    },
                },
                required: ['uid', 'patch'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_remove_lorebook_entry',
            description: 'Remove a lorebook entry by uid.',
            parameters: {
                type: 'object',
                properties: {
                    uid: { type: 'integer', description: 'uid of the entry to remove.' },
                },
                required: ['uid'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_set_lorebook_metadata',
            description: 'Set a top-level lorebook metadata field (e.g. bookName).',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Metadata key (e.g. bookName).' },
                    value: { description: 'New value for the metadata field.' },
                },
                required: ['key', 'value'],
            },
        },
    },
];

export function createCharacterEditorAdapter(deps) {
    const { avatar, i18n, i18nFormat } = deps;
    let previousLiveSnapshot = null;
    // Snapshots of the last-committed (or last-read, if no commit has happened
    // yet) card and lorebook. Used by `commit()` to compute a minimal diff:
    // only changed card fields are passed to mergeCharacterAttributes, and the
    // lorebook save is skipped entirely when nothing changed. `live()` primes
    // them on first read so that the very first commit can diff against the
    // actual persisted state rather than a stale starting value.
    let prevCardSnapshot = null;
    let prevLorebookSnapshot = null;

    function cardDiff(before, after) {
        const patch = {};
        const keys = new Set([
            ...Object.keys(before || {}),
            ...Object.keys(after || {}),
        ]);
        for (const k of keys) {
            if (!lodash.isEqual(before?.[k], after?.[k])) patch[k] = after?.[k];
        }
        return patch;
    }

    const escapeHtml = (s) => (typeof deps.escapeHtml === 'function' ? deps.escapeHtml(s) : String(s ?? ''));

    /**
     * Render the body of the currently-active preview tab. Kept private so the
     * tab buttons stay co-located with the tab content in `renderPreviewPane`.
     *
     * - `card`: simple <label>/<value> rows per character-card field, in
     *   Object.entries iteration order. Empty card => empty body.
     * - `lorebook`: one row per entry value, keyed by uid, with the entry's
     *   `content` string (truncation/rich rendering is a future enhancement).
     * - `diff` (and unknown tabs): placeholder asking the user to pick a
     *   reference from the toolbar. Per the plan, real diff rendering is a
     *   follow-up; for SP-3 the tab is wired so the UX surface is in place.
     */
    function renderTabBody(tab, live) {
        if (tab === 'card') {
            return Object.entries(live?.card || {}).map(
                ([k, v]) => `<div class="cea_character_field"><label>${escapeHtml(k)}</label><div>${escapeHtml(String(v ?? ''))}</div></div>`,
            ).join('');
        }
        if (tab === 'lorebook') {
            return Object.values(live?.lorebook?.entries || {}).map(
                (e) => `<div class="cea_character_entry"><label>uid ${escapeHtml(String(e?.uid ?? ''))}</label><div>${escapeHtml(String(e?.content ?? ''))}</div></div>`,
            ).join('');
        }
        return `<div class="cea_character_diff_placeholder">${escapeHtml(i18n('Pick a reference from the toolbar to compare.'))}</div>`;
    }

    // Session storage is rooted at `extension_settings.character_editor_assistant
    // .popupSessionsV2[scope]`. `getBucket` lazily creates both levels so callers
    // never have to null-check. `scope` is the per-character key returned by
    // `sessionScope()` (currently `char_<avatar>`), so sessions for different
    // characters live in disjoint buckets.
    function getBucket(scope) {
        const settings = deps.getSettings();
        if (!settings.popupSessionsV2) settings.popupSessionsV2 = {};
        if (!settings.popupSessionsV2[scope]) settings.popupSessionsV2[scope] = {};
        return settings.popupSessionsV2[scope];
    }

    return defineAdapter({
        id: `cea_character_${avatar}`,
        title: i18n('Character Editor'),
        mode: 'cea_character',
        layout: 'split',
        popupClassName: 'luker_cea_character_popup',
        i18n, i18nFormat,

        live: async () => {
            const card = structuredClone(await deps.readCard());
            const lorebook = structuredClone(await deps.readLorebook());
            if (prevCardSnapshot === null) prevCardSnapshot = structuredClone(card);
            if (prevLorebookSnapshot === null) prevLorebookSnapshot = structuredClone(lorebook);
            return { card, lorebook };
        },
        commit: async (newLive) => {
            const cardBefore = prevCardSnapshot ?? await deps.readCard();
            const lorebookBefore = prevLorebookSnapshot ?? await deps.readLorebook();

            const cardPatch = cardDiff(cardBefore, newLive.card);
            if (Object.keys(cardPatch).length > 0) {
                await deps.mergeCharacterAttributes(deps.getContext(), deps.avatar, cardPatch);
            }

            if (!lodash.isEqual(lorebookBefore, newLive.lorebook)) {
                await deps.saveLorebook(newLive.lorebook.bookName, { entries: newLive.lorebook.entries });
            }

            prevCardSnapshot = structuredClone(newLive.card);
            prevLorebookSnapshot = structuredClone(newLive.lorebook);
        },

        sessionScope: () => `char_${avatar}`,
        listSessions: async (scope) => {
            const bucket = getBucket(scope);
            return Object.values(bucket)
                .map(s => ({
                    id: s.id,
                    title: s.title || '',
                    updatedAt: s.updatedAt || 0,
                    summary: s.summary || '',
                }))
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        },
        loadSession: async (scope, id) => {
            const bucket = getBucket(scope);
            const s = bucket[id];
            return s ? structuredClone(s) : null;
        },
        saveSession: async (scope, session) => {
            const bucket = getBucket(scope);
            bucket[session.id] = structuredClone(session);
            deps.saveSettingsDebounced();
        },
        deleteSession: async (scope, id) => {
            const bucket = getBucket(scope);
            delete bucket[id];
            deps.saveSettingsDebounced();
        },
        // Sweep away pre-v2 storage keys left behind by older CEA versions:
        //   - `lorebookSyncHistory`: the original lorebook-sync flat blob.
        //   - `popupSessions`: any hypothetical pre-v2 session bucket.
        // The v2 bucket (`popupSessionsV2`) is left untouched so that current
        // sessions survive the migration. Called once per scope during popup
        // initialization, after which the keys are gone for good.
        clearObsoleteSessions: async (_scope) => {
            const settings = deps.getSettings();
            delete settings.lorebookSyncHistory;
            delete settings.popupSessions;
            deps.saveSettingsDebounced();
        },

        registerCustomOps: (registry) => {
            registry.registerOp('lorebook_entry_add', createLorebookEntryAddOp());
            registry.registerOp('lorebook_entry_update', createLorebookEntryUpdateOp());
            registry.registerOp('lorebook_entry_remove', createLorebookEntryRemoveOp());
        },

        buildToolCatalog: () => TOOL_DEFS,

        normalizeToolCallToEdit: async (call, ctx) => {
            const name = call?.function?.name;
            const args = parseArgs(call);
            if (args === null) return null;
            const live = ctx?.live ?? {};

            if (name === 'cea_set_card_field') {
                return [{
                    op: 'set',
                    path: `card.${args.field}`,
                    oldValue: live.card?.[args.field],
                    newValue: args.value,
                }];
            }
            if (name === 'cea_str_replace_card_field') {
                return [{
                    op: 'str_replace',
                    path: `card.${args.field}`,
                    find: String(args.find ?? ''),
                    replace: String(args.replace ?? ''),
                }];
            }
            if (name === 'cea_add_lorebook_entry') {
                return [{
                    op: 'lorebook_entry_add',
                    path: 'lorebook.entries',
                    uid: args.entry?.uid,
                    entry: args.entry,
                }];
            }
            if (name === 'cea_update_lorebook_entry') {
                // Capture `before` from live state at emission time, for only the
                // fields the patch touches. This makes the edit self-contained:
                // inverse(edit) just swaps `patch` and `before`.
                const cur = live.lorebook?.entries?.[args.uid];
                const before = {};
                for (const k of Object.keys(args.patch || {})) {
                    before[k] = cur?.[k];
                }
                return [{
                    op: 'lorebook_entry_update',
                    path: 'lorebook.entries',
                    uid: args.uid,
                    patch: args.patch,
                    before,
                }];
            }
            if (name === 'cea_remove_lorebook_entry') {
                // Snapshot the live entry so the inverse `lorebook_entry_add`
                // can faithfully restore it without re-reading state.
                const entry = live.lorebook?.entries?.[args.uid];
                return [{
                    op: 'lorebook_entry_remove',
                    path: 'lorebook.entries',
                    uid: args.uid,
                    entry: entry ? structuredClone(entry) : undefined,
                }];
            }
            if (name === 'cea_set_lorebook_metadata') {
                return [{
                    op: 'set',
                    path: `lorebook.${args.key}`,
                    oldValue: live.lorebook?.[args.key],
                    newValue: args.value,
                }];
            }
            return [];
        },

        buildSystemPrompt: () => `You are the AI assistant for the Character Editor. You may propose edits to:
- Character card fields (name, description, personality, scenario, first_mes, mes_example).
- Lorebook entries (each identified by a numeric uid).
- Lorebook metadata (bookName etc.).
Use the cea_* tools to propose each edit. Each edit becomes a reviewable change the user can apply or reject.`,
        buildUserPrompt: (_s, userText, _opts) => userText,

        renderMessageCard: (message, _state) => {
            const role = String(message?.role || 'user');
            const body = escapeHtml(message?.content || '');
            let summary = '';
            if (Array.isArray(message?.appliedEdits) && message.appliedEdits.length > 0) {
                summary = `<div class="luker-studio-message-edits">${message.appliedEdits.length} ${escapeHtml(i18n('edit(s)'))}</div>`;
            }
            return `<div class="luker-studio-message luker-studio-message-${escapeHtml(role)}">
    <div class="luker-studio-message-body">${body}</div>${summary}
</div>`;
        },

        renderHistoryItem: (meta) => {
            const id = String(meta?.id || '');
            const title = String(meta?.title || meta?.id || '');
            return `<div class="luker-studio-history-item" data-iter-action="load-history" data-id="${escapeHtml(id)}">
    <div class="luker-studio-history-title">${escapeHtml(title)}</div>
    <div class="luker-studio-history-time">${escapeHtml(String(meta?.updatedAt ?? ''))}</div>
</div>`;
        },

        renderPreviewPane: (state) => {
            const activeTab = state?.session?.surfaceState?.activeTab || 'card';
            const live = state?.live || { card: {}, lorebook: { entries: {} } };
            const cls = (tab) => activeTab === tab ? 'active' : '';
            return `<div class="cea_character_pane">
    <div class="cea_character_tabs">
        <button data-iter-action="cea-tab-card" class="${cls('card')}">${escapeHtml(i18n('Card fields'))}</button>
        <button data-iter-action="cea-tab-lorebook" class="${cls('lorebook')}">${escapeHtml(i18n('Lorebook'))}</button>
        <button data-iter-action="cea-tab-diff" class="${cls('diff')}">${escapeHtml(i18n('Diff vs reference'))}</button>
    </div>
    <div class="cea_character_tab_body">${renderTabBody(activeTab, live)}</div>
</div>`;
        },

        renderToolbarSlots: (_state) => {
            // No CEA-specific toolbar controls in SP-3; reserved for the
            // future "reference picker" that drives the diff tab. Returning
            // an empty object keeps the shell happy and leaves room to grow.
            return {};
        },

        handleAction: async (actionId, { session } = {}) => {
            if (!session) return;
            const tabMap = {
                'cea-tab-card': 'card',
                'cea-tab-lorebook': 'lorebook',
                'cea-tab-diff': 'diff',
            };
            const nextTab = tabMap[actionId];
            if (nextTab) {
                session.surfaceState = { ...(session.surfaceState || {}), activeTab: nextTab };
            }
            // Shell re-renders after handleAction returns.
        },
    });
}
