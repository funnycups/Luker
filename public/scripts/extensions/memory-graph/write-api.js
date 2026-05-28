// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory-graph Layer-1 write API. Mirrors read-api.js shape. The runtime
// store is supplied by the caller; the optional `context` flows through to
// `applyExtractionOpsImpl` for the few op handlers that consult it (e.g.
// timeline / link semantics that may inspect chat metadata).
// applyExtractionBatch is the recommended entry — it provides the
// single rollback / persist boundary; the per-op primitives are thin
// wrappers that build a one-op batch.
//
// Persistence is opt-in via `onCommit`. The factory accepts an
// `onCommit(store)` async callback; every method that mutates the store
// awaits it after the mutation lands so the caller can flush the change
// to floor-state + sync the active cache (see `commitSessionMutation`
// in main.js). Callers that pass no `onCommit` (test fixtures, batch
// pipelines that defer their own commit) get the legacy in-memory
// semantics.

import { applyExtractionOpsImpl, createRollupWithChildren } from './main.js';

// Accept both the Layer-1 public shape `{ target: { id, ref }, relation, direction }`
// (symmetric with deleteLinks and documented in extension-api/memory-graph.md)
// and the lower-level ExtractionOp shape `{ targetNodeId, targetRef, relation, direction }`
// that `applyExtractedLinks` ultimately consumes. The LLM tool-call path
// (orchestrator memory_link_upsert) feeds us the latter; third-party agents
// reading the docs feed us the former. Normalize to ExtractionOp shape before
// handing off so downstream stays single-shape.
function normalizeLinkSpec(link) {
    if (!link || typeof link !== 'object') return link;
    if (link.target && typeof link.target === 'object'
        && (link.target.id || link.target.ref)
        && link.targetNodeId === undefined
        && link.targetRef === undefined
        && link.target_node_id === undefined
        && link.target_ref === undefined) {
        const { target, ...rest } = link;
        return {
            ...rest,
            targetNodeId: target.id || '',
            targetRef: target.ref || '',
        };
    }
    return link;
}

function normalizeLinkList(links) {
    if (!Array.isArray(links)) return links;
    return links.map(normalizeLinkSpec);
}

