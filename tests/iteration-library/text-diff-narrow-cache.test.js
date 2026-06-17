// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Regression: `text-diff.js#isNarrowViewport()` read `window.innerWidth`
// on every `renderInlineTextDiffHtml` call. The renderer fires once per
// diff row of every pending edit in iter-studio's full popup re-render,
// and the read forces a synchronous layout pass — Chrome's "forced
// reflow" classification. Trace-20260617T154806 measured 25 seconds of
// `get innerWidth` self-time during a single chat send (677 distinct
// `isNarrowViewport` entries, ~36ms each, on a non-trivial chat).
//
// The narrow-viewport breakpoint only changes when the user resizes the
// window or rotates a device. Read it ONCE at module init and refresh it
// via a `matchMedia` change listener; renderInlineTextDiffHtml must use
// the cached value and never touch window.innerWidth itself.
//
// We assert this by counting innerWidth getter invocations across a
// realistic batch of renders. The contract under test: zero reads
// during the renderer hot path; cache stays correct when the underlying
// matchMedia state changes.

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

let renderInlineTextDiffHtml;
let _testOnly_refreshNarrowViewport;

let restoreWindow;
let innerWidthGetterCalls;
let mqListeners;
let mqMatches;

function installWindowStub({ initialWidth = 1280 } = {}) {
    const previousWindow = globalThis.window;
    innerWidthGetterCalls = 0;
    mqListeners = [];
    mqMatches = initialWidth < 720;
    const fakeWindow = {};
    Object.defineProperty(fakeWindow, 'innerWidth', {
        configurable: true,
        get() {
            innerWidthGetterCalls += 1;
            return initialWidth;
        },
    });
    fakeWindow.matchMedia = jest.fn((query) => {
        const mql = {
            media: String(query || ''),
            matches: mqMatches,
            addEventListener: jest.fn((evt, fn) => {
                if (evt === 'change') mqListeners.push({ mql, fn });
            }),
            removeEventListener: jest.fn((evt, fn) => {
                if (evt === 'change') {
                    const idx = mqListeners.findIndex((l) => l.fn === fn);
                    if (idx >= 0) mqListeners.splice(idx, 1);
                }
            }),
            // Legacy API some browsers still ship — the cache wire-up
            // should prefer addEventListener, but mirror both so the
            // test would catch a mistaken regression to addListener.
            addListener: jest.fn(),
            removeListener: jest.fn(),
        };
        return mql;
    });
    globalThis.window = fakeWindow;
    return () => {
        if (previousWindow === undefined) {
            delete globalThis.window;
        } else {
            globalThis.window = previousWindow;
        }
    };
}

beforeEach(async () => {
    // The module reads matchMedia at import time, so we must (1) install
    // the stub first, then (2) jest.isolateModules-equivalent the import.
    restoreWindow = installWindowStub({ initialWidth: 1280 });
    jest.resetModules();
    const mod = await import('../../public/scripts/iteration-library/text-diff.js');
    renderInlineTextDiffHtml = mod.renderInlineTextDiffHtml;
    _testOnly_refreshNarrowViewport = mod._testOnly_refreshNarrowViewport;
    // Module init may have read innerWidth once as a bootstrap — that's
    // permitted. Reset the counter before each test asserts on the hot
    // path so we measure what `renderInlineTextDiffHtml` itself reads.
    innerWidthGetterCalls = 0;
});

afterEach(() => {
    restoreWindow();
});

describe('text-diff — narrow-viewport cache (no per-call innerWidth reads)', () => {
    test('renderInlineTextDiffHtml does not read window.innerWidth', () => {
        renderInlineTextDiffHtml('hello world', 'hello there');
        expect(innerWidthGetterCalls).toBe(0);
    });

    test('100 consecutive renders read window.innerWidth zero times', () => {
        // Simulates the iter-studio render hot path: a popup with several
        // pending edit cards re-renders fast under the auto-continue loop.
        for (let i = 0; i < 100; i++) {
            renderInlineTextDiffHtml(`old ${i}`, `new ${i}`);
        }
        expect(innerWidthGetterCalls).toBe(0);
    });

    test('renderer wires a matchMedia(max-width:720px) change listener at init', () => {
        // The cache must subscribe to viewport changes so a user dragging
        // the window across the breakpoint still sees correct
        // collapse-on-narrow behaviour.
        expect(globalThis.window.matchMedia).toHaveBeenCalled();
        const queries = globalThis.window.matchMedia.mock.calls.map((c) => String(c[0] || ''));
        expect(queries.some((q) => /max-width\s*:\s*719(\.9+)?px|max-width\s*:\s*720px|width\s*<\s*720/.test(q))).toBe(true);
        expect(mqListeners.length).toBeGreaterThan(0);
    });

    test('cache flips when matchMedia notifies a viewport-change to narrow', () => {
        // Wide → renders short content as open (matches the existing
        // contract from text-diff.test.js — short + wide = open).
        const wideHtml = renderInlineTextDiffHtml('a', 'b');
        expect(wideHtml).toMatch(/<details class="luker_lib_diff" open>/);

        // Simulate the user shrinking the window across the breakpoint.
        mqListeners.forEach(({ mql, fn }) => {
            mql.matches = true;
            fn({ matches: true, media: mql.media });
        });
        const narrowHtml = renderInlineTextDiffHtml('a', 'b');
        // Same input + narrow viewport → details should ship collapsed.
        expect(narrowHtml).not.toMatch(/<details class="luker_lib_diff" open>/);
        expect(narrowHtml).toMatch(/<details class="luker_lib_diff">/);

        // And it STILL didn't read innerWidth — the listener is the only
        // refresh path, not a per-call poll.
        expect(innerWidthGetterCalls).toBe(0);
    });

    test('forceOpen still wins over a narrow viewport (caller-driven override survives)', () => {
        // Flip cache to narrow.
        mqListeners.forEach(({ mql, fn }) => {
            mql.matches = true;
            fn({ matches: true, media: mql.media });
        });
        const html = renderInlineTextDiffHtml('a', 'b', { forceOpen: true });
        expect(html).toMatch(/<details class="luker_lib_diff" open>/);
    });
});

describe('text-diff — narrow-viewport refresh helper (exported for popup teardown)', () => {
    test('exports a _testOnly_refreshNarrowViewport for invalidating the cache', () => {
        // The helper isn't part of the public API; it exists so tests
        // can force a re-read without triggering a real layout. The
        // production cache is driven by matchMedia, but the helper proves
        // the cache CAN be re-evaluated if a popup ever needs to nudge it
        // (e.g. mobile keyboard show/hide that doesn't fire matchMedia).
        expect(typeof _testOnly_refreshNarrowViewport).toBe('function');
        // Calling it must NOT read innerWidth either: the refresh path
        // uses matchMedia.matches, not the legacy property read.
        _testOnly_refreshNarrowViewport();
        expect(innerWidthGetterCalls).toBe(0);
    });
});
