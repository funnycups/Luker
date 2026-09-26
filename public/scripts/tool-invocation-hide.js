/**
 * Prompt-time decision for historical tool-invocation records.
 *
 * Closed tasks (an assistant turn finished with `stop`, or a legacy turn that
 * never stored a finish reason) still drop records whose owner was hidden.
 * The open tail — everything after the last closing assistant, i.e. the task
 * that has not received `stop` yet — must keep its tool records. Stripping
 * them mid-task makes the model call the same tools again.
 *
 * No DOM, no SillyTavern globals — import-safe for jest.
 */

/**
 * @param {any} message
 * @returns {boolean}
 */
export function isInvocationSummaryMessage(message) {
    return message?.extra?.isSmallSys === true
        && Array.isArray(message.extra.tool_invocations)
        && message.extra.tool_invocations.length > 0;
}

/**
 * A model turn, including one later marked `is_system` by /hide.
 * Skips users, invocation summaries, and typed system injections (narrator,
 * comment, …) so those cannot close a tool task.
 * @param {any} message
 * @returns {boolean}
 */
export function isModelAssistantTurn(message) {
    if (!message || message.is_user) {
        return false;
    }
    if (isInvocationSummaryMessage(message) || message.extra?.isSmallSys) {
        return false;
    }
    if (typeof message.extra?.type === 'string' && message.extra.type.length > 0) {
        return false;
    }
    return true;
}

/**
 * Whether this assistant turn closes a tool task.
 * Missing `finish_reason` counts as closed so chats written before the field
 * existed keep the hide cascade. Only an explicit non-`stop` reason
 * (`tool_calls`, `length`, …) leaves the task open.
 * @param {any} message
 * @returns {boolean}
 */
export function isTaskClosingAssistant(message) {
    if (!isModelAssistantTurn(message)) {
        return false;
    }
    const reason = message.extra?.finish_reason;
    if (reason == null || String(reason).trim() === '') {
        return true;
    }
    return String(reason).trim() === 'stop';
}

/**
 * Index of the first message in the open tool-task tail.
 * `rawChat.length` when every assistant turn has already closed.
 * @param {any[]} rawChat
 * @returns {number}
 */
export function getOpenToolTaskTailStart(rawChat) {
    if (!Array.isArray(rawChat) || rawChat.length === 0) {
        return 0;
    }
    let lastClose = -1;
    for (let i = 0; i < rawChat.length; i++) {
        if (isTaskClosingAssistant(rawChat[i])) {
            lastClose = i;
        }
    }
    return lastClose + 1;
}

/**
 * How a tool-invocation summary should be treated at prompt-build time.
 * `drop` removes it. `merge` folds it into the owning assistant turn.
 * `keep` leaves it standalone so the wire expander can still emit
 * `tool_calls` + `role:tool`.
 *
 * @param {object} args
 * @param {boolean} args.inOpenTail Summary belongs to the task that has not received `stop`
 * @param {boolean} args.ownerHidden Owner is /hide'd or carries the ignore symbol
 * @param {boolean} args.ownerPresent Owner survived into the post-filter chat
 * @param {boolean} args.ownerBlank Owner text is empty and it has no reasoning
 * @param {boolean} args.ownerMergeable Owner is an assistant turn the merger may absorb into
 * @returns {'drop'|'keep'|'merge'}
 */
export function classifyInvocationSummary({
    inOpenTail = false,
    ownerHidden = false,
    ownerPresent = false,
    ownerBlank = false,
    ownerMergeable = false,
} = {}) {
    // Mid-task: never delete the record. Do not merge into a hidden owner —
    // that owner is filtered out of the prompt and would take the calls with it.
    if (inOpenTail) {
        if (ownerHidden || !ownerPresent || !ownerMergeable) {
            return 'keep';
        }
        return 'merge';
    }
    if (ownerHidden || (ownerPresent && ownerBlank)) {
        return 'drop';
    }
    if (ownerPresent && ownerMergeable) {
        return 'merge';
    }
    return 'keep';
}
