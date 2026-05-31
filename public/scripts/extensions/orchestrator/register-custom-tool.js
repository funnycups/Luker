// public/scripts/extensions/orchestrator/register-custom-tool.js
/**
 * Three-layer API exposure contract:
 *   Layer 1: direct ES module import from this file.
 *   Layer 2: getExtensionApi('orchestrator').registerOrchestrationTool(...)
 *   Layer 3: ctx.getExtensionApi('orchestrator').registerOrchestrationTool(...)
 *            (where ctx is the SillyTavern context returned by getContext()).
 * All three resolve to identical references.
 */
import { getBuiltinToolRegistry } from './loop-tools.js';

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

const EXTENSION_REGISTRY = new Map();

function validateSpec(spec) {
    if (!spec || typeof spec !== 'object') {
        throw new TypeError('registerOrchestrationTool: spec must be an object.');
    }
    const name = String(spec.name || '');
    if (!NAME_PATTERN.test(name)) {
        throw new Error(`registerOrchestrationTool: invalid name '${name}'.`);
    }
    if (typeof spec.exec !== 'function') {
        throw new TypeError(`registerOrchestrationTool: spec.exec must be a function (tool '${name}').`);
    }
    if (spec.mode !== 'read' && spec.mode !== 'write') {
        throw new TypeError(`registerOrchestrationTool: spec.mode must be 'read' or 'write' (tool '${name}').`);
    }
    if (spec.simulate != null && typeof spec.simulate !== 'function') {
        throw new TypeError(`registerOrchestrationTool: spec.simulate must be a function or omitted (tool '${name}').`);
    }
}

export function registerOrchestrationTool(spec) {
    validateSpec(spec);
    const name = String(spec.name);
    const builtin = getBuiltinToolRegistry();
    if (builtin.has(name)) {
        throw new Error(`registerOrchestrationTool: name '${name}' conflicts with a builtin tool. Pick a different name.`);
    }
    if (EXTENSION_REGISTRY.has(name)) {
        console.warn(`[orchestrator] registerOrchestrationTool: overwriting existing extension tool '${name}'.`);
    }
    EXTENSION_REGISTRY.set(name, {
        exec: spec.exec,
        simulate: typeof spec.simulate === 'function' ? spec.simulate : null,
        mode: spec.mode,
        source: 'extension',
        displayName: String(spec.displayName || ''),
        schema: {
            type: 'function',
            function: {
                name,
                description: String(spec.description || ''),
                parameters: spec.parameters && typeof spec.parameters === 'object'
                    ? spec.parameters
                    : { type: 'object' },
            },
        },
    });
}

export function unregisterOrchestrationTool(name) {
    EXTENSION_REGISTRY.delete(String(name || ''));
}

export function listExtensionTools() {
    const out = [];
    for (const [name, entry] of EXTENSION_REGISTRY) {
        out.push({
            name,
            mode: entry.mode,
            description: entry.schema.function.description,
            displayName: entry.displayName,
            hasSimulate: typeof entry.simulate === 'function',
            source: entry.source,
        });
    }
    return out;
}

const ST_BRIDGE_PREFIX = 'st_';

let _cachedToolManager = null;
async function loadToolManager() {
    if (!_cachedToolManager) {
        _cachedToolManager = import('../../tool-calling.js').then(m => m.ToolManager);
    }
    return _cachedToolManager;
}

export async function bridgeSillyTavernTool(stToolName, opts = {}) {
    const mode = opts.mode === 'read' ? 'read' : 'write';
    const ToolManager = await loadToolManager();
    const all = Array.isArray(ToolManager?.tools) ? ToolManager.tools : [];
    const stTool = all.find(t => t.name === stToolName);
    if (!stTool) {
        throw new Error(`bridgeSillyTavernTool: ST tool '${stToolName}' not found in ToolManager.`);
    }
    const bridgedName = `${ST_BRIDGE_PREFIX}${stToolName}`;
    const exec = async (args, _ctx) => ToolManager.invokeFunctionTool(stToolName, args);
    if (EXTENSION_REGISTRY.has(bridgedName)) {
        console.warn(`[orchestrator] re-bridging ST tool '${stToolName}'.`);
    }
    EXTENSION_REGISTRY.set(bridgedName, {
        exec,
        simulate: null,
        mode,
        source: 'st-bridge',
        displayName: String(stTool.displayName || stToolName),
        schema: {
            type: 'function',
            function: {
                name: bridgedName,
                description: String(stTool.description || ''),
                parameters: stTool.parameters && typeof stTool.parameters === 'object'
                    ? stTool.parameters
                    : { type: 'object' },
            },
        },
    });
}

export function unbridgeSillyTavernTool(stToolName) {
    EXTENSION_REGISTRY.delete(`${ST_BRIDGE_PREFIX}${stToolName}`);
}

export async function listAvailableSillyTavernTools() {
    const ToolManager = await loadToolManager();
    const all = Array.isArray(ToolManager?.tools) ? ToolManager.tools : [];
    return all
        .filter(t => !EXTENSION_REGISTRY.has(`${ST_BRIDGE_PREFIX}${t.name}`))
        .map(t => ({
            name: t.name,
            displayName: String(t.displayName || t.name),
            description: String(t.description || ''),
        }));
}

export async function rehydrateBridgedSillyTavernTools(settings) {
    const list = Array.isArray(settings?.bridgedSillyTavernTools)
        ? settings.bridgedSillyTavernTools
        : [];
    if (list.length === 0) return;
    for (const entry of list) {
        const name = String(entry?.name || '');
        const mode = entry?.mode === 'read' ? 'read' : 'write';
        if (!name) continue;
        try {
            await bridgeSillyTavernTool(name, { mode });
        } catch (err) {
            console.info(`[orchestrator] ST tool '${name}' missing at bridge rehydrate:`, err?.message || err);
        }
    }
}

/** Returns the live Layer-2 registry. Used both at runtime (Layer-2 dispatch
 *  and schema merge) and by tests for setup/teardown. */
export function getExtensionRegistry() {
    return EXTENSION_REGISTRY;
}

/** @internal — alias retained for existing test files. */
export const __getExtensionRegistryForTest = getExtensionRegistry;