export function getMemoryGraphWriteApi(store, context = null, { onCommit = null } = {}) {
    function resolveStore() {
        return (store && typeof store === 'object') ? store : null;
    }

    function requireStore(method) {
        const resolved = resolveStore();
        if (!resolved) {
            const err = new Error(`memory-graph write-api: ${method} requires a runtime store.`);
            err.code = 'MEMORY_STORE_MISSING';
            throw err;
        }
        return resolved;
    }

    function applyOne(method, op) {
        const resolved = requireStore(method);
        const result = applyExtractionOpsImpl(resolved, [op], {
            maxSeq: Number(resolved.seqCounter || 0),
            context,
        });
        return { store: resolved, result };
    }

    async function flushCommit() {
        if (typeof onCommit !== 'function') return;
        await onCommit(store);
    }

    async function createNode({ type, title, fields, links, ref } = {}) {
        if (!type) throw new Error('createNode: type is required.');
        const op = {
            op: 'create',
            type,
            title: title || '',
            fields: fields || {},
            ...(Array.isArray(links) ? { links: normalizeLinkList(links) } : {}),
            ...(ref ? { ref } : {}),
        };
        const { store: mutated, result } = applyOne('createNode', op);
        if (result.applied.length === 0) {
            const err = new Error('createNode failed.');
            err.code = 'OP_FAILED';
            err.rejected = result.rejected;
            throw err;
        }
        // Identify the newly-added node. applyExtractionOpsImpl mutates store.nodes;
        // the newest entry should be the one we just added.
        const nodes = Object.values(mutated.nodes);
        const newest = nodes[nodes.length - 1];
        await flushCommit();
        return { id: String(newest?.id || ''), ...(ref ? { ref } : {}) };
    }

    async function editNode({ id, setFields, clearFields, title } = {}) {
        if (!id) throw new Error('editNode: id is required.');
        const op = {
            op: 'edit',
            nodeId: id,
            setFields: setFields || {},
            clearFields: clearFields || [],
            ...(title !== undefined ? { title, hasTitlePatch: true } : {}),
        };
        const { result } = applyOne('editNode', op);
        const ok = result.applied.length > 0;
        if (ok) {
            await flushCommit();
            return { ok: true };
        }
        const firstReject = Array.isArray(result.rejected) ? result.rejected[0] : null;
        const error = firstReject?.error || { code: 'OP_FAILED', message: 'editNode produced no change.' };
        return { ok: false, error };
    }

    async function deleteNode({ id } = {}) {
        if (!id) throw new Error('deleteNode: id is required.');
        const { result } = applyOne('deleteNode', { op: 'delete', nodeId: id });
        const ok = result.applied.length > 0;
        if (ok) {
            await flushCommit();
            return { ok: true };
        }
        const firstReject = Array.isArray(result.rejected) ? result.rejected[0] : null;
        const error = firstReject?.error || { code: 'OP_FAILED', message: 'deleteNode produced no change.' };
        return { ok: false, error };
    }

    async function upsertLinks({ source, links } = {}) {
        if (!source || !Array.isArray(links)) throw new Error('upsertLinks: source and links are required.');
        const op = {
            op: 'link_upsert',
            sourceNodeId: source.id || '',
            sourceRef: source.ref || '',
            links: normalizeLinkList(links),
        };
        const { result } = applyOne('upsertLinks', op);
        const applied = result.applied.length;
        if (applied > 0) {
            await flushCommit();
            return { applied };
        }
        const firstReject = Array.isArray(result.rejected) ? result.rejected[0] : null;
        if (firstReject?.error) {
            return { applied: 0, error: firstReject.error };
        }
        return { applied: 0 };
    }

    async function deleteLinks({ source, target, relation, direction } = {}) {
        if (!source || !target || !relation) throw new Error('deleteLinks: source, target, relation required.');
        const op = {
            op: 'link_delete',
            sourceNodeId: source.id || '',
            targetNodeId: target.id || '',
            relation: String(relation).toLowerCase(),
            direction: direction || 'bidirectional',
        };
        const resolved = requireStore('deleteLinks');
        const beforeCount = (resolved.edges || []).length;
        applyExtractionOpsImpl(resolved, [op], { maxSeq: Number(resolved.seqCounter || 0), context });
        const removed = beforeCount - (resolved.edges || []).length;
        if (removed > 0) await flushCommit();
        return { removed };
    }

    async function applyExtractionBatch({ ops, maxSeq } = {}) {
        if (!Array.isArray(ops)) throw new Error('applyExtractionBatch: ops must be an array.');
        const resolved = requireStore('applyExtractionBatch');
        const seq = Number.isFinite(Number(maxSeq)) ? Number(maxSeq) : Number(resolved.seqCounter || 0);
        const result = applyExtractionOpsImpl(resolved, ops, { maxSeq: seq, context });
        if (result.applied.length > 0) await flushCommit();
        return result;
    }

    // compactNodes creates a rollup parent over the given children and adds the
    // semantic_contains edges. Shares `createRollupWithChildren` with the internal
    // compression loop so both paths produce identical rollup shapes.
    async function compactNodes({ type, childIds, summary, fields } = {}) {
        if (!type || !Array.isArray(childIds) || childIds.length === 0) {
            throw new Error('compactNodes: type and non-empty childIds required.');
        }
        if (!summary || !String(summary).trim()) {
            throw new Error('compactNodes: summary is required.');
        }
        const resolved = requireStore('compactNodes');
        const rollup = createRollupWithChildren(resolved, { type, childIds, summary, fields });
        await flushCommit();
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
