// SPDX-License-Identifier: AGPL-3.0-or-later

import { createIsolatedMacroRegistry } from './engine/MacroRegistry.js';
import { createIsolatedMacroEngine } from './engine/MacroEngine.js';
import { registerCoreMacros } from './definitions/core-macros.js';
import { registerEnvMacros } from './definitions/env-macros.js';
import { registerChatMacros } from './definitions/chat-macros.js';
import { registerInstructMacros } from './definitions/instruct-macros.js';
import { registerTimeMacros } from './definitions/time-macros.js';
import { registerStateMacros } from './definitions/state-macros.js';
import { registerVariableMacros } from './definitions/variable-macros.js';
import { readVariableValue } from './util/variable-values.js';
import { extractFromText } from '../variable-op-log/extractor.js';
import { getStringHash } from '../utils.js';

const evaluators = new WeakMap();

function readOnlyVariables(values, dotted) {
    const rejectWrite = () => {
        throw new Error('Captured task macros cannot change variables.');
    };
    return {
        get: (name, args) => readVariableValue(values, name, args, { dotted }),
        has: name => values[name] !== undefined,
        set: rejectWrite,
        add: rejectWrite,
        push: rejectWrite,
        pop: rejectWrite,
        inc: rejectWrite,
        dec: rejectWrite,
        del: rejectWrite,
    };
}

function getEvaluator(snapshot) {
    if (evaluators.has(snapshot)) return evaluators.get(snapshot);
    const variables = {
        local: readOnlyVariables(snapshot.variables.local, true),
        global: readOnlyVariables(snapshot.variables.global, false),
    };
    const context = { variables };
    const registry = createIsolatedMacroRegistry();
    registerCoreMacros(registry, context);
    registerEnvMacros(registry);
    registerChatMacros(registry);
    registerInstructMacros(registry, snapshot.powerUser);
    registerTimeMacros(registry);
    registerStateMacros(registry);
    registerVariableMacros(registry, context);
    const evaluator = { engine: createIsolatedMacroEngine(registry), variables };
    evaluators.set(snapshot, evaluator);
    return evaluator;
}

/**
 * Evaluate the native built-ins against captured data without live handlers,
 * environment providers, extension processors, or writable variable scopes.
 */
export function substituteCapturedMacros(content, snapshot, {
    original = '',
    skipSideEffects = true,
    replaceCharacterCard = true,
    name1Override = null,
    name2Override = null,
    postProcessFn = text => text,
    dynamicMacros = {},
} = {}) {
    if (typeof content !== 'string' || !content) return content ?? '';
    const { engine, variables } = getEvaluator(snapshot);
    const input = skipSideEffects ? extractFromText(content, {}, () => ({})).mes : content;
    let originalSubstituted = false;
    return engine.evaluate(input, {
        content: input,
        contentHash: getStringHash(input),
        names: {
            ...snapshot.names,
            user: name1Override ?? snapshot.names.user,
            char: name2Override ?? snapshot.names.char,
        },
        character: replaceCharacterCard ? snapshot.character : {},
        system: snapshot.system,
        functions: {
            original: () => {
                if (originalSubstituted) return '';
                originalSubstituted = true;
                return original;
            },
            postProcess: postProcessFn,
        },
        dynamicMacros,
        extra: {},
        contextSnapshot: snapshot.contextSnapshot,
        variables,
    });
}
