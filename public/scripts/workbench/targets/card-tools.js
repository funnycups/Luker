// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Platform-owned character card & worldbook AI iteration tool catalog,
 * edit normalizer, and draft-aware read dispatcher.
 * Zero imports from extensions/.
 */

import { CHARACTER_PRESET_READ_TOOL_DEFS, runCharacterPresetReadTool } from '../../iteration-library/tools/character-presets-reads.js';
import { lorebookHelpers as H } from '../../iteration-library/tools/_lorebook-helpers.js';
import { readFieldsByEnum } from '../../iteration-library/read-fields-helper.js';
import { diagnoseAnchorMiss } from '../../iteration-library/anchor-diagnostic.js';
import {
    CEA_CARD_FIELD_ENUM,
    isKnownCardField,
    parseAlternateGreetingsValue,
    projectCardV2Fields,
    runCardSimulatePrompt,
} from './card-world.js';

export { CEA_CARD_FIELD_ENUM, isKnownCardField };

export async function dispatchCeaReadCardFields({ state, args } = {}) {
    const rawChar = (state && state.live && typeof state.live.character === 'object' && state.live.character !== null)
        ? state.live.character
        : null;
    const character = rawChar ? projectCardV2Fields(rawChar) : {};
    return readFieldsByEnum(character, args?.fields, CEA_CARD_FIELD_ENUM);
}

function buildAnchorMissError({ toolName, currentText, oldString, nextStepHint, detail }) {
    const cur = String(currentText ?? '');
    const diagnosis = diagnoseAnchorMiss(cur, String(oldString ?? ''));
    const err = new Error(`${toolName}: not_found — ${detail || 'oldString not present in the current text.'} ${nextStepHint}`);
    err.envelope = {
        ok: false,
        error: 'not_found',
        detail: detail || 'oldString not present in the current text.',
        currentLength: cur.length,
        match_diagnosis: diagnosis,
        next_step: nextStepHint,
    };
    err.code = 'not_found';
    return err;
}

