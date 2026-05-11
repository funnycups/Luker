/**
 * Backwards-compat shim. The real implementation now lives in the shared
 * iteration-studio module so all adapters (orchestrator's spec/agenda/loop
 * plus memory-graph schema plus any future studio) share one renderer.
 *
 * Kept here so orchestrator-internal consumers (`runtime-trace-render.js`,
 * `main.js` second-diff usage) don't have to update import paths.
 */

export {
    renderInlineTextDiffHtml as renderIterationLineDiffHtml,
    sanitizeDiffPlaceholderValue,
    formatDiffValue,
} from '../../iteration-studio/inline-text-diff.js';
