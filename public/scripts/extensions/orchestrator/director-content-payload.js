/**
 * Director content-payload module.
 *
 * Per-session in-memory cache that the director runtime consults each turn
 * for the chat-completion messages ST assembled under the user's active
 * preset. The director splices `payload.messages` verbatim between
 * `<story_context>` open/close system messages when it builds taskMessages
 * for each agent dispatch (main or sub).
 *
 * The cache stores the GENERATE_TAKEOVER_DISPATCH eventData reference (not
 * a snapshot of messages) and resolves `eventData.generateData.prompt` on
 * every get(). This matters because CHAT_COMPLETION_SETTINGS_READY is
 * emitted from the takeover branch in script.js *after* the
 * GENERATE_TAKEOVER_DISPATCH listener runs (the order is forced by the
 * takeover protocol — core can only know a takeover happened by emitting
 * dispatch first), and a chat-completion hook firing in that emit may
 * replace `generate_data.prompt` with a new array (e.g. ST-Prompt-Template
 * with `inject_loader_enabled` splices @INJECT entries into a fresh array).
 * Lazy resolution makes the cache always return the latest array reference,
 * including any post-dispatch hook substitutions.
 */

/**
 * @returns {{
 *   get: () => {messages: Array} | null,
 *   set: (source: {eventData: object}) => void,
 *   clear: () => void,
 * }}
 */
export function createContentPayloadCache() {
    let source = null;
    return {
        get() {
            if (!source) return null;
            const messages = source.eventData?.generateData?.prompt;
            return Array.isArray(messages) ? { messages } : null;
        },
        set(value) { source = value; },
        clear() { source = null; },
    };
}
