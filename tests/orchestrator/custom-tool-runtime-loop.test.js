// tests/orchestrator/custom-tool-runtime-loop.test.js
import { describe, test, expect, beforeEach } from '@jest/globals';
import { runLoopOrchestration } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';
import { __getExtensionRegistryForTest } from '../../public/scripts/extensions/orchestrator/register-custom-tool.js';

function makeProfile(customTools) {
    return {
        mode: 'loop',
        apiPresetName: '',
        promptPresetName: '',
        system_prompt: 'sys',
        tools: { custom: {}, finalize: true },
        max_rounds: 3,
        wall_clock_budget_ms: 60000,
        customTools,
        capsule_inject: { position: 'atDepth', depth: 0, role: 'system', customInstruction: '' },
    };
}

describe('loop runtime Layer-3 dispatch', () => {
    beforeEach(() => { __getExtensionRegistryForTest().clear(); });

    test('Layer-3 profile tool surfaces in the LLM tool list', async () => {
        const sentTools = [];
        const sendLlm = async (opts) => {
            sentTools.push(opts.tools);
            // Pretend the model called finalize on round 1.
            return { toolCalls: [{ name: 'finalize', args: { capsule_text: 'ok' } }], assistantText: '', reasoning: '' };
        };
        const profile = makeProfile([
            { name: 'my_weather', description: 'weather', parameters: {}, mode: 'read', body: 'return 1;', simulateBody: '' },
        ]);
        await runLoopOrchestration({}, {}, profile, { sendLlm });
        const names = sentTools[0].map(s => s.function?.name);
        expect(names).toContain('my_weather');
    });

    test('Layer-3 tool is invoked via the per-run registry, not Layer-1/2', async () => {
        const sendLlm = async (opts) => {
            // First round: model calls the custom tool. Second: finalize.
            if (opts.round === 1) {
                return { toolCalls: [{ name: 'my_tool', args: { v: 9 } }], assistantText: '', reasoning: '' };
            }
            return { toolCalls: [{ name: 'finalize', args: { capsule_text: 'done' } }], assistantText: '', reasoning: '' };
        };
        const profile = makeProfile([
            { name: 'my_tool', description: 'd', parameters: {}, mode: 'read',
              body: 'globalThis.__test_exec_called = true; return { value: args.v * 2 };',
              simulateBody: '' },
        ]);
        delete globalThis.__test_exec_called;
        await runLoopOrchestration({}, {}, profile, { sendLlm });
        expect(globalThis.__test_exec_called).toBe(true);
        delete globalThis.__test_exec_called;
    });

    test('Layer-3 tool name overrides Layer-2 when both registered', async () => {
        // Layer-2 entry that records via a shared object.
        const layer2Trace = { calls: [] };
        const { registerOrchestrationTool } = await import('../../public/scripts/extensions/orchestrator/register-custom-tool.js');
        registerOrchestrationTool({
            name: 'dup_tool', description: 'd', parameters: {}, mode: 'read',
            exec: async () => { layer2Trace.calls.push('layer2'); return { from: 'layer2' }; },
        });
        const sendLlm = async (opts) => {
            if (opts.round === 1) return { toolCalls: [{ name: 'dup_tool', args: {} }], assistantText: '', reasoning: '' };
            return { toolCalls: [{ name: 'finalize', args: { capsule_text: 'x' } }], assistantText: '', reasoning: '' };
        };
        const profile = makeProfile([
            { name: 'dup_tool', description: 'd', parameters: {}, mode: 'read',
              body: 'globalThis.__test_layer3_called = true; return { from: "layer3" };', simulateBody: '' },
        ]);
        delete globalThis.__test_layer3_called;
        await runLoopOrchestration({}, {}, profile, { sendLlm });
        expect(globalThis.__test_layer3_called).toBe(true);
        expect(layer2Trace.calls).toEqual([]);
        delete globalThis.__test_layer3_called;
    });
});
