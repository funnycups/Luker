// tests/orchestrator/tool-call-source-tagging.test.js
//
// Integration tests for FINAL.1 — tool_call trace entries carry a `source`
// field set by the runtime (one of: builtin / extension / profile /
// st-bridge / unknown). The simulation-review popup reads this off the
// trace and renders a layer chip; we lock in the runtime side here.

import { describe, test, expect, beforeEach } from '@jest/globals';
import { runLoopOrchestration } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';
import {
    registerOrchestrationTool,
    __getExtensionRegistryForTest,
} from '../../public/scripts/extensions/orchestrator/register-custom-tool.js';
import { exportLoopPayload } from '../../public/scripts/extensions/orchestrator/simulation-payload-adapter.js';

function makeProfile(customTools = [], overrides = {}) {
    return {
        mode: 'loop',
        apiPresetName: '',
        promptPresetName: '',
        system_prompt: 'sys',
        tools: {
            chat: { read_range: true, search: false },
            lorebook: { search: false, get: false },
            note: { open: false, close: false },
            custom: {},
            finalize: true,
        },
        max_rounds: 5,
        wall_clock_budget_ms: 60000,
        customTools,
        capsule_inject: { position: 'atDepth', depth: 0, role: 'system', customInstruction: '' },
        ...overrides,
    };
}

describe('loop-runtime tags tool_call trace entries with source', () => {
    beforeEach(() => { __getExtensionRegistryForTest().clear(); });

    test('builtin tool produces source=builtin on the tool_call event AND on the messages tool_calls entry', async () => {
        const sendLlm = async (opts) => {
            if (opts.round === 1) {
                return {
                    toolCalls: [{ id: 'tc1', name: 'chat_read_range', args: { start: 0, end: 0 } }],
                    assistantText: '',
                    reasoning: '',
                };
            }
            return { toolCalls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'done' } }], assistantText: '', reasoning: '' };
        };
        const result = await runLoopOrchestration({ chat: [{ mes: 'hi', is_user: false, send_date: '' }] }, {}, makeProfile(), { sendLlm });

        const toolCallEvents = result.runtimeTrace.events.filter(e => e.type === 'tool_call');
        // First tool call is chat_read_range; second is finalize.
        const builtinCall = toolCallEvents.find(e => e.name === 'chat_read_range');
        expect(builtinCall).toBeTruthy();
        expect(builtinCall.source).toBe('builtin');

        // finalize is also a builtin (well, it's a reserved name; resolveToolSource
        // returns 'unknown' for finalize since it doesn't live in any
        // registry — the runtime intercepts it ahead of dispatch).
        const finalizeCall = toolCallEvents.find(e => e.name === 'finalize');
        expect(finalizeCall).toBeTruthy();
        expect(finalizeCall.source).toBe('unknown');

        // The messages array's assistant tool_calls entries must also
        // carry source so the simulation-review popup can render the chip
        // even when no per-event lookup is done.
        const messages = result.runtimeTrace.loop?.conversation?.messages || [];
        const firstAssistant = messages.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
        expect(firstAssistant).toBeTruthy();
        expect(firstAssistant.tool_calls[0].source).toBe('builtin');
    });

    test('Layer-3 profile tool produces source=profile', async () => {
        const sendLlm = async (opts) => {
            if (opts.round === 1) {
                return {
                    toolCalls: [{ id: 'tc1', name: 'my_weather', args: { city: 'NYC' } }],
                    assistantText: '',
                    reasoning: '',
                };
            }
            return { toolCalls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'done' } }], assistantText: '', reasoning: '' };
        };
        const profile = makeProfile([
            { name: 'my_weather', description: 'd', parameters: {}, mode: 'read', body: 'return { temp: 70 };', simulateBody: '' },
        ]);
        const result = await runLoopOrchestration({}, {}, profile, { sendLlm });

        const toolCallEvents = result.runtimeTrace.events.filter(e => e.type === 'tool_call');
        const profileCall = toolCallEvents.find(e => e.name === 'my_weather');
        expect(profileCall).toBeTruthy();
        expect(profileCall.source).toBe('profile');

        const messages = result.runtimeTrace.loop?.conversation?.messages || [];
        const firstAssistant = messages.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
        expect(firstAssistant.tool_calls[0].source).toBe('profile');
    });

    test('Layer-2 extension tool produces source=extension', async () => {
        registerOrchestrationTool({
            name: 'demo_ext_tool', description: 'd', parameters: {},
            exec: async () => ({ ok: true }), mode: 'read',
        });
        const sendLlm = async (opts) => {
            if (opts.round === 1) {
                return {
                    toolCalls: [{ id: 'tc1', name: 'demo_ext_tool', args: {} }],
                    assistantText: '',
                    reasoning: '',
                };
            }
            return { toolCalls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'done' } }], assistantText: '', reasoning: '' };
        };
        const result = await runLoopOrchestration({}, {}, makeProfile(), { sendLlm });

        const toolCallEvents = result.runtimeTrace.events.filter(e => e.type === 'tool_call');
        const extCall = toolCallEvents.find(e => e.name === 'demo_ext_tool');
        expect(extCall).toBeTruthy();
        expect(extCall.source).toBe('extension');
    });

    test('Layer-2 ST-bridged tool produces source=st-bridge', async () => {
        // Inject a synthetic bridged entry directly (bypassing the lazy
        // ToolManager import in bridgeSillyTavernTool).
        __getExtensionRegistryForTest().set('st_demo_st_tool', {
            exec: async () => ({ ok: true }),
            simulate: null,
            mode: 'read',
            source: 'st-bridge',
            displayName: 'Demo ST',
            schema: { type: 'function', function: { name: 'st_demo_st_tool', description: 'd', parameters: {} } },
        });
        const sendLlm = async (opts) => {
            if (opts.round === 1) {
                return {
                    toolCalls: [{ id: 'tc1', name: 'st_demo_st_tool', args: {} }],
                    assistantText: '',
                    reasoning: '',
                };
            }
            return { toolCalls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'done' } }], assistantText: '', reasoning: '' };
        };
        const result = await runLoopOrchestration({}, {}, makeProfile(), { sendLlm });

        const toolCallEvents = result.runtimeTrace.events.filter(e => e.type === 'tool_call');
        const stCall = toolCallEvents.find(e => e.name === 'st_demo_st_tool');
        expect(stCall).toBeTruthy();
        expect(stCall.source).toBe('st-bridge');
    });
});

describe('simulation-payload-adapter forwards source to renderers', () => {
    beforeEach(() => { __getExtensionRegistryForTest().clear(); });

    test('exportLoopPayload preserves source on each tool call', async () => {
        const sendLlm = async (opts) => {
            if (opts.round === 1) {
                return {
                    toolCalls: [{ id: 'tc1', name: 'my_weather', args: {} }],
                    assistantText: '',
                    reasoning: '',
                };
            }
            return { toolCalls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'done' } }], assistantText: '', reasoning: '' };
        };
        const profile = makeProfile([
            { name: 'my_weather', description: 'd', parameters: {}, mode: 'read', body: 'return {};', simulateBody: '' },
        ]);
        const result = await runLoopOrchestration({}, {}, profile, { sendLlm });
        const payload = exportLoopPayload(result.runtimeTrace);

        expect(payload.rounds.length).toBeGreaterThan(0);
        const allCalls = payload.rounds.flatMap(r => r.toolCalls);
        const weatherCall = allCalls.find(c => c.name === 'my_weather');
        expect(weatherCall).toBeTruthy();
        expect(weatherCall.source).toBe('profile');
    });
});
