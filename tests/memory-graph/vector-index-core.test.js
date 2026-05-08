/**
 * Pure-function tests for
 * public/scripts/extensions/memory-graph/vector-index-core.js.
 *
 * Covers:
 *   - validateVectorConfig
 *   - buildCollectionId (chat-id sanitization, prefix override)
 *   - getStringHash (stability + non-string handling)
 *   - buildNodeVectorText: schema priority, fallback priority, title fallback,
 *     array/object/scalar field handling, omitted/empty fields
 *   - buildNodeVectorHash: composition, profile-sensitivity, seqTo handling
 *   - ensureVectorIndexState: idempotency, mutation in place
 *   - computeVectorSyncPlan: insert/delete classification, eligibility filter
 */

import { describe, test, expect } from '@jest/globals';
import {
    getStringHash,
    validateVectorConfig,
    buildCollectionId,
    buildNodeVectorText,
    buildNodeVectorHash,
    ensureVectorIndexState,
    computeVectorSyncPlan,
} from '../../public/scripts/extensions/memory-graph/vector-index-core.js';

describe('validateVectorConfig', () => {
    test('rejects null/undefined', () => {
        expect(validateVectorConfig(null)).toEqual({ valid: false, error: 'No embedding profile selected' });
        expect(validateVectorConfig(undefined)).toEqual({ valid: false, error: 'No embedding profile selected' });
    });

    test('rejects profile without source', () => {
        expect(validateVectorConfig({})).toMatchObject({ valid: false });
        expect(validateVectorConfig({ source: '' })).toMatchObject({ valid: false });
        expect(validateVectorConfig({ name: 'x' })).toMatchObject({ valid: false });
    });

    test('accepts profile with source', () => {
        expect(validateVectorConfig({ source: 'openai' })).toEqual({ valid: true, error: '' });
        expect(validateVectorConfig({ source: 'transformers', model: '' })).toEqual({ valid: true, error: '' });
    });
});

describe('buildCollectionId', () => {
    test('uses default mg_ prefix', () => {
        expect(buildCollectionId('chat-1')).toBe('mg_chat-1');
    });

    test('honours custom prefix', () => {
        expect(buildCollectionId('chat-1', 'pre_')).toBe('pre_chat-1');
    });

    test('sanitizes characters outside [A-Za-z0-9_-]', () => {
        expect(buildCollectionId('chat/with spaces+ special?')).toBe('mg_chat_with_spaces__special_');
    });

    test('falls back to "default" for empty/falsy chat ids', () => {
        expect(buildCollectionId('')).toBe('mg_default');
        expect(buildCollectionId(null)).toBe('mg_default');
        expect(buildCollectionId(undefined)).toBe('mg_default');
    });

    test('coerces non-strings via String()', () => {
        expect(buildCollectionId(42)).toBe('mg_42');
    });
});

describe('getStringHash', () => {
    test('deterministic across calls', () => {
        expect(getStringHash('abc')).toBe(getStringHash('abc'));
    });

    test('different inputs produce different hashes', () => {
        expect(getStringHash('abc')).not.toBe(getStringHash('abd'));
    });

    test('seed changes the result', () => {
        expect(getStringHash('abc', 1)).not.toBe(getStringHash('abc', 2));
    });

    test('non-string returns 0', () => {
        expect(getStringHash(null)).toBe(0);
        expect(getStringHash(undefined)).toBe(0);
        expect(getStringHash(42)).toBe(0);
        expect(getStringHash({})).toBe(0);
    });

    test('empty string is a valid hashable input (returns deterministic value)', () => {
        expect(getStringHash('')).toBe(getStringHash(''));
        expect(typeof getStringHash('')).toBe('number');
    });
});

