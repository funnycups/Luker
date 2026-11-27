import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createActivityGuardRegistry,
} from '../../public/scripts/activity-guard.js';
import {
    findPluginViolations,
    findReverseViolations,
} from '../../scripts/check-plugin-imports.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function makeLayer2FromRegistry(registry) {
    return Object.freeze({
        acquire: registry.acquireActivityLease,
        run: registry.withActivityLease,
        hasUnloadGuard: registry.hasUnloadGuard,
        hasChatSwitchGuard: registry.hasChatSwitchGuard,
        hasKeepAliveHold: registry.hasKeepAliveHold,
        list: registry.getActiveActivities,
        subscribe: registry.subscribeActivityGuard,
    });
}

describe('Layer 3 CardApp activityGuard exposure (card-app/context.js)', () => {
    const origLuker = globalThis.Luker;
    let buildContext;
    let createScopedActivityGuard;
    let registry;
    let activeLayer2;
    let ctx;

    beforeAll(async () => {
        const noop = () => {};
        registry = createActivityGuardRegistry();
        activeLayer2 = makeLayer2FromRegistry(registry);
        globalThis.Luker = {
            getContext: () => ({
                eventSource: { on: noop, off: noop, emit: async () => {}, once: noop },
                chat: [],
                characters: [],
                swipe: { right: noop },
                presets: { listDocuments: noop, readDocument: noop },
                worldInfoEntry: { create: noop, delete: noop },
                chatWorldInfo: { getNames: noop, setSelection: noop },
                get activityGuard() {
                    return activeLayer2;
                },
            }),
        };
        ({ buildContext, createScopedActivityGuard } = await import('../../public/scripts/extensions/card-app/context.js'));
    });

    afterAll(() => {
        globalThis.Luker = origLuker;
    });

    beforeEach(() => {
        registry = createActivityGuardRegistry();
        activeLayer2 = makeLayer2FromRegistry(registry);
        ctx = buildContext({}, 'char-1', {});
    });

    afterEach(() => {
        ctx?._dispose?.();
    });

    test('exposes the 7 public methods and does not expose cancelChatSwitchActivities', () => {
        expect(ctx.activityGuard).toBeDefined();
        expect(Object.keys(ctx.activityGuard).sort()).toEqual([
            'acquire',
            'hasChatSwitchGuard',
            'hasKeepAliveHold',
            'hasUnloadGuard',
            'list',
            'run',
            'subscribe',
        ]);
        expect('cancelChatSwitchActivities' in ctx.activityGuard).toBe(false);
        expect(ctx.activityGuard.cancelChatSwitchActivities).toBeUndefined();
    });

    test('acquire defaults scope to "chat" when omitted', () => {
        const release = ctx.activityGuard.acquire({ source: 'card:op', label: 'Op' });

        expect(ctx.activityGuard.hasChatSwitchGuard()).toBe(true);
        expect(ctx.activityGuard.hasUnloadGuard()).toBe(true);
        expect(ctx.activityGuard.hasKeepAliveHold()).toBe(true);
        expect(ctx.activityGuard.list()).toHaveLength(1);
        expect(ctx.activityGuard.list()[0]).toMatchObject({
            source: 'card:op',
            label: 'Op',
            scope: 'chat',
            guardChatSwitch: true,
            guardUnload: true,
        });

        release();
        expect(ctx.activityGuard.list()).toEqual([]);
    });

    test('explicit scope: "global" is preserved', () => {
        const release = ctx.activityGuard.acquire({
            source: 'card:bg',
            label: 'Background sync',
            scope: 'global',
        });

        expect(ctx.activityGuard.hasChatSwitchGuard()).toBe(false);
        expect(ctx.activityGuard.hasUnloadGuard()).toBe(true);
        expect(ctx.activityGuard.list()[0]).toMatchObject({
            source: 'card:bg',
            scope: 'global',
            guardChatSwitch: false,
            guardUnload: true,
        });

        release();
    });

    test('disposing the CardApp releases all still-held leases and unsubscribes all listeners', () => {
        const listener1 = jest.fn();
        const listener2 = jest.fn();
        ctx.activityGuard.subscribe(listener1);
        ctx.activityGuard.subscribe(listener2);

        const r1 = ctx.activityGuard.acquire({ source: 'card:first', label: 'First' });
        const r2 = ctx.activityGuard.acquire({ source: 'card:second', label: 'Second', scope: 'global' });

        expect(ctx.activityGuard.list()).toHaveLength(2);
        expect(listener1).toHaveBeenCalledTimes(2);
        expect(listener2).toHaveBeenCalledTimes(2);

        ctx._dispose();

        expect(ctx.activityGuard.list()).toEqual([]);
        expect(registry.hasUnloadGuard()).toBe(false);
        expect(registry.hasChatSwitchGuard()).toBe(false);
        expect(listener1).toHaveBeenCalledTimes(2);
        expect(listener2).toHaveBeenCalledTimes(2);

        const outsideRelease = registry.acquireActivityLease({ source: 'other:op' });
        outsideRelease();
        expect(listener1).toHaveBeenCalledTimes(2);
        expect(listener2).toHaveBeenCalledTimes(2);

        r1();
        r2();
        ctx._dispose();
    });

    test('manual release and unsubscribe remove cleanup entries cleanly and remain idempotent', () => {
        const cleanups = [];
        const registerCleanup = (fn) => {
            cleanups.push(fn);
            return () => {
                const idx = cleanups.indexOf(fn);
                if (idx !== -1) cleanups.splice(idx, 1);
            };
        };

        const scoped = createScopedActivityGuard(makeLayer2FromRegistry(registry), registerCleanup);
        const listener = jest.fn();
        const unsubscribe = scoped.subscribe(listener);
        const release = scoped.acquire({ source: 'card:manual', label: 'Manual' });

        expect(cleanups).toHaveLength(2);
        expect(listener).toHaveBeenCalledTimes(1);

        release();
        release();
        expect(cleanups).toHaveLength(1);
        expect(registry.getActiveActivities()).toEqual([]);
        expect(listener).toHaveBeenCalledTimes(2);

        unsubscribe();
        unsubscribe();
        expect(cleanups).toHaveLength(0);

        const outsideRelease = registry.acquireActivityLease({ source: 'card:after-unsub' });
        outsideRelease();
        expect(listener).toHaveBeenCalledTimes(2);

        const ctxRelease = ctx.activityGuard.acquire({ source: 'card:ctx-manual' });
        const ctxUnsub = ctx.activityGuard.subscribe(jest.fn());
        ctxRelease();
        ctxRelease();
        ctxUnsub();
        ctxUnsub();
        ctx._dispose();
        ctx._dispose();
    });

    test('run defaults scope to "chat" and releases in finally on both resolve and reject', async () => {
        let seenDuringRun = null;
        const result = await ctx.activityGuard.run(
            { source: 'card:run-ok', label: 'Run OK' },
            async () => {
                seenDuringRun = ctx.activityGuard.list();
                return 42;
            },
        );

        expect(result).toBe(42);
        expect(seenDuringRun).toHaveLength(1);
        expect(seenDuringRun[0].scope).toBe('chat');
        expect(seenDuringRun[0].guardChatSwitch).toBe(true);
        expect(ctx.activityGuard.list()).toEqual([]);

        await expect(
            ctx.activityGuard.run({ source: 'card:run-err', label: 'Run Err' }, async () => {
                expect(ctx.activityGuard.hasChatSwitchGuard()).toBe(true);
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        expect(ctx.activityGuard.list()).toEqual([]);
        expect(ctx.activityGuard.hasChatSwitchGuard()).toBe(false);
    });

    test('run cleans up via _dispose if CardApp unmounts mid-flight and handles late settlement idempotently', async () => {
        let resolvePending;
        const pending = new Promise((resolve) => {
            resolvePending = resolve;
        });

        const runPromise = ctx.activityGuard.run(
            { source: 'card:in-flight', label: 'In flight' },
            () => pending,
        );

        expect(ctx.activityGuard.hasChatSwitchGuard()).toBe(true);
        ctx._dispose();
        expect(ctx.activityGuard.hasChatSwitchGuard()).toBe(false);
        expect(ctx.activityGuard.list()).toEqual([]);

        resolvePending('settled-after-dispose');
        await expect(runPromise).resolves.toBe('settled-after-dispose');
        expect(ctx.activityGuard.list()).toEqual([]);
    });

    test('hasKeepAliveHold forwards filter options and invalid acquire/run inputs throw without leaking cleanups', async () => {
        const cleanups = [];
        const scoped = createScopedActivityGuard(makeLayer2FromRegistry(registry), (fn) => {
            cleanups.push(fn);
            return () => {
                const idx = cleanups.indexOf(fn);
                if (idx !== -1) cleanups.splice(idx, 1);
            };
        });

        expect(() => scoped.acquire({})).toThrow(TypeError);
        expect(() => scoped.subscribe('not-fn')).toThrow(TypeError);
        await expect(scoped.run({ source: 'card:bad-fn' }, 'not-fn')).rejects.toThrow(TypeError);
        expect(cleanups).toHaveLength(0);

        const release = ctx.activityGuard.acquire({
            source: 'card:ambient',
            ambient: true,
        });
        expect(ctx.activityGuard.hasKeepAliveHold()).toBe(true);
        expect(ctx.activityGuard.hasKeepAliveHold({ excludeAmbient: true })).toBe(false);
        expect(ctx.activityGuard.hasKeepAliveHold({ excludeSources: ['card:ambient'] })).toBe(false);
        release();
    });

    test('card-app/context.js preserves zero plugin boundary violations', () => {
        const { coreViolations, pluginViolations } = findPluginViolations(REPO_ROOT);
        const reverseViolations = findReverseViolations(REPO_ROOT);
        expect(coreViolations.size).toBe(0);
        expect(pluginViolations.size).toBe(0);
        expect(reverseViolations).toEqual([]);
    });
});
