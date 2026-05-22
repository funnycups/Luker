/**
 * iteration-library — runner primitives.
 *
 * Re-exports the low-level LLM call mechanics from public/scripts/lib/. This
 * file is the library's umbrella; plugin-owned popups should import from
 * here rather than digging into `lib/iter-tool-calling.js` directly so the
 * public surface has a single stable home.
 *
 * Stage 1 deliberately does NOT extract conversation-state advancement
 * (`session.messages.push`, turn-by-turn state machine) from
 * iteration-studio/runner.js — that logic is UI-layer per spec §12 and
 * stays in the shell until the relevant plugin owns its own popup.
 */

export {
    requestToolCallsWithRetry,
    buildExecutionToolCalls,
    buildPendingToolResults,
    buildPersistentToolCallsFromRawCalls,
    buildPersistentToolHistoryMessages,
    createPersistentToolTurnMessage,
    makeAiIterationMessageId,
} from '../lib/iter-tool-calling.js';

export * as abortUtils from '../lib/abort-utils.js';
