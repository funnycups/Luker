/**
 * iteration-library — runner primitives.
 *
 * Re-exports the low-level LLM call mechanics from public/scripts/lib/. This
 * file exposes the documented runner surface. Consumers needing other
 * lib helpers import their submodules directly.
 *
 * Conversation-state advancement (`session.messages.push`, turn-by-turn
 * state machine) is owned by the plugin popups.
 */

export {
    requestToolCallsWithRetry,
    buildExecutionToolCalls,
    buildPendingToolResults,
    buildPersistentToolCallsFromRawCalls,
    buildPersistentToolHistoryMessages,
    collectIterToolCallIds,
    createPersistentToolTurnMessage,
    makeAiIterationMessageId,
} from '../lib/iter-tool-calling.js';

export * as abortUtils from '../lib/abort-utils.js';
