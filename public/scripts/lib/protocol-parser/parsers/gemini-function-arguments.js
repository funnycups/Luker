// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolParseError } from '../errors.js';
import { WIRE_PROTOCOLS } from '../protocol.js';

function invalid(message) {
    throw new ProtocolParseError({ protocol: WIRE_PROTOCOLS.GEMINI, stage: 'payload', location: 'functionCall.partialArgs', message });
}

// Gemini sends concrete JSONPath locations, e.g. $.items[0].title.
function pathSegments(path) {
    if (typeof path !== 'string' || !path.startsWith('$')) invalid('Missing Gemini argument path.');
    const token = /\.([^.[\]\s]+)|\[(\d+)\]|\[("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\]/gy;
    const segments = [];
    for (let offset = 1; offset < path.length;) {
        token.lastIndex = offset;
        const match = token.exec(path);
        if (!match) invalid('Invalid Gemini argument path.');
        if (match[2] !== undefined) {
            const index = Number(match[2]);
            if (!Number.isSafeInteger(index) || index >= 0xffffffff) invalid('Invalid Gemini argument index.');
            segments.push(index);
        } else if (match[3] !== undefined) {
            const quoted = match[3];
            const json = quoted.startsWith('\'')
                ? '"' + quoted.slice(1, -1).replace(/\\.|"/g, ch => ch === '\\\'' ? '\'' : ch === '"' ? '\\"' : ch) + '"'
                : quoted;
            try { segments.push(JSON.parse(json)); } catch { invalid('Invalid quoted Gemini argument key.'); }
        } else {
            segments.push(match[1]);
        }
        offset = token.lastIndex;
    }
    if (!segments.length || typeof segments[0] !== 'string') invalid('Expected a named Gemini argument.');
    return segments;
}

function applyFragment(args, fragment) {
    if (!fragment || typeof fragment !== 'object') invalid('Invalid Gemini argument fragment.');
    const field = ['stringValue', 'numberValue', 'boolValue', 'nullValue'].find(key => Object.hasOwn(fragment, key));
    if (!field) return; // A path without a value can close a previously streamed string.
    const keys = pathSegments(fragment.jsonPath);
    let node = args;
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (Array.isArray(node) !== (typeof key === 'number')) invalid('Conflicting Gemini argument containers.');
        if (i === keys.length - 1) {
            if (field === 'stringValue') {
                if (typeof fragment[field] !== 'string') invalid('Invalid Gemini string fragment.');
                if (Object.hasOwn(node, key) && typeof node[key] !== 'string') invalid('Conflicting Gemini argument types.');
                node[key] = (node[key] ?? '') + fragment[field];
            } else {
                node[key] = field === 'nullValue' ? null : fragment[field];
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
            const value = previews.get(name)?.args?.[argument];
            return typeof value === 'string' ? value : '';
        },
        get pendingCount() { return pending.size; },
        // A continuation can omit both name and ID, including the empty final marker.
        ingest(part) {
            const fc = part.functionCall ?? part.function_call;
            if (!fc) return null;
            const matches = [...pending].filter(c => (!fc.id || c.id === fc.id) && (!fc.name || c.name === fc.name));
            if (matches.length > 1) invalid('Ambiguous Gemini function continuation.');
            let call = matches[0];
            if (!call && !fc.partialArgs && fc.willContinue === undefined) return null;
            const started = !call;
            if (started) {
                if (!fc.name) invalid('Gemini function stream started without a name.');
                call = { name: fc.name, id: fc.id, args: Object.create(null), signature: undefined };
                pending.add(call);
                previews.set(call.name, call);
            }
            if (part.thoughtSignature) call.signature = part.thoughtSignature;
            for (const fragment of fc.partialArgs ?? []) applyFragment(call.args, fragment);
            if (fc.args) {
                if (fc.willContinue === true) invalid('Complete Gemini arguments marked as unfinished.');
                call.args = fc.args;
            }
            const complete = fc.willContinue !== true;
            if (complete) {
                checkArrays(call.args);
                pending.delete(call);
            }
            return { call, started, complete };
        },
    };
}
