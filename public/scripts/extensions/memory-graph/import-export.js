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

const SCHEMA_EXPORT_TYPE = 'luker-memory-graph-schema';
const SCHEMA_EXPORT_VERSION = 1;

/**
 * Compose the default export filename for a schema. Filename encodes scope
 * so users can tell global vs character-bound exports apart at a glance.
 */
export function getSchemaExportFileName(scopeInfo) {
    if (scopeInfo?.hasOverride) {
        const tag = sanitizeMemoryGraphFileNamePart(
            scopeInfo.characterName || scopeInfo.avatar,
            'character',
        );
        return `memory-graph-schema-character-${tag}.json`;
    }
    return 'memory-graph-schema-global.json';
}

/**
 * Build a portable export payload from an in-editor schema array. The
 * payload always carries an explicit type+version marker so future format
 * changes can migrate cleanly. `scopeInfo` is informational metadata —
 * import does NOT auto-write to that scope; the user picks where to save.
 */
export function buildSchemaExportPayload(schema, scopeInfo, normalizeNodeTypeSchema) {
    const normalized = normalizeNodeTypeSchema(schema);
    return {
        type: SCHEMA_EXPORT_TYPE,
        version: SCHEMA_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        scope: scopeInfo?.hasOverride ? 'character' : 'global',
        characterName: scopeInfo?.hasOverride
            ? String(scopeInfo.characterName || scopeInfo.avatar || '')
            : '',
        schema: normalized,
    };
}

/**
 * Parse and validate an imported schema payload. Returns the normalized
 * schema array on success; throws an Error with a translatable key on
 * failure so the caller can surface a clean message.
 *
 * Accepts both the wrapped {type, schema} envelope and a raw array (for
 * compatibility with users hand-editing a file).
 */
export function parseSchemaImportPayload(parsed, normalizeNodeTypeSchema) {
    if (Array.isArray(parsed)) {
        const normalized = normalizeNodeTypeSchema(parsed);
        if (!Array.isArray(normalized) || normalized.length === 0) {
            throw new Error('Invalid schema file: schema array missing or empty.');
        }
        return normalized;
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid schema file: missing or wrong type marker.');
    }
    if (String(parsed.type || '') !== SCHEMA_EXPORT_TYPE) {
        throw new Error('Invalid schema file: missing or wrong type marker.');
    }
    const schema = parsed.schema;
    if (!Array.isArray(schema) || schema.length === 0) {
        throw new Error('Invalid schema file: schema array missing or empty.');
    }
    const normalized = normalizeNodeTypeSchema(schema);
    if (!Array.isArray(normalized) || normalized.length === 0) {
        throw new Error('Invalid schema file: schema array missing or empty.');
    }
    return normalized;
}
