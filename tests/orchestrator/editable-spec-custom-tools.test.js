import { describe, test, expect, beforeAll } from '@jest/globals';

// A spec profile whose custom tool list was emptied keeps it empty when
// the editor draft is built and serialized back: the draft carries the
// `seededDefaultCustomTools` flag, so `sanitizeSpec` does not seed the
// default custom tools again.

globalThis.Luker = {
    getContext: () => ({
        translate: (s) => String(s ?? ''),
        saveSettings: async () => {},
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
            unset: Symbol('unset'),
        },
        lib: {
            yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
        },
    }),
};

let sanitizeSpec;
let serializeEditorSpec;
let toEditableSpec;

beforeAll(async () => {
    ({ sanitizeSpec } = await import('../../public/scripts/extensions/orchestrator/spec-schema.js'));
    ({ serializeEditorSpec, toEditableSpec } = await import('../../public/scripts/extensions/orchestrator/editable-spec.js'));
});

const STAGES = [{ id: 'watch', mode: 'serial', nodes: [{ id: 'lookout', preset: 'lookout' }] }];

describe('spec editor draft and seeded default custom tools', () => {
    test('an emptied custom tool list stays empty through the editor draft', () => {
        const stored = sanitizeSpec({ stages: STAGES, customTools: [], seededDefaultCustomTools: true });
        expect(stored.customTools).toEqual([]);
        const roundTripped = serializeEditorSpec(toEditableSpec(stored, { lookout: {} }));
        expect(roundTripped.customTools).toEqual([]);
        expect(roundTripped).toEqual(stored);
    });

    test('a fresh profile still receives the default custom tools', () => {
        const fresh = serializeEditorSpec(toEditableSpec({ stages: STAGES }, { lookout: {} }));
        expect(fresh.customTools.length).toBeGreaterThan(0);
        expect(fresh.seededDefaultCustomTools).toBe(true);
    });
});
