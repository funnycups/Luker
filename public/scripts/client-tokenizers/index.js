// public/scripts/client-tokenizers/index.js
//
// Single entry point for client-side tokenization. Routes by model name to one
// of the three adapters; returns null from countMessages/encode/decode if no
// client adapter handles this model, so callers can fall back to HTTP.

import * as tiktoken     from './tiktoken-adapter.js';
import * as webTokenizer from './web-tokenizer-adapter.js';
import * as sentencepiece from './sentencepiece-adapter.js';
import { normalizeTokenizerModel } from './normalize-model.js';

const ADAPTERS = [tiktoken, webTokenizer, sentencepiece];

function pick(model) {
    const normalized = normalizeTokenizerModel(model);
    return { adapter: ADAPTERS.find(a => a.supports(normalized)) ?? null, model: normalized };
}

export function hasClientTokenizer(model) {
    return pick(model).adapter !== null;
}

export async function clientCountTokens(model, messages) {
    const { adapter, model: normalized } = pick(model);
    if (!adapter) return null;
    try {
        return await adapter.countMessages(normalized, Array.isArray(messages) ? messages : [messages]);
    } catch (e) {
        console.warn(`[client-tokenizers] ${model} count failed, will fall back`, e);
        return null;
    }
}

export async function clientEncode(model, text) {
    const { adapter, model: normalized } = pick(model);
    if (!adapter) return null;
    try {
        return await adapter.encode(normalized, text);
    } catch (e) {
        console.warn(`[client-tokenizers] ${model} encode failed, will fall back`, e);
        return null;
    }
}

export async function clientDecode(model, ids) {
    const { adapter, model: normalized } = pick(model);
    if (!adapter) return null;
    try {
        return await adapter.decode(normalized, ids);
    } catch (e) {
        console.warn(`[client-tokenizers] ${model} decode failed, will fall back`, e);
        return null;
    }
}
