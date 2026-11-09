// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Agent-level editing of an orchestrator profile, shared by hand edits and
// the AI assistant. Only per-agent text and model routing are editable here;
// adding / removing agents or stages stays in the native editor.
//
// Fields (display keys):
//   system       role prompt (system prompt)
//   task         task template (user prompt template)
//   description  description (director sub-agents only)
//   api          connection profile
//   preset       generation preset
//
// Where each one lives depends on the mode (see locate()). Pure: no DOM.

import { i18n, i18nFormat } from '../i18n.js';

const FIELD_LABELS = { system: 'Role prompt', task: 'Task template', description: 'Agent description', api: 'Connection profile', preset: 'Generation preset' };

/** Translated name of an editable field; '' for unknown fields. */
export function fieldLabel(field) {
    return FIELD_LABELS[field] ? i18n(FIELD_LABELS[field]) : '';
}
export const TEXT_FIELDS = ['system', 'task', 'description'];

const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const str = (value) => (value == null ? '' : String(value));

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
function locate(mode, profile, agentId, { create = false } = {}) {
    const p = obj(profile);
    if (!p) return {};
    const id = str(agentId);
    const entry = (holder, keys) => Object.fromEntries(Object.entries(keys).map(([field, key]) => [field, holder ? { obj: holder, key } : null]).filter(([, v]) => v));
    const routing = { system: 'systemPrompt', task: 'userPromptTemplate', api: 'apiPresetName', preset: 'promptPresetName' };

    if (mode === 'spec' || mode === 'single') {
        const hit = specNodes(p).find(n => n.id === id);
        if (!hit) return {};
        const presetId = typeof hit.node === 'string' ? hit.node : str(hit.node?.preset || hit.node?.id);
        if (create) {
            p.presets = obj(p.presets) || {};
            p.presets[presetId] = obj(p.presets[presetId]) || {};
        }
        const preset = obj(p.presets?.[presetId]);
        const keys = mode === 'single' ? { system: 'systemPrompt', task: 'userPromptTemplate' } : routing;
        const out = entry(preset, keys);
        // A node-level template overrides the preset's one.
        if (out.task && typeof hit.node === 'object' && str(hit.node.userPromptTemplate).trim()) out.task = { obj: hit.node, key: 'userPromptTemplate' };
        return out;
    }
    if (mode === 'agenda') {
        const holder = id === 'agenda_planner' ? obj(p.planner) : obj(p.agents?.[id]);
        return entry(holder, routing);
    }
    if (mode === 'loop') {
        return id === 'loop_agent' ? entry(p, { system: 'system_prompt', api: 'apiPresetName', preset: 'promptPresetName' }) : {};
    }
    if (mode === 'director') {
        if (id === 'main') return entry(obj(p.mainAgent), { system: 'systemPrompt', api: 'apiPresetName', preset: 'promptPresetName' });
        const sub = (Array.isArray(p.subAgents) ? p.subAgents : []).find(a => str(a?.id) === id);
        return entry(obj(sub), { description: 'description', system: 'systemPrompt', api: 'apiPresetName', preset: 'promptPresetName' });
    }
    return {};
}

/** Editable fields for one agent, in display order. */
export function agentFields(mode, profile, agentId) {
    const found = locate(mode, profile, agentId);
    return ['description', 'system', 'task', 'api', 'preset'].filter(field => found[field]);
}

export function getField(mode, profile, agentId, field) {
    const slot = locate(mode, profile, agentId)[field];
    return slot ? str(slot.obj[slot.key]) : '';
}

/** Returns a new profile with one field changed (the input is untouched). */
export function setField(mode, profile, agentId, field, value) {
    const next = cloneProfile(profile);
    const slot = locate(mode, next, agentId, { create: true })[field];
    if (!slot) throw new EditError('field', i18nFormat('"${0}" has no "${1}"', agentId, fieldLabel(field) || field));
    slot.obj[slot.key] = str(value);
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
    const ids = [...new Set([...listAgents(mode, before), ...listAgents(mode, after)])];
    const out = [];
    for (const agentId of ids) {
        const fields = new Set([...agentFields(mode, before, agentId), ...agentFields(mode, after, agentId)]);
        for (const field of ['description', 'system', 'task', 'api', 'preset']) {
            if (!fields.has(field)) continue;
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
    for (const change of changes) next = setField(mode, next, change.agentId, change.field, change.after);
    return next;
}

/**
 * Puts the changes on top of the freshly stored profile so edits made
 * elsewhere (the native editor) to other fields survive. A field that was
 * also changed elsewhere since the draft started is a conflict.
 * @returns {{ profile: object, conflicts: object[], missing: object[] }}
 */
export function mergeChanges(mode, fresh, changes) {
    let profile = cloneProfile(fresh);
    const conflicts = [];
    const missing = [];
    for (const change of changes) {
        if (!agentFields(mode, profile, change.agentId).includes(change.field)) {
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
