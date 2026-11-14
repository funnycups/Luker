// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure halves of the AI iteration adapters: cutting a working copy into units
// for the change list, and applying field changes to a copy (model/patch.js).
// Each unit's `fields` is what gets written; `hidden` is the part of it the
// unit's text does not show. The Luker halves (load / tools / commit) live in
// source-iterate.js.
//
//   memory  live = node-type schema array      unit = one type
//   orch    live = { mode, profile }           unit = one agent field
//   preset  live = preset body                 unit = one prompt entry / setting
//   card    live = { character, lorebooks }    unit = one card field / lorebook entry

import { i18n, i18nFormat, listSeparator } from '../i18n.js';
import { listAgents, agentFields, getField, setField, fieldLabel } from '../../orchestrator/lens/model/edit.js';
import { fieldPlan } from './patch.js';

const json = (v) => JSON.stringify(v ?? null, null, 1);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// ----- memory: one unit per type ---------------------------------------------

function memoryText(spec) {
    const lines = [];
    lines.push(i18nFormat('Name: ${0}', spec.label || spec.id));
    if (spec.extractHint) lines.push(i18nFormat('What this memory is: ${0}', spec.extractHint));
    const hints = spec.columnHints || {};
    const req = new Set(spec.requiredColumns || []);
    for (const key of spec.tableColumns || []) lines.push(i18nFormat('· ${0}${1}: ${2}', key, req.has(key) ? i18n(' (required)') : '', hints[key] || ''));
    const flags = [spec.alwaysInject ? i18n('Always visible to the AI') : '', spec.latestOnly ? i18n('Keep only the latest of the same name') : '', spec.compression?.mode === 'hierarchical' ? i18n('Auto-merge into summaries') : ''].filter(Boolean);
    if (flags.length) lines.push(i18nFormat('Recording: ${0}', flags.join(listSeparator())));
    if (spec.extractionInstructions) lines.push(i18nFormat('Extraction rules: ${0}', spec.extractionInstructions));
    if (spec.compression?.summarizeInstruction) lines.push(i18nFormat('Summary instruction: ${0}', spec.compression.summarizeInstruction));
    return lines.join('\n');
}

function flatSpec({ compression, ...rest }) {
    const out = clone(rest);
    for (const [key, value] of Object.entries(compression || {})) out[`compression.${key}`] = clone(value);
    return out;
}

// What memoryText shows in full; everything else is listed separately when it changes.
const MEMORY_SHOWN_FIELDS = ['id', 'label', 'extractHint', 'tableColumns', 'alwaysInject', 'latestOnly', 'extractionInstructions', 'compression.summarizeInstruction'];

function memoryHidden(spec) {
    const hidden = flatSpec(spec);
    for (const field of MEMORY_SHOWN_FIELDS) delete hidden[field];
    const columns = new Set(spec.tableColumns || []);
    const extraHints = Object.entries(spec.columnHints || {}).filter(([key]) => !columns.has(key));
    if (extraHints.length) hidden.columnHints = Object.fromEntries(extraHints);
    else delete hidden.columnHints;
    const extraRequired = (spec.requiredColumns || []).filter(key => !columns.has(key));
    if (extraRequired.length) hidden.requiredColumns = extraRequired;
    else delete hidden.requiredColumns;
    if (hidden['compression.mode'] === 'hierarchical') delete hidden['compression.mode'];
    return hidden;
}

export const memoryUnits = (schema) => new Map((schema || []).map(spec => [String(spec.id), { key: String(spec.id), label: spec.label || spec.id, group: i18n('Memory types'), text: memoryText(spec), raw: spec, fields: flatSpec(spec), hidden: memoryHidden(spec) }]));

function setSpecField(spec, field, value) {
    if (field.startsWith('compression.')) {
        const key = field.slice('compression.'.length);
        if (value === undefined) {
            if (spec.compression) delete spec.compression[key];
            if (spec.compression && !Object.keys(spec.compression).length) delete spec.compression;
        } else {
            spec.compression ||= {};
            spec.compression[key] = clone(value);
        }
    } else if (value === undefined) delete spec[field];
    else spec[field] = clone(value);
}

/** Applies field changes to a schema; a new type goes last. */
export function applyMemoryOps(schema, ops) {
    let next = clone(schema);
    for (const op of ops) {
        if (op.kind === 'remove') { next = next.filter(spec => String(spec.id) !== op.key); continue; }
        let spec = next.find(item => String(item.id) === op.key);
        if (!spec) { spec = {}; next.push(spec); }
        for (const c of op.changes) setSpecField(spec, c.field, c.after);
    }
    return next;
}

