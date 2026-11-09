// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Editing of an orchestrator profile, shared by hand edits and the AI
// assistant. Agent fields and whole-profile "slots" (stages, agent entries,
// default tools, ...) are one change list, so drafts, diffs and undo treat
// them alike. Structural operations return a new profile.
//
// Fields (display keys):
//   system       role prompt (system prompt)
//   task         task template (user prompt template)
//   description  description (director sub-agents only)
//   api          connection profile
//   preset       generation preset
//   tools        tool flags as JSON ('' inherits)
//   skills       skill visibility as JSON ('' inherits)
//   maxRounds    director sub-agent round cap ('' inherits)
//
// Slots use agentId PROFILE and a path as the field, e.g. 'spec/stages' or
// 'presets/<id>'. A slot's value is JSON; '' means absent.
//
// Where each one lives depends on the mode (see locate()). Pure: no DOM.

import { i18n, i18nFormat } from '../i18n.js';

export const PROFILE = '@profile';
const FIELD_LABELS = {
    system: 'Role prompt', task: 'Task template', description: 'Agent description', api: 'Connection profile', preset: 'Generation preset',
    tools: 'Agent tools', skills: 'Skills', maxRounds: 'Maximum tool-calling rounds',
    'spec/stages': 'Workflow stages', 'spec/defaultTools': 'Default tools', defaultTools: 'Default tools', 
    'spec/lorebookFilter': 'Lorebook filter', lorebookFilter: 'Lorebook filter', 'spec/skills': 'Skills', finalAgentId: 'Final agent',
};
const ENTITY_LABELS = { presets: 'Agent preset', agents: 'Agent', subAgents: 'Sub-agent' };
const ENTITY_CONTAINERS = Object.keys(ENTITY_LABELS);

/** Translated name of an editable field or slot; '' for unknown fields. */
export function fieldLabel(field) {
    const key = String(field || '');
    const [head, entity] = key.split('/');
    if (entity && ENTITY_LABELS[head]) return i18nFormat('${0}: ${1}', i18n(ENTITY_LABELS[head]), entity);
    if (key === 'tools' || key === 'skills') return i18n(FIELD_LABELS[key]);
    return FIELD_LABELS[key] ? i18n(FIELD_LABELS[key]) : '';
}
export const TEXT_FIELDS = ['system', 'task', 'description'];

const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const str = (value) => (value == null ? '' : String(value));

const sortKeys = (value) => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
};
const canon = (value) => JSON.stringify(sortKeys(value), null, 2);

export function cloneProfile(profile) {
    return profile == null ? profile : JSON.parse(JSON.stringify(profile));
}

function specNodes(profile) {
    const stages = Array.isArray(profile?.spec?.stages) ? profile.spec.stages : [];
    const out = [];
    stages.forEach((stage, si) => (Array.isArray(stage?.nodes) ? stage.nodes : []).forEach((node, ni) => {
        const id = typeof node === 'string' ? node : str(node?.id || node?.preset);
        if (id) out.push({ id, stage: si, index: ni, node });
    }));
    return out;
}

/** Agent ids in display order. */
export function listAgents(mode, profile) {
    const p = obj(profile) || {};
    if (mode === 'spec' || mode === 'single') return specNodes(p).map(n => n.id);
    if (mode === 'agenda') return ['agenda_planner', ...Object.keys(obj(p.agents) || {})];
    if (mode === 'loop') return ['loop_agent'];
    if (mode === 'director') return ['main', ...(Array.isArray(p.subAgents) ? p.subAgents : []).map(a => str(a?.id)).filter(Boolean)];
    return [];
}

/**
 * field → { obj, key } inside `profile` (the live object, so callers mutate a
 * clone). `create` makes the holder when it is missing (spec preset entries).
 */
