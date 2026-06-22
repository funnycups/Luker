import { jest } from '@jest/globals';
import {
    registerTarget,
    resolveTarget,
    clearRegistry,
    UnknownTargetError,
} from '/scripts/iteration-library/storage/target-registry.js';

beforeEach(() => clearRegistry());

describe('target-registry', () => {
    test('register + resolve returns the handler', async () => {
        const handler = { read: jest.fn(), write: jest.fn(), describe: () => 'preset' };
        registerTarget('preset', handler);
        expect(resolveTarget({ type: 'preset' })).toBe(handler);
    });

    test('resolve unknown type throws UnknownTargetError', () => {
        expect(() => resolveTarget({ type: 'nope' })).toThrow(UnknownTargetError);
    });

    test('resolve with missing/invalid target throws UnknownTargetError', () => {
        expect(() => resolveTarget(null)).toThrow(UnknownTargetError);
        expect(() => resolveTarget({})).toThrow(UnknownTargetError);
        expect(() => resolveTarget({ type: '' })).toThrow(UnknownTargetError);
    });

    test('duplicate register overwrites and warns to console', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const h1 = { read: () => {}, write: () => {}, describe: () => 'a' };
        const h2 = { read: () => {}, write: () => {}, describe: () => 'b' };
        registerTarget('preset', h1);
        registerTarget('preset', h2);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('preset'));
        expect(resolveTarget({ type: 'preset' })).toBe(h2);
        warn.mockRestore();
    });

    test('isolation: registering one type does not affect another', () => {
        const presetH = { read: () => {}, write: () => {}, describe: () => 'p' };
        const lorebookH = { read: () => {}, write: () => {}, describe: () => 'l' };
        registerTarget('preset', presetH);
        registerTarget('lorebook', lorebookH);
        expect(resolveTarget({ type: 'preset' })).toBe(presetH);
        expect(resolveTarget({ type: 'lorebook', name: 'My Book' })).toBe(lorebookH);
    });

    test('register rejects invalid handler shape', () => {
        expect(() => registerTarget('x', null)).toThrow();
        expect(() => registerTarget('x', { read: () => {} })).toThrow(/write|describe/);
    });
});
