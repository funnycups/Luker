/**
 * Round-trip tests for vectorIndexState through the meta-sidecar persist
 * boundary. Regression coverage for the bug where every cache refresh
 * (CHAT_CHANGED, mutation invalidation) wiped the hash map and forced
 * users to re-embed all nodes from scratch on the next sync.
 */

import { describe, test, expect } from '@jest/globals';
import {
    metaFieldsFromStore,
    buildRuntimeStoreFromGraphPayloadAndMeta,
    normalizeVectorIndexState,
} from '../../public/scripts/extensions/memory-graph/persistence.js';

describe('vectorIndexState persistence', () => {
    function makeSampleVectorIndexState() {
        return {
            source: 'openai',
            model: 'text-embedding-3-small',
            collectionId: 'memory-graph-chat-1',
            nodeToHash: { n1: 1234, n2: 5678 },
            hashToNodeId: { 1234: 'n1', 5678: 'n2' },
            dirty: false,
            lastWarning: '',
        };
    }

    test('metaFieldsFromStore captures vectorIndexState', () => {
        const store = {
            sourceMessageCount: 10,
            lastRecallTrace: [],
            lastRecallProjection: null,
            vectorIndexState: makeSampleVectorIndexState(),
        };
        const meta = metaFieldsFromStore(store);
        expect(meta.vectorIndexState).toEqual(makeSampleVectorIndexState());
        expect(meta.vectorIndexState).not.toBe(store.vectorIndexState);
    });

    test('metaFieldsFromStore emits null when the store has no vectorIndexState', () => {
        const meta = metaFieldsFromStore({ sourceMessageCount: 0 });
        expect(meta.vectorIndexState).toBeNull();
    });

    test('buildRuntimeStoreFromGraphPayloadAndMeta restores vectorIndexState from meta', () => {
        const meta = { vectorIndexState: makeSampleVectorIndexState() };
        const runtime = buildRuntimeStoreFromGraphPayloadAndMeta({}, meta);
        expect(runtime.vectorIndexState).toEqual(makeSampleVectorIndexState());
    });

    test('buildRuntimeStoreFromGraphPayloadAndMeta leaves vectorIndexState absent when meta lacks the field (backward compat with pre-fix sidecars)', () => {
        const runtime = buildRuntimeStoreFromGraphPayloadAndMeta({}, { sourceMessageCount: 5 });
        expect(runtime.vectorIndexState).toBeUndefined();
    });

    test('full round-trip: store → meta → restored store preserves nodeToHash / hashToNodeId exactly', () => {
        const original = {
            sourceMessageCount: 3,
            lastRecallTrace: [],
            lastRecallProjection: null,
            vectorIndexState: makeSampleVectorIndexState(),
        };
        const meta = metaFieldsFromStore(original);
        const restored = buildRuntimeStoreFromGraphPayloadAndMeta({}, meta);
        expect(restored.vectorIndexState.nodeToHash).toEqual({ n1: 1234, n2: 5678 });
        expect(restored.vectorIndexState.hashToNodeId).toEqual({ 1234: 'n1', 5678: 'n2' });
        expect(restored.vectorIndexState.source).toBe('openai');
        expect(restored.vectorIndexState.model).toBe('text-embedding-3-small');
        expect(restored.vectorIndexState.collectionId).toBe('memory-graph-chat-1');
    });

    test('normalizeVectorIndexState coerces partial / malformed input to the expected shape', () => {
        expect(normalizeVectorIndexState(null)).toBeNull();
        expect(normalizeVectorIndexState(undefined)).toBeNull();
        expect(normalizeVectorIndexState('broken')).toBeNull();
        expect(normalizeVectorIndexState([])).toBeNull();

        const partial = normalizeVectorIndexState({ source: 'cohere', nodeToHash: { n1: 99 } });
        expect(partial).toEqual({
            source: 'cohere',
            model: '',
            collectionId: '',
            nodeToHash: { n1: 99 },
            hashToNodeId: {},
            dirty: false,
            lastWarning: '',
        });

        const arrayMap = normalizeVectorIndexState({ nodeToHash: ['not', 'an', 'object'] });
        expect(arrayMap.nodeToHash).toEqual({});
    });
});
