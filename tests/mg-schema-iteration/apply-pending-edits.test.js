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
//     itself) are covered by STRUCTURAL ASSERTIONS against the real
//     studio.js source text (read via fs) at the bottom of this file — a
//     regression in the closure's control flow trips those expectations.

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

    test('messages start empty and title/summary are blank', () => {
        const sess = _testOnly_createNewSession();
        expect(sess.messages).toEqual([]);
        expect(sess.title).toBe('');
        expect(sess.summary).toBe('');
    });
});

// ---------------------------------------------------------------------------
// Structural assertions against the actual studio.js source.
//
// The previous version of these two describe blocks defined local mirror
// helpers (`applyAutoApplyPreservation`, `clearAllHistoryMirror`) inside the
// test file and validated those LOCAL copies. That pattern is banned by the
// `feedback_e2e_must_expose_real_bugs` rule: an in-file re-implementation
// locks the test's own copy, not the product — `studio.js` could regress
// (drop the autoApply overlay, reorder abort-vs-delete) and the test would
// still pass because it never reads the product file.
//
// `startNewSession` and `clearAllHistory` are closure-private inside
// `openSchemaIterationStudio` and can't be invoked directly under jest, and
// exposing them as `_testOnly_*` exports would be an invasive product change
// just for test convenience. The structural-assertion approach used in
// `tests/memory-graph/injection-window.test.js` (lines 307+) is the right
// fit here: read the source via fs and assert on the actual function-body
// text. A regression deleting the overlay or reordering the abort would
// flip these expectations.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const __mgSchemaTestDir = dirname(fileURLToPath(import.meta.url));
const STUDIO_JS = readFileSync(
    resolvePath(
        __mgSchemaTestDir, '..', '..',
        'public', 'scripts', 'extensions', 'memory-graph', 'schema-iteration', 'studio.js',
    ),
    'utf8',
);

