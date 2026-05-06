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
 * uses for ad-hoc text exports. Callers that need to write traces to a server
 * path (the future `settings.persistTrace` auto-disk feature) should call
 * `exportRunTraceAsJsonl` directly and route the resulting string through the
 * appropriate filesystem helper themselves.
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

/**
 * Optional auto-persist sink: write a finalized trace's events to a JSONL
 * file under the user's data directory and prune the directory to the
 * most-recent N runs (LRU). Wired off `extension_settings.orchestrator.
 * persistTrace`.
 *
 * NEEDS_CONTEXT — the sink is currently a no-op because SillyTavern does
 * not expose a public file API that satisfies all three requirements:
 *
 *   1. arbitrary text writes by an extension (the existing
 *      `/api/files/upload` endpoint validates the filename against
 *      `/^[a-zA-Z0-9_\-.]+$/` so subdirectories like `luker-orch-runs/...`
 *      are rejected — the best we could do is a flat namespace such as
 *      `luker-orch-runs-<runId>.jsonl`),
 *   2. a listing endpoint so we can enumerate prior runs and delete the
 *      oldest 50+ — `/api/files/upload` and `/api/files/delete` exist but
 *      no `/api/files/list` companion does, so LRU pruning would have to
 *      track filenames out-of-band in `localStorage` / `extension_settings`
 *      and trust them to stay in sync with the filesystem,
 *   3. graceful degradation when SillyTavern is run via a plain
 *      `index.html` open without the Node backend (the test environment).
 *
 * Until a backend helper lands, the on-demand JSONL download (the
 * `downloadRunTraceAsJsonl` button in the trace popup, Task 13) covers
 * the practical "I want to grep my run later" workflow without any disk
 * writes. This stub stays in place so callers can opt in early — the day
 * an upstream API lands, only this function changes.
 *
 * @param {Array<object>} _events trace events to persist (ignored in stub)
 * @param {object} [_options]
 * @param {string} [_options.runId] used as filename basename when implemented
 * @param {number} [_options.maxRuns=50] LRU keep count when implemented
 * @returns {Promise<{persisted: false, reason: string}>} always not-persisted
 */
export async function persistRunTraceToDisk(_events, _options = {}) {
    return {
        persisted: false,
        reason: 'NEEDS_CONTEXT: no SillyTavern endpoint supports per-extension JSONL writes with LRU listing yet.',
    };
}

function safeStringify(value) {
    try {
        const out = JSON.stringify(value);
        return typeof out === 'string' ? out : null;
    } catch {
        return null;
    }
}
