/**
 * Pure helpers for memory-graph export / import flows.
 *
 * The orchestration (`importMemoryGraphStore`, `promptMemoryGraphImportMode`,
 * `deleteMemoryStoreByTarget`) intentionally stays in main.js because it
 * threads runtime caches (memoryStoreTargets, latestRecallSnapshot,
 * rollbackHistoryCache) and UI helpers (notifyError, refreshUiStats,
 * callGenericPopup). What's extracted here is the side-effect-free shape
 * work: filename generation, store binding/clearing, floor lookup. Those
 * are the parts that benefit from isolation — they're trivially testable
 * and shared across import + export paths.
 *
 * Depends only on persistence transformations (normalizeStoreForRuntime,
 * getStoreCoveredSeqTo) and the `context.chat` array. No DOM, no events,
 * no extension settings.
 */

import {
    normalizeStoreForRuntime,
    getStoreCoveredSeqTo,
} from './persistence.js';

/**
 * Strip a candidate filename part down to a portable subset:
 * drop the trailing extension, replace anything outside
 * `[a-z0-9._-]` with underscores, and trim leading/trailing
 * underscores. Falls back to `fallback` when the result would be empty.
 */
export function sanitizeMemoryGraphFileNamePart(value, fallback = 'current-chat') {
    const sanitized = String(value || '')
        .trim()
        .replace(/\.[^/.]+$/, '')
        .replace(/[^a-z0-9._-]+/gi, '_')
        .replace(/^_+|_+$/g, '');
    return sanitized || fallback;
}

/**
 * Compose the default export filename for a given memory target.
 * Group chats are keyed by id; solo chats by file_name.
 *
 * @param {{is_group?: boolean, id?: string, file_name?: string}|null} target
 */
export function getMemoryGraphExportFileName(target) {
    if (!target) {
        return 'memory-graph-current-chat.json';
    }
    if (target.is_group) {
        return `memory-graph-group-${sanitizeMemoryGraphFileNamePart(target.id)}.json`;
    }
    return `memory-graph-${sanitizeMemoryGraphFileNamePart(target.file_name)}.json`;
}

/**
 * Coverage watermark embedded in an exported store. Used by the import
 * popup to show the user the floor the export was bound to.
 */
export function getImportedStoreBindingFloor(store) {
    const normalized = normalizeStoreForRuntime(store);
    return getStoreCoveredSeqTo(normalized);
}

/**
 * Strip non-portable runtime state from an imported store.
 *
 * Recall traces, projection caches, and extraction debug payloads are
 * tied to a specific chat's prompt history; they only confuse a
 * different chat (or a re-imported same chat). Returns a normalized
 * runtime store with those fields cleared, ready to write.
 */
export function clearImportedStoreTransientState(store) {
    const normalized = normalizeStoreForRuntime(store);
    normalized.lastRecallTrace = [];
    normalized.lastRecallProjection = null;
    normalized.lastExtractionDebug = null;
    return normalized;
}

/**
 * Rewrite an imported store so every node binds to a single assistant
 * floor in the destination chat.
 *
 * Used by the "Bind Latest" / "Bind Specific" import modes when the
 * caller wants to graft a foreign memory graph onto the current chat
 * timeline rather than restore exported floor numbers verbatim.
 *
 * Mutates and returns a normalized clone — callers should treat the
 * input as read-only.
 */
export function bindImportedStoreToAssistantFloor(store, bindSeq) {
    const normalized = clearImportedStoreTransientState(store);
    const targetSeq = Math.max(1, Math.floor(Number(bindSeq || 0)));
    for (const node of Object.values(normalized.nodes || {})) {
        if (!node || typeof node !== 'object') {
            continue;
        }
        node.seqTo = targetSeq;
    }
    normalized.appliedSeqTo = targetSeq;
    normalized.seqCounter = targetSeq;
    normalized.loggedSeqTo = targetSeq;
    return normalized;
}
