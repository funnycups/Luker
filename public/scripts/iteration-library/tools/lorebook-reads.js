// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Lorebook read tools shared by iter popups (orchestrator iter-studio,
 * memory-graph schema iter, etc).
 *
 * Why shared: each popup needs the AI to read the active character's world
 * books while shaping its artifact — orchestrator agents that reference
 * specific facts, schema fields that mirror existing lorebook columns,
 * etc. The wire format and the legacy `luker_card_*` dispatcher are
 * identical across popups; only the system prompt around the tools is
 * popup-specific.
 *
 * Architecture: this module is plugin-agnostic. The legacy helper-tool
 * dispatcher lives in `character-editor-assistant/main.js` and is scoped
 * to a specific character via `helperApis`. Callers inject it via the
 * `dispatch` argument; this module never imports from CEA so it stays
 * usable from any popup that wants lorebook reads.
 *
 * Exports:
 *   - LOREBOOK_READ_TOOL_LEGACY_NAMES — short name → legacy `luker_card_*`
 *     wire name. The model sees the short names; the legacy dispatcher
 *     receives the wire names.
 *   - isLorebookReadTool(name): boolean — runtime predicate.
 *   - LOREBOOK_READ_TOOL_DEFS — OpenAI-style function definitions ready
 *     to splice into a popup's tool catalog.
 *   - runLorebookReadTool(call, { dispatch, helperApis }): runs one tool
 *     call. Returns `{ ok: true, result }` or `{ ok: false, error }` so
 *     the popup can persist a tool_result either way.
 */

export const LOREBOOK_READ_TOOL_LEGACY_NAMES = Object.freeze({
    lorebook_list: 'luker_card_list_lorebook_entries',
    lorebook_query: 'luker_card_query_lorebook_entries',
    lorebook_get: 'luker_card_get_lorebook_entries',
    world_book_list: 'luker_card_list_world_books',
});

const LOREBOOK_READ_TOOL_NAME_SET = new Set(Object.keys(LOREBOOK_READ_TOOL_LEGACY_NAMES));

export function isLorebookReadTool(name) {
    return LOREBOOK_READ_TOOL_NAME_SET.has(String(name || ''));
}

export const LOREBOOK_READ_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'world_book_list',
            description: 'List world book names visible to the character being designed, tagged with their scope (character, character_aux, chat, global). Call before lorebook_list / lorebook_query / lorebook_get to know which book names exist.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lorebook_list',
            description: 'List compact lorebook entry index rows (uid, name, enabled) for a world book. Optional range narrows the inclusive UID window, for example 0~100.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    range: { type: 'string', description: 'Optional inclusive UID range such as 0~100, 50~, ~100, or a single uid like 42.' },
                },
                required: ['book_name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lorebook_query',
            description: 'Search a world book and return lightweight matching entries. Use this before lorebook_get to narrow candidates.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    text: { type: 'string' },
                    search_mode: { type: 'string', enum: ['any', 'activation'] },
                    constant: { type: 'boolean' },
                    enabled: { type: 'boolean' },
                    limit: { type: 'integer', minimum: 1, maximum: 20 },
                },
                required: ['book_name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lorebook_get',
            description: 'Fetch full lorebook entries from a world book by uid after narrowing candidates with lorebook_query.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    uids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 10 },
                },
                required: ['book_name', 'uids'],
                additionalProperties: false,
            },
        },
    },
];

/**
 * Execute one lorebook read tool. Translates the short canonical name to
 * the legacy `luker_card_*` wire name + dispatches through the supplied
 * helper-tool runner. The dispatcher itself is plugin-owned (lives in
 * `character-editor-assistant/main.js#runCharacterEditorHelperToolCall`)
 * and is injected via `dispatch` so this module stays plugin-agnostic.
 *
 * @param {object} call — `{ id, name, args }` from the runner
 * @param {object} ctx
 * @param {(legacyCall: object, helperApis: any) => Promise<any>} ctx.dispatch
 * @param {any[]} [ctx.helperApis] — per-character helper APIs (avatar-scoped)
 * @returns {Promise<{ ok: true, result: any } | { ok: false, error: string }>}
 */
export async function runLorebookReadTool(call, { dispatch, helperApis = [] } = {}) {
    const shortName = String(call?.name || '');
    if (!isLorebookReadTool(shortName)) {
        return { ok: false, error: `Not a lorebook read tool: ${shortName || '(empty)'}` };
    }
    if (typeof dispatch !== 'function') {
        return { ok: false, error: 'runLorebookReadTool: ctx.dispatch must be a function' };
    }
    const legacyName = LOREBOOK_READ_TOOL_LEGACY_NAMES[shortName];
    const legacyCall = {
        id: call?.id,
        name: legacyName,
        args: call?.args && typeof call.args === 'object' ? call.args : {},
    };
    try {
        const raw = await dispatch(legacyCall, helperApis);
        const result = raw && typeof raw === 'object' && Object.hasOwn(raw, 'result')
            ? raw.result
            : raw;
        return { ok: true, result };
    } catch (err) {
        return { ok: false, error: String(err?.message || err || 'unknown error') };
    }
}
