// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure halves of the AI iteration adapters: cutting a working copy into units
// for the change list, and applying field changes to a copy (model/patch.js).
// Each unit's `fields` is what gets written; `hidden` is the part of it the
// unit's text does not show.

import { i18n, i18nFormat } from '../i18n.js';
import { fieldPlan } from './patch.js';

const json = (v) => JSON.stringify(v ?? null, null, 1);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// ----- preset: prompt entries + prompt_order groups + top-level settings -----

const PRESET_SETTING_KEYS = [
    'temperature',
    'top_p',
    'top_k',
    'frequency_penalty',
    'presence_penalty',
    'repetition_penalty',
    'temp_openai',
    'top_p_openai',
    'top_k_openai',
    'freq_pen_openai',
    'pres_pen_openai',
    'openai_max_context',
    'openai_max_tokens',
    'stream_openai',
    'names_behavior',
    'continue_prefill',
    'squash_system_messages',
    'assistant_prefill',
    'assistant_impersonation',
    'wi_format',
    'scenario_format',
    'personality_format',
];

const DEFAULT_PROMPT_ORDER_CHARACTER_ID = 100001;
const PRESET_STRUCTURE_KEYS = new Set(['prompts', 'prompt_order']);
// What a prompt's text shows in full.
const PROMPT_SHOWN_FIELDS = new Set(['identifier', 'role', 'content', '$enabled']);

function groupCidKey(group) {
    return String(group?.character_id ?? '').trim();
}

function resolvePrimaryOrderGroup(body) {
    const orders = Array.isArray(body?.prompt_order) ? body.prompt_order : [];
    const byDefaultId = orders.find(o => Number(o?.character_id) === DEFAULT_PROMPT_ORDER_CHARACTER_ID);
    if (byDefaultId) return byDefaultId;
    if (orders.length === 1 && groupCidKey(orders[0]) === '') return orders[0];
    return null;
}

function ensurePrimaryOrder(body, { createDefaultIfMissing = true } = {}) {
    if (!Array.isArray(body.prompt_order)) body.prompt_order = [];
    let order = body.prompt_order.find(o => Number(o?.character_id) === DEFAULT_PROMPT_ORDER_CHARACTER_ID);
    if (!order && body.prompt_order.length === 1 && groupCidKey(body.prompt_order[0]) === '') {
        order = body.prompt_order[0];
        order.character_id = DEFAULT_PROMPT_ORDER_CHARACTER_ID;
    }
    if (!order && !createDefaultIfMissing && body.prompt_order.length > 0) {
        order = body.prompt_order[0];
    }
    if (!order || typeof order !== 'object') {
        order = { character_id: DEFAULT_PROMPT_ORDER_CHARACTER_ID, order: [] };
        body.prompt_order.push(order);
    }
    if (!Array.isArray(order.order)) order.order = [];
    return order;
}

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

function formatGroupOrderText(orderList) {
    return (orderList || [])
        .map(o => `${o.identifier} (${o.enabled ? i18n('Switched on') : i18n('Off')})`)
        .join(' → ');
}

export function presetUnits(body) {
    const out = new Map();
    const orders = Array.isArray(body?.prompt_order) ? body.prompt_order : [];
    const primary = resolvePrimaryOrderGroup(body);
    const enabledSource = primary || orders[0] || { order: [] };
    const enabled = new Map((enabledSource.order || []).map((o, i) => [o.identifier, { on: Boolean(o.enabled), at: i }]));

    for (const p of body?.prompts || []) {
        if (!p?.identifier) continue;
        const state = enabled.get(p.identifier);
        const head = `${state ? (state.on ? i18n('Switched on') : i18n('Off')) : i18n('Not listed')} · ${p.role || 'system'}${p.injection_position ? i18nFormat(' · injection depth ${0}', p.injection_depth) : ''}`;
        const text = p.marker ? i18nFormat('${0}\n(system placeholder: ${1})', head, p.name || p.identifier) : `${head}\n${p.content || ''}`;
        const fields = promptFields(p, state);
        out.set(`prompt:${p.identifier}`, {
            key: `prompt:${p.identifier}`,
            label: p.name || p.identifier,
            group: i18n('Entries'),
            text,
            raw: { prompt: p, order: state },
            fields,
            hidden: promptHidden(fields),
        });
    }

    const ids = (primary?.order || []).map(o => o.identifier);
    out.set('order', {
        key: 'order',
        label: i18n('Entry order'),
        group: i18n('Structure'),
        text: ids.join(' → '),
        raw: clone(primary?.order || []),
        fields: { ids },
    });

    for (const group of orders) {
        if (!group || group === primary) continue;
        const cid = groupCidKey(group);
        const unitKey = `order:${cid}`;
        const groupOrder = Array.isArray(group.order) ? group.order : [];
        out.set(unitKey, {
            key: unitKey,
            label: i18nFormat('Entry order (${0})', cid || i18n('Default')),
            group: i18n('Structure'),
            text: formatGroupOrderText(groupOrder),
            raw: clone(groupOrder),
            fields: {
                character_id: group.character_id,
                order: clone(groupOrder),
            },
        });
    }

    const shown = {};
    const fields = {};
    const hidden = {};
    for (const [k, v] of Object.entries(body || {})) {
        if (PRESET_STRUCTURE_KEYS.has(k)) continue;
        fields[k] = clone(v);
        if (PRESET_SETTING_KEYS.includes(k)) shown[k] = v;
        else hidden[k] = clone(v);
    }
    out.set('settings', {
        key: 'settings',
        label: i18n('Generation parameters'),
        group: i18n('Structure'),
        text: json(shown),
        raw: shown,
        fields,
        hidden,
    });
    return out;
}

