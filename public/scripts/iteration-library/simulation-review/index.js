// Public entry for the simulation-review module. Wraps popup.js +
// feedback-builder.js so callers get a single function that turns a
// per-mode payload into a tagged-text tool result.

import { openSimulationReview as openPopup } from './popup.js';
import { buildSimulationToolResult } from './feedback-builder.js';
import { ensureSimulationReviewStylesheetInjected } from './styles.js';

/**
 * @param {{
 *   kind: string,
 *   payload: any,
 *   worldInfoHits?: any[],
 *   i18n: (key: string, fallback?: string) => string,
 *   abortSignal?: AbortSignal,
 *   onRerun?: () => Promise<{ payload: any, worldInfoHits?: any[] } | null>,
 * }} args
 * @returns {Promise<{ok:boolean, cancelled:boolean, toolResultText:string, annotations:any[], chainText:string}>}
 */
export async function openSimulationReview(args) {
    const { kind, payload, worldInfoHits = [], i18n, abortSignal, onRerun } = args;
    ensureSimulationReviewStylesheetInjected();
    // World-info hits travel with each successful re-run and need to flow
    // into the final tool result, but the popup itself only knows about
    // payload geometry. Track the latest hits locally and hand the popup
    // a wrapped onRerun that strips worldInfoHits before forwarding.
    let currentWorldInfoHits = worldInfoHits;
    const wrappedOnRerun = (typeof onRerun === 'function')
        ? async () => {
            const next = await onRerun();
            if (!next) return null;
            if (Array.isArray(next.worldInfoHits)) {
                currentWorldInfoHits = next.worldInfoHits;
            }
            return { payload: next.payload };
        }
        : null;
    try {
        const popupResult = await openPopup({
            kind,
            payload,
            i18n,
            abortSignal,
            onRerun: wrappedOnRerun,
        });
        const toolResultText = buildSimulationToolResult({
            kind,
            cancelled: popupResult.cancelled,
            error: null,
            chainSegments: popupResult.chainSegments,
            annotations: popupResult.annotations,
            worldInfoHits: currentWorldInfoHits,
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
