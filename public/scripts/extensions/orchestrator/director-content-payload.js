/**
 * Director content-payload module.
 *
 * One primitive consumed by the director runtime:
 *
 *   `createContentPayloadCache()` — per-session in-memory cache for the
 *   content payload captured via `GENERATE_TAKEOVER_DISPATCH`. The captured
 *   messages array is the chat-completion prompt ST assembled under the
 *   user's currently-active preset, and the director runtime splices it
 *   verbatim between `<story_context>` open/close system messages when it
 *   builds taskMessages for each agent dispatch (main or sub).
 *
 * See docs/superpowers/specs/2026-05-17-director-content-instruction-decoupling-design.md
 */

/**
 * @returns {{get: () => object|null, set: (payload: object) => void, clear: () => void}}
 */
export function createContentPayloadCache() {
    let payload = null;
    return {
        get() { return payload; },
        set(value) { payload = value; },
        clear() { payload = null; },
    };
}
