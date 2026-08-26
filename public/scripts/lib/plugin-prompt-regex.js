/**
 * plugin-prompt-regex.js — dispatch-layer provenance cooking for
 * plugin-built LLM prompt message arrays.
 *
 * Role in the regex lane-semantics refactor:
 *   The per-text cooking primitive lives in
 *   `lib/plugin-floors.js:cookPluginFloorText` (`{ isPluginPrompt: true,
 *   depth }`). This module is the DISPATCH-layer piece: it is the single
 *   point where a fully assembled prompt-message array (post
 *   `normalizePromptMessages`) gets its one and only plugin-lane regex
 *   pass before hitting the network.
 *
 * Floor provenance:
 *   Task 3 introduces `floorRecordToTaskMessage`, which converts chat
 *   floor records into task messages. Those messages already ran through
 *   the main pipeline's regex pass, so re-cooking them here would be a
 *   second application. Such messages carry an internal-only numeric
 *   marker (`sourceFloorIndex`, stamped by `markPluginFloorMessage`) and
 *   this dispatcher passes them through UNCOOKED. The marker never leaves
 *   this module's output — every returned message is rebuilt without it,
 *   so it can't leak into network payloads.
 *
 * Depth semantics:
 *   Unmarked `user`/`assistant` messages are cooked with
 *   `{ isPluginPrompt: true }` and NO `depth` key. The previous dispatch
 *   implementation derived depth from array position of plugin messages,
 *   which does not correspond to real chat depth; passing no depth
 *   disables minDepth/maxDepth filtering entirely (matching how the main
 *   pipeline treats undepthed prompt text), instead of guessing wrong
 *   depths.
 *
 * Regex engine access:
 *   Same lazy-ctx pattern as `chat-regex.js`: the primitives are consumed
 *   via `Luker.getContext().regex` (three-layer API). Direct import from
 *   `../extensions/regex/engine.js` would transitively pull
 *   `public/script.js` and its DOM bootstrap chain — poison for the jest
 *   module graph. Ctx resolution is lazy + memoized for the same reasons
 *   as there.
 *
 *   Callers that already hold the engine function (e.g. st-context.js,
 *   which imports `getRegexedString` directly) may pass it via the
 *   `{ applyRegex }` override; the override takes precedence over the
 *   lazy ctx lookup so unit tests can inject a probe without stubbing
 *   globalThis. Placement values still come from ctx.regex.placement.
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
 * Internal-only field name carrying the source chat floor index on
 * messages that must skip the dispatcher's cooking pass. Never present
 * on any message returned by {@link applyPluginLaneRegex}.
 */
export const PLUGIN_FLOOR_PROVENANCE_FIELD = 'sourceFloorIndex';

function normalizeRole(role) {
    return String(role ?? '').trim().toLowerCase();
}

function placementForRole(placementEnum, role) {
    if (role === 'user' && typeof placementEnum.USER_INPUT === 'number') {
        return placementEnum.USER_INPUT;
    }
    if (role === 'assistant' && typeof placementEnum.AI_OUTPUT === 'number') {
        return placementEnum.AI_OUTPUT;
    }
    return null;
}

/**
 * Stamp the internal-only floor-provenance marker onto a fresh copy of
 * `message`. The input object is never mutated. Task 3's
 * `floorRecordToTaskMessage` calls this when converting chat floor
 * records into task messages.
 *
 * @param {object} message
 * @param {number} sourceFloorIndex — 0-based index into the source chat
 * @returns {object} new message object carrying the marker
 */
export function markPluginFloorMessage(message, sourceFloorIndex) {
    return { ...message, [PLUGIN_FLOOR_PROVENANCE_FIELD]: Math.floor(Number(sourceFloorIndex)) };
}

function rebuildWithoutProvenance(message) {
    const copy = { ...message };
    delete copy[PLUGIN_FLOOR_PROVENANCE_FIELD];
    return copy;
}

/**
 * Apply the plugin-lane regex pass across a normalized prompt-message
 * array. This is the ONE place a dispatch-assembled array gets cooked.
 *
 * Per message:
 *   - carries a finite numeric provenance marker → passed through
 *     UNCOOKED (it was already regexed upstream);
 *   - role `user`/`assistant` with string content →
 *     `content = applyRegex(content, placement, { isPluginPrompt: true })`
 *     (no `depth`: filtering by depth is disabled rather than guessed);
 *   - any other role (`system`, `tool`, ...) or non-string content →
 *     untouched.
 *
 * Every returned message is rebuilt WITHOUT the provenance marker, so it
 * stays internal-only and cannot reach network payloads. All other
 * fields are preserved.
 *
 * When the regex API isn't reachable (no ctx, or bare unit tests without
 * a Luker stub), messages degrade gracefully: text stays raw but markers
 * are still stripped.
 *
 * @param {Array} messages — normalized `{ role, content, ... }` messages
 * @param {{ applyRegex?: Function }} [overrides] — optional engine
 *     override; takes precedence over the lazy `ctx.regex.applyRegex`
 * @returns {Array} new array of cooked/stripped messages
 */
export function applyPluginLaneRegex(messages, overrides = {}) {
    const source = Array.isArray(messages) ? messages : [];
    const api = getRegexApi();
    const injected = overrides?.applyRegex;
    const cook = typeof injected === 'function'
        ? injected
        : (api && typeof api.applyRegex === 'function' ? api.applyRegex : null);
    const placementEnum = api?.placement;
    const hasPlacements = placementEnum
        && typeof placementEnum.USER_INPUT === 'number'
        && typeof placementEnum.AI_OUTPUT === 'number';

    if (!cook || !hasPlacements) {
        return source.map(message => (message && typeof message === 'object')
            ? rebuildWithoutProvenance(message)
            : message);
    }

    return source.map(message => {
        if (!message || typeof message !== 'object') {
            return message;
        }
        const out = rebuildWithoutProvenance(message);
        if (Number.isFinite(message[PLUGIN_FLOOR_PROVENANCE_FIELD])) {
            return out;
        }
        const placement = placementForRole(placementEnum, normalizeRole(out.role));
        if (placement === null || typeof out.content !== 'string') {
            return out;
        }
        return { ...out, content: cook(out.content, placement, { isPluginPrompt: true }) };
    });
}