describe('buildNodeVectorText — null / empty', () => {
    test('returns empty for null/non-object node', () => {
        expect(buildNodeVectorText(null)).toBe('');
        expect(buildNodeVectorText('foo')).toBe('');
        expect(buildNodeVectorText(undefined)).toBe('');
    });

    test('returns empty for node with no fields and no priority match', () => {
        expect(buildNodeVectorText({})).toBe('');
        expect(buildNodeVectorText({ type: 'unknown_type' })).toBe('');
    });
});

describe('buildNodeVectorText — fallback priority by type', () => {
    test('event prioritises summary then key_sentences', () => {
        const node = {
            type: 'event',
            fields: { summary: 'A thing happened', key_sentences: ['s1', 's2'], extra: 'low' },
        };
        const text = buildNodeVectorText(node);
        expect(text.indexOf('A thing happened')).toBeLessThan(text.indexOf('s1'));
        expect(text.indexOf('s1')).toBeLessThan(text.indexOf('extra'));
        expect(text).toContain('s1, s2');
    });

    test('character_sheet prioritises title then aliases/traits/identity/state/goal/core_note', () => {
        const node = {
            type: 'character_sheet',
            title: 'Eileen',
            fields: { aliases: ['Lee'], traits: 'kind', state: 'injured', extra: 'low' },
        };
        const text = buildNodeVectorText(node);
        expect(text.indexOf('Eileen')).toBeLessThan(text.indexOf('Lee'));
    });

    test('title falls back to fields.title then fields.name', () => {
        expect(buildNodeVectorText({ type: 'character_sheet', fields: { title: 'FromTitle' } })).toContain('FromTitle');
        expect(buildNodeVectorText({ type: 'character_sheet', fields: { name: 'FromName' } })).toContain('FromName');
    });

    test('case-insensitive type match', () => {
        const node = { type: 'EVENT', fields: { summary: 'cap-event' } };
        expect(buildNodeVectorText(node)).toContain('cap-event');
    });
});

describe('buildNodeVectorText — schema-driven priority', () => {
    test('schema embeddingColumns wins over tableColumns', () => {
        const schema = [{
            id: 'event',
            embeddingColumns: ['key_sentences'],
            tableColumns: ['summary'],
        }];
        const node = {
            type: 'event',
            fields: { summary: 'less-priority', key_sentences: ['important'] },
        };
        const text = buildNodeVectorText(node, schema);
        // both surface, but key_sentences appears first
        expect(text.indexOf('important')).toBeLessThan(text.indexOf('less-priority'));
    });

    test('schema tableColumns drive priority when embeddingColumns missing', () => {
        const schema = [{ id: 'event', tableColumns: ['key_sentences', 'summary'] }];
        const node = { type: 'event', fields: { summary: 'B', key_sentences: ['A'] } };
        expect(buildNodeVectorText(node, schema).indexOf('A')).toBeLessThan(buildNodeVectorText(node, schema).indexOf('B'));
    });

    test('schema entry must match by id (case insensitive)', () => {
        const schema = [{ id: 'EVENT', tableColumns: ['summary'] }];
        const node = { type: 'event', fields: { summary: 'matched' } };
        expect(buildNodeVectorText(node, schema)).toContain('matched');
    });

    test('schema with empty arrays falls through to fallback priority', () => {
        const schema = [{ id: 'event', embeddingColumns: [], tableColumns: [] }];
        const node = { type: 'event', fields: { summary: 'fallback' } };
        expect(buildNodeVectorText(node, schema)).toContain('fallback');
    });

    test('non-array schema is ignored, fallback priority used', () => {
        expect(buildNodeVectorText({ type: 'event', fields: { summary: 'x' } }, 'not-an-array')).toContain('x');
        expect(buildNodeVectorText({ type: 'event', fields: { summary: 'x' } }, null)).toContain('x');
    });
});

