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
});
