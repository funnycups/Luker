// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory-graph Layer-1 write API. Mirrors read-api.js shape. Caller
// resolves store via context.__memoryStore (same convention as read-api).
// applyExtractionBatch is the recommended entry — it provides the
// single rollback / persist boundary; the per-op primitives are thin
// wrappers that build a one-op batch.

import { applyExtractionOpsImpl, createRollupWithChildren } from './main.js';

export function getMemoryGraphWriteApi(context) {
    function resolveStore() {
        if (context && context.__memoryStore && typeof context.__memoryStore === 'object') {
            return context.__memoryStore;
        }
        return null;
    }

    function requireStore(method) {
        const store = resolveStore();
        if (!store) {
            const err = new Error(`memory-graph write-api: ${method} requires __memoryStore on context.`);
            err.code = 'MEMORY_STORE_MISSING';
            throw err;
        }
        return store;
    }

    function applyOne(method, op) {
        const store = requireStore(method);
        const result = applyExtractionOpsImpl(store, [op], {
            maxSeq: Number(store.seqCounter || 0),
            context,
        });
        return { store, result };
    }

    function createNode({ type, title, fields, links, ref } = {}) {
        if (!type) throw new Error('createNode: type is required.');
        const op = {
            op: 'create',
            type,
            title: title || '',
            fields: fields || {},
            ...(Array.isArray(links) ? { links } : {}),
            ...(ref ? { ref } : {}),
        };
        const { store, result } = applyOne('createNode', op);
        if (result.applied.length === 0) {
            const err = new Error('createNode failed.');
            err.code = 'OP_FAILED';
            err.rejected = result.rejected;
            throw err;
        }
        // Identify the newly-added node. applyExtractionOpsImpl mutates store.nodes;
        // the newest entry should be the one we just added.
        const nodes = Object.values(store.nodes);
        const newest = nodes[nodes.length - 1];
        return { id: String(newest?.id || ''), ...(ref ? { ref } : {}) };
    }

    function editNode({ id, setFields, clearFields, title } = {}) {
        if (!id) throw new Error('editNode: id is required.');
        const op = {
            op: 'edit',
            nodeId: id,
            setFields: setFields || {},
            clearFields: clearFields || [],
            ...(title !== undefined ? { title, hasTitlePatch: true } : {}),
        };
        const { result } = applyOne('editNode', op);
        return { ok: result.applied.length > 0 };
    }

    function deleteNode({ id } = {}) {
        if (!id) throw new Error('deleteNode: id is required.');
        const { result } = applyOne('deleteNode', { op: 'delete', nodeId: id });
        return { ok: result.applied.length > 0 };
    }

    function upsertLinks({ source, links } = {}) {
        if (!source || !Array.isArray(links)) throw new Error('upsertLinks: source and links are required.');
        const op = {
            op: 'link_upsert',
            sourceNodeId: source.id || '',
            sourceRef: source.ref || '',
            links,
        };
        const { result } = applyOne('upsertLinks', op);
        return { applied: result.applied.length };
    }

    function deleteLinks({ source, target, relation, direction } = {}) {
        if (!source || !target || !relation) throw new Error('deleteLinks: source, target, relation required.');
        const op = {
            op: 'link_delete',
            sourceNodeId: source.id || '',
            targetNodeId: target.id || '',
            relation: String(relation).toLowerCase(),
            direction: direction || 'bidirectional',
        };
        const store = requireStore('deleteLinks');
        const beforeCount = (store.edges || []).length;
        applyExtractionOpsImpl(store, [op], { maxSeq: Number(store.seqCounter || 0), context });
        return { removed: beforeCount - (store.edges || []).length };
    }

    function applyExtractionBatch({ ops, maxSeq } = {}) {
        if (!Array.isArray(ops)) throw new Error('applyExtractionBatch: ops must be an array.');
        const store = requireStore('applyExtractionBatch');
        const seq = Number.isFinite(Number(maxSeq)) ? Number(maxSeq) : Number(store.seqCounter || 0);
        return applyExtractionOpsImpl(store, ops, { maxSeq: seq, context });
    }

    // compactNodes creates a rollup parent over the given children and adds the
    // semantic_contains edges. Shares `createRollupWithChildren` with the internal
    // compression loop so both paths produce identical rollup shapes.
    function compactNodes({ type, childIds, summary, fields } = {}) {
        if (!type || !Array.isArray(childIds) || childIds.length === 0) {
            throw new Error('compactNodes: type and non-empty childIds required.');
        }
        if (!summary || !String(summary).trim()) {
            throw new Error('compactNodes: summary is required.');
        }
        const store = requireStore('compactNodes');
        const rollup = createRollupWithChildren(store, { type, childIds, summary, fields });
        return { rollupNodeId: String(rollup.id) };
    }

    return Object.freeze({
        createNode,
        editNode,
        deleteNode,
        upsertLinks,
        deleteLinks,
        compactNodes,
        applyExtractionBatch,
    });
}
