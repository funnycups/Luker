/**
 * loop-tools/memory write-exec tests (Task 26).
 *
 * Verifies the five write-side wrappers added in Task 26:
 *
 *   - memory_node_create    → createNode
 *   - memory_node_edit      → editNode
 *   - memory_link_upsert    → upsertLinks
 *   - memory_link_delete    → deleteLinks
 *   - memory_compact_nodes  → compactNodes  (smoke-tested separately if needed)
 *
 * Like the read-side tests in `loop-tools-memory.test.js`, we inject a stub
 * session through `context.__memoryGraphSession` so we never load the real
 * `memory-graph/api.js` (which would pull `main.js` and its big web of
 * SillyTavern globals into the Node test runtime). The stub mutates a
 * caller-supplied `store` object so tests can assert side-effects directly.
 *
 * Required wiring on the context:
 *   - `__memoryGraphSession` must be a non-null object exposing the write
 *     methods — wrappers throw `ToolError(MEMORY_DISABLED)` when it's missing.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';

let execMemoryNodeCreate;
let execMemoryNodeEdit;
let execMemoryLinkUpsert;
let execMemoryLinkDelete;
let execMemoryCompactNodes;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/orchestrator/loop-tools/memory.js');
    execMemoryNodeCreate = mod.execMemoryNodeCreate;
    execMemoryNodeEdit = mod.execMemoryNodeEdit;
    execMemoryLinkUpsert = mod.execMemoryLinkUpsert;
    execMemoryLinkDelete = mod.execMemoryLinkDelete;
    execMemoryCompactNodes = mod.execMemoryCompactNodes;
});

/**
 * Build a small stub session that mutates `store` directly. The shape
 * mirrors the Layer-1 session exposed by `memory-graph/api.js::openSession`
 * — return values are minimal ack shapes (id / ok / applied / removed /
 * rollupNodeId) and the wrappers re-key them into LLM-facing forms.
 *
 * Override individual methods per test by spreading:
 *   makeSession(store, { createNode: jest.fn() })
 */
function makeSession(store, overrides = {}) {
    let counter = Number(store?.seqCounter || 0);
    function nextId(prefix) {
        counter += 1;
        if (store) store.seqCounter = counter;
        return `${prefix}${counter}`;
    }
    return {
        createNode({ type, title, fields, links }) {
            const id = nextId('n');
            const node = { id, type, title, fields: fields || {}, level: 'semantic' };
            if (!store.nodes) store.nodes = {};
            store.nodes[id] = node;
            if (Array.isArray(links) && links.length > 0) {
                if (!store.edges) store.edges = [];
                for (const link of links) {
                    store.edges.push({
                        from: id,
                        to: link.target_node_id || link.targetNodeId || '',
                        type: link.relation || '',
                    });
                }
            }
            return { id };
        },
        editNode({ id, setFields, clearFields, title }) {
            const node = store?.nodes?.[id];
            if (!node) return { ok: false };
            if (title !== undefined) node.title = title;
            if (setFields && typeof setFields === 'object') {
                node.fields = { ...(node.fields || {}), ...setFields };
            }
            if (Array.isArray(clearFields)) {
                for (const key of clearFields) {
                    if (node.fields) delete node.fields[key];
                }
            }
            return { ok: true };
        },
        deleteNode({ id }) {
            if (!store?.nodes?.[id]) return { ok: false };
            delete store.nodes[id];
            return { ok: true };
        },
        upsertLinks({ source, links }) {
            const sourceId = source?.id || '';
            if (!Array.isArray(links) || !store) return { applied: 0 };
            if (!store.edges) store.edges = [];
            let applied = 0;
            for (const link of links) {
                store.edges.push({
                    from: sourceId,
                    to: link.target_node_id || link.targetNodeId || '',
                    type: link.relation || '',
                });
                applied += 1;
            }
            return { applied };
        },
        deleteLinks({ source, target, relation }) {
            if (!Array.isArray(store?.edges)) return { removed: 0 };
            const before = store.edges.length;
            store.edges = store.edges.filter(e => !(e.from === source?.id && e.to === target?.id && e.type === relation));
            return { removed: before - store.edges.length };
        },
        compactNodes({ type, childIds, summary }) {
            const id = nextId('rollup');
            if (!store.nodes) store.nodes = {};
            store.nodes[id] = { id, type, title: summary, level: 'semantic', fields: {} };
            if (!store.edges) store.edges = [];
            for (const child of childIds) {
                store.edges.push({ from: id, to: child, type: 'semantic_contains' });
            }
            return { rollupNodeId: id };
        },
        ...overrides,
    };
}

function makeCtx(store = { nodes: {}, edges: [], seqCounter: 0 }, sessionOverrides = {}) {
    return {
        __memoryGraphSession: makeSession(store, sessionOverrides),
    };
}

