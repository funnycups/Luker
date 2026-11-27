// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolParseError } from '../errors.js';
import { WIRE_PROTOCOLS } from '../protocol.js';
import { getValueAtArgumentPath, parseArgumentPath } from '../../streaming-tool-reply.js';

function invalid(message) {
    throw new ProtocolParseError({
        protocol: WIRE_PROTOCOLS.GEMINI,
        stage: 'payload',
        location: 'functionCall.partialArgs',
        message,
    });
}

function readFragmentField(fragment) {
    if (Object.hasOwn(fragment, 'stringValue')) return { kind: 'string', value: fragment.stringValue };
    if (Object.hasOwn(fragment, 'string_value')) return { kind: 'string', value: fragment.string_value };
    if (Object.hasOwn(fragment, 'numberValue')) return { kind: 'primitive', value: fragment.numberValue };
    if (Object.hasOwn(fragment, 'number_value')) return { kind: 'primitive', value: fragment.number_value };
    if (Object.hasOwn(fragment, 'boolValue')) return { kind: 'primitive', value: fragment.boolValue };
    if (Object.hasOwn(fragment, 'bool_value')) return { kind: 'primitive', value: fragment.bool_value };
    if (Object.hasOwn(fragment, 'nullValue') || Object.hasOwn(fragment, 'null_value')) return { kind: 'null', value: null };
    return null;
}

// Gemini sends concrete JSONPath locations, e.g. $.items[0].title.
function applyFragment(args, fragment) {
    if (!fragment || typeof fragment !== 'object') invalid('Invalid Gemini argument fragment.');
    const field = readFragmentField(fragment);
    if (!field) return; // A path without a value can close a previously streamed string.
    const rawPath = fragment.jsonPath ?? fragment.json_path;
    const keys = parseArgumentPath(rawPath, { requireRootDollar: true });
    if (!keys) invalid('Invalid Gemini argument path.');
    let node = args;
    for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (Array.isArray(node) !== (typeof key === 'number')) invalid('Conflicting Gemini argument containers.');
        if (i === keys.length - 1) {
            if (field.kind === 'string') {
                if (typeof field.value !== 'string') invalid('Invalid Gemini string fragment.');
                if (Object.hasOwn(node, key) && typeof node[key] !== 'string') invalid('Conflicting Gemini argument types.');
                node[key] = (node[key] ?? '') + field.value;
            } else {
                node[key] = field.value;
            }
        } else {
            if (!Object.hasOwn(node, key)) node[key] = typeof keys[i + 1] === 'number' ? [] : Object.create(null);
            node = node[key];
            if (!node || typeof node !== 'object') invalid('Conflicting Gemini argument path.');
        }
    }
}

function checkArrays(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value) && Object.keys(value).length !== value.length) invalid('Incomplete Gemini argument array.');
    Object.values(value).forEach(checkArrays);
}

export function createGeminiFunctionArgumentStream() {
    const pending = new Set();
    const previews = new Map();
    return {
        getPreview(name, argument) {
            const call = previews.get(name);
            if (!call) return '';
            const value = getValueAtArgumentPath(call.args, argument);
            return typeof value === 'string' ? value : '';
        },
        recordCompletedCall(name, args) {
            if (!name || !args || typeof args !== 'object') return;
            previews.set(name, { name, args });
        },
        get pendingCount() { return pending.size; },
        // A continuation can omit both name and ID, including the empty final marker.
        ingest(part) {
            const fc = part.functionCall ?? part.function_call;
            if (!fc || typeof fc !== 'object') return null;
            const partialArgs = fc.partialArgs ?? fc.partial_args;
            const willContinue = fc.willContinue ?? fc.will_continue;
            const thoughtSignature = part.thoughtSignature ?? part.thought_signature;

            const matches = [...pending].filter(c => (!fc.id || c.id === fc.id) && (!fc.name || c.name === fc.name));
            if (matches.length > 1) invalid('Ambiguous Gemini function continuation.');
            let call = matches[0];
            if (!call && partialArgs === undefined && willContinue === undefined) return null;

            const started = !call;
            if (started) {
                if (!fc.name) invalid('Gemini function stream started without a name.');
                call = {
                    name: fc.name,
                    id: fc.id,
                    args: Object.create(null),
                    signature: undefined,
                    hasPartialArgs: false,
                };
                pending.add(call);
                previews.set(call.name, call);
            }
            if (typeof thoughtSignature === 'string' && thoughtSignature.length > 0) {
                call.signature = thoughtSignature;
            }
            if (partialArgs !== undefined) {
                if (!Array.isArray(partialArgs)) invalid('Gemini partialArgs must be an array.');
                for (const fragment of partialArgs) {
                    applyFragment(call.args, fragment);
                    call.hasPartialArgs = true;
                }
            }
            if (fc.args !== undefined) {
                if (willContinue === true) invalid('Complete Gemini arguments marked as unfinished.');
                if (!fc.args || typeof fc.args !== 'object' || Array.isArray(fc.args)) {
                    invalid('Gemini functionCall.args must be an object.');
                }
                if (Object.keys(fc.args).length > 0 || !call.hasPartialArgs) {
                    call.args = fc.args;
                }
            }
            const complete = willContinue !== true;
            if (complete) {
                checkArrays(call.args);
                pending.delete(call);
            }
            return { call, started, complete };
        },
    };
}