function locate(mode, profile, agentId, { create = false, field = '' } = {}) {
    const p = obj(profile);
    if (!p) return {};
    const id = str(agentId);
    const entry = (holder, keys) => Object.fromEntries(Object.entries(keys).map(([field, key]) => [field, holder ? { obj: holder, key } : null]).filter(([, v]) => v));
    const routing = { system: 'systemPrompt', task: 'userPromptTemplate', api: 'apiPresetName', preset: 'promptPresetName' };

    if (mode === 'spec' || mode === 'single') {
        // An id with no node may still name an entry of the preset library.
        const hit = specNodes(p).find(n => n.id === id) || (mode === 'spec' && obj(p.presets?.[id]) ? { id, node: null } : null);
        if (!hit) return {};
        const presetId = hit.node === null || typeof hit.node === 'string' ? (hit.node || id) : str(hit.node?.preset || hit.node?.id);
        if (create) {
            p.presets = obj(p.presets) || {};
            p.presets[presetId] = obj(p.presets[presetId]) || {};
        }
        const preset = obj(p.presets?.[presetId]);
        const keys = mode === 'single' ? { system: 'systemPrompt', task: 'userPromptTemplate' } : routing;
        const out = entry(preset, keys);
        // A node-level template overrides the preset's one.
        if (out.task && obj(hit.node) && str(hit.node.userPromptTemplate).trim()) out.task = { obj: hit.node, key: 'userPromptTemplate' };
        if (mode === 'spec' && hit.node !== null) {
            if (create && typeof hit.node === 'string' && (field === 'tools' || field === 'skills')) {
                hit.node = { id: hit.node, preset: hit.node };
                p.spec.stages[hit.stage].nodes[hit.index] = hit.node;
            }
            if (obj(hit.node)) Object.assign(out, jsonSlots(hit.node));
        }
        return out;
    }
    if (mode === 'agenda') {
        const holder = id === 'agenda_planner' ? obj(p.planner) : obj(p.agents?.[id]);
        const out = entry(holder, routing);
        if (holder) Object.assign(out, id === 'agenda_planner' ? { skills: { obj: holder, key: 'skills', kind: 'json' } } : jsonSlots(holder));
        return out;
    }
    if (mode === 'loop') {
        return id === 'loop_agent' ? { ...entry(p, { system: 'system_prompt', api: 'apiPresetName', preset: 'promptPresetName' }), tools: { obj: p, key: 'tools', kind: 'json' } } : {};
    }
    if (mode === 'director') {
        if (id === 'main') {
            const main = obj(p.mainAgent);
            return { ...entry(main, { system: 'systemPrompt', api: 'apiPresetName', preset: 'promptPresetName' }), ...(main ? jsonSlots(main) : {}) };
        }
        const sub = (Array.isArray(p.subAgents) ? p.subAgents : []).find(a => str(a?.id) === id);
        const out = entry(obj(sub), { description: 'description', system: 'systemPrompt', api: 'apiPresetName', preset: 'promptPresetName' });
        return obj(sub) ? { ...out, ...jsonSlots(sub), maxRounds: { obj: sub, key: 'maxRounds', kind: 'number' } } : out;
    }
    return {};
}

function jsonSlots(holder) {
    return { tools: { obj: holder, key: 'tools', kind: 'json' }, skills: { obj: holder, key: 'skills', kind: 'json' } };
}

const readLocated = (slot) => {
    const value = slot.obj[slot.key];
    if (slot.kind === 'json') return value == null ? '' : canon(value);
    return str(value);
};

function writeLocated(slot, value) {
    const text = str(value);
    if (slot.kind === 'json') slot.obj[slot.key] = text ? JSON.parse(text) : null;
    else if (slot.kind === 'number') slot.obj[slot.key] = text ? Number(text) : null;
    else slot.obj[slot.key] = text;
}

const childOf = (holder, key) => (Array.isArray(holder) ? holder.find(item => str(item?.id) === key) : holder?.[key]);

function readSlot(profile, path) {
    let current = profile;
    for (const part of String(path).split('/')) current = childOf(current, part);
    return current == null ? '' : canon(current);
}

function writeSlot(profile, path, value) {
    const parts = String(path).split('/');
    const last = parts.pop();
    let holder = profile;
    for (const part of parts) {
        if (holder[part] == null) holder[part] = {};
        holder = holder[part];
    }
    const text = str(value);
    const parsed = text ? JSON.parse(text) : null;
    if (Array.isArray(holder)) {
        const index = holder.findIndex(item => str(item?.id) === last);
        if (!text) { if (index >= 0) holder.splice(index, 1); }
        else if (index >= 0) holder[index] = parsed;
        else holder.push(parsed);
    } else if (!text && ENTITY_CONTAINERS.includes(parts[parts.length - 1])) {
        delete holder[last];
    } else {
        holder[last] = parsed;
    }
}