/** Base schema with the accepted types applied. */
export function memoryRebuild(base, ai, accepted) {
    return applyMemoryOps(base, fieldPlan(memoryUnits(base), memoryUnits(ai), accepted));
}

// ----- orchestrator: one unit per agent field --------------------------------

export function orchUnits({ mode, profile }, nameOf = (id) => id) {
    const out = new Map();
    for (const id of listAgents(mode, profile)) {
        for (const field of agentFields(mode, profile, id)) {
            const key = `${id}/${field}`;
            out.set(key, { key, label: `${nameOf(id)} · ${fieldLabel(field)}`, group: nameOf(id), text: getField(mode, profile, id, field), raw: { id, field }, fields: { value: getField(mode, profile, id, field) } });
        }
    }
    return out;
}

/** Applies field changes to { mode, profile }. */
export function applyOrchOps({ mode, profile }, ops) {
    let next = profile;
    for (const op of ops) {
        const [id, field] = op.key.split('/');
        for (const c of op.changes) next = setField(mode, next, id, field, c.after ?? '');
    }
    return { mode, profile: next };
}

export function orchRebuild(base, aiLive, accepted) {
    let profile = clone(base.profile);
    for (const key of accepted) {
        const [id, field] = key.split('/');
        profile = setField(base.mode, profile, id, field, getField(aiLive.mode, aiLive.profile, id, field));
    }
    return { mode: base.mode, profile };
}

// ----- preset: prompt entries + top-level settings ---------------------------

const PRESET_SETTING_KEYS = ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'openai_max_context', 'openai_max_tokens', 'stream_openai', 'names_behavior', 'continue_prefill', 'squash_system_messages', 'assistant_prefill', 'assistant_impersonation', 'wi_format', 'scenario_format', 'personality_format'];

function promptOrder(body) {
    const orders = Array.isArray(body?.prompt_order) ? body.prompt_order : [];
    return orders.find(o => Number(o.character_id) === 100001) || orders[0] || { order: [] };
}

const PRESET_STRUCTURE_KEYS = new Set(['prompts', 'prompt_order']);
// What a prompt's text shows in full.
const PROMPT_SHOWN_FIELDS = new Set(['identifier', 'role', 'content', '$enabled']);

function promptFields(p, state) {
    const fields = clone(p);
    if (state) fields.$enabled = state.on;
    return fields;
}

function promptHidden(fields) {
    const hidden = Object.fromEntries(Object.entries(fields).filter(([k]) => !PROMPT_SHOWN_FIELDS.has(k)));
    if (fields.marker && fields.content !== undefined) hidden.content = fields.content;
    return hidden;
}

export function presetUnits(body) {
    const out = new Map();
    const order = promptOrder(body);
    const enabled = new Map((order.order || []).map((o, i) => [o.identifier, { on: Boolean(o.enabled), at: i }]));
    for (const p of body?.prompts || []) {
        if (!p?.identifier) continue;
        const state = enabled.get(p.identifier);
        const head = `${state ? (state.on ? i18n('Switched on') : i18n('Off')) : i18n('Not listed')} · ${p.role || 'system'}${p.injection_position ? i18nFormat(' · injection depth ${0}', p.injection_depth) : ''}`;
        const text = p.marker ? i18nFormat('${0}\n(system placeholder: ${1})', head, p.name || p.identifier) : `${head}\n${p.content || ''}`;
        const fields = promptFields(p, state);
        out.set(`prompt:${p.identifier}`, { key: `prompt:${p.identifier}`, label: p.name || p.identifier, group: i18n('Entries'), text, raw: { prompt: p, order: state }, fields, hidden: promptHidden(fields) });
    }
    const ids = (order.order || []).map(o => o.identifier);
    out.set('order', { key: 'order', label: i18n('Entry order'), group: i18n('Structure'), text: ids.join(' → '), raw: clone(order.order || []), fields: { ids } });
    const shown = {};
    const fields = {};
    const hidden = {};
    for (const [k, v] of Object.entries(body || {})) {
        if (PRESET_STRUCTURE_KEYS.has(k)) continue;
        fields[k] = clone(v);
        if (PRESET_SETTING_KEYS.includes(k)) shown[k] = v;
        else hidden[k] = clone(v);
    }
    out.set('settings', { key: 'settings', label: i18n('Generation parameters'), group: i18n('Structure'), text: json(shown), raw: shown, fields, hidden });
    return out;
}

