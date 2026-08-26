/**
 * chat-regex.js — depth computation and the response-side regex
 * primitive for plugin-driven LLM traffic.
 *
 * This module no longer hosts a request-side per-text entry point: the
 * single place plugins cook chat text for their own LLM requests is
 * `lib/plugin-floors.js` (`readPluginFloors` / `cookPluginFloorText`).
 * What remains here:
 *   - `computeDepthsFromEnd` — shared depth-from-end computation, used
 *     by plugin-floors so plugins see the same depth numbering the main
 *     generation pipeline feeds to `applyRegex`.
 *   - `regexAgentPluginOutput` — response-side primitive: applies
 *     AI_OUTPUT-scoped, plugin-message regex scripts to agent-produced
 *     text re-entering an LLM context through a non-`role:'assistant'`
 *     channel (e.g. a sub-agent's output in a tool-result envelope).
 *   - `__resetRegexApiCacheForTests` — test seam.
 *
 * Depth semantics match the main pipeline: `depth` is 0-based, counting
 * from the *end* of the "usable" chat (system messages skipped). The
 * last non-system message is depth 0. This lets a script authored with
 * `maxDepth: 4` do the same thing on the plugin lane that it does in
 * Generate().
 *
 * Plugin-channel semantics:
 *   The plugin channel applies pluginOnly rules plus the message's real
 *   chat depth; main-pipeline-only rules (promptOnly) never enter it.
 *
 * Regex engine access:
 *   We consume the regex primitives through `Luker.getContext().regex`
 *   (three-layer API). Direct `import` from
 *   `../extensions/regex/engine.js` would transitively pull
 *   `public/script.js` and its DOM bootstrap chain — poison for the
 *   jest module graph. The context surface stays test-friendly because
 *   jest.setup.js already installs a Luker stub.
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
 * Apply AI_OUTPUT-scoped, plugin-message regex scripts to a piece of
 * agent-produced text before it re-enters an LLM's context via a
 * non-`role:'assistant'` channel (e.g. a sub-agent's `outputText`
 * bubbling back through a `tool_result` envelope to the main agent).
 *
 * Distinct from the request-side lane (`lib/plugin-floors.js`):
 *   - Placement is fixed to AI_OUTPUT (this text is by definition an
 *     agent's own output; there is no user-input case).
 *   - Flag is `isPluginPrompt:true`, matching what
 *     `applyPluginLaneRegex` already sets when cooking assistant
 *     messages in plugin-built prompt arrays. This means a
 *     single user-authored rule scoped to AI_OUTPUT with the
 *     "plugin messages only" flag ticked will cover BOTH (a) an
 *     agent's own next-round view of its previous-round assistant turn
 *     AND (b) a sub-agent's output as seen by the parent through
 *     `await_subagents` — one rule, both channels.
 *   - `isPrompt` is deliberately NOT set: prompt-scoped rules already
 *     ran on the chat-derived inputs feeding the agent; this pass is
 *     specifically about the plugin-message ephemerality lane.
 *   - `depth` is `undefined`: `tool_result` envelopes don't sit at a
 *     stable chat-depth, and depth-based filtering (`minDepth` /
 *     `maxDepth`) is almost never authored on pluginOnly rules.
 *     Passing `undefined` disables the depth filter, matching how
 *     `applyPluginLaneRegex` treats an undepthed message.
 *
 * Returns raw text when the regex API isn't reachable (bare unit tests
 * without a Luker stub) so callers degrade gracefully.
 *
 * @param {string} text — raw agent output text
 * @returns {string} text after plugin-scoped AI_OUTPUT regex application
 */
export function regexAgentPluginOutput(text) {
    const raw = String(text ?? '');
    if (!raw) return '';
    const api = getRegexApi();
    if (!api) return raw;
    return api.applyRegex(raw, api.placement.AI_OUTPUT, { isPluginPrompt: true });
}
