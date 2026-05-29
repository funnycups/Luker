// Public entry for the simulation-review module. Wraps popup.js +
// feedback-builder.js so callers get a single function that turns a
// per-mode payload into a tagged-text tool result.

import { openSimulationReview as openPopup } from './popup.js';
import { buildSimulationToolResult } from './feedback-builder.js';

/**
 * @param {{
 *   kind: string,
 *   payload: any,
 *   worldInfoHits?: any[],
 *   i18n: (key: string, fallback?: string) => string,
 *   abortSignal?: AbortSignal,
 * }} args
 * @returns {Promise<{ok:boolean, cancelled:boolean, toolResultText:string, annotations:any[], chainText:string}>}
 */
export async function openSimulationReview(args) {
    const { kind, payload, worldInfoHits = [], i18n, abortSignal } = args;
    try {
        const popupResult = await openPopup({ kind, payload, i18n, abortSignal });
        const toolResultText = buildSimulationToolResult({
            kind,
            cancelled: popupResult.cancelled,
            error: null,
            chainSegments: popupResult.chainSegments,
            annotations: popupResult.annotations,
            worldInfoHits,
        });
        return {
            ok: popupResult.ok,
            cancelled: popupResult.cancelled,
            toolResultText,
            annotations: popupResult.annotations,
            chainText: toolResultText,
        };
    } catch (err) {
        const reason = err?.code || 'simulation_failed';
        const toolResultText = buildSimulationToolResult({
            kind,
            cancelled: false,
            error: { reason, message: String(err?.message || err) },
        });
        return { ok: false, cancelled: false, toolResultText, annotations: [], chainText: toolResultText };
    }
}

export { buildSimulationToolResult };
