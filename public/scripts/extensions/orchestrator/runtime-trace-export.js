/**
 * Pure-data JSONL serialization for orchestration runtime traces.
 *
 * This module is intentionally decoupled from `runtime-trace.js`: it accepts
 * an already-collected events array (whatever shape the trace producer stored)
 * and emits a string that can be downloaded, written to disk, or piped to
 * external tooling. Decoupling keeps the test runner usable — `runtime-trace.js`
 * pulls `lib.js` transitively and is not importable under the Node-based Jest
 * config we ship with the orchestrator suite.
 *
 * Events are serialized one per line, in input order, with a trailing newline
 * after each entry (standard JSONL framing). Any single event that fails
 * `JSON.stringify` (cyclic references, BigInt, etc.) is silently dropped so
 * one malformed event cannot corrupt the entire export.
 *
 * The browser-only `downloadRunTraceAsJsonl` helper wraps the serializer in a
 * Blob + anchor click, the same pattern `public/scripts/utils.js::download`
 * uses for ad-hoc text exports.
 */

/**
 * Serialize an events array as a JSONL (newline-delimited JSON) string.
 *
 * Each element of `events` is `JSON.stringify`'d on its own line. Events that
 * raise during stringification (cycles, non-serializable values) are dropped
 * silently — the export never throws, never produces a partial line.
 *
 * The result has a trailing newline so concatenating multiple exports
 * preserves framing.
 *
 * @param {Array<object>} events
 * @returns {string} JSONL document; '' when input is empty or non-array.
 */
export function exportRunTraceAsJsonl(events) {
    if (!Array.isArray(events) || events.length === 0) {
        return '';
    }
    const lines = [];
    for (const event of events) {
        const line = safeStringify(event);
        if (line !== null) {
            lines.push(line);
        }
    }
    if (lines.length === 0) {
        return '';
    }
    return lines.join('\n') + '\n';
}

/**
 * Trigger a browser download of the events as a JSONL file. No-op outside
 * a browser (no `document` / `Blob` / `URL.createObjectURL`).
 *
 * @param {Array<object>} events
 * @param {string} [filename='orch-run.jsonl']
 * @returns {boolean} true if the download was triggered, false on no-op.
 */
export function downloadRunTraceAsJsonl(events, filename = 'orch-run.jsonl') {
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
        return false;
    }
    const body = exportRunTraceAsJsonl(events);
    if (!body) {
        return false;
    }
    const blob = new Blob([body], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = String(filename || 'orch-run.jsonl');
        anchor.click();
    } finally {
        URL.revokeObjectURL(url);
    }
    return true;
}

function safeStringify(value) {
    try {
        const out = JSON.stringify(value);
        return typeof out === 'string' ? out : null;
    } catch {
        return null;
    }
}