describe('memory write tool execs', () => {
    test('execMemoryNodeCreate creates a node and returns { ok, id }', async () => {
        const store = { nodes: {}, edges: [], seqCounter: 0 };
        const ctx = makeCtx(store);
        const result = await execMemoryNodeCreate({
            type: 'character_sheet',
            title: 'Eileen',
            fields: { traits: 'healer' },
        }, ctx);
        expect(result.ok).toBe(true);
        expect(result.id).toBeTruthy();
        expect(store.nodes[result.id].title).toBe('Eileen');
        expect(store.nodes[result.id].fields.traits).toBe('healer');
    });

    test('execMemoryNodeEdit patches set_fields onto the node', async () => {
        const store = {
            nodes: { n1: { id: 'n1', type: 'character_sheet', title: 'X', level: 'semantic', fields: {} } },
            edges: [],
            seqCounter: 0,
        };
        const ctx = makeCtx(store);
        const result = await execMemoryNodeEdit({
            node_id: 'n1',
            set_fields: { traits: 'updated' },
        }, ctx);
        expect(result.ok).toBe(true);
        expect(store.nodes.n1.fields.traits).toBe('updated');
    });

    test('execMemoryLinkUpsert adds edges to the store', async () => {
        const store = {
            nodes: { a: { id: 'a' }, b: { id: 'b' } },
            edges: [],
            seqCounter: 0,
        };
        const ctx = makeCtx(store);
        const result = await execMemoryLinkUpsert({
            source_node_id: 'a',
            links: [{ target_node_id: 'b', relation: 'partner_of', direction: 'bidirectional' }],
        }, ctx);
        expect(result.ok).toBe(true);
        expect(result.applied).toBe(1);
        expect(store.edges.length).toBeGreaterThan(0);
        expect(store.edges[0]).toMatchObject({ from: 'a', to: 'b', type: 'partner_of' });
    });

    test('execMemoryLinkDelete removes matching edges from the store', async () => {
        const store = {
            nodes: { a: { id: 'a' }, b: { id: 'b' } },
            edges: [{ from: 'a', to: 'b', type: 'partner_of' }],
            seqCounter: 0,
        };
        const ctx = makeCtx(store);
        const result = await execMemoryLinkDelete({
            source_node_id: 'a',
            target_node_id: 'b',
            relation: 'partner_of',
        }, ctx);
        expect(result.ok).toBe(true);
        expect(result.removed).toBe(1);
        expect(store.edges).toEqual([]);
    });

    test('MEMORY_DISABLED surfaces when __memoryGraphSession is null', async () => {
        const ctx = { __memoryGraphSession: null };
        await expect(execMemoryNodeCreate({ type: 'x', title: 'y' }, ctx))
            .rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    });

    test('execMemoryCompactNodes creates a rollup parent and returns { ok, rollup_node_id }', async () => {
        const store = {
            nodes: {
                c1: { id: 'c1', type: 'event', title: 'A', level: 'semantic' },
                c2: { id: 'c2', type: 'event', title: 'B', level: 'semantic' },
            },
            edges: [],
            seqCounter: 0,
        };
        const ctx = makeCtx(store);
        const result = await execMemoryCompactNodes({
            type: 'event',
            child_ids: ['c1', 'c2'],
            summary: 'rolled up summary',
        }, ctx);
        expect(result.ok).toBe(true);
        expect(result.rollup_node_id).toBeTruthy();
        expect(store.nodes[result.rollup_node_id]).toBeTruthy();
        expect(store.edges.some(e => e.from === result.rollup_node_id && e.to === 'c1')).toBe(true);
        expect(store.edges.some(e => e.from === result.rollup_node_id && e.to === 'c2')).toBe(true);
    });
});

// When the underlying session returns { ok: false, error: {...} } the
// wrapper must forward the error object verbatim. Without this, the
// LLM only sees `ok: false` and tries the same op repeatedly with no
// diagnostic — the exact failure mode the orchestrator memory-graph
// integration was reporting before this contract.
describe('memory write tool execs — error forwarding', () => {
    test('execMemoryNodeEdit forwards { ok: false, error } from the session', async () => {
        const ctx = { __memoryGraphSession: {
            editNode: async () => ({ ok: false, error: { code: 'NODE_NOT_FOUND', message: 'edit: node ghost does not exist.' } }),
        } };
        const result = await execMemoryNodeEdit({ node_id: 'ghost', set_fields: { x: 1 } }, ctx);
        expect(result.ok).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error.code).toBe('NODE_NOT_FOUND');
        expect(String(result.error.message || '')).toMatch(/ghost/);
    });

    test('execMemoryNodeDelete forwards error info on failure', async () => {
        const ctx = { __memoryGraphSession: {
            deleteNode: async () => ({ ok: false, error: { code: 'NODE_NOT_FOUND', message: 'delete: node missing does not exist.' } }),
        } };
        const { execMemoryNodeDelete } = await import('../../public/scripts/extensions/orchestrator/loop-tools/memory.js');
        const result = await execMemoryNodeDelete({ node_id: 'missing' }, ctx);
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('NODE_NOT_FOUND');
    });

    test('execMemoryLinkUpsert reports zero-applied with an error when session attaches one', async () => {
        const ctx = { __memoryGraphSession: {
            upsertLinks: async () => ({ applied: 0, error: { code: 'SOURCE_NOT_FOUND', message: 'upsertLinks: source node "x" does not exist.' } }),
        } };
        const result = await execMemoryLinkUpsert({ source_node_id: 'x', links: [{ target_node_id: 'y', relation: 'r' }] }, ctx);
        expect(result.ok).toBe(false);
        expect(result.applied).toBe(0);
        expect(result.error?.code).toBe('SOURCE_NOT_FOUND');
    });
});
