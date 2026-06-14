/**
 * Single-slot hand-off between a chat-completion request and the message-saving
 * code that writes `extra.token_count`. The request handler (`sendOpenAIRequest`
 * in `openai.js`) stores the response's `usage` here; `script.js` consumes it
 * when finalising the assistant message so the badge and `t/s` reflect the real
 * billed `completion_tokens` instead of a local-tokenizer estimate.
 *
 * Why a global slot and not parameter threading: the request originates several
 * call layers above the writer (sendOpenAIRequest → ... → Generate → saveReply),
 * and threading an extra arg through every layer is a much larger refactor for
 * the same effect. ST generations are serialized per session (one assistant
 * message at a time), so there's no concurrent-write hazard.
 *
 * Consume-on-read with an explicit clear at request entry keeps stale values
 * from leaking when an error path skips the writer.
 */

let lastUsage = null;

/**
 * Stash the current request's usage. Pass `null`/`undefined` to clear.
 * Always replaces — never merges. Subsequent `set` wins.
 * @param {object|null|undefined} usage Normalized OpenAI snake_case usage object, or null/undefined to clear
 */
export function setLastUsage(usage) {
    lastUsage = (usage && typeof usage === 'object') ? usage : null;
}

/**
 * Read and clear in one step. The writer in `script.js` calls this when it's
 * about to populate `extra.token_count`; the next request starts from a clean
 * slot.
 * @returns {object|null}
 */
export function consumeLastUsage() {
    const value = lastUsage;
    lastUsage = null;
    return value;
}

/**
 * Read without clearing. Provided for debugging and future read-only consumers
 * (e.g. logging); the production write path uses `consumeLastUsage` so each
 * request's usage is taken exactly once.
 * @returns {object|null}
 */
export function peekLastUsage() {
    return lastUsage;
}
