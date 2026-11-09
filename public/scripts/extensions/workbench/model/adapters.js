// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure halves of the four AI iteration adapters: cutting a working copy into
// units for the change list, and rebuilding it from accepted units. The
// Luker halves (load / tools / commit) live in source-iterate.js.
//
//   memory  live = node-type schema array      unit = one type
//   orch    live = { mode, profile }           unit = one agent field
//   preset  live = preset body                 unit = one prompt entry / setting
//   card    live = { character, lorebooks }    unit = one card field / lorebook entry

import { i18n, i18nFormat, listSeparator } from '../i18n.js';
import { listAgents, agentFields, getField, setField, fieldLabel } from '../../orchestrator/lens/model/edit.js';
import { pickUnits } from './units.js';

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

export const memoryUnits = (schema) => new Map((schema || []).map(spec => [String(spec.id), { key: String(spec.id), label: spec.label || spec.id, group: i18n('Memory types'), text: memoryText(spec), raw: spec }]));

// The fields memoryText shows. Only these can have been reviewed.
const MEMORY_SHOWN_FIELDS = ['label', 'extractHint', 'tableColumns', 'columnHints', 'requiredColumns', 'alwaysInject', 'latestOnly', 'extractionInstructions'];

function takeField(target, source, field) {
    if (source && field in source) target[field] = clone(source[field]);
    else delete target[field];
}

function mergeShownMemoryFields(prev, next) {
    const out = clone(prev);
    for (const field of MEMORY_SHOWN_FIELDS) takeField(out, next, field);
    const compression = { ...(prev.compression || {}) };
    takeField(compression, next.compression, 'summarizeInstruction');
    // The list only shows whether a type is merged hierarchically.
    if ((prev.compression?.mode === 'hierarchical') !== (next.compression?.mode === 'hierarchical')) takeField(compression, next.compression, 'mode');
    if (Object.keys(compression).length) out.compression = compression;
    else delete out.compression;
    return out;
}

/** Base schema with accepted types applied; a brand-new type is taken whole. */
export function memoryRebuild(base, ai, accepted) {
    const before = memoryUnits(base);
    const after = memoryUnits(ai);
    return [...pickUnits(before, after, accepted)].map(([key, unit]) => (accepted.includes(key) && before.has(key)
        ? mergeShownMemoryFields(before.get(key).raw, unit.raw)
        : clone(unit.raw)));
}

// ----- orchestrator: one unit per agent field --------------------------------

