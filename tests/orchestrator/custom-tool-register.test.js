// tests/orchestrator/custom-tool-register.test.js
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    registerOrchestrationTool,
    unregisterOrchestrationTool,
    listExtensionTools,
    __getExtensionRegistryForTest,
} from '../../public/scripts/extensions/orchestrator/register-custom-tool.js';
import { executeLoopTool, beginSimulation, endSimulation } from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import { getEnabledToolSchemas } from '../../public/scripts/extensions/orchestrator/loop-tools.js';

describe('registerOrchestrationTool basic registry', () => {
    beforeEach(() => {
        __getExtensionRegistryForTest().clear();
    });

    test('registers a read tool with full spec', () => {
        const exec = async () => ({ ok: true });
        registerOrchestrationTool({
            name: 'demo_read',
            description: 'demo',
            parameters: { type: 'object', properties: {} },
            exec,
            mode: 'read',
        });
        const entry = __getExtensionRegistryForTest().get('demo_read');
        expect(entry).toBeTruthy();
        expect(entry.mode).toBe('read');
        expect(entry.exec).toBe(exec);
        expect(entry.simulate).toBeNull();
        expect(entry.source).toBe('extension');
        expect(entry.schema.function.name).toBe('demo_read');
        expect(entry.schema.function.description).toBe('demo');
    });

    test('registers a write tool with simulate', () => {
        const simulate = async () => ({ ok: true, simulated: true });
        registerOrchestrationTool({
            name: 'demo_write',
            description: 'd',
            parameters: { type: 'object' },
            exec: async () => ({}),
            mode: 'write',
            simulate,
        });
        const entry = __getExtensionRegistryForTest().get('demo_write');
        expect(entry.mode).toBe('write');
        expect(entry.simulate).toBe(simulate);
    });

    test('unregister removes the entry', () => {
        registerOrchestrationTool({
            name: 'demo_x', description: 'd', parameters: {}, exec: async () => ({}), mode: 'read',
        });
        unregisterOrchestrationTool('demo_x');
        expect(__getExtensionRegistryForTest().get('demo_x')).toBeUndefined();
    });

    test('listExtensionTools returns shallow copies', () => {
        registerOrchestrationTool({
            name: 'demo_a', description: 'a', parameters: {}, exec: async () => ({}), mode: 'read',
        });
        const list = listExtensionTools();
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('demo_a');
        expect(list[0].mode).toBe('read');
    });

    test('rejects names that collide with Layer-1 builtins', () => {
        expect(() => registerOrchestrationTool({
            name: 'chat_read_range',
            description: 'rogue', parameters: {},
            exec: async () => ({}), mode: 'read',
        })).toThrow(/builtin|reserved|conflict/i);
    });
});

describe('executeLoopTool Layer-2 dispatch', () => {
    beforeEach(() => { __getExtensionRegistryForTest().clear(); });
    afterEach(() => { endSimulation(); });

    test('dispatches an extension read tool', async () => {
        registerOrchestrationTool({
            name: 'demo_read', description: 'd', parameters: {},
            exec: async (args, _ctx) => ({ echo: args.value }),
            mode: 'read',
        });
        const result = await executeLoopTool('demo_read', { value: 42 }, {});
        expect(result).toEqual({ echo: 42 });
    });

    test('extension write tool in sim returns simulate output when present', async () => {
        registerOrchestrationTool({
            name: 'demo_write', description: 'd', parameters: {},
            exec: async () => { throw new Error('should not run'); },
            mode: 'write',
            simulate: async (args) => ({ ok: true, simulated: true, args }),
        });
        beginSimulation('run-x');
        const result = await executeLoopTool('demo_write', { v: 1 }, {});
        expect(result).toEqual({ ok: true, simulated: true, args: { v: 1 } });
    });

    test('extension write tool in sim returns unvalidated noop when no simulate', async () => {
        registerOrchestrationTool({
            name: 'demo_write_no_sim', description: 'd', parameters: {},
            exec: async () => { throw new Error('should not run'); },
            mode: 'write',
        });
        beginSimulation('run-y');
        const result = await executeLoopTool('demo_write_no_sim', {}, {});
        expect(result).toEqual({ ok: true, simulated: true, unvalidated: true });
    });
});

describe('getEnabledToolSchemas Layer-2 merge', () => {
    beforeEach(() => { __getExtensionRegistryForTest().clear(); });

    test('includes extension tools when flag is missing (default-on)', () => {
        registerOrchestrationTool({
            name: 'ext_a', description: 'a', parameters: {},
            exec: async () => ({}), mode: 'read',
        });
        const schemas = getEnabledToolSchemas({ tools: { custom: {} } }, null);
        expect(schemas.map(s => s.function?.name)).toContain('ext_a');
    });

    test('respects explicit disable in profile.tools.custom', () => {
        registerOrchestrationTool({
            name: 'ext_b', description: 'b', parameters: {},
            exec: async () => ({}), mode: 'read',
        });
        const schemas = getEnabledToolSchemas({ tools: { custom: { ext_b: false } } }, null);
        expect(schemas.map(s => s.function?.name)).not.toContain('ext_b');
    });

    test('Layer-1 builtin schemas still surface', () => {
        const schemas = getEnabledToolSchemas({ tools: { chat: { read_range: true, search: true } } }, null);
        const names = schemas.map(s => s.function?.name);
        expect(names).toContain('chat_read_range');
        expect(names).toContain('chat_search');
        expect(names).toContain('finalize');
    });
});
