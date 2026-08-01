// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Memory-graph vector index — pure core layer.
//
// All side-effect-free helpers live here so they can be unit-tested without
// pulling in the embedding-service / connection-manager / DOM dependency
// chain. The IO shell (`vector-index.js`) wires these to the EmbeddingService
// for the actual `/api/vector/*` requests.

const VECTOR_COLLECTION_PREFIX = 'mg_';

/**
 * @typedef {{hash: number, text: string, index: number, nodeId?: string}} VectorInsertItem
 * @typedef {{hash: number, score: number, text: string, index: number, nodeId?: string, vector?: number[]}} VectorQueryHit
 * @typedef {Array<VectorQueryHit> & {__queryVector?: number[]}} VectorQueryResults
 */

/**
 * Pinned local copy of the xxhash-flavoured string hash used by the rest of
 * the project. Kept verbatim so the memory-graph hash domain doesn't shift
 * even when the IO-bound `public/scripts/utils.js` tightens its imports.
 *
 * @param {string} str
 * @param {number} [seed=0]
 * @returns {number}
 */
export function getStringHash(str, seed = 0) {
    if (typeof str !== 'string') {
        return 0;
    }

    let h1 = 0xdeadbeef ^ seed,
        h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }

    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Validate that an embedding profile is usable for vector operations.
 * @param {object|null} profile
 * @returns {{valid: boolean, error: string}}
 */
export function validateVectorConfig(profile) {
    if (!profile) return { valid: false, error: 'No embedding profile selected' };
    if (!profile.source) return { valid: false, error: 'Embedding profile has no source' };
    return { valid: true, error: '' };
}

/**
 * Build a stable collection ID for a chat.
 * @param {string} chatId
 * @param {string} [prefix]
 * @returns {string}
 */
