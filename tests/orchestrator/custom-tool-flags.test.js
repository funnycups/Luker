// tests/orchestrator/custom-tool-flags.test.js
import { describe, test, expect } from '@jest/globals';
import { sanitizeAgentToolFlags } from '../../public/scripts/extensions/orchestrator/persistence.js';

// Helper: in override mode, the sanitizer emits explicit `false` for every
// Layer-2 memory_* / search_* verb the caller did not name (see the
// override-narrowing contract in custom-tools-legacy-migration.test.js).
// These tests don't care about that contract — they assert the caller-
// supplied custom flags pass through untouched — so strip the Layer-2
// default-offs before comparing.
function stripLayer2Defaults(custom) {
    const out = {};
    for (const [k, v] of Object.entries(custom)) {
        if (k.startsWith('memory_')) continue;
        if (k.startsWith('search_')) continue;
        out[k] = v;
    }
    return out;
}

describe('sanitizeAgentToolFlags custom namespace', () => {
    test('preserves custom flags verbatim', () => {
        const out = sanitizeAgentToolFlags({
            custom: { my_tool: true, another: false, weird_name: true },
        });
        expect(stripLayer2Defaults(out.custom)).toEqual({ my_tool: true, another: false, weird_name: true });
    });

    test('missing custom field becomes empty object (modulo Layer-2 default-offs)', () => {
        const out = sanitizeAgentToolFlags({});
        expect(stripLayer2Defaults(out.custom)).toEqual({});
    });

    test('non-boolean custom values coerce to boolean with only-false-disables', () => {
        const out = sanitizeAgentToolFlags({
            custom: { a: 1, b: 0, c: 'yes', d: null, e: undefined },
        });
        expect(stripLayer2Defaults(out.custom)).toEqual({ a: true, b: true, c: true, d: true, e: true });
    });

    test('non-object custom value becomes empty object (modulo Layer-2 default-offs)', () => {
        const out = sanitizeAgentToolFlags({ custom: 'not an object' });
        expect(stripLayer2Defaults(out.custom)).toEqual({});
    });
});
