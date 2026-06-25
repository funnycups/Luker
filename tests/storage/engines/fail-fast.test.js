// Startup fail-fast probe: when `storage.failFast` is true in config, the
// boot chain awaits engine.ping() once and exits process(1) on failure.
// When false (default), maybeFailFast is a no-op — lazy connect on first
// request, preserving the current behavior.
//
// The actual `process.exit(1)` is impossible to test directly without
// killing the test runner, so we spy on `process.exit` and throw from the
// stub to interrupt control flow at the call site. That gives us both
// "exit was called with code 1" and "control returned to us after the
// stub threw" as evidence.

import { jest } from '@jest/globals';

describe('storage.failFast startup probe', () => {
    test('calls process.exit(1) when ping fails and failFast=true', async () => {
        const { maybeFailFast } = await import('../../../src/storage/fail-fast.js');
        const fakeEngine = {
            kind: 'mysql',
            ping: async () => {
                throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
            },
        };
        // process.exit normally terminates the test runner — stub it and
        // throw so the function actually unwinds at the exit call site.
        const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('exit-called');
        });
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await expect(maybeFailFast(fakeEngine, true)).rejects.toThrow('exit-called');
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            exitSpy.mockRestore();
            errSpy.mockRestore();
        }
    });

    test('no-op when failFast=false even if ping would fail', async () => {
        const { maybeFailFast } = await import('../../../src/storage/fail-fast.js');
        const fakeEngine = {
            kind: 'mysql',
            ping: async () => { throw new Error('boom'); },
        };
        // Should resolve to undefined and NOT call ping. We verify both: the
        // call returns clean, and ping is never invoked (a stricter check
        // than just "doesn't throw").
        let pingCalled = false;
        fakeEngine.ping = async () => { pingCalled = true; throw new Error('boom'); };
        await expect(maybeFailFast(fakeEngine, false)).resolves.toBeUndefined();
        expect(pingCalled).toBe(false);
    });

    test('no-op when failFast=true and ping succeeds', async () => {
        const { maybeFailFast } = await import('../../../src/storage/fail-fast.js');
        const fakeEngine = { kind: 'fs', ping: async () => {} };
        await expect(maybeFailFast(fakeEngine, true)).resolves.toBeUndefined();
    });
});
