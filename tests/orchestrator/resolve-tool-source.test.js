// tests/orchestrator/resolve-tool-source.test.js
//
// Unit tests for `resolveToolSource(name, ctx)` in loop-tools.js. The helper
// mirrors `executeLoopTool`'s dispatch precedence (Layer-3 → Layer-1 → Layer-2)
// so the source label reflects the registry that would actually serve the
// dispatch. Runtimes use it to tag tool_call trace entries; the
// simulation-review popup then renders a layer chip.

import { describe, test, expect, beforeEach } from '@jest/globals';
import { resolveToolSource } from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import {
    registerOrchestrationTool,
    __getExtensionRegistryForTest,
} from '../../public/scripts/extensions/orchestrator/register-custom-tool.js';

describe('resolveToolSource', () => {
    beforeEach(() => {
        __getExtensionRegistryForTest().clear();
    });

    test("returns 'builtin' for a Layer-1 builtin name (no ctx)", () => {
        // chat_read_range is registered at module load by loop-tools.js.
        expect(resolveToolSource('chat_read_range', {})).toBe('builtin');
        expect(resolveToolSource('chat_read_range', null)).toBe('builtin');
    });

    test("returns 'profile' when ctx.__customToolRegistry has the name", () => {
        const perRunReg = new Map();
        perRunReg.set('echo', {
            exec: async () => ({}),
            mode: 'read',
            source: 'profile',
            schema: { type: 'function', function: { name: 'echo' } },
        });
        const ctx = { __customToolRegistry: perRunReg };
        expect(resolveToolSource('echo', ctx)).toBe('profile');
    });

    test("returns 'extension' for a Layer-2 extension-registered tool", () => {
        registerOrchestrationTool({
            name: 'demo_ext', description: 'd', parameters: {},
            exec: async () => ({}), mode: 'read',
        });
        expect(resolveToolSource('demo_ext', {})).toBe('extension');
    });

    test("returns 'st-bridge' for a Layer-2 entry with source='st-bridge'", () => {
        // Inject a synthetic bridged entry without going through bridgeSillyTavernTool
        // (which would lazy-import ToolManager). The registry shape is the
        // contract; source resolution checks `entry.source === 'st-bridge'`.
        __getExtensionRegistryForTest().set('st_read_world_info', {
            exec: async () => ({}),
            simulate: null,
            mode: 'read',
            source: 'st-bridge',
            displayName: 'Read World Info',
            schema: { type: 'function', function: { name: 'st_read_world_info' } },
        });
        expect(resolveToolSource('st_read_world_info', {})).toBe('st-bridge');
    });

    test("returns 'unknown' for an unregistered name", () => {
        expect(resolveToolSource('nope_not_a_tool', {})).toBe('unknown');
        expect(resolveToolSource('', {})).toBe('unknown');
    });

    test("Layer-3 wins over Layer-1 (matches executeLoopTool precedence)", () => {
        const perRunReg = new Map();
        perRunReg.set('chat_read_range', {
            exec: async () => ({}),
            mode: 'read',
            source: 'profile',
            schema: { type: 'function', function: { name: 'chat_read_range' } },
        });
        expect(resolveToolSource('chat_read_range', { __customToolRegistry: perRunReg })).toBe('profile');
    });

    test("Layer-1 wins over Layer-2 (matches executeLoopTool precedence)", () => {
        // Forcefully insert a colliding extension entry under a builtin
        // name to assert the lookup order (registerOrchestrationTool would
        // reject this at runtime — we're directly probing precedence).
        __getExtensionRegistryForTest().set('chat_read_range', {
            exec: async () => ({}),
            simulate: null,
            mode: 'read',
            source: 'extension',
            displayName: '',
            schema: { type: 'function', function: { name: 'chat_read_range' } },
        });
        expect(resolveToolSource('chat_read_range', {})).toBe('builtin');
    });

    test('normalizes dotted legacy names to underscore form before lookup', () => {
        // pre-rename traces used `chat.read_range`; runtime normalizes the
        // input via `.replace(/\./g, '_')` before walking the registries.
        expect(resolveToolSource('chat.read_range', {})).toBe('builtin');
    });

    test('tolerates a non-Map __customToolRegistry without throwing', () => {
        // Defensive — a malformed ctx (e.g. plain object instead of Map)
        // must not crash the resolver. Lookup falls through to subsequent
        // layers.
        expect(resolveToolSource('chat_read_range', { __customToolRegistry: {} })).toBe('builtin');
        expect(resolveToolSource('nope', { __customToolRegistry: null })).toBe('unknown');
    });
});