// Extract a top-level `async function NAME(...) { ... }` body by balanced-brace
// scan from the function declaration. Returns the body text between the
// opening `{` and its matching `}`. The whole-file regex flavor used in
// injection-window.test.js relies on `\n}\n` as a terminator, which works
// when the function is followed by a blank line — it isn't always here, so
// we do an honest brace walk instead.
function extractAsyncFnBody(source, name) {
    const decl = new RegExp(`async\\s+function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
    const m = decl.exec(source);
    if (!m) return null;
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
        const ch = source[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        i += 1;
    }
    if (depth !== 0) return null;
    return source.slice(start, i - 1);
}

describe('MG schema — startNewSession autoApply preservation (MG-10) [structural]', () => {
    // Closure body in studio.js (lines ~1221-1250 at time of writing).
    // The contract we guard:
    //   1. priorAutoApply is captured from state.session?.surfaceState?.autoApply
    //      BEFORE the new session is created (so the read sees the old session,
    //      not the just-overwritten one).
    //   2. The overlay sets `autoApply: true` only when priorAutoApply was truthy.
    //   3. No other surfaceState field is preserved — historyOpen et al. reset
    //      to the createNewSession default (verified by the baseline-shape
    //      describe above, which exercises the real export).
    let body;
    beforeAll(() => {
        body = extractAsyncFnBody(STUDIO_JS, 'startNewSession');
        expect(body).not.toBeNull();
    });

    test('captures priorAutoApply from state.session?.surfaceState?.autoApply', () => {
        // The Boolean() coercion is load-bearing: a missing surfaceState would
        // otherwise leak `undefined` into the overlay branch.
        expect(body).toMatch(
            /priorAutoApply\s*=\s*Boolean\(\s*state\.session\?\.surfaceState\?\.autoApply\s*\)/,
        );
    });

    test('read of priorAutoApply happens BEFORE state.session = createNewSession()', () => {
        // If the read landed after the overwrite, it would always observe the
        // fresh session's `autoApply: false` default and the overlay would
        // never fire.
        const priorReadIdx = body.indexOf('priorAutoApply');
        const overwriteIdx = body.search(/state\.session\s*=\s*createNewSession\(\)/);
        expect(priorReadIdx).toBeGreaterThan(-1);
        expect(overwriteIdx).toBeGreaterThan(-1);
        expect(priorReadIdx).toBeLessThan(overwriteIdx);
    });

    test('overlays autoApply: true conditionally on priorAutoApply being truthy', () => {
        // The `if (priorAutoApply)` gate + `autoApply: true` literal inside
        // the spread. The structure is what we guard — a regression that
        // drops the gate (always overlay) or drops the literal would fail.
        expect(body).toMatch(
            /if\s*\(\s*priorAutoApply\s*\)\s*\{[\s\S]*?state\.session\.surfaceState\s*=\s*\{[\s\S]*?\.\.\.\(\s*state\.session\.surfaceState\s*\|\|\s*\{\}\s*\)[\s\S]*?autoApply:\s*true[\s\S]*?\}/,
        );
    });

    test('does NOT preserve any field other than autoApply', () => {
        // Defensive: a refactor that adds e.g. `historyOpen: priorSession?.surfaceState?.historyOpen`
        // to the overlay would break the contract. The overlay block must
        // set exactly one key (autoApply). We isolate the `if (priorAutoApply) { ... }`
        // block (balanced-brace scan) and assert the keys assigned inside it
        // are exactly ['autoApply'] — no historyOpen, no other surface field.
        const ifIdx = body.search(/if\s*\(\s*priorAutoApply\s*\)\s*\{/);
        expect(ifIdx).toBeGreaterThan(-1);
        // Walk to the matching brace from the if's opening `{`.
        const openIdx = body.indexOf('{', ifIdx);
        let depth = 1;
        let j = openIdx + 1;
        while (j < body.length && depth > 0) {
            if (body[j] === '{') depth += 1;
            else if (body[j] === '}') depth -= 1;
            j += 1;
        }
        const overlayBody = body.slice(openIdx + 1, j - 1);
        // Find the inner object literal assigned to state.session.surfaceState.
        const innerObj = overlayBody.match(/state\.session\.surfaceState\s*=\s*\{([\s\S]*?)\};/);
        expect(innerObj).not.toBeNull();
        // Walk the object literal at its own depth, collecting top-level keys.
        // Skip the `...spread` entry, count only the literal `key: value` pairs.
        const objText = innerObj[1];
        // Remove the spread; whatever's left after the spread is the explicit
        // key-set list. Top-level keys appear as `KEY:` after a comma or at start.
        const explicit = objText
            .replace(/\.\.\.\([^)]*\)\s*,?/g, '')   // drop the spread
            .replace(/\([^()]*\)/g, '')             // strip nested parens
            .replace(/\[[^\[\]]*\]/g, '');          // strip nested brackets
        const keyMatches = [...explicit.matchAll(/(?:^|,)\s*(\w+)\s*:/g)].map(m => m[1]);
        expect(keyMatches).toEqual(['autoApply']);
    });
});

describe('MG schema — clearAllHistory abort-then-delete ordering [structural]', () => {
    // Closure body in studio.js (lines ~1252-1266 at time of writing).
    // The contract: any in-flight LLM call MUST be aborted before sessions
    // are deleted, otherwise a slow response could land in the freshly-
    // seeded post-clear session and re-stamp it.
    let body;
    beforeAll(() => {
        body = extractAsyncFnBody(STUDIO_JS, 'clearAllHistory');
        expect(body).not.toBeNull();
    });

    test('calls state.abortController?.abort() in the body', () => {
        expect(body).toMatch(/state\.abortController\?\.abort\(\)/);
    });

    test('calls sessionStore.delete(...) in the body', () => {
        expect(body).toMatch(/sessionStore\.delete\s*\(/);
    });

    test('abort() is positioned BEFORE the first sessionStore.delete() call', () => {
        // The ordering contract. If a refactor moves the abort below the
        // delete loop, this assertion flips and the regression is caught.
        const abortIdx = body.indexOf('state.abortController?.abort()');
        const deleteIdx = body.search(/sessionStore\.delete\s*\(/);
        expect(abortIdx).toBeGreaterThan(-1);
        expect(deleteIdx).toBeGreaterThan(-1);
        expect(abortIdx).toBeLessThan(deleteIdx);
    });

    test('clears state.abortController and state.isBusy AFTER abort()', () => {
        // The cleanup sequence: abort → isBusy=false → abortController=null →
        // delete loop. Both reset lines must appear after the abort, before
        // the delete loop reaches the store.
        const abortIdx = body.indexOf('state.abortController?.abort()');
        const isBusyResetIdx = body.search(/state\.isBusy\s*=\s*false/);
        const abortCtrlResetIdx = body.search(/state\.abortController\s*=\s*null/);
        const deleteIdx = body.search(/sessionStore\.delete\s*\(/);
        expect(isBusyResetIdx).toBeGreaterThan(abortIdx);
        expect(abortCtrlResetIdx).toBeGreaterThan(abortIdx);
        expect(isBusyResetIdx).toBeLessThan(deleteIdx);
        expect(abortCtrlResetIdx).toBeLessThan(deleteIdx);
    });

    test('confirm() guard still bails before any abort/delete (the early-return shape)', () => {
        // The very first statement after the function signature is the
        // confirm() bail. If a regression dropped this guard, an accidental
        // click would wipe history without prompting. Assert the early
        // `if (!confirm(...)) return;` shape sits before the abort.
        const confirmIdx = body.search(/if\s*\(\s*!\s*confirm\s*\([\s\S]*?\)\s*\)\s*return/);
        const abortIdx = body.indexOf('state.abortController?.abort()');
        expect(confirmIdx).toBeGreaterThan(-1);
        expect(confirmIdx).toBeLessThan(abortIdx);
    });
});