export function orchUnits({ mode, profile }, nameOf = (id) => id) {
    const out = new Map();
    for (const id of listAgents(mode, profile)) {
        for (const field of agentFields(mode, profile, id)) {
            const key = `${id}/${field}`;
            out.set(key, { key, label: `${nameOf(id)} · ${fieldLabel(field)}`, group: nameOf(id), text: getField(mode, profile, id, field), raw: { id, field } });
        }
    }
    return out;
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

export function presetUnits(body) {
    const out = new Map();
    const order = promptOrder(body);
    const enabled = new Map((order.order || []).map((o, i) => [o.identifier, { on: Boolean(o.enabled), at: i }]));
    for (const p of body?.prompts || []) {
        if (!p?.identifier) continue;
        const state = enabled.get(p.identifier);
        const head = `${state ? (state.on ? i18n('Switched on') : i18n('Off')) : i18n('Not listed')} · ${p.role || 'system'}${p.injection_position ? i18nFormat(' · injection depth ${0}', p.injection_depth) : ''}`;
        const text = p.marker ? i18nFormat('${0}\n(system placeholder: ${1})', head, p.name || p.identifier) : `${head}\n${p.content || ''}`;
        out.set(`prompt:${p.identifier}`, { key: `prompt:${p.identifier}`, label: p.name || p.identifier, group: i18n('Entries'), text, raw: { prompt: p, order: state } });
    }
    out.set('order', { key: 'order', label: i18n('Entry order'), group: i18n('Structure'), text: (order.order || []).map(o => o.identifier).join(' → '), raw: clone(order.order || []) });
    const settings = {};
    for (const k of PRESET_SETTING_KEYS) if (body && k in body) settings[k] = body[k];
    out.set('settings', { key: 'settings', label: i18n('Generation parameters'), group: i18n('Structure'), text: json(settings), raw: settings });
    return out;
}

export function presetRebuild(base, ai, accepted) {
    const next = clone(base);
    const keys = new Set(accepted);
    const aiOrder = promptOrder(ai).order || [];
    const order = promptOrder(next);
    const byId = new Map((next.prompts || []).map((p, i) => [p.identifier, i]));
    for (const key of keys) {
        if (key === 'settings') {
            for (const k of PRESET_SETTING_KEYS) { if (k in ai) next[k] = clone(ai[k]); else delete next[k]; }
        } else if (key === 'order') {
            order.order = clone(aiOrder);
        } else if (key.startsWith('prompt:')) {
            const id = key.slice(7);
            const aiPrompt = (ai.prompts || []).find(p => p.identifier === id);
            const aiState = aiOrder.find(o => o.identifier === id);
            if (!aiPrompt) {
                next.prompts = (next.prompts || []).filter(p => p.identifier !== id);
                order.order = (order.order || []).filter(o => o.identifier !== id);
                continue;
            }
            if (byId.has(id)) next.prompts[byId.get(id)] = clone(aiPrompt);
            else next.prompts = [...(next.prompts || []), clone(aiPrompt)];
            const slot = (order.order || []).find(o => o.identifier === id);
            if (aiState && slot) slot.enabled = aiState.enabled;
            else if (aiState && !slot) order.order = [...(order.order || []), clone(aiState)];
        }
    }
    return next;
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

export function cardUnits(live) {
    const out = new Map();
    for (const f of CARD_FIELDS) {
        const text = cardField(live?.character, f);
        if (text || f === 'description') out.set(`card:${f}`, { key: `card:${f}`, label: CARD_LABELS[f], group: i18n('Character card'), text, raw: { field: f } });
    }
    for (const [book, data] of Object.entries(live?.lorebooks || {})) {
        for (const [uid, e] of Object.entries(data?.entries || {})) {
            out.set(`wi:${book}:${uid}`, { key: `wi:${book}:${uid}`, label: e.comment || (e.key || [])[0] || i18nFormat('Entry ${0}', uid), group: i18nFormat('World book "${0}"', book), text: entryText(e), raw: { book, uid } });
        }
    }
    return out;
}

/** Accepted keys → { cardEdits, bookEdits: { [book]: edits } } as iteration-library edits. */
export function cardEditsFor(base, ai, accepted) {
    const cardEdits = [];
    const bookEdits = {};
    const keyOf = new Map();
    const add = (list, key, edit) => { list.push(edit); keyOf.set(edit, key); };
    for (const key of accepted) {
        if (key.startsWith('card:')) {
            const f = key.slice(5);
            const before = base.character?.[f] ?? base.character?.data?.[f];
            const after = ai.character?.[f] ?? ai.character?.data?.[f];
            add(cardEdits, key, { op: 'set', path: f, oldValue: clone(before), newValue: clone(after) });
        } else if (key.startsWith('wi:')) {
            const [, book, uid] = key.match(/^wi:(.*):([^:]+)$/) || [];
            const prev = base.lorebooks?.[book]?.entries?.[uid];
            const next = ai.lorebooks?.[book]?.entries?.[uid];
            const list = (bookEdits[book] ||= []);
            if (!prev && next) add(list, key, { op: 'lorebook_entry_add', path: 'entries', uid: next.uid ?? uid, entry: clone(next) });
            else if (prev && !next) add(list, key, { op: 'lorebook_entry_remove', path: 'entries', uid: prev.uid ?? uid, entry: clone(prev) });
            else if (prev && next) {
                const patch = {};
                const before = {};
                for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
                    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) { patch[k] = clone(next[k]); before[k] = clone(prev[k]); }
                }
                if (Object.keys(patch).length) add(list, key, { op: 'lorebook_entry_update', path: 'entries', uid: prev.uid ?? uid, patch, before });
            }
        }
    }
    return { cardEdits, bookEdits, keyOf };
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
            const entry = ai.lorebooks?.[book]?.entries?.[uid];
            next.lorebooks ||= {};
            next.lorebooks[book] ||= { entries: {} };
            next.lorebooks[book].entries ||= {};
            if (entry) next.lorebooks[book].entries[uid] = clone(entry);
            else delete next.lorebooks[book].entries[uid];
        }
    }
    return next;
}

// ----- world info only (live = { lorebooks }) --------------------------------

export const worldUnits = (live) => new Map([...cardUnits({ lorebooks: live?.lorebooks || {} })].filter(([k]) => k.startsWith('wi:')));
export const worldRebuild = (base, ai, accepted) => cardRebuild(base, ai, accepted.filter(k => k.startsWith('wi:')));
