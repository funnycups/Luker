import { describe, test, expect } from '@jest/globals';
import { createStubAdapter } from './helpers/stub-adapter.js';

describe('stub adapter shape', () => {
    test('has all required hooks', () => {
        const a = createStubAdapter({ greeting: 'hello' });
        expect(typeof a.live).toBe('function');
        expect(typeof a.commit).toBe('function');
        expect(typeof a.sessionScope).toBe('function');
        expect(typeof a.listSessions).toBe('function');
        expect(typeof a.normalizeToolCallToEdit).toBe('function');
        expect(typeof a.renderMessageCard).toBe('function');
        expect(a.live()).toEqual({ greeting: 'hello' });
    });
});

import {
    createEmptySession,
    createEmptyHistoryState,
    makeSessionId,
    sanitizeSessionMessage,
} from '../../public/scripts/iteration-studio/session.js';

describe('createEmptySession', () => {
    test('returns shape with appliedEdits-ready fields and no baseline', () => {
        const adapter = createStubAdapter();
        const s = createEmptySession(adapter, { chatId: 'irrelevant' });
        expect(s.id).toMatch(/^session_/);
        expect(s.mode).toBe('stub');
        expect(s.sourceScope).toBe('test');
        expect(s.messages).toEqual([]);
        expect(s.pendingApproval).toBeNull();
        expect(s.surfaceState).toBeUndefined();
        expect(s.createdAt).toBeGreaterThan(0);
        // Old fields must be absent:
        expect('workingProfile' in s).toBe(false);
        expect('baseWorkingProfile' in s).toBe(false);
        expect('revision' in s).toBe(false);
        expect('lastSimulation' in s).toBe(false);
        expect('chatKey' in s).toBe(false);
    });
});

describe('sanitizeSessionMessage', () => {
    test('passes through user message intact', () => {
        const m = sanitizeSessionMessage({ id: 'm1', role: 'user', content: 'hi', at: 123 });
        expect(m).toEqual({ id: 'm1', role: 'user', content: 'hi', at: 123, auto: false });
    });

    test('preserves appliedEdits and rolledBack on assistant turn', () => {
        const edits = [{ op: 'set', path: 'a.b', oldValue: 1, newValue: 2 }];
        const m = sanitizeSessionMessage({
            id: 'm2', role: 'assistant', content: 'done', at: 456,
            appliedEdits: edits, rolledBack: true,
        });
        expect(m.appliedEdits).toEqual(edits);
        expect(m.rolledBack).toBe(true);
    });

    test('drops legacy profileSnapshot / profileDelta fields silently', () => {
        const m = sanitizeSessionMessage({
            id: 'm3', role: 'assistant', content: 'x', at: 1,
            profileSnapshotBefore: { a: 1 },
            profileSnapshotAfter: { a: 2 },
            profileDelta: { a: [1, 2] },
            reverseProfileDelta: { a: [2, 1] },
            lastSimulationAfter: { ok: true },
        });
        expect('profileSnapshotBefore' in m).toBe(false);
        expect('profileSnapshotAfter' in m).toBe(false);
        expect('profileDelta' in m).toBe(false);
        expect('reverseProfileDelta' in m).toBe(false);
        expect('lastSimulationAfter' in m).toBe(false);
    });
});

describe('createEmptyHistoryState', () => {
    test('returns version 4 (bumped from 3 for IDE-shape)', () => {
        const h = createEmptyHistoryState();
        expect(h).toEqual({ version: 4, sessions: [] });
    });
});