function setPromptSlot(order, id, enabled) {
    const slots = order.order || [];
    const slot = slots.find(o => o.identifier === id);
    if (enabled === undefined) order.order = slots.filter(o => o.identifier !== id);
    else if (slot) slot.enabled = enabled;
    else order.order = [...slots, { identifier: id, enabled }];
}

function applyPromptOp(next, order, op) {
    const id = op.key.slice('prompt:'.length);
    if (op.kind === 'remove') {
        next.prompts = (next.prompts || []).filter(p => p.identifier !== id);
        order.order = (order.order || []).filter(o => o.identifier !== id);
        return;
    }
    let prompt = (next.prompts || []).find(p => p.identifier === id);
    if (!prompt) {
        prompt = {};
        next.prompts = [...(next.prompts || []), prompt];
    }
    for (const c of op.changes) {
        if (c.field === '$enabled') setPromptSlot(order, id, c.after);
        else if (c.after === undefined) delete prompt[c.field];
        else prompt[c.field] = clone(c.after);
    }
}

/** Reorders by identifier only: each row keeps its own switch state. */
function applyOrderOp(order, ids) {
    const slots = order.order || [];
    const byId = new Map(slots.map(o => [o.identifier, o]));
    const listed = new Set(ids);
    order.order = [...ids.filter(id => byId.has(id)).map(id => byId.get(id)), ...slots.filter(o => !listed.has(o.identifier))];
}

/** Applies field changes to a preset body; the order goes last so new entries can be placed. */
export function applyPresetOps(body, ops) {
    const next = clone(body);
    const order = promptOrder(next);
    for (const op of ops) {
        if (op.key === 'settings') {
            for (const c of op.changes) {
                if (c.after === undefined) delete next[c.field];
                else next[c.field] = clone(c.after);
            }
        } else if (op.key.startsWith('prompt:')) applyPromptOp(next, order, op);
    }
    const orderOp = ops.find(op => op.key === 'order');
    if (orderOp) applyOrderOp(order, orderOp.changes.find(c => c.field === 'ids')?.after || []);
    return next;
}

export function presetRebuild(base, ai, accepted) {
    return applyPresetOps(base, fieldPlan(presetUnits(base), presetUnits(ai), accepted));
}

// ----- character card + lorebooks --------------------------------------------

export const CARD_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes', 'alternate_greetings'];
export const CARD_LABELS = { name: i18n('Card name'), description: i18n('Description field'), personality: i18n('Personality'), scenario: i18n('Card scenario'), first_mes: i18n('Opening message'), mes_example: i18n('Example dialogue'), system_prompt: i18n('Card system prompt'), post_history_instructions: i18n('Card post-history instructions'), creator_notes: i18n('Card creator notes'), alternate_greetings: i18n('Alternate opening messages') };

function cardField(character, field) {
    const v = character?.[field] ?? character?.data?.[field];
    return Array.isArray(v) ? v.join('\n—\n') : String(v ?? '');
}

function entryText(e) {
    const keys = [...(e.key || [])].join(listSeparator());
    const flags = [e.disable ? i18n('Switched off') : '', e.constant ? i18n('Always on') : ''].filter(Boolean).join(listSeparator());
    return `${i18nFormat('Keywords: ${0}', keys || i18n('(none)'))}${e.keysecondary?.length ? `\n${i18nFormat('Secondary keywords: ${0}', e.keysecondary.join(listSeparator()))}` : ''}${flags ? `\n${flags}` : ''}\n${e.content || ''}`;
}

// What entryText shows in full.
const ENTRY_SHOWN_FIELDS = new Set(['uid', 'key', 'keysecondary', 'disable', 'constant', 'content']);
export const BOOK_META = '__meta';
// Renaming a book needs the world info panel, so it is never a field change.
const BOOK_META_SKIPPED = new Set(['entries', 'bookName']);

const parseBookKey = (key) => key.match(/^wi:(.*):([^:]+)$/)?.slice(1) || [];

/** One unit per entry, plus one for the book's own settings. */
export function bookUnits(book, data) {
    const out = new Map();
    for (const [uid, e] of Object.entries(data?.entries || {})) {
        const key = `wi:${book}:${uid}`;
        out.set(key, { key, label: e.comment || (e.key || [])[0] || i18nFormat('Entry ${0}', uid), group: i18nFormat('World book "${0}"', book), text: entryText(e), raw: { book, uid }, fields: clone(e), hidden: Object.fromEntries(Object.entries(e).filter(([k]) => !ENTRY_SHOWN_FIELDS.has(k))) });
    }
    const meta = Object.fromEntries(Object.entries(data || {}).filter(([k]) => !BOOK_META_SKIPPED.has(k)));
    const key = `wi:${book}:${BOOK_META}`;
    out.set(key, { key, label: i18n('World book settings'), group: i18nFormat('World book "${0}"', book), text: '', raw: { book, uid: BOOK_META }, fields: clone(meta), hidden: clone(meta) });
    return out;
}

