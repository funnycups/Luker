/**
 * Macro escape lifecycle — sink-stage utilities.
 *
 * The macro engine treats `\{{...}}` as a literal escape: the lexer recognizes
 * `\{` / `\}` as plaintext (see `MacroLexer.js`'s `Plaintext` token), so an
 * escaped opener never starts a macro. This means side-effect macros taught as
 * teaching examples in world book entries (`\{{setvar::name::value}}`) survive
 * any number of intermediate `substituteParams` passes without firing.
 *
 * The remaining job is to strip the leading backslash *exactly once*, at the
 * boundary where the prompt is handed to the LLM. After that strip, the model
 * sees a literal `{{setvar::...}}` it can copy verbatim into its reply, which
 * the op-log scanner then matches and applies (the scanner also honours the
 * `\{{` escape, so a backslash leaking into model output silently breaks
 * variable updates).
 *
 * Kept pure so it can be node-tested without the macro runtime.
 */

/**
 * Strip a single leading backslash from any `\{` or `\}` occurrence in the
 * input string. Other characters pass through untouched. Non-string inputs are
 * returned as-is so this can be applied unconditionally to OpenAI-style
 * message content fields (which may legitimately be `null`, an array of
 * content blocks, etc.).
 *
 * @template T
 * @param {T} text
 * @returns {T}
 */
export function unescapeMacroBraces(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/\\([{}])/g, '$1');
}

/**
 * Apply `unescapeMacroBraces` across an OpenAI-style messages array. String
 * `content` fields are unescaped; multimodal content blocks (`{type: 'text',
 * text}` / `{type: 'image_url', ...}`) have their `text` parts unescaped while
 * non-text blocks pass through. The input array is not mutated.
 *
 * Returns the input as-is when it isn't an array, so callers can apply this
 * unconditionally before sending a request body to a generation backend.
 *
 * @template T
 * @param {T} messages
 * @returns {T}
 */
export function unescapeMacroBracesInMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map(msg => {
        if (!msg || typeof msg !== 'object') return msg;
        const content = msg.content;
        if (typeof content === 'string') {
            return { ...msg, content: unescapeMacroBraces(content) };
        }
        if (Array.isArray(content)) {
            return {
                ...msg,
                content: content.map(block => {
                    if (block && typeof block === 'object' && typeof block.text === 'string') {
                        return { ...block, text: unescapeMacroBraces(block.text) };
                    }
                    return block;
                }),
            };
        }
        return msg;
    });
}

/**
 * Sink-stage convenience: prepare a request body destined for a generation
 * backend by unescaping macro braces in any string fields the backend reads
 * as prompt. Returns a shallow copy with `messages` (chat-completion shape)
 * and / or `prompt` (text-completion shape) sanitized; other fields are
 * passed through unchanged. The input object is not mutated.
 *
 * Apply this exactly once at the boundary right before `JSON.stringify(body)`
 * — never in intermediate stages, otherwise `\{{...}}` escape state in
 * authoring sources (world book entries, character fields, etc.) is lost
 * before reaching the sink.
 *
 * @template T
 * @param {T} data
 * @returns {T}
 */
export function unescapeMacroBracesInRequestData(data) {
    if (!data || typeof data !== 'object') return data;
    const out = { ...data };
    if (Array.isArray(out.messages)) {
        out.messages = unescapeMacroBracesInMessages(out.messages);
    }
    if (typeof out.prompt === 'string') {
        out.prompt = unescapeMacroBraces(out.prompt);
    }
    return out;
}
