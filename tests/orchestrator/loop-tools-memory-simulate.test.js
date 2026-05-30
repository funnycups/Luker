/**
 * loop-tools/memory simulate-handler tests (Task 3).
 *
 * Each simulate fn must:
 *   - Validate args against the real exec's required shape (raising
 *     `ToolError` with a stable per-tool code).
 *   - Validate feasibility against the live session when present
 *     (e.g. link_upsert requires both endpoint ids to exist on the real
 *     graph; node_edit requires the target node to exist).
 *   - Return a payload shape-aligned with the success branch of the real
 *     exec, with `simulated: true` appended.
 *   - Return shape-valid payload even when no session is attached, so the
 *     workbench LLM can simulate a tool in a context without a graph open.
 *
 * The real exec signatures (from loop-tools/memory.js) are the source of
 * truth here — simulate's accepted arg names mirror exec's (`node_id`,
 * `source_node_id`, `child_ids`, etc.), not any hypothetical "id" /
 * "node_ids" / "into" shorthand.
 */

import { describe, test, expect } from '@jest/globals';

import {
    simulateMemoryNodeCreate,
    simulateMemoryNodeEdit,
    simulateMemoryNodeDelete,
    simulateMemoryLinkUpsert,
    simulateMemoryLinkDelete,
    simulateMemoryCompactNodes,
} from '../../public/scripts/extensions/orchestrator/loop-tools/memory.js';
import { ToolError } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

/**
 * Build a minimal stub of `context.__memoryGraphSession` exposing only
 * the read methods simulate consults for feasibility checks. Pass `nodes`
 * as an array of `{ id, ... }` objects; only the `id` field is consulted.
 */
function makeCtx({ nodes = [] } = {}) {
    return {
        __memoryGraphSession: {
            getNodeBrief: (id) => nodes.find(n => n.id === id) || null,
        },
    };
}

// ---------------------------------------------------------------------------
// simulateMemoryNodeCreate
// ---------------------------------------------------------------------------

describe('simulateMemoryNodeCreate', () => {
    test('rejects empty type with a ToolError', async () => {
        await expect(simulateMemoryNodeCreate({ title: 'Eileen' }, makeCtx()))
            .rejects.toBeInstanceOf(ToolError);
    });

    test('rejects empty title with a ToolError', async () => {
        await expect(simulateMemoryNodeCreate({ type: 'character_sheet' }, makeCtx()))
            .rejects.toBeInstanceOf(ToolError);
    });

    test('returns simulated payload on valid args (no session needed)', async () => {
        const result = await simulateMemoryNodeCreate({
            type: 'character_sheet',
            title: 'Eileen',
            fields: { traits: 'healer' },
        }, makeCtx());
        expect(result).toMatchObject({ ok: true, simulated: true });
        expect(typeof result.id).toBe('string');
        expect(result.id.length).toBeGreaterThan(0);
    });

    test('returns simulated payload even when no session is attached', async () => {
        const result = await simulateMemoryNodeCreate({
            type: 'character_sheet',
            title: 'Eileen',
        }, { __memoryGraphSession: null });
        expect(result).toMatchObject({ ok: true, simulated: true });
        expect(typeof result.id).toBe('string');
    });
});

// ---------------------------------------------------------------------------
// simulateMemoryNodeEdit
// ---------------------------------------------------------------------------

describe('simulateMemoryNodeEdit', () => {
    test('rejects missing node_id with a ToolError', async () => {
        await expect(simulateMemoryNodeEdit({ set_fields: { x: 1 } }, makeCtx()))
            .rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when target node does not exist on the real graph', async () => {
        const ctx = makeCtx({ nodes: [{ id: 'n-A' }] });
        await expect(simulateMemoryNodeEdit({ node_id: 'n-Z', set_fields: { x: 1 } }, ctx))
            .rejects.toBeInstanceOf(ToolError);
    });

    test('returns simulated payload when node exists', async () => {
        const ctx = makeCtx({ nodes: [{ id: 'n-A' }] });
        const result = await simulateMemoryNodeEdit({
            node_id: 'n-A',
            set_fields: { traits: 'updated' },
        }, ctx);
        expect(result).toMatchObject({ ok: true, simulated: true });
    });

    test('returns simulated payload when no session is attached', async () => {
        const result = await simulateMemoryNodeEdit({
            node_id: 'n-A',
            set_fields: { traits: 'updated' },
        }, { __memoryGraphSession: null });
        expect(result).toMatchObject({ ok: true, simulated: true });
    });
});

