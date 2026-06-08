/**
 * Backwards-compat shim. The real implementation lives in the shared
 * iteration-library text-diff module so all adapters (orchestrator's
 * spec/agenda/loop plus memory-graph schema plus any future studio)
 * share one renderer.
 *
 * Kept here so orchestrator-internal consumers don't have to update
 * import paths.
 */

export {
    renderInlineTextDiffHtml as renderIterationLineDiffHtml,
    sanitizeDiffPlaceholderValue,
    formatDiffValue,
} from '../../iteration-library/text-diff.js';
