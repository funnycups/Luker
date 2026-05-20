/**
 * Tests for runner.js IDE-style tool classification.
 *
 * runner.js imports `../lib/edits/index.js` (which transitively loads the
 * browser-only `public/lib.js` bundle). The dispatch tests only exercise
 * `getControlToolNames` / `classifyToolCalls`, so we stub the edits lib
 * with `jest.unstable_mockModule` BEFORE importing runner.js to skip the
 * bundle load. Production code still consumes the real exports.
 */

import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { createStubAdapter } from './helpers/stub-adapter.js';

jest.unstable_mockModule('../../public/scripts/lib/edits/index.js', () => ({
    applyEdits: () => { throw new Error('mocked applyEdits should not be called in dispatch tests'); },
    inverseEdit: () => { throw new Error('mocked inverseEdit should not be called in dispatch tests'); },
}));

jest.unstable_mockModule('../../public/scripts/lib/edits/conflict-ui.js', () => ({
    showConflictResolution: () => { throw new Error('mocked showConflictResolution should not be called'); },
}));

jest.unstable_mockModule('../../public/scripts/iteration-studio/i18n.js', () => ({
    i18n: (text) => String(text || ''),
    i18nFormat: (key, ...args) => String(key) + ':' + args.join('|'),
}));

let classifyToolCalls;
let getControlToolNames;

beforeAll(async () => {
    ({ classifyToolCalls, getControlToolNames } = await import('../../public/scripts/iteration-studio/runner.js'));
});

describe('getControlToolNames', () => {
    test('returns shell defaults when adapter has no override', () => {
        const a = createStubAdapter();
        const names = getControlToolNames(a);
        expect(names).toEqual({ continue: 'iter_continue', finalize: 'iter_finalize' });
    });

    test('honors adapter override', () => {
        const a = { ...createStubAdapter(), controlToolNames: { continue: 'foo', finalize: 'bar' } };
        expect(getControlToolNames(a)).toEqual({ continue: 'foo', finalize: 'bar' });
    });
});

describe('classifyToolCalls', () => {
    test('routes shell control names to control', () => {
        const a = createStubAdapter();
        const result = classifyToolCalls(a, [
            { id: 'c1', name: 'iter_continue', args: {} },
            { id: 'c2', name: 'iter_finalize', args: { summary: 'done' } },
            { id: 'c3', name: 'stub_set', args: { path: 'x', newValue: 1 } },
        ]);
        expect(result.controlCalls.map(c => c.name)).toEqual(['iter_continue', 'iter_finalize']);
        expect(result.editableCalls.map(c => c.name)).toEqual(['stub_set']);
    });

    test('adapter.classifyToolCall override wins for non-shell names', () => {
        const a = createStubAdapter();   // stub routes 'stub_control' to control
        const result = classifyToolCalls(a, [
            { id: '1', name: 'stub_control', args: {} },
            { id: '2', name: 'stub_set', args: {} },
        ]);
        expect(result.controlCalls).toHaveLength(1);
        expect(result.editableCalls).toHaveLength(1);
    });
});
