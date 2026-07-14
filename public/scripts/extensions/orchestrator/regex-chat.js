/**
 * regex-chat.js — apply user-authored regex scripts to chat text that will
 * be fed to orchestrator agents.
 *
 * Rationale: the main generation pipeline runs every chat message through
 * `getRegexedString(..., USER_INPUT|AI_OUTPUT, { isPrompt: true, depth })`
 * before shipping it to the model (see `public/script.js` in the
 * `coreChat.map` block). Orchestrator agents used to skip this step —
 * they pulled `message.mes` raw, so user regex scripts scoped to
 * "prompt" placements silently didn't apply to what the agent saw.
 *
 * This module centralizes the transformation so every orchestrator entry
 * point that surfaces chat text to an LLM behaves the same way. Three
 * consumers today:
 *   - spec-runtime.js: `{{recent_chat}}` / `{{last_user}}` template vars
 *   - agenda-runtime.js: same, for agenda mode
 *   - loop-tools/chat.js: `chat_read_range` / `chat_search` tools
 *
 * Depth semantics match the main pipeline: `depth` is 0-based, counting
 * from the *end* of the "usable" chat (system messages skipped). The
 * last non-system message is depth 0. This lets a script authored with
 * `maxDepth: 4` do the same thing here that it does in Generate().
 *
 * Regex engine access:
 *   We consume the regex primitives through `Luker.getContext().regex`
 *   (three-layer API). Direct `import` from
 *   `../regex/engine.js` would transitively pull `public/script.js` and
 *   its DOM bootstrap chain — poison for the jest module graph. The
 *   context surface stays test-friendly because jest.setup.js already
 *   installs a Luker stub.
 *
 *   Ctx resolution is lazy (first-call, memoized): reading
 *   `Luker.getContext()` at module load would fire before jest.setup.js
 *   finishes wiring `globalThis.Luker`, and in the browser it would
 *   fire before `st-context.js` finishes exposing the `regex` field.
 *   Lazy avoids both hazards.
 */

let __regexApiCache = undefined;

function getRegexApi() {
    if (__regexApiCache !== undefined) return __regexApiCache;
    try {
        const ctx = globalThis.Luker?.getContext?.();
        const api = ctx?.regex;
        if (api && typeof api.applyRegex === 'function' && api.placement
            && typeof api.placement.USER_INPUT === 'number'
            && typeof api.placement.AI_OUTPUT === 'number') {
            __regexApiCache = api;
        } else {
            __regexApiCache = null;
        }
    } catch {
        __regexApiCache = null;
    }
    return __regexApiCache;
}

/**
 * Test-only: reset the cached ctx.regex reference. Not part of the
 * runtime contract; production code path only ever memoizes once.
 */
export function __resetRegexApiCacheForTests() {
    __regexApiCache = undefined;
}

/**
 * Precompute depth-from-end (skipping system messages) for every index
 * in `messages`. Returns an array parallel to `messages` where
 * `depths[i]` is the depth to pass to `applyRegex` for `messages[i]`,
 * or `undefined` when the message is system (regex won't be applied to
 * system messages anyway).
 *
 * O(n). Iterates once from the tail forward.
 *
 * @param {Array} messages
 * @returns {number[]}
 */
export function computeDepthsFromEnd(messages) {
    const source = Array.isArray(messages) ? messages : [];
    const depths = new Array(source.length);
    let cursor = 0;
    for (let i = source.length - 1; i >= 0; i -= 1) {
        const message = source[i];
        if (!message || message.is_system) {
            depths[i] = undefined;
            continue;
        }
        depths[i] = cursor;
        cursor += 1;
    }
    return depths;
}

/**
 * Apply prompt-scoped regex scripts to a single chat message's text.
 * Returns raw `mes` when the regex API isn't reachable (e.g. bare unit
 * tests without a Luker stub) so orchestrator degrades gracefully rather
 * than crashing.
 *
 * @param {object} message — chat message object (needs `mes` + `is_user`)
 * @param {number|undefined} depth — 0-based depth from chat tail; pass
 *     `undefined` to disable depth-based script filtering
 * @returns {string} the text ready to feed to an LLM
 */
export function regexChatMessageForAgent(message, depth) {
    const raw = String(message?.mes ?? '');
    if (!raw) return '';
    const api = getRegexApi();
    if (!api) return raw;
    const placement = message?.is_user ? api.placement.USER_INPUT : api.placement.AI_OUTPUT;
    return api.applyRegex(raw, placement, { isPrompt: true, depth });
}
