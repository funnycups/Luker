/**
 * iteration-library — public API umbrella.
 *
 * Three-layer surface:
 *   Layer 1 (direct):       import { ... } from '/scripts/iteration-library/index.js';
 *   Layer 2 (lukerContext): const { ... } = lukerContext.iterationLibrary;
 *   Layer 3 (getContext):   const { ... } = Luker.getContext().iterationLibrary;
 */

export {
    applyEdits,
    inverseEdit,
    registerOp,
    BUILT_IN_OPS,
} from '../lib/edits/index.js';

export { showConflictResolution } from '../lib/edits/conflict-ui.js';

import { ensureMarkdownDeps, renderMessageMarkdown } from './render.js';
import {
    STYLESHEET_HREF,
    STYLESHEET_ID,
    ensureStylesheetInjected,
    formatDiffValue,
    renderInlineTextDiffElement,
    renderInlineTextDiffHtml,
    sanitizeDiffPlaceholderValue,
} from './text-diff.js';

export const render = Object.freeze({
    ensureMarkdownDeps,
    renderMessageMarkdown,
});
export * as runner from './runner.js';
export const textDiff = Object.freeze({
    STYLESHEET_HREF,
    STYLESHEET_ID,
    ensureStylesheetInjected,
    formatDiffValue,
    renderInlineTextDiffElement,
    renderInlineTextDiffHtml,
    sanitizeDiffPlaceholderValue,
});
export * as zoomOverlay from './zoom-overlay.js';
export * as ui from './ui/index.js';
export * as tools from './tools/index.js';
export * as proposalBus from './proposal-bus/index.js';

export { bindIterWorkspaceResizer } from './workspace-resizer.js';
export { createRenderScheduler } from './render-scheduler.js';
