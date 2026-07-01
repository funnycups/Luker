import { describe, test, expect, beforeEach, jest } from '@jest/globals';

describe('luker-android-debug-trail', () => {
    beforeEach(() => {
        jest.resetModules();
        delete globalThis.window;
        delete globalThis.performance;
    });

    test('initAndroidDebugTrail is a noop when bridge missing', async () => {
        globalThis.window = { addEventListener: jest.fn() };
        const mod = await import('../public/scripts/luker-android-debug-trail.js');
        mod.initAndroidDebugTrail();
        expect(globalThis.window.addEventListener).not.toHaveBeenCalled();
    });

    test('setAndroidDebugRecordingEnabled does not throw when bridge missing', async () => {
        globalThis.window = {};
        const mod = await import('../public/scripts/luker-android-debug-trail.js');
        expect(() => mod.setAndroidDebugRecordingEnabled(true)).not.toThrow();
        expect(() => mod.setAndroidDebugRecordingEnabled(false)).not.toThrow();
    });

    test('pushRenderMarker is a noop when bridge missing', async () => {
        const consoleInfo = jest.fn();
        globalThis.window = {};
        globalThis.console = { ...console, info: consoleInfo };
        const mod = await import('../public/scripts/luker-android-debug-trail.js');
        mod.pushRenderMarker({ msgId: 'm1', bytes: 100, turn: 2 });
        expect(consoleInfo).not.toHaveBeenCalled();
    });

    test('initAndroidDebugTrail with bridge attaches listeners and heap sampler', async () => {
        const addEventListener = jest.fn();
        const setIntervalSpy = jest.fn(() => 99);
        const pushDebugTrail = jest.fn();
        globalThis.window = {
            addEventListener,
            setInterval: setIntervalSpy,
            LukerAndroid: { pushDebugTrail, setDebugRecordingEnabled: jest.fn() },
        };
        globalThis.performance = { memory: { usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 } };
        globalThis.setInterval = setIntervalSpy;

        const mod = await import('../public/scripts/luker-android-debug-trail.js');
        mod.initAndroidDebugTrail();

        expect(addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
        expect(addEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);

        const heapTick = setIntervalSpy.mock.calls[0][0];
        heapTick();
        expect(pushDebugTrail).toHaveBeenCalledWith('webheap', 'used=1 total=2 limit=3');
    });

    test('setAndroidDebugRecordingEnabled with bridge forwards boolean', async () => {
        const setDebugRecordingEnabled = jest.fn();
        globalThis.window = {
            addEventListener: jest.fn(),
            LukerAndroid: { pushDebugTrail: jest.fn(), setDebugRecordingEnabled },
        };

        const mod = await import('../public/scripts/luker-android-debug-trail.js');
        mod.setAndroidDebugRecordingEnabled(true);
        mod.setAndroidDebugRecordingEnabled(false);

        expect(setDebugRecordingEnabled).toHaveBeenNthCalledWith(1, true);
        expect(setDebugRecordingEnabled).toHaveBeenNthCalledWith(2, false);
    });

    test('pushRenderMarker with bridge calls console.info', async () => {
        const consoleInfo = jest.fn();
        globalThis.window = {
            addEventListener: jest.fn(),
            LukerAndroid: { pushDebugTrail: jest.fn(), setDebugRecordingEnabled: jest.fn() },
        };
        globalThis.console = { ...console, info: consoleInfo };

        const mod = await import('../public/scripts/luker-android-debug-trail.js');
        mod.pushRenderMarker({ msgId: 'm42', bytes: 999, turn: 7 });

        expect(consoleInfo).toHaveBeenCalledWith('[render] msg=m42 bytes=999 turn=7');
    });
});
