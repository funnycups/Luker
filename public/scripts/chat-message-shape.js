/*
 * Shared payload shaping for chat completion messages.
 *
 * Both ChatCompletion.getChat() and MessageCollection.getChat() must produce
 * byte-identical {role, name, content, tool_calls, tool_call_id, ...} objects,
 * so the field spread lives here once instead of in two drifting copies.
 */

/**
 * Shape a Message-like object into the wire payload sent to chat completion
 * endpoints.
 *
 * Anthropic's /v1/messages rejects any property outside its message schema
 * (role, content, name-inside-tool-blocks). Root-level `reasoning`,
 * `reasoning_details`, and `signature` are not accepted; Extended Thinking
 * signatures travel inside the `thinking` content block, which the
 * server-side Claude converter reconstructs from `reasoning_blocks` alone.
 * So for CLAUDE we emit `reasoning_blocks` only and drop the
 * OAI/OpenRouter/Gemini-shaped sidecars. All other providers still consume
 * them: DeepSeek/Doubao read root `reasoning`
 * (prompt-converters.js ensureDeepSeekReasoningContent), Gemini 2.5/3 read
 * root `signature` (convertGooglePrompt), OpenRouter reads
 * `reasoning_details` (prompt-converters.js addOpenRouterSignatures).
 *
 * @param {object} message Message instance (or plain object with the same fields)
 * @param {boolean} isClaude Whether the target is the Claude /v1/messages schema
 * @returns {object} Wire-shaped message payload
 */
export function shapeChatMessagePayload(message, isClaude) {
    return {
        role: message.role,
        content: message.content,
        ...(message.name && { name: message.name }),
        ...(message.tool_calls && { tool_calls: message.tool_calls }),
        ...(message.role === 'tool' ? { tool_call_id: message.identifier } : {}),
        ...(!isClaude && message.signature && { signature: message.signature }),
        ...(!isClaude && message.reasoning && { reasoning: message.reasoning }),
        ...(Array.isArray(message.reasoning_blocks) && message.reasoning_blocks.length > 0 ? { reasoning_blocks: message.reasoning_blocks } : {}),
        ...(!isClaude && Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0 ? { reasoning_details: message.reasoning_details } : {}),
    };
}