describe('buildNodeVectorText — value handling', () => {
    test('arrays joined with commas', () => {
        const node = { type: 'event', fields: { key_sentences: ['a', 'b', 'c'] } };
        expect(buildNodeVectorText(node)).toContain('a, b, c');
    });

    test('object values JSON-stringified', () => {
        const node = { type: 'event', fields: { summary: { nested: 'obj' } } };
        expect(buildNodeVectorText(node)).toContain('{"nested":"obj"}');
    });

    test('skips empty/null/undefined field values in priority list', () => {
        const node = {
            type: 'event',
            fields: { summary: '', key_sentences: null, extra: 'kept' },
        };
        const text = buildNodeVectorText(node);
        expect(text).toContain('kept');
        expect(text.startsWith('extra:')).toBe(true);
    });

    test('arrays with all-falsy entries produce no contribution', () => {
        const node = { type: 'event', fields: { key_sentences: [null, '', 0] } };
        // 0 is filtered out by .filter(Boolean), so the joined string is empty -> not added
        expect(buildNodeVectorText(node)).toBe('');
    });

    test('non-priority fields appear with key prefix', () => {
        const node = {
            type: 'event',
            fields: { summary: 'top', random_field: 'bottom' },
        };
        expect(buildNodeVectorText(node)).toContain('random_field: bottom');
    });

    test('embedding field is always skipped (storage-only)', () => {
        const node = { type: 'event', fields: { summary: 'kept', embedding: [0.1, 0.2] } };
        expect(buildNodeVectorText(node)).not.toContain('embedding');
    });

    test('separates parts with " | "', () => {
        const node = { type: 'event', fields: { summary: 'first', extra: 'second' } };
        expect(buildNodeVectorText(node)).toBe('first | extra: second');
    });
});

describe('buildNodeVectorHash', () => {
    const profile = { source: 'openai', model: 'text-embedding-3-small' };
    const node = { id: 'n1', type: 'event', seqTo: 5, fields: { summary: 'hi' } };

    test('deterministic for the same node + profile', () => {
        expect(buildNodeVectorHash(node, profile)).toBe(buildNodeVectorHash(node, profile));
    });

    test('changes when source differs', () => {
        expect(buildNodeVectorHash(node, profile)).not.toBe(buildNodeVectorHash(node, { ...profile, source: 'cohere' }));
    });

    test('changes when model differs', () => {
        expect(buildNodeVectorHash(node, profile)).not.toBe(buildNodeVectorHash(node, { ...profile, model: 'other' }));
    });

    test('changes when seqTo differs', () => {
        expect(buildNodeVectorHash(node, profile)).not.toBe(buildNodeVectorHash({ ...node, seqTo: 6 }, profile));
    });

    test('changes when text content (fields.summary) differs', () => {
        expect(buildNodeVectorHash(node, profile))
            .not.toBe(buildNodeVectorHash({ ...node, fields: { summary: 'different' } }, profile));
    });

    test('coerces missing seqTo to 0', () => {
        const a = { ...node, seqTo: 0 };
        const b = { ...node, seqTo: undefined };
        expect(buildNodeVectorHash(a, profile)).toBe(buildNodeVectorHash(b, profile));
    });

    test('null profile yields a stable hash (uses empty source/model)', () => {
        const h = buildNodeVectorHash(node, null);
        expect(typeof h).toBe('number');
        expect(buildNodeVectorHash(node, null)).toBe(h);
    });

    test('hash factors in schema-driven text', () => {
        const schema = [{ id: 'event', embeddingColumns: ['summary'] }];
        const a = buildNodeVectorHash(node, profile);
        const b = buildNodeVectorHash(node, profile, schema);
        // both should be defined; the values may match if fallback already picks summary first
        expect(typeof a).toBe('number');
        expect(typeof b).toBe('number');
    });
});

