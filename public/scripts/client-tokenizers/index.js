// public/scripts/client-tokenizers/index.js
//
// Single entry point for client-side tokenization. Routes by model name to one
// of the three adapters; returns null from countMessages/encode/decode if no
// client adapter handles this model, so callers can fall back to HTTP.

import * as tiktoken     from './tiktoken-adapter.js';
import * as webTokenizer from './web-tokenizer-adapter.js';
import * as sentencepiece from './sentencepiece-adapter.js';
import { normalizeTokenizerModel } from './normalize-model.js';

// Order matters: specialized adapters first (web tokenizers for
// claude/llama3/qwen2/…, sentencepiece for llama/mistral/yi/gemma/…), then
// tiktoken as a catch-all so unknown model names (kimi, moonshot/*, custom
// OpenAI-compat providers) still tokenize locally with cl100k_base — the same
// encoding src/endpoints/tokenizers.js defaults to. This preserves the
// invariant that /api/tokenizers/openai/count-batch is only reached after a
// real client-side attempt failed, not because a model name was missing from
// normalize-model.js's keyword table.
const ADAPTERS = [webTokenizer, sentencepiece, tiktoken];

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
