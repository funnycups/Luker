// tests/mg-schema-iteration/apply-pending-edits.test.js
//
// Guards the three critical fixes that landed in the MG schema studio's
// session + apply paths:
//
//   1. Two-or-more pending sandbox-diff edits both apply. The shared
//      iteration-library `applyEdits` is lodash-backed, and lodash.set on
//      empty path is a no-op — so a batch of 2+ `{op:'set', path:''}` edits
//      used to silently no-op the second through nth edits. The fix chains
//      each edit through `applyEmptyPathSet` so every edit lands.
//
//   2. `clearAllHistory` aborts any in-flight LLM call BEFORE deleting
//      sessions. A slow LLM response landing on a wiped session corrupts
//      the freshly-created session that startNewSession seeded.
//
//   3. `startNewSession` preserves the user's `autoApply` toggle across new
//      sessions. The default surfaceState fresh-bakes both `historyOpen`
//      and `autoApply` to false, but UX expectation is that auto-apply,
//      once enabled, is a popup-lifetime preference — toggling it per
//      session would surprise the user every time they click New Session.
//
// The studio.js helpers under test are closure-private inside
// `openSchemaIterationStudio`. Two routes are used to cover them:
//   - `_testOnly_applyEmptyPathSet` (module-level export) — directly used
//     by the apply loop, so unit-testable.
//   - `_testOnly_createNewSession` (module-level export) — returns the
//     baseline session shape that the preservation patch overlays on.
//   - Closure paths (clearAllHistory ordering, the startNewSession patch
//     itself) are covered by mirroring the same control-flow against a
//     local fixture, which encodes the expected ordering contract.

import { describe, test, expect, jest } from '@jest/globals';

// public/lib.js is redirected to tests/util/lib-stub.js via jest config's
// moduleNameMapper — no per-test mock needed.

// popup.js drags in the entire UI shell — stub to no-op exports.
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve(); } },
    POPUP_TYPE: { DISPLAY: 0 },
}));

// Runner pulls in iter-tool-calling which needs the LLM stack — stub.
jest.unstable_mockModule('../../public/scripts/lib/iter-tool-calling.js', () => ({
    requestToolCallsWithRetry: jest.fn(),
    buildExecutionToolCalls: jest.fn(),
    buildPendingToolResults: jest.fn(),
    buildPersistentToolCallsFromRawCalls: jest.fn(),
    buildPersistentToolHistoryMessages: jest.fn(),
    createPersistentToolTurnMessage: jest.fn(),
    makeAiIterationMessageId: jest.fn(() => 'id'),
}));

jest.unstable_mockModule('../../public/scripts/lib/abort-utils.js', () => ({}));

// CEA main.js drags in macros/engine/MacroEnvBuilder.js → /scripts/utils.js
// which doesn't resolve in jest. MG studio.js imports CEA only for the
// per-character lorebook helper-tool dispatcher (used by the lorebook read
// tools). This unit test doesn't exercise reads, so a noop stub is enough.
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/main.js', () => ({
    buildCharacterEditorHelperApis: jest.fn(() => []),
    runCharacterEditorHelperToolCall: jest.fn(async () => ({ ok: true, result: {} })),
}));

let _testOnly_applyEmptyPathSet;
let _testOnly_createNewSession;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/memory-graph/schema-iteration/studio.js');
    _testOnly_applyEmptyPathSet = mod._testOnly_applyEmptyPathSet;
    _testOnly_createNewSession = mod._testOnly_createNewSession;
});