const CEA_EDIT_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'cea_set_card_field',
            description: 'Set a character card field to a new value. `field` is restricted to the canonical card fields enum. For `alternate_greetings`, pass a string[] or JSON-encoded string[].',
            parameters: {
                type: 'object',
                properties: {
                    field: {
                        type: 'string',
                        enum: [...CEA_CARD_FIELD_ENUM],
                        description: 'Card field name. Restricted to: name / description / personality / scenario / first_mes / mes_example / system_prompt / post_history_instructions / creator_notes / alternate_greetings.',
                    },
                    value: {
                        description: 'New value for the field (string for text fields; string[] or JSON-encoded string[] for alternate_greetings).',
                    },
                },
                required: ['field', 'value'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_str_replace_card_field',
            description: 'Find-and-replace a substring inside a character card field. By default `oldString` must occur exactly once — fails otherwise; widen with surrounding context until unique, or pass `replaceAll: true` to replace every occurrence. `field` is restricted to the canonical card fields enum.',
            parameters: {
                type: 'object',
                properties: {
                    field: {
                        type: 'string',
                        enum: [...CEA_CARD_FIELD_ENUM],
                        description: 'Card field name. Restricted to the canonical card fields enum (see cea_set_card_field).',
                    },
                    oldString: { type: 'string', description: 'Substring to locate. Must occur exactly once unless `replaceAll` is true.' },
                    newString: { type: 'string', description: 'Replacement text.' },
                    replaceAll: { type: 'boolean', description: 'Optional. When true, replace every occurrence of `oldString`. Default false (unique-or-fail).' },
                },
                required: ['field', 'oldString', 'newString'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_add_lorebook_entry',
            description: 'Add a new lorebook entry. The entry object must include uid. book_name selects which world book to target (call world_book_list first if unsure which books are bound to this character).',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Target world book name.' },
                    entry: {
                        type: 'object',
                        description: 'The new entry, including uid, key, content, and any other lorebook fields.',
                    },
                },
                required: ['book_name', 'entry'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_update_lorebook_entry',
            description: 'Patch fields of an existing lorebook entry, identified by uid. book_name selects which world book to target. Prefer cea_str_replace_lorebook_entry_field for partial text edits within a single field.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Target world book name.' },
                    uid: { type: 'integer', description: 'uid of the entry to update.' },
                    patch: {
                        type: 'object',
                        description: 'Object of fields to merge into the entry (shallow merge).',
                    },
                },
                required: ['book_name', 'uid', 'patch'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_str_replace_lorebook_entry_field',
            description: 'Find-and-replace a substring inside a single field of a lorebook entry. Mirrors cea_str_replace_card_field for lorebook entries — preferred over cea_update_lorebook_entry when you only want to tweak a portion of one field (typically `content`) without resending the entire field. By default `oldString` must occur exactly once; pass `replaceAll: true` to replace every occurrence. Bails out without staging an edit when `oldString` is not present in the current value.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Target world book name.' },
                    uid: { type: 'integer', description: 'uid of the entry to edit.' },
                    field: { type: 'string', description: 'Entry field to edit (commonly `content`; also valid: `comment`, `key`, etc.).' },
                    oldString: { type: 'string', description: 'Substring to locate inside the field. Must occur exactly once unless `replaceAll` is true.' },
                    newString: { type: 'string', description: 'Replacement text.' },
                    replaceAll: { type: 'boolean', description: 'Optional. When true, replace every occurrence of `oldString`. Default false (unique-or-fail).' },
                },
                required: ['book_name', 'uid', 'field', 'oldString', 'newString'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_remove_lorebook_entry',
            description: 'Remove a lorebook entry by uid. book_name selects which world book to target.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Target world book name.' },
                    uid: { type: 'integer', description: 'uid of the entry to remove.' },
                },
                required: ['book_name', 'uid'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_set_lorebook_metadata',
            description: 'Set a top-level lorebook metadata field (e.g. scan_depth, recursive_scan). book_name selects which world book to target. Do not use this to rename the lorebook itself — bookName renames are rejected at commit time; the user must rename via the world-info panel.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Target world book name.' },
                    key: { type: 'string', description: 'Metadata key (e.g. scan_depth). Setting `bookName` is rejected — use the world-info panel to rename a lorebook.' },
                    value: { description: 'New value for the metadata field.' },
                },
                required: ['book_name', 'key', 'value'],
            },
        },
    },
];

function parseArgs(call) {
    try {
        return JSON.parse(call?.function?.arguments ?? '{}');
    } catch {
        return null;
    }
}

export function resolveBookNameFromArgsOrSingle(args, live = null) {
    let bookName = String(args?.book_name ?? args?.world_name ?? '').trim();
    if (!bookName && live && typeof live === 'object') {
        const lorebooks = live.lorebooks && typeof live.lorebooks === 'object' ? live.lorebooks : {};
        const candidates = Object.keys(lorebooks);
        if (candidates.length === 1) {
            bookName = String(candidates[0]).trim();
        }
    }
    return bookName;
}

function readCharacterField(character, field) {
    if (!character || typeof character !== 'object') return undefined;
    if (Object.hasOwn(character, field) && character[field] !== undefined) {
        return character[field];
    }
    if (character.data && typeof character.data === 'object' && Object.hasOwn(character.data, field)) {
        return character.data[field];
    }
    return undefined;
}

function strReplaceInStringArray(arr, { find, replace, replaceAll, toolName, field }) {
    const items = Array.isArray(arr) ? arr.map((item) => String(item ?? '')) : [];
    const totalOccurrences = items.reduce((sum, item) => sum + (item.split(find).length - 1), 0);
    if (totalOccurrences === 0) {
        throw buildAnchorMissError({
            toolName,
            currentText: items.join('\n—\n'),
            oldString: find,
            nextStepHint: `Call cea_read_card_fields(['${field}']) to see the current text, then re-issue the patch.`,
            detail: `oldString is not present in card field "${field}".`,
        });
    }
    if (!replaceAll && totalOccurrences !== 1) {
        throw new Error(`${toolName}: multiple_matches — oldString occurs ${totalOccurrences} times in card field "${field}". Widen oldString with surrounding context until it matches exactly once, or pass replaceAll: true.`);
    }
    const nextItems = items.map((item) => item.split(find).join(replace));
    return { oldValue: items.slice(), newValue: nextItems };
}

