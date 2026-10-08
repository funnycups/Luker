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
 *   - `regexAgentPluginOutput` — response-side primitive: applies the
 *     plugin channel's OUTPUT-direction regex pass to the assistant
 *     text a plugin request returns.
 *   - `__resetRegexApiCacheForTests` — test seam.
 *
 * Depth semantics match the main pipeline: `depth` is 0-based, counting
 * from the *end* of the "usable" chat (system messages skipped). The
 * last non-system message is depth 0. This lets a script authored with
 * `maxDepth: 4` do the same thing on the plugin lane that it does in
 * Generate().
 *
 * Plugin-channel semantics:
 *   The plugin channel is directional. Rules scoped to `pluginOnly` +
 *   `promptOnly` cook text going INTO a plugin request (floors,
 *   plugin-composed messages, world info). Rules scoped to `pluginOnly`
 *   without `promptOnly` cook the assistant text a plugin request
 *   RETURNS. Main-pipeline-only rules (promptOnly without pluginOnly)
 *   never enter the channel.
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
 * Apply the plugin channel's OUTPUT-direction regex pass to
 * agent-produced text. A rule participates when it is scoped to the
 * plugin channel (`pluginOnly`) and NOT to the prompt direction
 * (`promptOnly` absent) — the "Alter Plugin Messages" box without
 * "Alter Outgoing Prompt".
 *
 * This is the response-side counterpart of the request-side lane
 * (`lib/plugin-floors.js` / `applyPluginLaneRegex`): the request side
 * cooks text going INTO a plugin request (`pluginOnly` + `promptOnly`),
 * this cooks the assistant text a plugin request RETURNS. The two
 * directions are disjoint, so one rule never fires twice on the same
 * text.
 *
 * Placement is fixed to AI_OUTPUT (a response is by definition the
 * agent's own output). `isPrompt` is deliberately NOT set:
 * main-pipeline-only rules never enter the plugin channel. `depth` is
 * `undefined` (responses don't sit at a stable chat depth).
 *
 * Returns raw text when the regex API isn't reachable (bare unit tests
 * without a Luker stub) so callers degrade gracefully.
 *
 * @param {string} text — raw agent output text
 * @returns {string} text after the plugin output-direction regex pass
 */
export function regexAgentPluginOutput(text) {
    const raw = String(text ?? '');
    if (!raw) return '';
    const api = getRegexApi();
    if (!api) return raw;
    return api.applyRegex(raw, api.placement.AI_OUTPUT, { isPluginOutput: true });
}