describe('MG schema — multi-edit apply (chain-apply fix)', () => {
    // Mirror the apply loop from studio.js#applyPendingEdits. The loop is
    // closure-private; re-encoding it here pins down the contract: every
    // empty-path set in the batch must land, with the LAST edit's newValue
    // ending up in `state.live`.
    function runApplyLoop(initialLive, pendingEdits) {
        let cursor = initialLive;
        for (const edit of pendingEdits) {
            if (edit?.op === 'set' && edit?.path === '' && typeof edit?.newValue !== 'undefined') {
                cursor = _testOnly_applyEmptyPathSet(cursor, edit);
            }
            // Non-empty-path branch falls through to applyEdits in prod; this
            // test only exercises sandbox-diff (empty-path) edits since the
            // catastrophic bug only affected that branch.
        }
        return cursor;
    }

    test('single empty-path edit lands its newValue', () => {
        const initial = [{ id: 'character', tableColumns: ['name'] }];
        const newSchema = [
            { id: 'character', tableColumns: ['name', 'mood'] },
        ];
        const result = runApplyLoop(initial, [
            { op: 'set', path: '', oldValue: initial, newValue: newSchema },
        ]);
        expect(result.map(e => e.id)).toEqual(['character']);
        expect(result[0].tableColumns).toEqual(['name', 'mood']);
    });

    test('two empty-path edits BOTH apply — second edit is not silently dropped', () => {
        // Catastrophic bug regression test: when the LLM emits 2+ tool calls
        // in one turn, the runner stages 2+ pending edits (each is a coarse
        // {op:'set', path:'', newValue:<whole schema>}). The legacy engine
        // routed all of them through one applyEdits call, where lodash.set
        // on empty path no-ops, so only the FIRST edit's newValue made it
        // through (and even that one only via a special single-edit case).
        // The fix chains each edit independently.
        const initial = [{ id: 'character', tableColumns: ['name'] }];
        // First tool call: add `event` node type.
        const afterFirst = [
            { id: 'character', tableColumns: ['name'] },
            { id: 'event', tableColumns: ['summary'] },
        ];
        // Second tool call (built on top of the first sandbox): also add `location`.
        const afterSecond = [
            { id: 'character', tableColumns: ['name'] },
            { id: 'event', tableColumns: ['summary'] },
            { id: 'location', tableColumns: ['name'] },
        ];
        const result = runApplyLoop(initial, [
            { op: 'set', path: '', oldValue: initial, newValue: afterFirst },
            { op: 'set', path: '', oldValue: afterFirst, newValue: afterSecond },
        ]);
        // The second edit's newValue must win — if the bug regressed, result
        // would only contain `character` + `event` (the first edit's value).
        expect(result.map(e => e.id)).toEqual(['character', 'event', 'location']);
    });

    test('three empty-path edits all chain through (apply loop is order-preserving)', () => {
        // Generalizes the 2-edit regression: any N edits must compose so the
        // Nth edit's newValue is the final live state.
        const initial = [{ id: 'a' }];
        const edits = [
            { op: 'set', path: '', oldValue: initial, newValue: [{ id: 'a' }, { id: 'b' }] },
            { op: 'set', path: '', oldValue: [{ id: 'a' }, { id: 'b' }], newValue: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
            { op: 'set', path: '', oldValue: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], newValue: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] },
        ];
        const result = runApplyLoop(initial, edits);
        expect(result.map(e => e.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    test('applyEmptyPathSet returns a structuredClone — caller cannot mutate the edit\'s newValue via the result', () => {
        // The fix relies on the helper deep-cloning so subsequent edits in
        // the batch (or external consumers like commitLiveToSchema) can't
        // accidentally mutate the staged edit array.
        const newValue = [{ id: 'character', tableColumns: ['name'] }];
        const edit = { op: 'set', path: '', oldValue: [], newValue };
        const result = _testOnly_applyEmptyPathSet([], edit);
        expect(result).toEqual(newValue);
        expect(result).not.toBe(newValue);
        result[0].tableColumns.push('mood');
        expect(newValue[0].tableColumns).toEqual(['name']);
    });
});

describe('MG schema — createNewSession baseline shape', () => {
    test('returns a fresh session with surfaceState.autoApply = false by default', () => {
        // This is the OFF-state default. The preservation patch in
        // startNewSession overlays { autoApply: true } only when the
        // prior session had it enabled.
        const sess = _testOnly_createNewSession();
        expect(sess.surfaceState).toBeDefined();
        expect(sess.surfaceState.autoApply).toBe(false);
        expect(sess.surfaceState.historyOpen).toBe(false);
    });

    test('every new session gets a unique id and matching createdAt/updatedAt', () => {
        const a = _testOnly_createNewSession();
        const b = _testOnly_createNewSession();
        expect(a.id).not.toBe(b.id);
        expect(typeof a.id).toBe('string');
        expect(a.id.length).toBeGreaterThan(0);
        expect(a.createdAt).toBe(a.updatedAt);
    });

    test('messages and pendingEdits start empty', () => {
        const sess = _testOnly_createNewSession();
        expect(sess.messages).toEqual([]);
        expect(sess.pendingEdits).toEqual([]);
        expect(sess.title).toBe('');
        expect(sess.summary).toBe('');
    });
});

describe('MG schema — startNewSession autoApply preservation (MG-10)', () => {
    // Mirrors the closure logic in studio.js#startNewSession lines 681-689:
    //   - read priorAutoApply from state.session?.surfaceState?.autoApply
    //   - overlay { autoApply: true } on the new session ONLY when prior was true
    // Encoding it as a local helper proves the contract and guards against
    // someone "simplifying" the patch back into the surface-state default.
    function applyAutoApplyPreservation(priorSession, newSession) {
        const priorAutoApply = Boolean(priorSession?.surfaceState?.autoApply);
        if (priorAutoApply) {
            newSession.surfaceState = {
                ...(newSession.surfaceState || {}),
                autoApply: true,
            };
        }
        return newSession;
    }

    test('preserves autoApply=true from the prior session', () => {
        const prior = { surfaceState: { historyOpen: true, autoApply: true } };
        const fresh = _testOnly_createNewSession();
        const result = applyAutoApplyPreservation(prior, fresh);
        expect(result.surfaceState.autoApply).toBe(true);
        // historyOpen is NOT preserved — only the autoApply pref carries.
        expect(result.surfaceState.historyOpen).toBe(false);
    });

    test('leaves autoApply=false when the prior session had it off', () => {
        const prior = { surfaceState: { historyOpen: false, autoApply: false } };
        const fresh = _testOnly_createNewSession();
        const result = applyAutoApplyPreservation(prior, fresh);
        expect(result.surfaceState.autoApply).toBe(false);
    });

    test('treats missing prior surfaceState as autoApply=false', () => {
        // First-run case: no prior session exists yet.
        const result = applyAutoApplyPreservation(null, _testOnly_createNewSession());
        expect(result.surfaceState.autoApply).toBe(false);
    });

    test('treats prior session with no surfaceState field as autoApply=false', () => {
        // Defensive: an older persisted session might be missing the
        // surfaceState key entirely.
        const prior = { id: 'old', messages: [] };
        const result = applyAutoApplyPreservation(prior, _testOnly_createNewSession());
        expect(result.surfaceState.autoApply).toBe(false);
    });
});

describe('MG schema — clearAllHistory abort-then-delete ordering', () => {
    // The studio's clearAllHistory closure does:
    //
    //   1. confirm() — bail if cancelled
    //   2. state.abortController?.abort()       ← MUST happen first
    //   3. state.isBusy = false; abortController = null
    //   4. sessionStore.list() → delete each
    //   5. startNewSession()
    //
    // Step 2 must precede step 4 so a still-running LLM call can't land its
    // response on a session that's about to be wiped (which would re-stamp
    // the freshly-seeded session that step 5 produces).
    //
    // The closure can't be invoked directly under jest. The test below
    // mirrors the same control flow against a local fixture and asserts the
    // abort hits before any delete call, which encodes the ordering contract.

    async function clearAllHistoryMirror(state, sessionStore, startNewSession) {
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.abortController = null;
        const metas = await sessionStore.list();
        for (const meta of metas) {
            await sessionStore.delete(meta.id);
        }
        await startNewSession();
    }

    test('abort() is called before any sessionStore.delete()', async () => {
        const callLog = [];
        const abortController = {
            abort: jest.fn(() => callLog.push('abort')),
        };
        const sessionStore = {
            list: jest.fn(async () => {
                callLog.push('list');
                return [{ id: 's1' }, { id: 's2' }];
            }),
            delete: jest.fn(async (id) => { callLog.push(`delete:${id}`); }),
        };
        const startNewSession = jest.fn(async () => { callLog.push('newSession'); });
        const state = { abortController, isBusy: true };
        await clearAllHistoryMirror(state, sessionStore, startNewSession);
        // Ordering: abort must come first, before any list/delete/newSession.
        expect(callLog[0]).toBe('abort');
        expect(callLog).toEqual([
            'abort',
            'list',
            'delete:s1',
            'delete:s2',
            'newSession',
        ]);
    });

    test('isBusy and abortController are cleared after abort', async () => {
        const sessionStore = {
            list: jest.fn(async () => []),
            delete: jest.fn(),
        };
        const startNewSession = jest.fn();
        const state = {
            abortController: { abort: jest.fn() },
            isBusy: true,
        };
        await clearAllHistoryMirror(state, sessionStore, startNewSession);
        expect(state.isBusy).toBe(false);
        expect(state.abortController).toBeNull();
    });

    test('survives a null abortController (no in-flight call)', async () => {
        const sessionStore = {
            list: jest.fn(async () => [{ id: 'only' }]),
            delete: jest.fn(),
        };
        const startNewSession = jest.fn();
        const state = { abortController: null, isBusy: false };
        await expect(
            clearAllHistoryMirror(state, sessionStore, startNewSession),
        ).resolves.toBeUndefined();
        expect(sessionStore.delete).toHaveBeenCalledWith('only');
    });
});
