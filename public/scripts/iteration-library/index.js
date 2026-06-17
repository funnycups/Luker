/**
 * iteration-library — public API umbrella.
 *
 * Three-layer surface (per spec §15):
 *   Layer 1 (direct):       import { ... } from '/scripts/iteration-library/index.js';
 *   Layer 2 (lukerContext): const { ... } = lukerContext.iterationLibrary;
 *   Layer 3 (getContext):   const { ... } = Luker.getContext().iterationLibrary;
 *
 * Stage 1 deliverable. The legacy `iterationStudio.*` surface stays
 * exposed throughout Stages 1–5 (dual-track period). First access to
 * `iterationStudio` triggers a deprecation warning routed to console.
 */

export {
    applyEdits,
    inverseEdit,
    registerOp,
    BUILT_IN_OPS,
} from '../lib/edits/index.js';

export { showConflictResolution } from '../lib/edits/conflict-ui.js';

export * as render from './render.js';
export * as runner from './runner.js';
export * as storage from './storage.js';
export * as textDiff from './text-diff.js';
export * as zoomOverlay from './zoom-overlay.js';
export * as ui from './ui/index.js';
export * as tools from './tools/index.js';
export * as proposalBus from './proposal-bus/index.js';

export { bindIterWorkspaceResizer } from './workspace-resizer.js';
export { createRenderScheduler } from './render-scheduler.js';
