// Regression: orch + CEA both registered `'lorebook'` target on the
// shared target-registry singleton. Last-register-wins clobbered the
// first adapter's handler, silently routing one adapter's writes
// through the other adapter's code path (in particular dropping the
// `_op` envelope orch's flow depends on).
//
// Fix: orch's registration was namespaced to `'orch-lorebook'`. This
// test pins both type names to distinct handlers and confirms each
// resolves independently — co-existing adapters no longer collide.
import { jest } from '@jest/globals';
import {
    registerTarget,
    resolveTarget,
    clearRegistry,
} from '/scripts/iteration-library/storage/target-registry.js';

beforeEach(() => clearRegistry());

describe('lorebook target registration: orch vs CEA', () => {
    test('orch-lorebook and lorebook resolve to distinct handlers', () => {
        const ceaH = { read: jest.fn(), write: jest.fn(), describe: () => 'cea' };
        const orchH = { read: jest.fn(), write: jest.fn(), describe: () => 'orch' };
        registerTarget('lorebook', ceaH);
        registerTarget('orch-lorebook', orchH);
        expect(resolveTarget({ type: 'lorebook', name: 'A' })).toBe(ceaH);
        expect(resolveTarget({ type: 'orch-lorebook', name: 'A', _op: { kind: 'update' } })).toBe(orchH);
    });

    test('boot order does not matter (orch first, then CEA)', () => {
        const orchH = { read: jest.fn(), write: jest.fn(), describe: () => 'orch' };
        const ceaH = { read: jest.fn(), write: jest.fn(), describe: () => 'cea' };
        registerTarget('orch-lorebook', orchH);
        registerTarget('lorebook', ceaH);
        // Neither overwrote the other:
        expect(resolveTarget({ type: 'lorebook' })).toBe(ceaH);
        expect(resolveTarget({ type: 'orch-lorebook' })).toBe(orchH);
    });

    test('registering the same type twice still warns (covers the legacy collision shape)', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const h1 = { read: () => {}, write: () => {}, describe: () => 'a' };
        const h2 = { read: () => {}, write: () => {}, describe: () => 'b' };
        // Two adapters registering the SAME name still surfaces a warning
        // — defensive backstop in case a future caller forgets to namespace.
        registerTarget('lorebook', h1);
        registerTarget('lorebook', h2);
        expect(warn).toHaveBeenCalled();
        expect(resolveTarget({ type: 'lorebook' })).toBe(h2);
        warn.mockRestore();
    });
});