// ---------------------------------------------------------------------------
// simulateMemoryNodeDelete
// ---------------------------------------------------------------------------

describe('simulateMemoryNodeDelete', () => {
    test('rejects missing node_id with a ToolError', async () => {
        await expect(simulateMemoryNodeDelete({}, makeCtx()))
            .rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when node does not exist on the real graph', async () => {
        const ctx = makeCtx({ nodes: [{ id: 'n-A' }] });
        await expect(simulateMemoryNodeDelete({ node_id: 'n-Z' }, ctx))
            .rejects.toBeInstanceOf(ToolError);
    });

    test('returns simulated payload when node exists', async () => {
        const ctx = makeCtx({ nodes: [{ id: 'n-A' }] });
        const result = await simulateMemoryNodeDelete({ node_id: 'n-A' }, ctx);
        expect(result).toMatchObject({ ok: true, simulated: true });
    });

    test('returns simulated payload when no session is attached', async () => {
        const result = await simulateMemoryNodeDelete({ node_id: 'n-A' }, { __memoryGraphSession: null });
        expect(result).toMatchObject({ ok: true, simulated: true });
    });
});

// ---------------------------------------------------------------------------
// simulateMemoryLinkUpsert
// ---------------------------------------------------------------------------

describe('simulateMemoryLinkUpsert', () => {
    test('rejects when links is missing or empty', async () => {
        await expect(simulateMemoryLinkUpsert({
            source_node_id: 'n-A',
            links: [],
        }, makeCtx())).rejects.toBeInstanceOf(ToolError);

        await expect(simulateMemoryLinkUpsert({ source_node_id: 'n-A' }, makeCtx()))
            .rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when neither source_node_id nor source_ref is provided', async () => {
        await expect(simulateMemoryLinkUpsert({
            links: [{ target_node_id: 'n-B', relation: 'knows' }],
        }, makeCtx())).rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when a link entry lacks both target_node_id and target_ref', async () => {
        await expect(simulateMemoryLinkUpsert({
            source_node_id: 'n-A',
            links: [{ relation: 'knows' }],
        }, makeCtx())).rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when a link entry lacks a relation', async () => {
        await expect(simulateMemoryLinkUpsert({
            source_node_id: 'n-A',
            links: [{ target_node_id: 'n-B' }],
        }, makeCtx())).rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when an endpoint id is missing from the live graph', async () => {
        const ctx = makeCtx({ nodes: [{ id: 'n-A' }] });
        await expect(simulateMemoryLinkUpsert({
            source_node_id: 'n-A',
            links: [{ target_node_id: 'n-Z', relation: 'knows' }],
        }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('returns simulated payload when both endpoints exist', async () => {
        const ctx = makeCtx({ nodes: [{ id: 'n-A' }, { id: 'n-B' }] });
        const result = await simulateMemoryLinkUpsert({
            source_node_id: 'n-A',
            links: [{ target_node_id: 'n-B', relation: 'knows' }],
        }, ctx);
        expect(result).toMatchObject({ ok: true, simulated: true });
        expect(result.applied).toBe(1);
    });

    test('returns simulated payload when no session is attached', async () => {
        const result = await simulateMemoryLinkUpsert({
            source_node_id: 'n-A',
            links: [{ target_node_id: 'n-B', relation: 'knows' }],
        }, { __memoryGraphSession: null });
        expect(result).toMatchObject({ ok: true, simulated: true });
        expect(result.applied).toBe(1);
    });

    test('skips feasibility check for same-call refs (target_ref)', async () => {
        // target_ref points at a sibling create in the same call — there is
        // no live-graph node to check, so simulate must not reject it.
        const ctx = makeCtx({ nodes: [{ id: 'n-A' }] });
        const result = await simulateMemoryLinkUpsert({
            source_node_id: 'n-A',
            links: [{ target_ref: 'ref-eileen', relation: 'knows' }],
        }, ctx);
        expect(result).toMatchObject({ ok: true, simulated: true });
    });
});

// ---------------------------------------------------------------------------
// simulateMemoryLinkDelete
// ---------------------------------------------------------------------------

describe('simulateMemoryLinkDelete', () => {
    test('rejects when source_node_id is missing', async () => {
        await expect(simulateMemoryLinkDelete({
            target_node_id: 'n-B',
            relation: 'knows',
        }, makeCtx())).rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when target_node_id is missing', async () => {
        await expect(simulateMemoryLinkDelete({
            source_node_id: 'n-A',
            relation: 'knows',
        }, makeCtx())).rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when relation is missing', async () => {
        await expect(simulateMemoryLinkDelete({
            source_node_id: 'n-A',
            target_node_id: 'n-B',
        }, makeCtx())).rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when source node does not exist on the real graph', async () => {
        const ctx = makeCtx({ nodes: [{ id: 'n-B' }] });
        await expect(simulateMemoryLinkDelete({
            source_node_id: 'n-Z',
            target_node_id: 'n-B',
            relation: 'knows',
        }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when target node does not exist on the real graph', async () => {
        const ctx = makeCtx({ nodes: [{ id: 'n-A' }] });
        await expect(simulateMemoryLinkDelete({
            source_node_id: 'n-A',
            target_node_id: 'n-Z',
            relation: 'knows',
        }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('returns simulated payload when both endpoints exist', async () => {
        const ctx = makeCtx({ nodes: [{ id: 'n-A' }, { id: 'n-B' }] });
        const result = await simulateMemoryLinkDelete({
            source_node_id: 'n-A',
            target_node_id: 'n-B',
            relation: 'knows',
        }, ctx);
        expect(result).toMatchObject({ ok: true, simulated: true });
        expect(typeof result.removed).toBe('number');
    });

    test('returns simulated payload when no session is attached', async () => {
        const result = await simulateMemoryLinkDelete({
            source_node_id: 'n-A',
            target_node_id: 'n-B',
            relation: 'knows',
        }, { __memoryGraphSession: null });
        expect(result).toMatchObject({ ok: true, simulated: true });
        expect(typeof result.removed).toBe('number');
    });
});

// ---------------------------------------------------------------------------
// simulateMemoryCompactNodes
// ---------------------------------------------------------------------------

describe('simulateMemoryCompactNodes', () => {
    test('rejects when type is missing', async () => {
        await expect(simulateMemoryCompactNodes({
            child_ids: ['n-A'],
            summary: 'rolled up',
        }, makeCtx())).rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when child_ids is missing or empty', async () => {
        await expect(simulateMemoryCompactNodes({
            type: 'event',
            child_ids: [],
            summary: 'rolled up',
        }, makeCtx())).rejects.toBeInstanceOf(ToolError);

        await expect(simulateMemoryCompactNodes({
            type: 'event',
            summary: 'rolled up',
        }, makeCtx())).rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when summary is missing', async () => {
        await expect(simulateMemoryCompactNodes({
            type: 'event',
            child_ids: ['n-A'],
        }, makeCtx())).rejects.toBeInstanceOf(ToolError);
    });

    test('rejects when any child node id is missing from the live graph', async () => {
        const ctx = makeCtx({ nodes: [{ id: 'n-A' }, { id: 'n-B' }] });
        await expect(simulateMemoryCompactNodes({
            type: 'event',
            child_ids: ['n-A', 'n-Z'],
            summary: 'rolled up',
        }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('returns simulated payload when all child nodes exist', async () => {
        const ctx = makeCtx({ nodes: [{ id: 'n-A' }, { id: 'n-B' }] });
        const result = await simulateMemoryCompactNodes({
            type: 'event',
            child_ids: ['n-A', 'n-B'],
            summary: 'rolled up',
        }, ctx);
        expect(result).toMatchObject({ ok: true, simulated: true });
        expect(typeof result.rollup_node_id).toBe('string');
        expect(result.rollup_node_id.length).toBeGreaterThan(0);
    });

    test('returns simulated payload when no session is attached', async () => {
        const result = await simulateMemoryCompactNodes({
            type: 'event',
            child_ids: ['n-A', 'n-B'],
            summary: 'rolled up',
        }, { __memoryGraphSession: null });
        expect(result).toMatchObject({ ok: true, simulated: true });
        expect(typeof result.rollup_node_id).toBe('string');
    });
});
