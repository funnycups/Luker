import { describe, test, expect } from '@jest/globals';
import {
    computeFingerprint, createState, shouldResume,
    pendingHandles, markStart, markStage, markDone, markFailed,
    isAllDone, serializeStatus,
} from '../../../src/storage/migration/state.js';

describe('computeFingerprint', () => {
    test('same inputs produce same hash', () => {
        const a = computeFingerprint({ targetMode: 'postgres', postgresConfig: { url: 'postgresql://u:p@h/d' } });
        const b = computeFingerprint({ targetMode: 'postgres', postgresConfig: { url: 'postgresql://u:p@h/d' } });
        expect(a).toBe(b);
        expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    test('different targetMode produces different hash', () => {
        const a = computeFingerprint({ targetMode: 'postgres', postgresConfig: { url: 'postgresql://u:p@h/d' } });
        const b = computeFingerprint({ targetMode: 'mysql', mysqlConfig: { url: 'mysql://u:p@h/d' } });
        expect(a).not.toBe(b);
    });

    test('different url produces different hash', () => {
        const a = computeFingerprint({ targetMode: 'postgres', postgresConfig: { url: 'postgresql://u:p@h1/d' } });
        const b = computeFingerprint({ targetMode: 'postgres', postgresConfig: { url: 'postgresql://u:p@h2/d' } });
        expect(a).not.toBe(b);
    });

    test('fs/sqlite tolerate absent db configs', () => {
        const a = computeFingerprint({ targetMode: 'fs' });
        const b = computeFingerprint({ targetMode: 'fs' });
        expect(a).toBe(b);
    });
});

describe('shouldResume', () => {
    test('null state -> fresh', () => {
        expect(shouldResume(null, 'fp1').kind).toBe('fresh');
    });

    test('matching fingerprint -> resume', () => {
        const state = createState({
            targetMode: 'postgres', fingerprint: 'fp1', handles: ['a', 'b'], now: '2026-06-19T00:00:00.000Z',
        });
        expect(shouldResume(state, 'fp1').kind).toBe('resume');
    });

    test('mismatching fingerprint -> conflict', () => {
        const state = createState({
            targetMode: 'postgres', fingerprint: 'fp1', handles: ['a'], now: '2026-06-19T00:00:00.000Z',
        });
        expect(shouldResume(state, 'fp2').kind).toBe('conflict');
    });
});

describe('pendingHandles', () => {
    test('initially returns all', () => {
        const state = createState({
            targetMode: 'postgres', fingerprint: 'f', handles: ['a', 'b', 'c'], now: '2026-06-19T00:00:00.000Z',
        });
        expect(pendingHandles(state)).toEqual(['a', 'b', 'c']);
    });

    test('skips done, includes failed', () => {
        const state = createState({
            targetMode: 'postgres', fingerprint: 'f', handles: ['a', 'b', 'c'], now: '2026-06-19T00:00:00.000Z',
        });
        markDone(state, 'a', '2026-06-19T00:00:01.000Z');
        markFailed(state, 'b', 'boom', '2026-06-19T00:00:02.000Z');
        expect(pendingHandles(state)).toEqual(['b', 'c']);
    });
});

describe('isAllDone', () => {
    test('false when any pending', () => {
        const state = createState({
            targetMode: 'postgres', fingerprint: 'f', handles: ['a', 'b'], now: '2026-06-19T00:00:00.000Z',
        });
        markDone(state, 'a', '2026-06-19T00:00:01.000Z');
        expect(isAllDone(state)).toBe(false);
    });

    test('false when any failed', () => {
        const state = createState({
            targetMode: 'postgres', fingerprint: 'f', handles: ['a', 'b'], now: '2026-06-19T00:00:00.000Z',
        });
        markDone(state, 'a', '2026-06-19T00:00:01.000Z');
        markFailed(state, 'b', 'boom', '2026-06-19T00:00:02.000Z');
        expect(isAllDone(state)).toBe(false);
    });

    test('true when all done', () => {
        const state = createState({
            targetMode: 'postgres', fingerprint: 'f', handles: ['a', 'b'], now: '2026-06-19T00:00:00.000Z',
        });
        markDone(state, 'a', '2026-06-19T00:00:01.000Z');
        markDone(state, 'b', '2026-06-19T00:00:02.000Z');
        expect(isAllDone(state)).toBe(true);
    });
});

describe('serializeStatus', () => {
    test('null state -> null', () => {
        expect(serializeStatus(null, '2026-06-19T00:00:00.000Z')).toBeNull();
    });

    test('returns staleSeconds and perUser', () => {
        const state = createState({
            targetMode: 'postgres', fingerprint: 'f', handles: ['a'], now: '2026-06-19T00:00:00.000Z',
        });
        const view = serializeStatus(state, '2026-06-19T00:05:00.000Z');
        expect(view.targetMode).toBe('postgres');
        expect(view.staleSeconds).toBe(300);
        expect(view.perUser).toEqual({ a: { status: 'pending' } });
    });
});

describe('markStart + markStage + markDone progress lifecycle', () => {
    test('markStart flips pending -> in_flight and refreshes lastProgressAt', () => {
        const state = createState({
            targetMode: 'sqlite', fingerprint: 'f', handles: ['a'], now: '2026-06-19T00:00:00.000Z',
        });
        markStart(state, 'a', '2026-06-19T00:00:01.000Z');
        expect(state.perUser.a.status).toBe('in_flight');
        expect(state.perUser.a.startedAt).toBe('2026-06-19T00:00:01.000Z');
        expect(state.lastProgressAt).toBe('2026-06-19T00:00:01.000Z');
    });

    test('markStage attaches stage + counts and updates lastProgressAt', () => {
        const state = createState({
            targetMode: 'sqlite', fingerprint: 'f', handles: ['a'], now: '2026-06-19T00:00:00.000Z',
        });
        markStart(state, 'a', '2026-06-19T00:00:01.000Z');
        markStage(state, 'a', {
            stage: 'chats-copied',
            counts: { chats: 12, presets: 4, worlds: 1, settings: 1, preset_states: 0, named_docs: 0, groups: 0, chat_states: 0, stats: 0 },
        }, '2026-06-19T00:00:05.000Z');
        expect(state.perUser.a.stage).toBe('chats-copied');
        expect(state.perUser.a.counts.chats).toBe(12);
        expect(state.lastProgressAt).toBe('2026-06-19T00:00:05.000Z');
    });

    test('markStage is a no-op once the user is done', () => {
        const state = createState({
            targetMode: 'sqlite', fingerprint: 'f', handles: ['a'], now: '2026-06-19T00:00:00.000Z',
        });
        markStart(state, 'a', '2026-06-19T00:00:01.000Z');
        markDone(state, 'a', '2026-06-19T00:00:10.000Z', { chats: 100 });
        markStage(state, 'a', { stage: 'verifying', counts: { chats: 50 } }, '2026-06-19T00:00:11.000Z');
        expect(state.perUser.a.status).toBe('done');
        expect(state.perUser.a.counts.chats).toBe(100);
    });

    test('markFailed preserves last in-flight counts for the UI', () => {
        const state = createState({
            targetMode: 'sqlite', fingerprint: 'f', handles: ['a'], now: '2026-06-19T00:00:00.000Z',
        });
        markStart(state, 'a', '2026-06-19T00:00:01.000Z');
        markStage(state, 'a', { stage: 'chats-copied', counts: { chats: 7 } }, '2026-06-19T00:00:05.000Z');
        markFailed(state, 'a', 'boom', '2026-06-19T00:00:06.000Z');
        expect(state.perUser.a.status).toBe('failed');
        expect(state.perUser.a.error).toBe('boom');
        expect(state.perUser.a.stage).toBe('chats-copied');
        expect(state.perUser.a.counts.chats).toBe(7);
    });
});
