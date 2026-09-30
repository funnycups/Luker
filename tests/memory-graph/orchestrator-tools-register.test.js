import { describe, test, expect, beforeEach } from '@jest/globals';
import {
    registerMemoryGraphOrchestrationTools,
    unregisterMemoryGraphOrchestrationTools,
    MEMORY_TOOL_NAMES,
} from '../../public/scripts/extensions/memory-graph/orchestrator-tools.js';
import { __getExtensionRegistryForTest } from '../../public/scripts/extensions/orchestrator/register-custom-tool.js';

describe('memory-graph orchestrator tools', () => {
    beforeEach(async () => {
        __getExtensionRegistryForTest().clear();
        // The register implementation is async (it dynamically imports
        // the orchestrator API). Tests await register/unregister.
        await unregisterMemoryGraphOrchestrationTools();
    });

    test('exports the canonical list of 15 tool names', () => {
        expect(MEMORY_TOOL_NAMES).toHaveLength(15);
        expect(MEMORY_TOOL_NAMES).toEqual(expect.arrayContaining([
            'memory_list_candidates',
            'memory_edge_summary',
            'memory_node_brief',
            'memory_expand_seeds',
            'memory_schema',
            'memory_keyword_search',
            'memory_vector_search',
            'memory_find_by_name',
            'memory_compaction_candidates',
            'memory_node_create',
            'memory_node_edit',
            'memory_node_delete',
            'memory_link_upsert',
            'memory_link_delete',
            'memory_compact_nodes',
        ]));
    });

    test('register populates the orchestrator extension registry', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        for (const name of MEMORY_TOOL_NAMES) {
            expect(reg.has(name)).toBe(true);
        }
    });

    test('each registered entry has correct mode', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const readTools = [
            'memory_list_candidates', 'memory_edge_summary', 'memory_node_brief',
            'memory_expand_seeds', 'memory_schema', 'memory_keyword_search',
            'memory_vector_search', 'memory_find_by_name', 'memory_compaction_candidates',
        ];
        const writeTools = [
            'memory_node_create', 'memory_node_edit', 'memory_node_delete',
            'memory_link_upsert', 'memory_link_delete', 'memory_compact_nodes',
        ];
        for (const name of readTools) expect(reg.get(name)?.mode).toBe('read');
        for (const name of writeTools) expect(reg.get(name)?.mode).toBe('write');
    });

    test('write tools carry a simulate hook', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const writeTools = [
            'memory_node_create', 'memory_node_edit', 'memory_node_delete',
            'memory_link_upsert', 'memory_link_delete', 'memory_compact_nodes',
        ];
        for (const name of writeTools) {
            expect(typeof reg.get(name)?.simulate).toBe('function');
        }
    });

    test('unregister removes all 15', async () => {
        await registerMemoryGraphOrchestrationTools();
        await unregisterMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        for (const name of MEMORY_TOOL_NAMES) {
            expect(reg.has(name)).toBe(false);
        }
    });

    test('read exec runs without throwing when session is attached', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_list_candidates');
        expect(typeof entry?.exec).toBe('function');
        // Stub the session pre-cache via the WeakMap helper exported for tests.
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            listVisibleCandidates: () => [
                { id: 'n1', type: 'event', level: 'episodic', title: 'hi', seqTo: 1, semanticDepth: 0 },
            ],
        });
        const out = await entry.exec({}, ctx);
        expect(out.candidates[0].id).toBe('n1');
    });

    test('memory_link_upsert reports a duplicate link as a success noop', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 0 }),
            getNodeBrief: (id) => ({ id, level: 'semantic' }),
        });
        const out = await entry.exec({
            source_node_id: 'n1',
            links: [{ target_node_id: 'n2', relation: 'knows' }],
        }, ctx);
        expect(out).toEqual({ ok: true, applied: 0, changed: false, note: 'links already exist' });
    });

    test('memory_link_upsert rejects an empty links array', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 0 }),
            getNodeBrief: (id) => ({ id, level: 'semantic' }),
        });
        await expect(entry.exec({
            source_node_id: 'n1',
            links: [],
        }, ctx)).rejects.toMatchObject({
            name: 'ToolError',
            code: 'MEMORY_LINK_UPSERT_BAD_ARGS',
            message: expect.stringContaining('non-empty array'),
        });
    });

    test('memory_link_upsert rejects a self-link', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 0 }),
            getNodeBrief: (id) => ({ id, level: 'semantic' }),
        });
        await expect(entry.exec({
            source_node_id: 'n1',
            links: [{ target_node_id: 'n1', relation: 'knows' }],
        }, ctx)).rejects.toMatchObject({
            name: 'ToolError',
            code: 'MEMORY_LINK_UPSERT_BAD_ARGS',
            message: expect.stringContaining('self-link'),
        });
    });

    test('memory_link_upsert rejects a link without a relation', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 0 }),
            getNodeBrief: (id) => ({ id, level: 'semantic' }),
        });
        await expect(entry.exec({
            source_node_id: 'n1',
            links: [{ target_node_id: 'n2' }],
        }, ctx)).rejects.toMatchObject({
            name: 'ToolError',
            code: 'MEMORY_LINK_UPSERT_BAD_ARGS',
            message: expect.stringContaining('relation'),
        });
    });

    test('memory_link_upsert rejects an applied-0 result when the target cannot resolve', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 0 }),
            getNodeBrief: (id) => (id === 'n1' ? { id, level: 'semantic' } : null),
        });
        await expect(entry.exec({
            source_node_id: 'n1',
            links: [{ target_node_id: 'n-missing', relation: 'knows' }],
        }, ctx)).rejects.toMatchObject({
            name: 'ToolError',
            code: 'MEMORY_LINK_UPSERT_NODE_NOT_FOUND',
            message: expect.stringContaining('does not exist'),
        });
    });

    test('memory_link_upsert refuses a non-semantic target endpoint', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 0 }),
            getNodeBrief: (id) => ({ id, level: id === 'n2' ? 'episodic' : 'semantic' }),
        });
        await expect(entry.exec({
            source_node_id: 'n1',
            links: [{ target_node_id: 'n2', relation: 'knows' }],
        }, ctx)).rejects.toMatchObject({
            name: 'ToolError',
            code: 'MEMORY_LINK_UPSERT_NODE_NOT_FOUND',
            message: expect.stringContaining('episodic'),
        });
    });

    test('memory_link_upsert refuses a non-semantic source endpoint', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 0 }),
            getNodeBrief: (id) => ({ id, level: id === 'n1' ? 'episodic' : 'semantic' }),
        });
        await expect(entry.exec({
            source_node_id: 'n1',
            links: [{ target_node_id: 'n2', relation: 'knows' }],
        }, ctx)).rejects.toMatchObject({
            name: 'ToolError',
            code: 'MEMORY_LINK_UPSERT_NODE_NOT_FOUND',
            message: expect.stringContaining('episodic'),
        });
    });

    test('memory_link_upsert rejects an applied-0 result when only source_ref is given', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 0 }),
            getNodeBrief: (id) => ({ id, level: 'semantic' }),
        });
        await expect(entry.exec({
            source_ref: 'ref-1',
            links: [{ target_node_id: 'n2', relation: 'knows' }],
        }, ctx)).rejects.toMatchObject({
            name: 'ToolError',
            code: 'MEMORY_LINK_UPSERT_SOURCE_UNRESOLVED',
            message: expect.stringContaining('source_ref'),
        });
    });

    test('memory_link_upsert rejects an applied-0 result when only target_ref is given', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 0 }),
            getNodeBrief: (id) => ({ id, level: 'semantic' }),
        });
        await expect(entry.exec({
            source_node_id: 'n1',
            links: [{ target_ref: 'ref-2', relation: 'knows' }],
        }, ctx)).rejects.toMatchObject({
            name: 'ToolError',
            code: 'MEMORY_LINK_UPSERT_TARGET_UNRESOLVED',
            message: expect.stringContaining('target_ref'),
        });
    });

    test('memory_link_upsert surfaces a rejected edge as failure', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        const error = { code: 'X', message: 'Y' };
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 0, error }),
            getNodeBrief: (id) => ({ id, level: 'semantic' }),
        });
        const out = await entry.exec({
            source_node_id: 'n1',
            links: [{ target_node_id: 'n2', relation: 'knows' }],
        }, ctx);
        expect(out).toEqual({ ok: false, applied: 0, error });
    });

    test('memory_link_upsert schema advertises only node-id endpoints', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const params = reg.get('memory_link_upsert')?.schema?.function?.parameters;
        expect(params).toBeTruthy();
        expect(params.properties.source_node_id).toBeDefined();
        expect(params.properties.source_ref).toBeUndefined();
        expect(params.required).toEqual(expect.arrayContaining(['source_node_id', 'links']));
        const linkItem = params.properties.links.items;
        expect(linkItem.properties.target_node_id).toBeDefined();
        expect(linkItem.properties.target_ref).toBeUndefined();
        expect(linkItem.additionalProperties).toBe(false);
    });

    test('memory_link_upsert simulate rejects a source_ref-only payload like exec', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 1 }),
            getNodeBrief: (id) => ({ id, level: 'semantic' }),
        });
        await expect(entry.simulate({
            source_ref: 'ref-1',
            links: [{ target_node_id: 'n2', relation: 'knows' }],
        }, ctx)).rejects.toMatchObject({
            name: 'ToolError',
            code: 'MEMORY_LINK_UPSERT_SOURCE_UNRESOLVED',
            message: expect.stringContaining('source_ref'),
        });
    });

    test('memory_link_upsert simulate rejects a target_ref-only payload like exec', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 1 }),
            getNodeBrief: (id) => ({ id, level: 'semantic' }),
        });
        await expect(entry.simulate({
            source_node_id: 'n1',
            links: [{ target_ref: 'ref-2', relation: 'knows' }],
        }, ctx)).rejects.toMatchObject({
            name: 'ToolError',
            code: 'MEMORY_LINK_UPSERT_TARGET_UNRESOLVED',
            message: expect.stringContaining('target_ref'),
        });
    });

    test('memory_link_upsert simulate rejects a self-link like exec', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 1 }),
            getNodeBrief: (id) => ({ id, level: 'semantic' }),
        });
        await expect(entry.simulate({
            source_node_id: 'n1',
            links: [{ target_node_id: 'n1', relation: 'knows' }],
        }, ctx)).rejects.toMatchObject({
            name: 'ToolError',
            code: 'MEMORY_LINK_UPSERT_BAD_ARGS',
            message: expect.stringContaining('self-link'),
        });
    });

    test('memory_link_upsert simulate reports the link count for resolvable endpoints', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 1 }),
            getNodeBrief: (id) => ({ id, level: 'semantic' }),
        });
        const out = await entry.simulate({
            source_node_id: 'n1',
            links: [{ target_node_id: 'n2', relation: 'knows' }],
        }, ctx);
        expect(out).toEqual({ ok: true, simulated: true, applied: 1 });
    });

    test('memory_link_upsert reports the applied edge count', async () => {
        await registerMemoryGraphOrchestrationTools();
        const reg = __getExtensionRegistryForTest();
        const entry = reg.get('memory_link_upsert');
        const ctx = {};
        const { __setSessionForTest } = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        __setSessionForTest(ctx, {
            upsertLinks: async () => ({ applied: 2 }),
            getNodeBrief: (id) => ({ id, level: 'semantic' }),
        });
        const out = await entry.exec({
            source_node_id: 'n1',
            links: [{ target_node_id: 'n2', relation: 'knows' }],
        }, ctx);
        expect(out).toEqual({ ok: true, applied: 2 });
    });
});
