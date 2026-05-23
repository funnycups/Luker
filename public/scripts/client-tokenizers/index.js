// public/scripts/client-tokenizers/index.js
//
// Single entry point for client-side tokenization. Routes by model name to one
// of the two adapters; returns null from countMessages/encode/decode if no
// client adapter handles this model, so callers can fall back to HTTP.

import * as tiktoken     from './tiktoken-adapter.js';
import * as webTokenizer from './web-tokenizer-adapter.js';

const ADAPTERS = [tiktoken, webTokenizer];

function pick(model) {
    return ADAPTERS.find(a => a.supports(model)) ?? null;
}

export function hasClientTokenizer(model) {
    return pick(model) !== null;
}

export async function clientCountTokens(model, messages) {
    const adapter = pick(model);
    if (!adapter) return null;
    try {
        return await adapter.countMessages(model, Array.isArray(messages) ? messages : [messages]);
    } catch (e) {
        console.warn(`[client-tokenizers] ${model} count failed, will fall back`, e);
        return null;
    }
}

export async function clientEncode(model, text) {
    const adapter = pick(model);
    if (!adapter) return null;
    try {
        return await adapter.encode(model, text);
    } catch (e) {
        console.warn(`[client-tokenizers] ${model} encode failed, will fall back`, e);
        return null;
    }
}

export async function clientDecode(model, ids) {
    const adapter = pick(model);
    if (!adapter) return null;
    try {
        return await adapter.decode(model, ids);
    } catch (e) {
        console.warn(`[client-tokenizers] ${model} decode failed, will fall back`, e);
        return null;
    }
}