async function normalizeUnifiedToolCallToEdit(call, ctx) {
    const name = call?.function?.name;
    const args = parseArgs(call);
    if (args === null) return null;
    const live = ctx?.live ?? {};
    const bookName = resolveBookNameFromArgsOrSingle(args, live);
    const liveBook = bookName ? (live?.lorebooks?.[bookName] ?? null) : null;

    if (name === 'cea_set_card_field') {
        const field = String(args.field ?? '').trim();
        if (!field || !isKnownCardField(field)) {
            throw new Error(`${name}: invalid_args — unknown card field "${field}".`);
        }
        const nextValue = field === 'alternate_greetings'
            ? parseAlternateGreetingsValue(args.value, name)
            : args.value;
        return [{
            op: 'set',
            path: `card.${field}`,
            oldValue: readCharacterField(live?.character, field),
            newValue: nextValue,
        }];
    }

    if (name === 'cea_str_replace_card_field') {
        const field = String(args.field ?? '').trim();
        if (!field) {
            throw new Error(`${name}: invalid_args — field is required.`);
        }
        if (!isKnownCardField(field)) {
            throw new Error(`${name}: invalid_args — unknown card field "${field}".`);
        }
        const find = String(args.oldString ?? '');
        const replace = String(args.newString ?? '');
        if (find === '') {
            throw new Error(`${name}: invalid_args — oldString must be a non-empty string.`);
        }

        const currentRaw = readCharacterField(live?.character, field);
        if (field === 'alternate_greetings') {
            if (currentRaw !== undefined && !Array.isArray(currentRaw)) {
                throw new Error(`${name}: invalid_args — alternate_greetings must be an array of strings.`);
            }
            const { oldValue, newValue } = strReplaceInStringArray(currentRaw || [], {
                find,
                replace,
                replaceAll: Boolean(args.replaceAll),
                toolName: name,
                field,
            });
            return [{
                op: 'set',
                path: `card.${field}`,
                oldValue,
                newValue,
            }];
        }

        const liveValue = String(currentRaw ?? '');
        const occurrences = liveValue.split(find).length - 1;
        if (occurrences === 0) {
            throw buildAnchorMissError({
                toolName: name,
                currentText: liveValue,
                oldString: find,
                nextStepHint: `Call cea_read_card_fields(['${field}']) to see the current text, then re-issue the patch.`,
                detail: `oldString is not present in card field "${field}".`,
            });
        }
        if (!args.replaceAll && occurrences !== 1) {
            throw new Error(`${name}: multiple_matches — oldString occurs ${occurrences} times in card field "${field}". Widen oldString with surrounding context until it matches exactly once, or pass replaceAll: true.`);
        }
        const expectedCount = args.replaceAll ? Math.max(1, occurrences) : 1;
        return [{
            op: 'str_replace',
            path: `card.${field}`,
            find,
            replace,
            expected_count: expectedCount,
        }];
    }

    if (name === 'cea_add_lorebook_entry') {
        if (!args.entry || typeof args.entry !== 'object' || Array.isArray(args.entry)) {
            throw new Error(`${name}: invalid_args — entry object is required.`);
        }
        if (args.entry.uid === undefined || args.entry.uid === null) {
            throw new Error(`${name}: invalid_args — entry.uid is required.`);
        }
        return [{
            op: 'lorebook_entry_add',
            path: 'lorebook.entries',
            uid: args.entry.uid,
            entry: args.entry,
        }];
    }

    if (name === 'cea_update_lorebook_entry') {
        const cur = liveBook?.entries?.[args.uid];
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

    if (name === 'cea_str_replace_lorebook_entry_field') {
        const field = String(args.field ?? '');
        if (!field) {
            throw new Error(`${name}: invalid_args — field is required.`);
        }
        const find = String(args.oldString ?? '');
        const replace = String(args.newString ?? '');
        const cur = liveBook?.entries?.[args.uid];
        const currentValue = cur && Object.hasOwn(cur, field) ? String(cur[field] ?? '') : '';
        if (find === '') {
            throw new Error(`${name}: invalid_args — oldString must be a non-empty string (use the regular update tool to clear a field).`);
        }
        const occurrences = currentValue.split(find).length - 1;
        if (occurrences === 0) {
            throw buildAnchorMissError({
                toolName: name,
                currentText: currentValue,
                oldString: find,
                nextStepHint: `Call lorebook_get({ book_name: '${bookName}', uids: [${args.uid}] }) to see the current entry text, then re-issue the patch.`,
                detail: `oldString is not present in lorebook entry "${args.uid}".${field} (book "${bookName}").`,
            });
        }
        if (!args.replaceAll && occurrences !== 1) {
            throw new Error(`${name}: multiple_matches — oldString occurs ${occurrences} times in lorebook entry "${args.uid}".${field} (book "${bookName}"). Widen oldString with surrounding context until it matches exactly once, or pass replaceAll: true.`);
        }
        const nextValue = currentValue.split(find).join(replace);
        return [{
            op: 'lorebook_entry_update',
            path: 'lorebook.entries',
            uid: args.uid,
            patch: { [field]: nextValue },
            before: { [field]: cur?.[field] },
        }];
    }

    if (name === 'cea_remove_lorebook_entry') {
        const entry = liveBook?.entries?.[args.uid];
        return [{
            op: 'lorebook_entry_remove',
            path: 'lorebook.entries',
            uid: args.uid,
            entry: entry ? JSON.parse(JSON.stringify(entry)) : undefined,
        }];
    }

    if (name === 'cea_set_lorebook_metadata') {
        const key = String(args.key ?? '').trim();
        if (!key) {
            throw new Error(`${name}: invalid_args — key is required.`);
        }
        if (key === 'bookName') {
            throw new Error(`${name}: invalid_args — renaming lorebooks via bookName is not supported. Use the world-info panel to rename a lorebook.`);
        }
        return [{
            op: 'set',
            path: `lorebook.${key}`,
            oldValue: liveBook?.[key],
            newValue: args.value,
        }];
    }

    return [];
}

export const CONTROL_TOOL_NAMES = Object.freeze({});
const CONTROL_TOOL_NAME_SET = new Set();

export function isCeaEditorControlCall(call) {
    return CONTROL_TOOL_NAME_SET.has(String(call?.name || ''));
}

export const CONTROL_TOOL_DEFS = [];

const READ_TOOL_LEGACY_NAMES = Object.freeze({
    cea_read_card_fields: null,
    lorebook_query: 'luker_card_query_lorebook_entries',
    lorebook_list: 'luker_card_list_lorebook_entries',
    lorebook_get: 'luker_card_get_lorebook_entries',
    world_book_list: 'luker_card_list_world_books',
    simulate_prompt: 'luker_card_simulate_prompt',
    inspect_bound_preset: 'inspect_bound_preset',
    web_search: null,
});

const READ_TOOL_NAME_SET = new Set(Object.keys(READ_TOOL_LEGACY_NAMES));

export function isCeaEditorReadTool(name) {
    return READ_TOOL_NAME_SET.has(String(name || ''));
}

const READ_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'cea_read_card_fields',
            description: 'Read exact values from the current live character card by field name. Whitelisted to the canonical author-facing fields; the field enum is fixed and any other name (including anything under `extensions`) is rejected. Use this before cea_str_replace_card_field so your oldString matches the live text byte-for-byte. Extension surfaces (character-bound world books, regex scripts, orchestrator profile, …) have their own dedicated tools — do not try to read them through this one.',
            parameters: {
                type: 'object',
                properties: {
                    fields: {
                        type: 'array',
                        items: { type: 'string', enum: [...CEA_CARD_FIELD_ENUM] },
                        description: 'Card field names to read. Only names from the fixed enum are accepted; extension surfaces are exposed through their own dedicated tools.',
                        minItems: 1,
                    },
                },
                required: ['fields'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lorebook_list',
            description: 'List compact lorebook entry index rows (uid, name, enabled) for a world book. Call world_book_list first to know which book names exist. Optional range narrows the inclusive UID window, for example 0~100.',
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
            description: 'Search a world book and return lightweight matching entries. Call world_book_list first to know which book names exist. Use this before lorebook_get to narrow candidates.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    text: { type: 'string' },
                    search_mode: { type: 'string', enum: ['any', 'activation'] },
                    constant: { type: 'boolean' },
                    enabled: { type: 'boolean' },
                    limit: { type: 'integer', minimum: 1, maximum: H.QUERY_LIMIT_MAX },
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
                    uids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: H.DETAIL_LIMIT_MAX },
                },
                required: ['book_name', 'uids'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'world_book_list',
            description: 'List world book names visible to the character being edited, tagged with their scope (character, character_aux, chat, global).',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    ...CHARACTER_PRESET_READ_TOOL_DEFS,
    {
        type: 'function',
        function: {
            name: 'simulate_prompt',
            description: 'Simulate current prompt assembly with character card and world info. Prefer text to append one user turn to the current chat. Use messages only when the user explicitly supplied a structured message array.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Preferred. Append this user text to the current chat and simulate with world info activation.' },
                    messages: {
                        type: 'array',
                        description: 'Explicit message array. Use only when the user already gave structured records/messages.',
                        items: {
                            type: 'object',
                            properties: {
                                role: { type: 'string' },
                                content: { type: 'string' },
                                mes: { type: 'string' },
                                is_user: { type: 'boolean' },
                                is_system: { type: 'boolean' },
                            },
                            additionalProperties: true,
                        },
                    },
                },
                additionalProperties: false,
            },
        },
    },
];