export function buildCollectionId(chatId, prefix = VECTOR_COLLECTION_PREFIX) {
    const sanitized = String(chatId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${prefix}${sanitized}`;
}

const FALLBACK_FIELD_PRIORITY = {
    event: ['summary', 'key_sentences'],
    character_sheet: ['title', 'aliases', 'traits', 'identity', 'state', 'goal', 'core_note'],
    location_state: ['title', 'aliases', 'controller', 'state', 'danger', 'resources'],
    rule_constraint: ['title', 'constraint', 'scope', 'status'],
};

function resolveEmbeddingFields(nodeType, schema) {
    if (Array.isArray(schema)) {
        const typeSpec = schema.find(s => String(s?.id || '').toLowerCase() === nodeType);
        if (typeSpec) {
            if (Array.isArray(typeSpec.embeddingColumns) && typeSpec.embeddingColumns.length > 0) {
                return typeSpec.embeddingColumns.map(c => String(c || '').trim()).filter(Boolean);
            }
            if (Array.isArray(typeSpec.tableColumns) && typeSpec.tableColumns.length > 0) {
                return typeSpec.tableColumns.map(c => String(c || '').trim()).filter(Boolean);
            }
        }
    }
    return FALLBACK_FIELD_PRIORITY[nodeType] || [];
}

/**
 * Build the text representation of a node for embedding.
 * Uses schema-defined tableColumns/embeddingColumns for field priority,
 * falling back to hardcoded defaults per node type.
 *
 * @param {object} node
 * @param {Array} [schema]
 * @returns {string}
 */
export function buildNodeVectorText(node, schema) {
    if (!node || typeof node !== 'object') return '';
    const fields = node.fields || {};
    const nodeType = String(node.type || '').trim().toLowerCase();
    const priorityFields = resolveEmbeddingFields(nodeType, schema);
    const parts = [];

    const readFieldValue = (key) => {
        if (key === 'title') {
            return node.title || fields.title || fields.name || '';
        }
        return fields[key];
    };

    for (const key of priorityFields) {
        const value = readFieldValue(key);
        if (value == null || value === '') continue;
        if (Array.isArray(value)) {
            const joined = value.filter(Boolean).join(', ');
            if (joined) parts.push(joined);
        } else if (typeof value === 'object') {
            parts.push(JSON.stringify(value));
        } else {
            parts.push(String(value));
        }
    }

    for (const [key, value] of Object.entries(fields)) {
        if (priorityFields.includes(key)) continue;
        if (value == null || value === '' || key === 'embedding') continue;
        if (Array.isArray(value)) {
            const joined = value.filter(Boolean).join(', ');
            if (joined) parts.push(`${key}: ${joined}`);
        } else if (typeof value === 'object') {
            parts.push(`${key}: ${JSON.stringify(value)}`);
        } else {
            parts.push(`${key}: ${value}`);
        }
    }

    return parts.join(' | ').trim();
}

/**
 * Compute a stable hash for a node's vector content + profile. Used to detect
 * when a node needs re-embedding.
 *
 * @param {object} node
 * @param {object} profile
 * @param {Array} [schema]
 * @returns {number}
 */
export function buildNodeVectorHash(node, profile, schema) {
    const text = buildNodeVectorText(node, schema);
    const seqTo = Number(node?.seqTo) || 0;
    const payload = [
        node?.id || '',
        text,
        String(seqTo),
        profile?.source || '',
        profile?.model || '',
    ].join('::');
    return getStringHash(payload);
}

/**
 * Initialize or retrieve the vector index state on a store. State tracks which
 * nodes have been embedded and with what hash. Mutates the store in place if
 * the state slot is missing; returns the (possibly newly-created) state.
 *
 * @param {object} store
 * @returns {object}
 */
export function ensureVectorIndexState(store) {
    if (!store.vectorIndexState || typeof store.vectorIndexState !== 'object') {
        store.vectorIndexState = {
            source: '',
            model: '',
            collectionId: '',
            nodeToHash: {},
            hashToNodeId: {},
            dirty: false,
            lastWarning: '',
        };
    }
    return store.vectorIndexState;
}

function getEligibleVectorNodes(store, schema) {
    const nodes = store.nodes || {};
    return Object.values(nodes)
        .filter(node => !node.archived)
        .filter(node => !(Number(node.semanticDepth) > 0 || node.semanticRollup))
        .filter(node => buildNodeVectorText(node, schema).length > 0);
}

/**
 * Build the desired set of vector index entries for the current store,
 * keyed by content hash. Callers diff this against the server's actual hashes
 * to decide what to insert / delete.
 *
 * @param {object} store
 * @param {object} profile
 * @param {Array} [schema]
 * @returns {Map<number, {nodeId: string, hash: number, text: string, index: number}>}
 */
export function buildDesiredIndexEntries(store, profile, schema) {
    const eligible = getEligibleVectorNodes(store, schema);
    const byHash = new Map();
    for (const node of eligible) {
        const hash = buildNodeVectorHash(node, profile, schema);
        const text = buildNodeVectorText(node, schema);
        byHash.set(hash, { nodeId: node.id, hash, text, index: Number(node.seqTo) || 0 });
    }
    return byHash;
}

/**
 * Diff the desired index against the server's authoritative hash set.
 * Nothing is read from `state.nodeToHash` — the client's bookkeeping is not
 * a source of truth and can drift out of sync with the server (external
 * purge, silent partial insert failure, storage migration, etc.). The server
 * side answers "what hashes are actually stored" via `EmbeddingService.listHashes`.
 *
 * @param {Map<number, {nodeId: string, hash: number, text: string, index: number}>} desiredByHash
 * @param {Set<number>} remoteHashes - Hashes currently stored server-side.
 * @returns {{toInsert: Array, toDelete: number[], stats: {total: number, indexed: number, pending: number, stale: number}}}
 */
export function diffAgainstRemote(desiredByHash, remoteHashes) {
    const toInsert = [];
    const toDelete = [];
    let indexed = 0;
    let pending = 0;

    for (const [hash, entry] of desiredByHash) {
        if (remoteHashes.has(hash)) indexed++;
        else { toInsert.push(entry); pending++; }
    }

    for (const hash of remoteHashes) {
        if (!desiredByHash.has(hash)) toDelete.push(hash);
    }

    return {
        toInsert,
        toDelete,
        stats: {
            total: desiredByHash.size,
            indexed,
            pending,
            stale: toDelete.length,
        },
    };
}

export const VECTOR_COLLECTION_PREFIX_VALUE = VECTOR_COLLECTION_PREFIX;