function setPromptSlot(order, id, enabled) {
    const slots = order.order || [];
    const slot = slots.find(o => o.identifier === id);
    if (enabled === undefined) order.order = slots.filter(o => o.identifier !== id);
    else if (slot) slot.enabled = enabled;
    else order.order = [...slots, { identifier: id, enabled }];
}

function applyPromptOp(next, getPrimaryOrder, op) {
    const id = op.key.slice('prompt:'.length);
    if (op.kind === 'remove') {
        next.prompts = (next.prompts || []).filter(p => p.identifier !== id);
        if (Array.isArray(next.prompt_order)) {
            for (const group of next.prompt_order) {
                if (group && Array.isArray(group.order)) {
                    group.order = group.order.filter(o => o.identifier !== id);
                }
            }
        }
        return;
    }
    let prompt = (next.prompts || []).find(p => p.identifier === id);
    if (!prompt) {
        prompt = {};
        next.prompts = [...(next.prompts || []), prompt];
    }
    for (const c of op.changes) {
        if (c.field === '$enabled') setPromptSlot(getPrimaryOrder(), id, c.after);
        else if (c.after === undefined) delete prompt[c.field];
        else prompt[c.field] = clone(c.after);
    }
}

/** Reorders by identifier only: each row keeps its own switch state. */
function applyOrderOp(next, order, ids) {
    const slots = order.order || [];
    const byId = new Map(slots.map(o => [o.identifier, o]));
    const knownPrompts = new Set((next.prompts || []).map(p => p?.identifier).filter(Boolean));
    const listed = new Set(ids);
    const ordered = ids
        .filter(id => byId.has(id) || knownPrompts.has(id))
        .map(id => byId.get(id) || { identifier: id, enabled: true });
    order.order = [...ordered, ...slots.filter(o => !listed.has(o.identifier))];
}

function applyOrderGroupOp(next, op) {
    const cid = op.key.slice('order:'.length);
    if (op.kind === 'remove') {
        if (Array.isArray(next.prompt_order)) {
            next.prompt_order = next.prompt_order.filter(g => groupCidKey(g) !== cid);
        }
        return;
    }
    if (!Array.isArray(next.prompt_order)) next.prompt_order = [];
    let group = next.prompt_order.find(g => groupCidKey(g) === cid);
    if (!group || typeof group !== 'object') {
        const rawCid = op.changes.find(c => c.field === 'character_id')?.after;
        const fallbackCid = /^\d+$/.test(cid) ? Number(cid) : cid;
        group = { character_id: rawCid !== undefined ? clone(rawCid) : fallbackCid, order: [] };
        next.prompt_order.push(group);
    }
    for (const c of op.changes) {
        if (c.field === 'character_id' && c.after !== undefined) {
            group.character_id = clone(c.after);
        } else if (c.field === 'order') {
            group.order = Array.isArray(c.after) ? clone(c.after) : [];
        }
    }
}

/** Applies field changes to a preset body; the order goes last so new entries can be placed. */
export function applyPresetOps(body, ops) {
    const next = clone(body) || {};
    const hasExplicitGroupOps = ops.some(op => op.key.startsWith('order:'));
    const hasOrderOp = ops.some(op => op.key === 'order');
    let primaryOrder = null;
    const getPrimaryOrder = () => {
        if (!primaryOrder) {
            primaryOrder = ensurePrimaryOrder(next, {
                createDefaultIfMissing: hasOrderOp || hasExplicitGroupOps,
            });
        }
        return primaryOrder;
    };

    for (const op of ops) {
        if (op.key === 'settings') {
            for (const c of op.changes) {
                if (c.after === undefined) delete next[c.field];
                else next[c.field] = clone(c.after);
            }
        } else if (op.key.startsWith('prompt:')) {
            applyPromptOp(next, getPrimaryOrder, op);
        } else if (op.key.startsWith('order:')) {
            applyOrderGroupOp(next, op);
        }
    }
    const orderOp = ops.find(op => op.key === 'order');
    if (orderOp) {
        const ids = orderOp.changes.find(c => c.field === 'ids')?.after || [];
        applyOrderOp(next, getPrimaryOrder(), ids);
    }
    return next;
}

export function presetRebuild(base, ai, accepted) {
    return applyPresetOps(base, fieldPlan(presetUnits(base), presetUnits(ai), accepted));
}