const WEB_SEARCH_TOOL_DEF = Object.freeze({
    type: 'function',
    function: {
        name: 'web_search',
        description: 'Search the public web and return a list of result links and snippets.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query.' },
                limit: { type: 'integer', minimum: 1, maximum: 20 },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
});

export function buildCeaEditorToolSet(_context, _settings, opts = {}) {
    const hasSearchTools = Boolean(opts?.hasSearchTools);
    const readTools = hasSearchTools
        ? [...READ_TOOL_DEFS, WEB_SEARCH_TOOL_DEF]
        : READ_TOOL_DEFS.slice();
    return [
        ...CEA_EDIT_TOOL_DEFS,
        ...readTools,
        ...CONTROL_TOOL_DEFS,
    ];
}

function adaptCallToOpenAiShape(call) {
    const name = String(call?.name || '');
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    return {
        id: call?.id,
        function: { name, arguments: JSON.stringify(args) },
    };
}

function annotateTarget(edit, call, live = null) {
    const name = String(call?.name || '');
    if (name === 'cea_set_card_field' || name === 'cea_str_replace_card_field') {
        return { ...edit, target: { kind: 'character' } };
    }
    if (name.startsWith('cea_') && name.includes('lorebook')) {
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        const bookName = resolveBookNameFromArgsOrSingle(args, live);
        return {
            ...edit,
            target: bookName ? { kind: 'lorebook', bookName } : { kind: 'lorebook' },
        };
    }
    return edit;
}

