// public/scripts/run-panel/index.js
/**
 * Shared Run Panel — reusable run-trace infrastructure.
 *
 * Three-layer API exposure:
 *   Layer 1 — direct ESM import (in-tree extensions)
 *   Layer 2 — lukerContext.runPanel
 *   Layer 3 — Luker.getContext().runPanel
 */

export { createRunStore } from './store.js';
export { createRunPanel } from './panel.js';
export { PanelRenderer, DEFAULT_KIND_ICONS } from './render-incremental.js';
export * as events from './events.js';
export { withRound, withStreamingSection } from './helpers.js';
export {
    HISTORY_KEY,
    runKeyOf,
    parseRunKey,
    serializeRunTrace,
    createMemoryStorage,
    createRecorder,
} from './recorder.js';
export {
    ensureDockStyles,
    createDock,
    attachDock,
    openRunDock,
    toggleRunDock,
    getRunRecorder,
} from './dock.js';
export { registerRunPanelLocaleData } from './locale-data.js';
