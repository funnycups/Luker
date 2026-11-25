// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Explicit browser module environment for unit tests.
// Only exposes capabilities explicitly declared by the caller — never
// synthesizes unknown properties or callable no-ops via a recursive Proxy.

const GLOBAL_CONTEXT_ALIASES = ['Luker', 'st', 'SillyTavern'];

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be a plain object`);
    }
}

/**
 * Create a plain explicit context object exposing ONLY the declared
 * dependencies. Accessing undeclared properties yields `undefined`
 * (never a synthesized recursive Proxy).
 *
 * @param {Record<string, unknown>} [dependencies]
 * @returns {Record<string, unknown>}
 */
export function createBrowserModuleContext(dependencies = {}) {
    assertPlainObject(dependencies, 'Browser module context dependencies');
    const context = {};
    for (const key of Object.keys(dependencies)) {
        context[key] = dependencies[key];
    }
    return context;
}

/**
 * Create an explicit in-memory extension API registry (`registerExtensionApi`
 * and `getExtensionApi`). Unknown API names return `null`.
 *
 * @param {Record<string, unknown>} [initial]
 * @returns {{ registerExtensionApi: (name: string, api: unknown) => void, getExtensionApi: (name: string) => unknown }}
 */
export function createExtensionRegistry(initial = {}) {
    assertPlainObject(initial, 'Initial extension APIs');
    const apis = new Map(Object.entries(initial));
    return {
        registerExtensionApi(name, api) {
            if (typeof name !== 'string' || !name) {
                throw new TypeError('Extension API name must be a non-empty string');
            }
            apis.set(name, api);
        },
        getExtensionApi(name) {
            return apis.has(name) ? apis.get(name) : null;
        },
    };
}

/**
 * Load the real orchestrator custom-tool registry API for tests that exercise
 * cross-extension tool registration without inventing a fake registry.
 */
export async function loadOrchestratorToolRegistryApi() {
    const mod = await import('../../public/scripts/extensions/orchestrator/register-custom-tool.js');
    return Object.freeze({
        registerOrchestrationTool: mod.registerOrchestrationTool,
        unregisterOrchestrationTool: mod.unregisterOrchestrationTool,
        listExtensionTools: mod.listExtensionTools,
        bridgeSillyTavernTool: mod.bridgeSillyTavernTool,
        unbridgeSillyTavernTool: mod.unbridgeSillyTavernTool,
    });
}

/**
 * Load the real shared state-errors helper surface.
 */
export async function loadStateErrorsApi() {
    const [core, format] = await Promise.all([
        import('../../public/scripts/lib/state-errors.js'),
        import('../../public/scripts/lib/state-errors-format.js'),
    ]);
    return Object.freeze({
        STATE_ERROR_REASONS: core.STATE_ERROR_REASONS,
        STATE_HINT_MAX_LENGTH: core.STATE_HINT_MAX_LENGTH,
        isValidReason: core.isValidReason,
        makeStateError: core.makeStateError,
        makeStateOk: core.makeStateOk,
        formatHttpErrorHint: format.formatHttpErrorHint,
        formatTransportErrorHint: format.formatTransportErrorHint,
        formatConflictHint: format.formatConflictHint,
        formatValidationArgsHint: format.formatValidationArgsHint,
        formatValidationTargetHint: format.formatValidationTargetHint,
    });
}

/**
 * Load the real card-bound preset option-value codec.
 */
export async function loadPresetRefCodecApi() {
    const mod = await import('../../public/scripts/lib/preset-ref-codec.js');
    return Object.freeze({
        encodeCardBoundOptionValue: mod.encodeCardBoundOptionValue,
        decodeCardBoundOptionValue: mod.decodeCardBoundOptionValue,
    });
}

/**
 * Bind an explicit browser module context onto `globalThis.Luker` (and its
 * `st` / `SillyTavern` aliases by default), returning a `restore()` disposer
 * that restores the exact prior global descriptors.
 *
 * @param {Record<string, unknown> | (() => Record<string, unknown>)} [dependenciesOrGetter]
 * @param {{ aliases?: boolean, hostProperties?: Record<string, unknown> }} [options]
 * @returns {{ context: Record<string, unknown> | null, getContext: () => Record<string, unknown>, restore: () => void }}
 */
export function installBrowserModuleContext(dependenciesOrGetter = {}, { aliases = true, hostProperties = {} } = {}) {
    assertPlainObject(hostProperties, 'Browser module host properties');
    if (Object.prototype.hasOwnProperty.call(hostProperties, 'getContext')) {
        throw new TypeError('Browser module host properties must not override getContext');
    }
    const isGetter = typeof dependenciesOrGetter === 'function';
    const context = isGetter ? null : createBrowserModuleContext(dependenciesOrGetter);
    const getContext = isGetter ? () => dependenciesOrGetter() : () => context;
    const host = Object.freeze({ ...hostProperties, getContext });
    const names = aliases ? GLOBAL_CONTEXT_ALIASES : ['Luker'];
    const previous = names.map(name => ({
        name,
        existed: Object.prototype.hasOwnProperty.call(globalThis, name),
        descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
    }));

    for (const name of names) {
        Object.defineProperty(globalThis, name, {
            value: host,
            configurable: true,
            writable: true,
            enumerable: true,
        });
    }

    let restored = false;
    return {
        context,
        getContext,
        restore() {
            if (restored) return;
            restored = true;
            for (const { name, existed, descriptor } of previous) {
                if (existed && descriptor) {
                    Object.defineProperty(globalThis, name, descriptor);
                } else {
                    delete globalThis[name];
                }
            }
        },
    };
}

/**
 * Install an explicit, non-Proxy DOM-ready `jQuery` / `$` adapter for unit
 * tests importing browser modules that register `jQuery(() => ...)` or
 * delegated document handlers at module load time. Only explicitly declared
 * selection and static properties exist; unknown properties remain `undefined`.
 *
 * @param {{ selectionMethods?: Record<string, unknown>, staticProperties?: Record<string, unknown> }} [options]
 * @returns {{ jQuery: Function, readyCallbacks: Function[], restore: () => void }}
 */
export function installDomReadyJQuery({ selectionMethods = {}, staticProperties = {} } = {}) {
    assertPlainObject(selectionMethods, 'jQuery selection methods');
    assertPlainObject(staticProperties, 'jQuery static properties');
    const readyCallbacks = [];

    function jQuery(target) {
        if (typeof target === 'function') {
            readyCallbacks.push(target);
            return undefined;
        }
        const selection = {
            length: 0,
            off() { return selection; },
            on() { return selection; },
        };
        for (const key of Object.keys(selectionMethods)) {
            const member = selectionMethods[key];
            selection[key] = typeof member === 'function'
                ? (...args) => member(selection, ...args)
                : member;
        }
        return selection;
    }

    jQuery.escapeSelector = (value) => String(value ?? '');
    for (const key of Object.keys(staticProperties)) {
        jQuery[key] = staticProperties[key];
    }

    const names = ['jQuery', '$'];
    const previous = names.map(name => ({
        name,
        existed: Object.prototype.hasOwnProperty.call(globalThis, name),
        descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
    }));

    for (const name of names) {
        Object.defineProperty(globalThis, name, {
            value: jQuery,
            configurable: true,
            writable: true,
            enumerable: true,
        });
    }

    let restored = false;
    return {
        jQuery,
        readyCallbacks,
        restore() {
            if (restored) return;
            restored = true;
            for (const { name, existed, descriptor } of previous) {
                if (existed && descriptor) {
                    Object.defineProperty(globalThis, name, descriptor);
                } else {
                    delete globalThis[name];
                }
            }
        },
    };
}