export async function normalizeToolCallToEdit(call, opts = {}) {
    if (call?.args !== undefined && call?.args !== null && typeof call.args !== 'object') {
        if (typeof call.args === 'string') {
            try {
                const parsed = JSON.parse(call.args);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            } catch {
                return null;
            }
        } else {
            return null;
        }
    }
    let adapted;
    try {
        adapted = adaptCallToOpenAiShape(call);
    } catch {
        return null;
    }
    const ctx = { live: opts?.live ?? {}, context: opts?.context };
    const edits = await normalizeUnifiedToolCallToEdit(adapted, ctx);
    if (!Array.isArray(edits)) {
        return null;
    }
    return edits.map((edit) => annotateTarget(edit, call, opts?.live));
}

// ---------------------------------------------------------------------------
// Draft-aware lorebook read helpers
// ---------------------------------------------------------------------------

async function resolveLorebookStateForRead(args, opts = {}) {
    const bookName = String(args?.book_name || '').trim();
    if (!bookName) {
        throw new Error('book_name is required.');
    }
    const liveBooks = opts?.state?.live?.lorebooks;
    if (liveBooks && typeof liveBooks === 'object' && Object.hasOwn(liveBooks, bookName)) {
        const raw = liveBooks[bookName];
        const lorebookData = raw && typeof raw === 'object'
            ? (raw.entries && typeof raw.entries === 'object' ? raw : { ...raw, entries: {} })
            : { entries: {} };
        return { bookName, lorebookData, fromDraft: true };
    }
    if (opts?.restrictToLiveBooks) {
        throw new Error(`World book "${bookName}" not found.`);
    }
    return H.loadBookByName(opts?.context, bookName);
}