/** Slot paths worth comparing between two versions of a profile. */
function slotPaths(mode, before, after) {
    const entities = (container) => {
        const ids = (p) => {
            const held = p?.[container];
            return Array.isArray(held) ? held.map(a => str(a?.id)).filter(Boolean) : Object.keys(obj(held) || {});
        };
        const a = new Set(ids(before));
        const b = new Set(ids(after));
        return [...a, ...b].filter((id, i, all) => all.indexOf(id) === i && a.has(id) !== b.has(id)).map(id => `${container}/${id}`);
    };
    if (mode === 'spec') return ['spec/stages', 'spec/defaultTools', 'spec/lorebookFilter', 'spec/skills', ...entities('presets')];
    if (mode === 'agenda') return ['finalAgentId', 'defaultTools', 'lorebookFilter', 'skills', ...entities('agents')];
    if (mode === 'loop') return ['lorebookFilter', 'skills'];
    if (mode === 'director') return ['tools', 'lorebookFilter', 'skills', ...entities('subAgents')];
    return [];
}

// Per-node tool flags have their own field, so they are not a stage change.
function comparableSlot(path, text) {
    if (path !== 'spec/stages' || !text) return text;
    return canon(JSON.parse(text).map(stage => ({ ...stage, nodes: (stage.nodes || []).map(node => (obj(node) ? { ...node, tools: undefined } : node)) })));
}

/** Slots first, so field edits land on top of an added or moved agent. */
const slotsFirst = (changes) => [...changes].sort((a, b) => Number(b.agentId === PROFILE) - Number(a.agentId === PROFILE));

/** Editable fields for one agent, in display order. */
export function agentFields(mode, profile, agentId) {
    const found = locate(mode, profile, agentId);
    return BASE_FIELDS.filter(field => found[field]);
}

const BASE_FIELDS = ['description', 'system', 'task', 'api', 'preset'];
const ALL_FIELDS = [...BASE_FIELDS, 'tools', 'skills', 'maxRounds'];

/** Whether a change can be placed on this profile. */
export function canHold(mode, profile, agentId, field) {
    return agentId === PROFILE || Boolean(locate(mode, profile, agentId)[field]);
}

export function getField(mode, profile, agentId, field) {
    if (agentId === PROFILE) return readSlot(profile, field);
    const slot = locate(mode, profile, agentId)[field];
    return slot ? readLocated(slot) : '';
}

/** Returns a new profile with one field changed (the input is untouched). */
export function setField(mode, profile, agentId, field, value) {
    const next = cloneProfile(profile);
    if (agentId === PROFILE) {
        writeSlot(next, field, value);
        return next;
    }
    const slot = locate(mode, next, agentId, { create: true, field })[field];
    if (!slot) throw new EditError('field', i18nFormat('"${0}" has no "${1}"', agentId, fieldLabel(field) || field));
    writeLocated(slot, value);
    return next;
}

export class EditError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

/**
 * Replaces one exact occurrence of `oldText` in a text field.
 * Throws EditError('not_found' | 'ambiguous').
 */
export function replaceInField(mode, profile, agentId, field, oldText, newText) {
    const current = getField(mode, profile, agentId, field);
    const needle = str(oldText);
    if (!needle) throw new EditError('empty', i18n('old_text must not be empty'));
    const first = current.indexOf(needle);
    if (first < 0) throw new EditError('not_found', i18n('This passage was not found (read the original first and copy the part to replace verbatim)'));
    if (current.indexOf(needle, first + needle.length) >= 0) throw new EditError('ambiguous', i18n('This passage occurs more than once; include more context'));
    return setField(mode, profile, agentId, field, current.slice(0, first) + str(newText) + current.slice(first + needle.length));
}

/** Checks the orchestrator would accept the value (its sanitizers drop some empties). */
export function validateField(mode, agentId, field, value) {
    if (mode === 'director' && agentId !== 'main' && field === 'system' && !str(value).trim()) {
        return i18n('Director-mode agents must have a role prompt; if left empty the orchestrator deletes them');
    }
    return '';
}

/**
 * Field-level differences between two versions of the same profile.
 * @returns {{ id: string, agentId: string, field: string, before: string, after: string }[]}
 */
export function diffProfiles(mode, before, after) {
    const inProfile = (p) => {
        const ids = listAgents(mode, p);
        if (mode !== 'spec') return [...new Set(ids)];
        const used = new Set(specNodes(p).map(n => (typeof n.node === 'string' ? n.node : str(n.node?.preset || n.node?.id))));
        return [...new Set([...ids, ...Object.keys(obj(p?.presets) || {}).filter(id => !used.has(id))])];
    };
    const afterIds = new Set(inProfile(after));
    const out = [];
    for (const field of slotPaths(mode, before, after)) {
        const a = readSlot(before, field);
        const b = readSlot(after, field);
        if (comparableSlot(field, a) !== comparableSlot(field, b)) out.push({ id: `${PROFILE}.${field}`, agentId: PROFILE, field, before: a, after: b });
    }
    // An added or removed agent is already one slot change.
    for (const agentId of inProfile(before).filter(id => afterIds.has(id))) {
        for (const field of ALL_FIELDS) {
            const a = getField(mode, before, agentId, field);
            const b = getField(mode, after, agentId, field);
            if (a !== b) out.push({ id: `${agentId}.${field}`, agentId, field, before: a, after: b });
        }
    }
    return out;
}

