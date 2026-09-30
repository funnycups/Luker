/**
 * Unit tests for graph-iteration/vector-sync.js — the injected-function
 * orchestrator that decides whether an approved graph mutation triggers an
 * incremental vector index sync.
 */
import { describe, test, expect, jest } from '@jest/globals';
import './_mocks/main-module-stack.js';

let resolveGraphVectorProfile;
let syncGraphVectorsAfterMutation;

beforeAll(async () => {
    const mod = await import(
        '../../public/scripts/extensions/memory-graph/graph-iteration/vector-sync.js'
    );
    resolveGraphVectorProfile = mod.resolveGraphVectorProfile;
    syncGraphVectorsAfterMutation = mod.syncGraphVectorsAfterMutation;
});

describe('resolveGraphVectorProfile', () => {
    test('returns null when no embedding profile is configured', () => {
        expect(resolveGraphVectorProfile({ embeddingProfileId: '' }, () => ({ source: 'x' }))).toBeNull();
    });
    test('returns null when the configured profile is invalid or missing', () => {
        expect(resolveGraphVectorProfile({ embeddingProfileId: 'p1' }, () => null)).toBeNull();
        expect(resolveGraphVectorProfile({ embeddingProfileId: 'p1' }, () => ({}))).toBeNull();
    });
    test('returns the profile when it validates', () => {
        const profile = { source: 'openai', model: 'm' };
        expect(resolveGraphVectorProfile({ embeddingProfileId: 'p1' }, () => profile)).toBe(profile);
    });
});

describe('syncGraphVectorsAfterMutation', () => {
    test('skips without calling sync/persist when no profile is resolved', async () => {
        const syncFn = jest.fn();
        const persistFn = jest.fn();
        const res = await syncGraphVectorsAfterMutation({
            store: { nodes: {}, edges: [] }, chatKey: 'chat', settings: {}, profile: null,
            schema: [], syncFn, persistFn,
        });
        expect(res).toEqual({ skipped: true, reason: 'no embedding profile' });
        expect(syncFn).not.toHaveBeenCalled();
        expect(persistFn).not.toHaveBeenCalled();
    });

    test('runs an error-tolerant sync then persists meta when a profile is present', async () => {
        const store = { nodes: {}, edges: [] };
        const profile = { source: 'openai', model: 'm' };
        const schema = [{ id: 'event' }];
        const calls = [];
        const syncFn = jest.fn(async (s, p, key, opts) => { calls.push(['sync', s, p, key, opts]); });
        const persistFn = jest.fn(async (s) => { calls.push(['persist', s]); });
        const res = await syncGraphVectorsAfterMutation({
            store, chatKey: 'chat', settings: {}, profile, schema, syncFn, persistFn,
        });
        expect(res).toEqual({ skipped: false });
        expect(syncFn).toHaveBeenCalledTimes(1);
        expect(syncFn.mock.calls[0][2]).toBe('chat');
        expect(syncFn.mock.calls[0][3]).toEqual({ schema, tolerateErrors: true });
        expect(persistFn).toHaveBeenCalledTimes(1);
        expect(calls[0][0]).toBe('sync');
        expect(calls[1][0]).toBe('persist');
    });
});