function listEntriesFromBookState(state, args) {
    const range = H.normalizeUidRange(args?.range);
    const entries = state?.lorebookData?.entries && typeof state.lorebookData.entries === 'object'
        ? state.lorebookData.entries
        : {};
    const uids = Array.from(H.collectEntryUids(entries).values()).sort((a, b) => a - b);
    const filteredUids = range ? uids.filter((uid) => uid >= range.start && uid <= range.end) : uids;
    return {
        book_name: state.bookName,
        total_entries: uids.length,
        returned_entries: filteredUids.length,
        range: range ? { start_uid: range.start, end_uid: range.end } : null,
        entries: filteredUids.map((uid) => H.summarizeListEntry(H.getEntryByUid(entries, uid), uid)),
    };
}

function queryEntriesFromBookState(state, args) {
    const queryText = H.normalizeText(args?.text ?? '');
    const searchMode = H.normalizeSearchMode(args?.search_mode);
    const hasConstantFilter = typeof args?.constant === 'boolean';
    const hasEnabledFilter = typeof args?.enabled === 'boolean';
    if (!queryText && !hasConstantFilter && !hasEnabledFilter) {
        throw new Error('lorebook_query requires text, constant, or enabled.');
    }
    const limit = H.normalizeQueryLimit(args?.limit);
    const entries = state?.lorebookData?.entries && typeof state.lorebookData.entries === 'object'
        ? state.lorebookData.entries
        : {};

    const hits = [];
    const uids = Array.from(H.collectEntryUids(entries).values()).sort((a, b) => a - b);
    for (const uid of uids) {
        const rawEntry = H.getEntryByUid(entries, uid);
        const normalizedEntry = H.normalizeToolEntry(rawEntry, uid, { includeContent: true });
        if (hasConstantFilter && normalizedEntry.constant !== Boolean(args.constant)) continue;
        if (hasEnabledFilter && normalizedEntry.enabled !== Boolean(args.enabled)) continue;
        const match = H.buildEntryMatch(normalizedEntry, queryText, searchMode);
        if (queryText && !match.matched) continue;
        hits.push({
            uid: normalizedEntry.uid,
            comment: normalizedEntry.comment,
            key: normalizedEntry.key,
            keysecondary: normalizedEntry.keysecondary,
            selective_logic: normalizedEntry.selective_logic,
            constant: normalizedEntry.constant,
            enabled: normalizedEntry.enabled,
            match_fields: match.matchFields,
            matched_excerpt: match.matchedExcerpt,
            _score: match.score,
        });
    }
    hits.sort((a, b) => {
        if (queryText && b._score !== a._score) return b._score - a._score;
        const aEntry = H.getEntryByUid(entries, a.uid);
        const bEntry = H.getEntryByUid(entries, b.uid);
        const aOrder = H.asFiniteInteger(aEntry?.order, 0) ?? 0;
        const bOrder = H.asFiniteInteger(bEntry?.order, 0) ?? 0;
        if (bOrder !== aOrder) return bOrder - aOrder;
        return a.uid - b.uid;
    });
    return {
        book_name: state.bookName,
        total_hits: hits.length,
        entries: hits.slice(0, limit).map(({ _score, ...entry }) => entry),
    };
}

