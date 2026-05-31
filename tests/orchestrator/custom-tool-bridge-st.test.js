// tests/orchestrator/custom-tool-bridge-st.test.js
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockTools = [
    { name: 'GenerateImage', description: 'SD', parameters: { type: 'object', properties: { prompt: { type: 'string' } } } },
    { name: 'WebSearch', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
];
const mockInvoke = jest.fn(async (name, params) => JSON.stringify({ called: name, params }));

jest.unstable_mockModule('../../public/scripts/tool-calling.js', () => ({
    ToolManager: {
        get tools() { return mockTools; },
        invokeFunctionTool: mockInvoke,
    },
}));

const {
    bridgeSillyTavernTool,
    unbridgeSillyTavernTool,
    listAvailableSillyTavernTools,
    rehydrateBridgedSillyTavernTools,
    __getExtensionRegistryForTest,
} = await import('../../public/scripts/extensions/orchestrator/register-custom-tool.js');
const { executeLoopTool } = await import('../../public/scripts/extensions/orchestrator/loop-tools.js');

describe('ST bridge', () => {
    beforeEach(() => {
        __getExtensionRegistryForTest().clear();
        mockInvoke.mockClear();
    });

    test('bridges a ST tool with st_ prefix', async () => {
        await bridgeSillyTavernTool('GenerateImage', { mode: 'write' });
        const entry = __getExtensionRegistryForTest().get('st_GenerateImage');
        expect(entry).toBeTruthy();
        expect(entry.mode).toBe('write');
        expect(entry.schema.function.name).toBe('st_GenerateImage');
        expect(entry.schema.function.description).toBe('SD');
    });

    test('default mode is write', async () => {
        await bridgeSillyTavernTool('WebSearch');
        expect(__getExtensionRegistryForTest().get('st_WebSearch').mode).toBe('write');
    });

    test('exec proxies to ToolManager.invokeFunctionTool', async () => {
        await bridgeSillyTavernTool('GenerateImage', { mode: 'write' });
        const result = await executeLoopTool('st_GenerateImage', { prompt: 'a cat' }, {});
        expect(mockInvoke).toHaveBeenCalledWith('GenerateImage', { prompt: 'a cat' });
        const parsed = JSON.parse(result);
        expect(parsed.called).toBe('GenerateImage');
    });

    test('unbridge removes the entry', async () => {
        await bridgeSillyTavernTool('GenerateImage');
        unbridgeSillyTavernTool('GenerateImage');
        expect(__getExtensionRegistryForTest().get('st_GenerateImage')).toBeUndefined();
    });

    test('bridging an unknown ST tool throws', async () => {
        await expect(bridgeSillyTavernTool('DoesNotExist')).rejects.toThrow(/not found/i);
    });

    test('listAvailableSillyTavernTools excludes already-bridged', async () => {
        await bridgeSillyTavernTool('GenerateImage');
        const available = await listAvailableSillyTavernTools();
        const names = available.map(t => t.name);
        expect(names).not.toContain('GenerateImage');
        expect(names).toContain('WebSearch');
    });
});

describe('ST bridge rehydration', () => {
    beforeEach(() => { __getExtensionRegistryForTest().clear(); });

    test('replays settings.bridgedSillyTavernTools[] into the registry', async () => {
        await rehydrateBridgedSillyTavernTools({
            bridgedSillyTavernTools: [
                { name: 'GenerateImage', mode: 'write' },
                { name: 'WebSearch', mode: 'read' },
            ],
        });
        expect(__getExtensionRegistryForTest().get('st_GenerateImage')?.mode).toBe('write');
        expect(__getExtensionRegistryForTest().get('st_WebSearch')?.mode).toBe('read');
    });

    test('skips entries whose ST tool is no longer registered', async () => {
        await rehydrateBridgedSillyTavernTools({
            bridgedSillyTavernTools: [
                { name: 'GenerateImage', mode: 'write' },
                { name: 'GhostTool', mode: 'read' },
            ],
        });
        expect(__getExtensionRegistryForTest().get('st_GenerateImage')).toBeTruthy();
        expect(__getExtensionRegistryForTest().get('st_GhostTool')).toBeUndefined();
    });

    test('missing settings field is a no-op', async () => {
        await rehydrateBridgedSillyTavernTools({});
        await rehydrateBridgedSillyTavernTools(null);
        expect(__getExtensionRegistryForTest().size).toBe(0);
    });
});
