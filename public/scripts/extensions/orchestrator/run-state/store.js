// public/scripts/extensions/orchestrator/run-state/store.js
/**
 * Orchestrator's run-state store — a thin instance over the shared
 * run-panel store factory. The four runtimes import the named methods
 * from here; the panel imports the default instance.
 */

import { createRunStore } from '/scripts/run-panel/store.js';

const store = createRunStore();

export const {
    subscribe,
    getCurrentRun,
    startRun,
    clearCurrentRun,
    appendRound,
    setRoundStatus,
    ensureSection,
    appendToSection,
    setSectionStatus,
    finishRun,
    setRunMeta,
    addTokenUsage,
} = store;

export default store;
