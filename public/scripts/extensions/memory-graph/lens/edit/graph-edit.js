// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory store edits used by the lens (no DOM, no Luker context).
// `createMutator` runs one edit on a copy of the live store, commits it once
// and keeps the before/after state for undo.

import { addEdge, removeEdge, reparentNode, willCreateParentCycle } from '../../graph-ops.js';
import { i18n } from '../i18n.js';

const clone = (value) => structuredClone(value);
function graphKey(store) {
    return JSON.stringify([store.nodes, store.edges], (_key, value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    });
}
const isEmpty = (value) => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);

/**
 * @param {{ getLive: () => Promise<object|null>, commit: (before: object, after: object) => Promise<void> }} deps
 */
export function createMutator({ getLive, commit, normalize = value => value }) {
    const requireLive = async () => {
        const live = await getLive();
        if (!live) throw Object.assign(new Error('no-chat'), { code: 'no-chat' });
        return live;
    };
    return {
        /** @returns {Promise<{ result: any, before: object, afterKey: string }>} snapshot for restore() */
        async mutate(edit) {
            const live = await requireLive();
            const before = clone(live);
            const working = clone(live);
            const result = await edit(working);
            await commit(live, working);
            return { result, before, afterKey: graphKey(normalize(working)) };
        },
        /** Puts the graph back, refusing when something else changed it since. */
        async restore(snapshot) {
            const live = await requireLive();
            if (graphKey(normalize(live)) !== snapshot.afterKey) throw new Error(i18n('The memory has changed since then, so this cannot be undone'));
            const restored = clone(live);
            restored.nodes = clone(snapshot.before.nodes);
            restored.edges = clone(snapshot.before.edges);
            await commit(live, restored);
        },
    };
}

function requireNode(store, id) {
    const node = store.nodes?.[id];
    if (!node) throw new Error(i18n('This memory could not be found'));
    return node;
}

/** Applies a manual edit; the same fields the native node editor can change. */
export function patchNode(store, id, { fields, title, type, level, seqTo, archived, parentId } = {}) {
    const node = requireNode(store, id);
    if (parentId !== undefined) {
        const nextParent = String(parentId || '').trim();
        if (nextParent && !store.nodes[nextParent]) throw new Error(i18n('The parent memory does not exist'));
        if (nextParent === id || willCreateParentCycle(store, id, nextParent)) throw new Error(i18n('This parent would create a loop'));
        const oldParent = String(node.parentId || '').trim();
        if (nextParent !== oldParent) {
            if (nextParent) reparentNode(store, id, nextParent);
            else {
                if (store.nodes[oldParent]) store.nodes[oldParent].childrenIds = (store.nodes[oldParent].childrenIds || []).filter(child => child !== id);
                node.parentId = '';
            }
        }
    }
    if (fields) {
        if (!node.fields || typeof node.fields !== 'object') node.fields = {};
        for (const [key, value] of Object.entries(fields)) {
            if (isEmpty(value)) delete node.fields[key];
            else node.fields[key] = value;
        }
    }
    if (title !== undefined) node.title = String(title).trim() || node.title;
    if (type !== undefined) node.type = String(type).trim() || node.type;
    if (level !== undefined) node.level = String(level).trim() || node.level;
    if (seqTo !== undefined) node.seqTo = seqTo;
    if (archived !== undefined) node.archived = Boolean(archived);
}

function checkEdge(store, { from, to, type }) {
    requireNode(store, from);
    requireNode(store, to);
    if (from === to) throw new Error(i18n('A relationship needs two different memories'));
    if (!String(type || '').trim()) throw new Error(i18n('Choose a relationship type'));
}

const sameEdge = (edge, { from, to, type }) => edge.from === from && edge.to === to && edge.type === type;

export function addExactEdge(store, edge) {
    checkEdge(store, edge);
    if (store.edges.some(item => sameEdge(item, edge))) throw new Error(i18n('This relationship already exists'));
    addEdge(store, edge.from, edge.to, edge.type);
}

/** Removes exactly this direction; a stored reverse edge stays. */
export function removeExactEdge(store, { from, to, type }) {
    if (!removeEdge(store, from, to, type, { direction: 'outgoing' })) throw new Error(i18n('This relationship could not be found'));
}

export function replaceExactEdge(store, edge, next) {
    checkEdge(store, next);
    const index = store.edges.findIndex(item => sameEdge(item, edge));
    if (index < 0) throw new Error(i18n('This relationship could not be found'));
    if (store.edges.some((item, i) => i !== index && sameEdge(item, next))) throw new Error(i18n('This relationship already exists'));
    store.edges[index] = { ...store.edges[index], from: next.from, to: next.to, type: next.type };
}
