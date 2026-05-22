// tests/cpa-ide-mode/promise-clone-safety.test.js
/**
 * Regression for: "generateTask sender failed: Promise object could not be cloned."
 *
 * Root cause (spec §11 / 附录 A.0): CPA's commit() path leads to
 *   public/scripts/openai.js:syncCharacterBoundPresetJsonData
 * which forwards `boundPreset` into `worker.postMessage(...)`. The Web Worker
 * postMessage uses structuredClone internally, which rejects Promises, Proxies,
 * getters returning Promises, and functions.
 *
 * Fix: sanitize `boundPreset` through JSON.parse(JSON.stringify(...)) before
 * postMessage. This test pins the exact contract the fix relies on:
 *
 *   1. A preset containing non-cloneable fields fails structuredClone as-is.
 *   2. After JSON round-trip, the same preset is structuredClone-safe.
 *   3. Plain-JSON fields survive the round-trip unchanged (so the worker still
 *      receives the data it needs to update the character JSON snapshot).
 */

import { describe, test, expect } from '@jest/globals';

function makeDirtyBoundPreset() {
    return {
        name: 'Test Preset',
        preset: {
            prompts: [
                { identifier: 'main', content: 'You are an assistant.' },
            ],
            prompt_order: [
                { character_id: 100001, order: [{ identifier: 'main', enabled: true }] },
            ],
            temperature: 0.7,
            _pendingSave: Promise.resolve('committed'),
            _onChange: () => {},
            _proxy: new Proxy({ inner: true }, {}),
        },
    };
}

describe('Stage 0: structured-clone safety for character-bound preset sync', () => {
    test('raw boundPreset with Promise/Proxy/function fields cannot be structuredCloned', () => {
        const dirty = makeDirtyBoundPreset();
        expect(() => structuredClone(dirty)).toThrow();
    });

    test('JSON-roundtripped boundPreset is structuredClone-safe', () => {
        const dirty = makeDirtyBoundPreset();
        const safe = JSON.parse(JSON.stringify(dirty));
        expect(() => structuredClone(safe)).not.toThrow();
    });

    test('JSON roundtrip preserves the fields the worker actually needs', () => {
        const dirty = makeDirtyBoundPreset();
        const safe = JSON.parse(JSON.stringify(dirty));

        expect(safe.name).toBe('Test Preset');
        expect(safe.preset.prompts).toEqual([
            { identifier: 'main', content: 'You are an assistant.' },
        ]);
        expect(safe.preset.prompt_order).toEqual([
            { character_id: 100001, order: [{ identifier: 'main', enabled: true }] },
        ]);
        expect(safe.preset.temperature).toBe(0.7);

        // Promises have no enumerable own props → JSON.stringify yields '{}'.
        // The inert empty object is structuredClone-safe, which is what the fix needs.
        expect(safe.preset._pendingSave).toEqual({});
        expect(safe.preset._onChange).toBeUndefined();
        expect(safe.preset._proxy).toEqual({ inner: true });
    });

    test('null boundPreset passes through (delete-bound-preset path)', () => {
        // The caller-side null comes from openai.js:6011 (`nextBoundPreset =
        // trimmed ? {...} : null`). undefined is unreachable in practice — and
        // would throw on JSON.parse(JSON.stringify(undefined)) anyway, so we
        // don't pretend to handle it.
        expect(JSON.parse(JSON.stringify(null))).toBeNull();
    });
});