export function cardUnits(live) {
    const out = new Map();
    for (const f of CARD_FIELDS) {
        const text = cardField(live?.character, f);
        if (text || f === 'description') out.set(`card:${f}`, { key: `card:${f}`, label: CARD_LABELS[f], group: i18n('Character card'), text, raw: { field: f } });
    }
    for (const [book, data] of Object.entries(live?.lorebooks || {})) {
        for (const [key, unit] of bookUnits(book, data)) out.set(key, unit);
    }
    return out;
}

/** Applies field changes to one world book; never starts from an empty book. */
export function applyBookOps(book, ops) {
    const next = clone(book);
    for (const op of ops) {
        const [, uid] = parseBookKey(op.key);
        if (uid === BOOK_META) {
            for (const c of op.changes) {
                if (c.after === undefined) delete next[c.field];
                else next[c.field] = clone(c.after);
            }
        } else if (op.kind === 'remove') {
            delete next.entries[uid];
        } else {
            const entry = next.entries[uid] || (next.entries[uid] = {});
            for (const c of op.changes) {
                if (c.after === undefined) delete entry[c.field];
                else entry[c.field] = clone(c.after);
            }
        }
    }
    return next;
}

/** Accepted keys -> card edits (iteration-library ops) and field changes per book. */
export function cardEditsFor(base, ai, accepted) {
    const cardEdits = [];
    const bookOps = {};
    const baseCounts = {};
    const keyOf = new Map();
    const perBook = new Map();
    for (const key of accepted) {
        if (key.startsWith('card:')) {
            const f = key.slice(5);
            const before = base.character?.[f] ?? base.character?.data?.[f];
            const after = ai.character?.[f] ?? ai.character?.data?.[f];
            const edit = { op: 'set', path: f, oldValue: clone(before), newValue: clone(after) };
            cardEdits.push(edit);
            keyOf.set(edit, key);
        } else if (key.startsWith('wi:')) {
            const [book] = parseBookKey(key);
            if (!perBook.has(book)) perBook.set(book, []);
            perBook.get(book).push(key);
        }
    }
    for (const [book, keys] of perBook) {
        bookOps[book] = fieldPlan(bookUnits(book, base.lorebooks?.[book]), bookUnits(book, ai.lorebooks?.[book]), keys);
        baseCounts[book] = Object.keys(base.lorebooks?.[book]?.entries || {}).length;
    }
    return { cardEdits, bookOps, baseCounts, keyOf };
}

/** Builds the card live that results from accepting some changes (for continuing the chat). */
export function cardRebuild(base, ai, accepted) {
    const next = clone(base);
    for (const key of accepted) {
        if (key.startsWith('card:')) {
            const f = key.slice(5);
            const v = clone(ai.character?.[f] ?? ai.character?.data?.[f]);
            next.character ||= {};
            next.character[f] = v;
            if (next.character.data) next.character.data[f] = v;
        } else if (key.startsWith('wi:')) {
            const [, book, uid] = key.match(/^wi:(.*):([^:]+)$/) || [];
            next.lorebooks ||= {};
            next.lorebooks[book] ||= { entries: {} };
            next.lorebooks[book].entries ||= {};
            if (uid === BOOK_META) {
                const { entries } = next.lorebooks[book];
                const fields = bookUnits(book, ai.lorebooks?.[book]).get(key)?.fields || {};
                const bookName = next.lorebooks[book].bookName;
                next.lorebooks[book] = { ...clone(fields), entries, ...(bookName === undefined ? {} : { bookName }) };
                continue;
            }
            const entry = ai.lorebooks?.[book]?.entries?.[uid];
            if (entry) next.lorebooks[book].entries[uid] = clone(entry);
            else delete next.lorebooks[book].entries[uid];
        }
    }
    return next;
}

// ----- world info only (live = { lorebooks }) --------------------------------

export const worldUnits = (live) => new Map([...cardUnits({ lorebooks: live?.lorebooks || {} })].filter(([k]) => k.startsWith('wi:')));
export const worldRebuild = (base, ai, accepted) => cardRebuild(base, ai, accepted.filter(k => k.startsWith('wi:')));