function getEntriesFromBookState(state, args) {
    const uids = H.normalizeDetailUids(args?.uids);
    if (uids.length === 0) {
        throw new Error('lorebook_get requires one or more valid uids.');
    }
    const entries = state?.lorebookData?.entries && typeof state.lorebookData.entries === 'object'
        ? state.lorebookData.entries
        : {};
    const output = [];
    const missing = [];
    for (const uid of uids) {
        const rawEntry = H.getEntryByUid(entries, uid);
        if (!rawEntry) {
            missing.push(uid);
            continue;
        }
        output.push(H.normalizeToolEntry(rawEntry, uid, { includeContent: true, includeLayout: true }));
    }
    return {
        book_name: state.bookName,
        entries: output,
        missing_uids: missing,
    };
}

function listWorldBooksFromContextAndDraft(context, opts = {}) {
    const liveBooks = opts?.state?.live?.lorebooks;
    const books = [];
    const sources = {};
    const push = (name, source) => {
        const trimmed = String(name || '').trim();
        if (!trimmed || sources[trimmed]) return;
        sources[trimmed] = source;
        books.push(trimmed);
    };

    if (opts?.restrictToLiveBooks) {
        for (const name of Object.keys(liveBooks || {})) {
            push(name, opts?.defaultSource || 'world');
        }
        return { books, sources };
    }

    const avatar = String(opts?.avatar || opts?.state?.live?.character?.avatar || '').trim();
    const character = H.resolveCharacterByAvatar(context, avatar);
    push(character?.data?.extensions?.world, 'character');

    if (character?.avatar && typeof context?.getCharaAuxWorlds === 'function') {
        const fileName = typeof context?.getCharaFilename === 'function'
            ? context.getCharaFilename(null, { manualAvatarKey: character.avatar })
            : String(character.avatar).replace(/\.[^.]+$/, '');
        if (fileName) {
            for (const name of context.getCharaAuxWorlds(fileName) || []) push(name, 'character_aux');
        }
    }
    if (typeof context?.chatWorldInfo?.getNames === 'function') {
        for (const name of context.chatWorldInfo.getNames(context?.chatMetadata) || []) push(name, 'chat');
    }
    const globalSelection = context?.chatWorldInfo?.globalSelection;
    if (Array.isArray(globalSelection)) {
        for (const name of globalSelection) push(name, 'global');
    }
    if (liveBooks && typeof liveBooks === 'object') {
        for (const name of Object.keys(liveBooks)) {
            push(name, 'draft');
        }
    }
    return { books, sources };
}

function getSearchApi() {
    const api = globalThis?.Luker?.searchTools;
    if (!api || typeof api !== 'object') return null;
    if (typeof api.getToolDefs !== 'function' || typeof api.isToolName !== 'function' || typeof api.invoke !== 'function') {
        return null;
    }
    const searchName = String(api?.toolNames?.SEARCH || '').trim();
    const visitName = String(api?.toolNames?.VISIT || '').trim();
    if (!searchName || !visitName) return null;
    return api;
}

function resolveWebSearchLegacyName(helperApis) {
    for (const api of Array.isArray(helperApis) ? helperApis : []) {
        const name = String(api?.toolNames?.SEARCH || '').trim();
        if (name) return name;
    }
    return '';
}