describe('ensureVectorIndexState', () => {
    test('initialises an empty state when missing', () => {
        const store = {};
        const state = ensureVectorIndexState(store);
        expect(state).toEqual({
            source: '', model: '', collectionId: '',
            nodeToHash: {}, hashToNodeId: {}, dirty: false, lastWarning: '',
        });
        expect(store.vectorIndexState).toBe(state);
    });

    test('returns the existing state on subsequent calls (idempotent)', () => {
        const store = {};
        const a = ensureVectorIndexState(store);
        a.nodeToHash['n1'] = 999;
        const b = ensureVectorIndexState(store);
        expect(b).toBe(a);
        expect(b.nodeToHash['n1']).toBe(999);
    });

    test('replaces non-object existing state', () => {
        const store = { vectorIndexState: 'broken' };
        const state = ensureVectorIndexState(store);
        expect(state).toMatchObject({ source: '', model: '', dirty: false });
    });
});

describe('computeVectorSyncPlan', () => {
    function makeStore() {
        return {
            nodes: {
                n1: { id: 'n1', type: 'event', seqTo: 1, fields: { summary: 'first' } },
                n2: { id: 'n2', type: 'event', seqTo: 2, fields: { summary: 'second' } },
                archived: { id: 'archived', type: 'event', seqTo: 3, fields: { summary: 'gone' }, archived: true },
                empty: { id: 'empty', type: 'event', seqTo: 4, fields: {} },
            },
        };
    }

    const profile = { source: 'openai', model: 'm' };

    test('classifies all nodes as toInsert when state is empty', () => {
        const store = makeStore();
        const plan = computeVectorSyncPlan(store, profile);
        const insertedIds = plan.toInsert.map(e => e.nodeId).sort();
        expect(insertedIds).toEqual(['n1', 'n2']);
        expect(plan.toDelete).toEqual([]);
        expect(plan.stats).toEqual({ total: 2, indexed: 0, pending: 2, stale: 0 });
    });

    test('skips archived nodes and nodes with empty text', () => {
        const store = makeStore();
        const plan = computeVectorSyncPlan(store, profile);
        const ids = plan.toInsert.map(e => e.nodeId);
        expect(ids).not.toContain('archived');
        expect(ids).not.toContain('empty');
    });

    test('counts already-indexed nodes', () => {
        const store = makeStore();
        const state = ensureVectorIndexState(store);
        const h1 = buildNodeVectorHash(store.nodes.n1, profile);
        state.nodeToHash['n1'] = h1;
        state.hashToNodeId[h1] = 'n1';

        const plan = computeVectorSyncPlan(store, profile);
        expect(plan.stats).toEqual({ total: 2, indexed: 1, pending: 1, stale: 0 });
        expect(plan.toInsert.map(e => e.nodeId)).toEqual(['n2']);
    });

    test('marks stale and re-inserts when content hash changes', () => {
        const store = makeStore();
        const state = ensureVectorIndexState(store);
        const oldHash = 12345;
        state.nodeToHash['n1'] = oldHash;
        state.hashToNodeId[oldHash] = 'n1';

        const plan = computeVectorSyncPlan(store, profile);
        expect(plan.toDelete).toContain(oldHash);
        expect(plan.toInsert.find(e => e.nodeId === 'n1')).toBeDefined();
        expect(plan.stats.stale).toBe(1);
    });

    test('marks fully-orphaned hashes as toDelete', () => {
        const store = { nodes: {} };
        const state = ensureVectorIndexState(store);
        state.nodeToHash['gone'] = 7777;
        state.hashToNodeId[7777] = 'gone';

        const plan = computeVectorSyncPlan(store, profile);
        expect(plan.toDelete).toContain(7777);
        expect(plan.toInsert).toEqual([]);
        expect(plan.stats.stale).toBe(1);
    });

    test('toInsert entries carry nodeId/hash/text/index in correct shape', () => {
        const store = makeStore();
        const plan = computeVectorSyncPlan(store, profile);
        for (const entry of plan.toInsert) {
            expect(entry).toEqual(expect.objectContaining({
                nodeId: expect.any(String),
                hash: expect.any(Number),
                text: expect.any(String),
                index: expect.any(Number),
            }));
            // index mirrors seqTo
            const node = store.nodes[entry.nodeId];
            expect(entry.index).toBe(node.seqTo);
        }
    });
});
