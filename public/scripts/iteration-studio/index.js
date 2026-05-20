/**
 * IterationStudio — public API (v2, IDE-style).
 *
 * Layer 1 (direct import for in-repo extensions):
 *   import { openIterationStudio, defineAdapter, createEmptyHistoryState, makeSessionId } from '/scripts/iteration-studio/index.js';
 *
 * Layer 2 (lukerContext property):
 *   const { openIterationStudio, defineAdapter } = lukerContext.iterationStudio;
 *
 * Layer 3 (third-party via getContext):
 *   const { open, defineAdapter } = SillyTavern.getContext().iterationStudio;
 *
 * See `adapter.js` for the Adapter contract and
 * `docs/development/extension-api/iteration-studio.md` for the walkthrough.
 */

export { openIterationStudio, openIterationStudio as open } from './studio.js';

export {
    defineAdapter,
    createEmptySession,
    createEmptyHistoryState,
    makeSessionId,
    sanitizeSession,
    sanitizeSessionMessage,
    findMessageById,
} from './session.js';

export {
    buildControlToolDefs,
    getControlToolNames,
    runIterationTurn,
    executeToolCalls,
    stagePendingApproval,
    applyPendingApproval,
    rejectPendingApproval,
    rollbackToMessage,
    buildAutoContinuePrompt,
} from './runner.js';

export { ensureStorageWipeOnce } from './storage-migration.js';