/** Copies the chosen changes' `after` values onto `base`. */
export function applyChanges(mode, base, changes) {
    let next = cloneProfile(base);
    for (const change of slotsFirst(changes)) {
        // The agent may have been removed by a slot change.
        if (canHold(mode, next, change.agentId, change.field)) next = setField(mode, next, change.agentId, change.field, change.after);
    }
    return next;
}

/**
 * Puts the changes on top of the freshly stored profile so edits made
 * elsewhere to other fields survive. A field that was
 * also changed elsewhere since the draft started is a conflict.
 * @returns {{ profile: object, conflicts: object[], missing: object[] }}
 */
export function mergeChanges(mode, fresh, changes) {
    let profile = cloneProfile(fresh);
    const conflicts = [];
    const missing = [];
    for (const change of slotsFirst(changes)) {
        if (!canHold(mode, profile, change.agentId, change.field)) {
            missing.push(change);
            continue;
        }
        const now = getField(mode, profile, change.agentId, change.field);
        if (now !== change.before && now !== change.after) conflicts.push({ ...change, current: now });
        profile = setField(mode, profile, change.agentId, change.field, change.after);
    }
    return { profile, conflicts, missing };
}

/** The same changes, undone (after ↔ before). */
export function invertChanges(changes) {
    return changes.map(c => ({ ...c, before: c.after, after: c.before }));
}

/** Agent ids that differ between two profiles. */
export function changedAgents(mode, before, after) {
    return new Set(diffProfiles(mode, before, after).map(c => c.agentId));
}

// ----- Structural operations (each returns a new profile) --------------------

const newPreset = () => ({ systemPrompt: '', userPromptTemplate: '', apiPresetName: '', promptPresetName: '' });
const firstPreset = (p) => Object.keys(obj(p.presets) || {})[0] || '';
const newNode = (p) => {
    const preset = firstPreset(p);
    return { id: preset, preset, type: 'worker', userPromptTemplate: '' };
};
const moved = (list, from, to) => {
    if (from < 0 || to < 0 || from >= list.length || to >= list.length) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
};
const stagesOf = (p) => {
    p.spec = obj(p.spec) || {};
    p.spec.stages = Array.isArray(p.spec.stages) ? p.spec.stages : [];
    return p.spec.stages;
};
const edit = (profile, fn) => {
    const next = cloneProfile(profile);
    fn(next);
    return next;
};

export const addStage = (profile) => edit(profile, (p) => {
    const stages = stagesOf(p);
    stages.push({ id: `stage_${stages.length + 1}`, mode: 'serial', nodes: [newNode(p)] });
});
export const removeStage = (profile, index) => edit(profile, (p) => {
    const stages = stagesOf(p);
    stages.splice(index, 1);
    if (!stages.length) stages.push({ id: 'stage_1', mode: 'serial', nodes: [newNode(p)] });
});
export const moveStage = (profile, index, delta) => edit(profile, p => moved(stagesOf(p), index, index + delta));
export const setStageProp = (profile, index, key, value) => edit(profile, (p) => { stagesOf(p)[index][key] = value; });

const nodesOf = (p, stage) => {
    const list = stagesOf(p)[stage].nodes;
    list.forEach((node, i) => { if (typeof node === 'string') list[i] = { id: node, preset: node, type: 'worker', userPromptTemplate: '' }; });
    return list;
};
export const addNode = (profile, stage) => edit(profile, p => nodesOf(p, stage).push(newNode(p)));
export const removeNode = (profile, stage, index) => edit(profile, (p) => {
    const nodes = nodesOf(p, stage);
    nodes.splice(index, 1);
    if (!nodes.length) nodes.push(newNode(p));
});
export const moveNode = (profile, stage, index, delta) => edit(profile, p => moved(nodesOf(p, stage), index, index + delta));
export const setNodeProp = (profile, stage, index, key, value) => edit(profile, (p) => { nodesOf(p, stage)[index][key] = value; });

const assertNewId = (taken, id) => {
    const value = str(id).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new EditError('id', i18n('Use letters, numbers, _ or - for the ID.'));
    if (taken.includes(value)) throw new EditError('id', i18nFormat('Preset \'${0}\' already exists.', value));
    return value;
};