export async function runCeaEditorReadTool(call, opts = {}) {
    const shortName = String(call?.name || '');
    if (!isCeaEditorReadTool(shortName)) {
        return { ok: false, error: `Not a read tool: ${shortName || '(empty)'}` };
    }
    const args = call?.args && typeof call.args === 'object' ? call.args : {};

    if (shortName === 'cea_read_card_fields') {
        try {
            const result = await dispatchCeaReadCardFields({ state: opts?.state, args });
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: String(err?.message || err || 'unknown error') };
        }
    }

    const helperApis = Array.isArray(opts?.helperApis) ? opts.helperApis : [];
    const hasLegacyRunner = typeof opts?.legacyRunner === 'function';
    const liveBooks = opts?.state?.live?.lorebooks;
    const bookName = String(args?.book_name || '').trim();

    if (shortName === 'lorebook_list' || shortName === 'lorebook_query' || shortName === 'lorebook_get') {
        const inDraft = Boolean(liveBooks && typeof liveBooks === 'object' && bookName && Object.hasOwn(liveBooks, bookName));
        if (!inDraft && !opts?.restrictToLiveBooks && hasLegacyRunner && typeof opts?.context?.loadWorldInfo !== 'function') {
            const legacyName = READ_TOOL_LEGACY_NAMES[shortName];
            try {
                const raw = await opts.legacyRunner({ id: call?.id, name: legacyName, args }, helperApis);
                const result = raw && typeof raw === 'object' && Object.hasOwn(raw, 'result') ? raw.result : raw;
                return { ok: true, result };
            } catch (err) {
                return { ok: false, error: String(err?.message || err || 'unknown error') };
            }
        }
        try {
            const state = await resolveLorebookStateForRead(args, opts);
            if (shortName === 'lorebook_list') return { ok: true, result: listEntriesFromBookState(state, args) };
            if (shortName === 'lorebook_query') return { ok: true, result: queryEntriesFromBookState(state, args) };
            return { ok: true, result: getEntriesFromBookState(state, args) };
        } catch (err) {
            return { ok: false, error: String(err?.message || err || 'unknown error') };
        }
    }

    if (shortName === 'world_book_list') {
        if (!opts?.restrictToLiveBooks && hasLegacyRunner && !liveBooks && !opts?.context?.characters) {
            try {
                const raw = await opts.legacyRunner({ id: call?.id, name: READ_TOOL_LEGACY_NAMES[shortName], args }, helperApis);
                const result = raw && typeof raw === 'object' && Object.hasOwn(raw, 'result') ? raw.result : raw;
                return { ok: true, result };
            } catch (err) {
                return { ok: false, error: String(err?.message || err || 'unknown error') };
            }
        }
        try {
            return { ok: true, result: listWorldBooksFromContextAndDraft(opts?.context, opts) };
        } catch (err) {
            return { ok: false, error: String(err?.message || err || 'unknown error') };
        }
    }

    if (shortName === 'inspect_bound_preset') {
        if (hasLegacyRunner && !opts?.context?.character?.presets) {
            try {
                const raw = await opts.legacyRunner({ id: call?.id, name: READ_TOOL_LEGACY_NAMES[shortName], args }, helperApis);
                const result = raw && typeof raw === 'object' && Object.hasOwn(raw, 'result') ? raw.result : raw;
                return { ok: true, result };
            } catch (err) {
                return { ok: false, error: String(err?.message || err || 'unknown error') };
            }
        }
        const avatar = String(opts?.avatar || opts?.state?.live?.character?.avatar || '').trim();
        return runCharacterPresetReadTool({ id: call?.id, name: shortName, args }, { context: opts?.context, avatar });
    }

    if (shortName === 'simulate_prompt') {
        if (hasLegacyRunner && !opts?.context?.buildPresetAwarePromptMessages) {
            try {
                const raw = await opts.legacyRunner({ id: call?.id, name: READ_TOOL_LEGACY_NAMES[shortName], args }, helperApis);
                const result = raw && typeof raw === 'object' && Object.hasOwn(raw, 'result') ? raw.result : raw;
                return { ok: true, result };
            } catch (err) {
                return { ok: false, error: String(err?.message || err || 'unknown error') };
            }
        }
        return runCardSimulatePrompt(opts?.context, args);
    }

    if (shortName === 'web_search') {
        if (hasLegacyRunner) {
            const legacyName = resolveWebSearchLegacyName(helperApis);
            if (!legacyName) {
                return { ok: false, error: 'web_search is not wired (Luker.searchTools missing).' };
            }
            try {
                const raw = await opts.legacyRunner({ id: call?.id, name: legacyName, args }, helperApis);
                const result = raw && typeof raw === 'object' && Object.hasOwn(raw, 'result') ? raw.result : raw;
                return { ok: true, result };
            } catch (err) {
                return { ok: false, error: String(err?.message || err || 'unknown error') };
            }
        }
        const searchApi = getSearchApi();
        if (!searchApi) {
            return { ok: false, error: 'web_search is not wired (Luker.searchTools missing).' };
        }
        try {
            const legacyName = String(searchApi.toolNames.SEARCH);
            const result = await searchApi.invoke({ id: call?.id, name: legacyName, args });
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: String(err?.message || err || 'unknown error') };
        }
    }

    return { ok: false, error: `Unknown read tool: ${shortName}` };
}
