/**
 * IterationStudio — public API.
 *
 * Layer 1 (direct import for in-repo extensions):
 *   import { open, defineAdapter, createSettingsBackedHistoryStore } from '/scripts/iteration-studio/index.js';
 *
 * Layer 2 (recommended for third-party extensions):
 *   const { open, defineAdapter, createSettingsBackedHistoryStore } = SillyTavern.getContext().iterationStudio;
 *
 * See `adapter.js` for the ProfileAdapter contract and
 * `docs/development/extension-api/iteration-studio.md` for the full
 * walkthrough.
 */

export { openIterationStudio as open } from './studio.js';

export {
    createSettingsBackedHistoryStore,
    defineAdapter,
    createEmptyHistoryState,
    makeSessionId,
} from './session.js';

export {
    buildProfileDelta,
    renderProfileDeltaHtml,
} from './delta.js';

export {
    buildControlToolDefs,
    getControlToolNames,
    runIterationTurn,
    applyApprovedToolCalls,
    buildAutoContinuePrompt,
} from './runner.js';