export const addPresetEntry = (profile, id) => edit(profile, (p) => {
    p.presets = obj(p.presets) || {};
    p.presets[assertNewId(Object.keys(p.presets), id)] = newPreset();
});
export const removePresetEntry = (profile, id) => {
    if (specNodes(profile).some(n => (typeof n.node === 'string' ? n.node : str(n.node?.preset)) === id)) {
        throw new EditError('in-use', i18nFormat('Preset \'${0}\' is still used by a node.', id));
    }
    return edit(profile, (p) => { delete p.presets[id]; });
};

export const addAgendaAgent = (profile, id) => edit(profile, (p) => {
    p.agents = obj(p.agents) || {};
    p.agents[assertNewId(Object.keys(p.agents), id)] = newPreset();
});
export const removeAgendaAgent = (profile, id) => edit(profile, (p) => {
    delete p.agents[id];
    if (!p.agents[p.finalAgentId]) p.finalAgentId = Object.keys(p.agents)[0] || '';
});

export const addSubAgent = (profile, id) => edit(profile, (p) => {
    p.subAgents = Array.isArray(p.subAgents) ? p.subAgents : [];
    p.subAgents.push({ id: assertNewId(p.subAgents.map(a => str(a?.id)), id), description: '', systemPrompt: '', apiPresetName: '', promptPresetName: '', tools: null, maxRounds: null });
});
export const removeSubAgent = (profile, id) => edit(profile, (p) => { p.subAgents = p.subAgents.filter(a => str(a?.id) !== id); });

/** Sets one 'ns.verb' tool flag on a copy of `tools`. */
export function withToolFlag(tools, flag, enabled) {
    const next = cloneProfile(obj(tools) || {});
    const dot = flag.indexOf('.');
    const [ns, verb] = [flag.slice(0, dot), flag.slice(dot + 1)];
    next[ns] = obj(next[ns]) || {};
    next[ns][verb] = Boolean(enabled);
    return next;
}

/** Replaces the profile's default tools. `clearOverrides` drops every per-agent override too. */
export function setDefaultTools(mode, profile, tools, { clearOverrides = false } = {}) {
    return edit(profile, (p) => {
        if (mode === 'spec') {
            p.spec = obj(p.spec) || {};
            p.spec.defaultTools = tools;
            if (clearOverrides) stagesOf(p).forEach(stage => (stage.nodes || []).forEach((node) => { if (obj(node)) node.tools = null; }));
        } else if (mode === 'agenda') {
            p.defaultTools = tools;
            if (clearOverrides) Object.values(obj(p.agents) || {}).forEach((agent) => { if (obj(agent)) agent.tools = null; });
        } else if (mode === 'director') {
            p.tools = tools;
            if (clearOverrides) [p.mainAgent, ...(p.subAgents || [])].forEach((agent) => { if (obj(agent)) agent.tools = null; });
        }
    });
}

/** Problems that would make the orchestrator reject or silently drop parts of the profile. */
export function validateStructure(mode, profile) {
    const p = obj(profile) || {};
    const out = [];
    if (mode === 'spec') {
        const stages = Array.isArray(p.spec?.stages) ? p.spec.stages : [];
        if (!stages.length) out.push(i18n('The workflow needs at least one stage.'));
        const seen = new Set();
        for (const stage of stages) {
            const id = str(stage?.id).trim();
            if (!id || seen.has(id)) out.push(i18nFormat('Stage ID "${0}" is empty or used twice.', id));
            seen.add(id);
            const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
            if (!nodes.length) out.push(i18nFormat('Stage "${0}" has no nodes.', id));
            for (const node of nodes) {
                const preset = typeof node === 'string' ? node : str(node?.preset || node?.id);
                if (!obj(p.presets?.[preset])) out.push(i18nFormat('Node preset "${0}" does not exist.', preset));
            }
        }
    } else if (mode === 'agenda') {
        const agents = Object.keys(obj(p.agents) || {});
        if (!agents.length) out.push(i18n('Add at least one agent.'));
        else if (!agents.includes(str(p.finalAgentId))) out.push(i18n('Pick a final agent.'));
    } else if (mode === 'director') {
        const seen = new Set();
        for (const sub of Array.isArray(p.subAgents) ? p.subAgents : []) {
            const id = str(sub?.id).trim();
            if (!id || seen.has(id)) out.push(i18nFormat('Sub-agent ID "${0}" is empty or used twice.', id));
            seen.add(id);
            const problem = validateField(mode, id, 'system', sub?.systemPrompt);
            if (problem) out.push(`${id}: ${problem}`);
        }
    }
    return out;
}
