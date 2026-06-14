/**
 * Streaming-usage extractor — translates per-provider SSE chunk shapes into a
 * single OpenAI snake_case usage object so the rest of the client never has to
 * branch on provider. Companion to `src/endpoints/backends/chat-completions.js`'s
 * non-streaming `normalize*Usage` helpers — same target shape, same field names.
 *
 * Target shape:
 *   {
 *     prompt_tokens, completion_tokens, total_tokens,
 *     prompt_tokens_details?: { cached_tokens?, cache_creation_tokens? },
 *     completion_tokens_details?: { reasoning_tokens? },
 *   }
 *
 * No SillyTavern globals, no DOM — kept import-safe for jest so the wiring in
 * `openai.js`'s stream loop can be exercised without a browser harness.
 */

function finiteOrZero(n) {
    return Number.isFinite(n) ? n : 0;
}

function extractFromOpenAIShape(rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') return null;
    const prompt = Number(rawUsage.prompt_tokens);
    const completion = Number(rawUsage.completion_tokens);
    const total = Number(rawUsage.total_tokens);
    if (!Number.isFinite(prompt) && !Number.isFinite(completion) && !Number.isFinite(total)) {
        return null;
    }
    const out = {
        prompt_tokens: finiteOrZero(prompt),
        completion_tokens: finiteOrZero(completion),
        total_tokens: Number.isFinite(total) ? total : finiteOrZero(prompt) + finiteOrZero(completion),
    };
    if (rawUsage.prompt_tokens_details && typeof rawUsage.prompt_tokens_details === 'object') {
        out.prompt_tokens_details = { ...rawUsage.prompt_tokens_details };
    }
    if (rawUsage.completion_tokens_details && typeof rawUsage.completion_tokens_details === 'object') {
        out.completion_tokens_details = { ...rawUsage.completion_tokens_details };
    }
    return out;
}

function extractFromClaudeUsage(rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') return null;
    const promptTokens = Number(rawUsage.input_tokens);
    const completionTokens = Number(rawUsage.output_tokens);
    if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return null;
    const prompt = finiteOrZero(promptTokens);
    const completion = finiteOrZero(completionTokens);
    const out = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
    };
    const cacheRead = Number(rawUsage.cache_read_input_tokens);
    const cacheCreate = Number(rawUsage.cache_creation_input_tokens);
    const details = {};
    if (Number.isFinite(cacheRead)) details.cached_tokens = cacheRead;
    if (Number.isFinite(cacheCreate)) details.cache_creation_tokens = cacheCreate;
    if (Object.keys(details).length) out.prompt_tokens_details = details;
    return out;
}

function extractFromGeminiMetadata(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const promptTokens = Number(meta.promptTokenCount);
    const candidatesTokens = Number(meta.candidatesTokenCount);
    const thoughtsTokens = Number(meta.thoughtsTokenCount);
    const totalTokens = Number(meta.totalTokenCount);
    if (!Number.isFinite(promptTokens) && !Number.isFinite(candidatesTokens) && !Number.isFinite(totalTokens)) {
        return null;
    }
    const prompt = finiteOrZero(promptTokens);
    const candidates = finiteOrZero(candidatesTokens);
    const thoughts = finiteOrZero(thoughtsTokens);
    const completion = candidates + thoughts;
    const total = Number.isFinite(totalTokens) ? totalTokens : prompt + completion;
    const out = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
    };
    const cached = Number(meta.cachedContentTokenCount);
    if (Number.isFinite(cached)) {
        out.prompt_tokens_details = { cached_tokens: cached };
    }
    if (Number.isFinite(thoughtsTokens)) {
        out.completion_tokens_details = { reasoning_tokens: thoughts };
    }
    return out;
}

const CLAUDE_SOURCES = new Set(['claude']);
const GEMINI_SOURCES = new Set(['makersuite', 'vertexai']);

/**
 * Pull a normalized usage object out of a single parsed SSE chunk.
 * Returns null when the chunk has no usage fields — most chunks (content
 * deltas) don't, so callers loop and `mergeStreamingUsage` what comes back.
 *
 * @param {*} parsed Parsed JSON of one SSE `data:` line
 * @param {string} source Chat completion source key
 * @returns {object|null}
 */
export function extractStreamingUsage(parsed, source) {
    if (!parsed || typeof parsed !== 'object') return null;

    if (CLAUDE_SOURCES.has(source)) {
        if (parsed.type === 'message_start') {
            return extractFromClaudeUsage(parsed?.message?.usage);
        }
        if (parsed.type === 'message_delta') {
            return extractFromClaudeUsage(parsed?.usage);
        }
        return null;
    }

    if (GEMINI_SOURCES.has(source)) {
        return extractFromGeminiMetadata(parsed?.usageMetadata);
    }

    // OpenAI-family fall-through. Cohere streaming surfaces usage on the
    // final `message-end` event as `parsed.delta.usage`; check that too.
    return extractFromOpenAIShape(parsed?.usage) ?? extractFromOpenAIShape(parsed?.delta?.usage);
}

/**
 * Merge two streaming-usage snapshots accumulated across multiple chunks.
 *
 * Field-merge rule:
 *  - `prompt_tokens`, `completion_tokens`: max of both sides
 *  - `total_tokens`: prompt + completion of the merged result (re-derived so
 *    Claude's message_start (prompt-only) + message_delta (completion-only)
 *    yields the correct total without double-counting overlapping fields)
 *  - `prompt_tokens_details` / `completion_tokens_details`: shallow-merge,
 *    taking the higher numeric value per key
 *
 * @param {object|null} prev
 * @param {object|null} next
 * @returns {object|null}
 */
export function mergeStreamingUsage(prev, next) {
    if (!prev) return next ? { ...next } : null;
    if (!next) return { ...prev };
    const prompt = Math.max(finiteOrZero(prev.prompt_tokens), finiteOrZero(next.prompt_tokens));
    const completion = Math.max(finiteOrZero(prev.completion_tokens), finiteOrZero(next.completion_tokens));
    const out = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
    };
    const details = mergeDetails(prev.prompt_tokens_details, next.prompt_tokens_details);
    if (details) out.prompt_tokens_details = details;
    const completionDetails = mergeDetails(prev.completion_tokens_details, next.completion_tokens_details);
    if (completionDetails) out.completion_tokens_details = completionDetails;
    return out;
}

function mergeDetails(a, b) {
    if (!a && !b) return null;
    if (!a) return { ...b };
    if (!b) return { ...a };
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
            out[k] = Math.max(finiteOrZero(out[k]), v);
        } else if (out[k] === undefined) {
            out[k] = v;
        }
    }
    return out;
}
