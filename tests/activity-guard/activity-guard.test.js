import { jest, describe, test, expect } from '@jest/globals';
import {
    createActivityGuardRegistry,
    acquireActivityLease,
    withActivityLease,
    hasUnloadGuard,
    hasChatSwitchGuard,
    hasKeepAliveHold,
    hasActiveSource,
    getActiveActivities,
    getChatSwitchBlockingLabels,
    cancelChatSwitchActivities,
    subscribeActivityGuard,
    resolveRequestActivityLeaseOptions,
} from '../../public/scripts/activity-guard.js';

describe('activity-guard registry', () => {
    describe('validation', () => {
        test('rejects missing options, missing/blank source, and invalid scope with TypeError', () => {
            const registry = createActivityGuardRegistry();

            expect(() => registry.acquireActivityLease()).toThrow(TypeError);
            expect(() => registry.acquireActivityLease(null)).toThrow(TypeError);
            expect(() => registry.acquireActivityLease([])).toThrow(TypeError);
            expect(() => registry.acquireActivityLease(['core:test'])).toThrow(TypeError);
            expect(() => registry.acquireActivityLease('bad')).toThrow(TypeError);
            expect(() => registry.acquireActivityLease({})).toThrow(TypeError);
            expect(() => registry.acquireActivityLease({ source: '' })).toThrow(TypeError);
            expect(() => registry.acquireActivityLease({ source: '   \t\n ' })).toThrow(TypeError);
            expect(() => registry.acquireActivityLease({ source: 123 })).toThrow(TypeError);

            expect(() => registry.acquireActivityLease({ source: 'core:test', scope: 'invalid' })).toThrow(TypeError);
            expect(() => registry.acquireActivityLease({ source: 'core:test', scope: '' })).toThrow(TypeError);
            expect(() => registry.acquireActivityLease({ source: 'core:test', scope: null })).toThrow(TypeError);
            expect(() => registry.acquireActivityLease({ source: 'core:test', onCancel: 'nope' })).toThrow(TypeError);
            expect(() => registry.subscribeActivityGuard('not-a-function')).toThrow(TypeError);

            expect(registry.getActiveActivities()).toEqual([]);
        });
    });

    describe('defaults and overrides', () => {
        test('applies global defaults when scope is omitted or "global"', () => {
            const registry = createActivityGuardRegistry();
            const release = registry.acquireActivityLease({ source: '  core:task  ' });

            expect(registry.hasUnloadGuard()).toBe(true);
            expect(registry.hasChatSwitchGuard()).toBe(false);
            expect(registry.hasKeepAliveHold()).toBe(true);
            expect(registry.hasActiveSource('core:task')).toBe(true);
            expect(registry.hasActiveSource('core:other')).toBe(false);

            const [entry] = registry.getActiveActivities();
            expect(entry).toMatchObject({
                source: 'core:task',
                label: '',
                scope: 'global',
                guardUnload: true,
                guardChatSwitch: false,
                keepAlive: true,
                ambient: false,
            });
            expect(typeof entry.startedAt).toBe('number');

            release();
            expect(registry.getActiveActivities()).toEqual([]);
        });

        test('defaults guardChatSwitch to true when scope is "chat"', () => {
            const registry = createActivityGuardRegistry();
            const release = registry.acquireActivityLease({
                source: 'core:generation',
                label: 'Message generation',
                scope: 'chat',
            });

            expect(registry.hasUnloadGuard()).toBe(true);
            expect(registry.hasChatSwitchGuard()).toBe(true);
            expect(registry.hasKeepAliveHold()).toBe(true);

            const [entry] = registry.getActiveActivities();
            expect(entry).toMatchObject({
                source: 'core:generation',
                label: 'Message generation',
                scope: 'chat',
                guardUnload: true,
                guardChatSwitch: true,
                keepAlive: true,
                ambient: false,
            });

            release();
        });

        test('respects explicit flag overrides', () => {
            const registry = createActivityGuardRegistry();
            const release = registry.acquireActivityLease({
                source: 'custom:job',
                label: 'Custom job',
                scope: 'chat',
                guardUnload: false,
                guardChatSwitch: false,
                keepAlive: false,
                ambient: true,
            });

            expect(registry.hasUnloadGuard()).toBe(false);
            expect(registry.hasChatSwitchGuard()).toBe(false);
            expect(registry.hasKeepAliveHold()).toBe(false);
            expect(registry.hasActiveSource('custom:job')).toBe(true);

            release();
        });
    });

    describe('idempotent release', () => {
        test('second release call is a no-op and does not notify subscribers again', () => {
            const registry = createActivityGuardRegistry();
            const listener = jest.fn();
            registry.subscribeActivityGuard(listener);

            const release = registry.acquireActivityLease({ source: 'core:test' });
            expect(listener).toHaveBeenCalledTimes(1);

            release();
            expect(listener).toHaveBeenCalledTimes(2);
            expect(registry.hasUnloadGuard()).toBe(false);

            release();
            release();
            expect(listener).toHaveBeenCalledTimes(2);
            expect(registry.hasUnloadGuard()).toBe(false);
        });

        test('releasing one of two identical-source leases keeps the other active', () => {
            const registry = createActivityGuardRegistry();
            const release1 = registry.acquireActivityLease({ source: 'core:dup' });
            const release2 = registry.acquireActivityLease({ source: 'core:dup' });

            expect(registry.getActiveActivities()).toHaveLength(2);
            release1();
            expect(registry.getActiveActivities()).toHaveLength(1);
            expect(registry.hasActiveSource('core:dup')).toBe(true);
            release2();
            expect(registry.getActiveActivities()).toHaveLength(0);
            expect(registry.hasActiveSource('core:dup')).toBe(false);
        });
    });

    describe('withActivityLease', () => {
        test('returns resolved value and releases on resolve', async () => {
            const registry = createActivityGuardRegistry();

            const result = await registry.withActivityLease({ source: 'core:async' }, async () => {
                expect(registry.hasActiveSource('core:async')).toBe(true);
                return 42;
            });

            expect(result).toBe(42);
            expect(registry.hasActiveSource('core:async')).toBe(false);
        });

        test('releases lease and rethrows original error on reject', async () => {
            const registry = createActivityGuardRegistry();
            const boom = new Error('boom');

            await expect(
                registry.withActivityLease({ source: 'core:fail' }, async () => {
                    expect(registry.hasActiveSource('core:fail')).toBe(true);
                    throw boom;
                }),
            ).rejects.toBe(boom);

            expect(registry.hasActiveSource('core:fail')).toBe(false);
        });

        test('rejects non-function callback without acquiring a lease', async () => {
            const registry = createActivityGuardRegistry();
            const listener = jest.fn();
            registry.subscribeActivityGuard(listener);

            await expect(registry.withActivityLease({ source: 'core:bad' }, null)).rejects.toThrow(TypeError);
            expect(listener).not.toHaveBeenCalled();
            expect(registry.getActiveActivities()).toEqual([]);
        });
    });

    describe('getChatSwitchBlockingLabels', () => {
        test('deduplicates labels preserving insertion order, skips empty labels, and excludes non-chat-switch leases', () => {
            const registry = createActivityGuardRegistry();
            const r1 = registry.acquireActivityLease({ source: 'g1', scope: 'global', label: 'Global work' });
            const r2 = registry.acquireActivityLease({ source: 'c1', scope: 'chat', label: 'Task A' });
            const r3 = registry.acquireActivityLease({ source: 'c2', scope: 'chat', label: '' });
            const r4 = registry.acquireActivityLease({ source: 'c3', scope: 'chat', label: '   ' });
            const r5 = registry.acquireActivityLease({ source: 'c4', scope: 'chat', label: 'Task B' });
            const r6 = registry.acquireActivityLease({ source: 'c5', scope: 'chat', label: 'Task A' });

            expect(registry.getChatSwitchBlockingLabels()).toEqual(['Task A', 'Task B']);

            r1(); r2(); r3(); r4(); r5(); r6();
        });

        test('shows ambient label only when no non-ambient guardChatSwitch lease is active', () => {
            const registry = createActivityGuardRegistry();
            const releaseAmbient = registry.acquireActivityLease({
                source: 'core:ambient',
                scope: 'chat',
                label: 'Background AI request',
                ambient: true,
            });

            expect(registry.getChatSwitchBlockingLabels()).toEqual(['Background AI request']);

            const releaseNamed = registry.acquireActivityLease({
                source: 'memory-graph:update',
                scope: 'chat',
                label: 'Memory Graph update',
                ambient: false,
            });

            expect(registry.getChatSwitchBlockingLabels()).toEqual(['Memory Graph update']);

            releaseNamed();
            expect(registry.getChatSwitchBlockingLabels()).toEqual(['Background AI request']);

            releaseAmbient();
            expect(registry.getChatSwitchBlockingLabels()).toEqual([]);
        });

        test('unnamed non-ambient guardChatSwitch lease does not suppress named ambient label', () => {
            const registry = createActivityGuardRegistry();
            const releaseAmbient = registry.acquireActivityLease({
                source: 'core:ambient',
                scope: 'chat',
                label: 'Background AI request',
                ambient: true,
            });
            const releaseUnnamed = registry.acquireActivityLease({
                source: 'plugin:unnamed',
                scope: 'chat',
                label: '',
                ambient: false,
            });
            const releaseWhitespace = registry.acquireActivityLease({
                source: 'plugin:whitespace',
                scope: 'chat',
                label: '   ',
                ambient: false,
            });

            expect(registry.getChatSwitchBlockingLabels()).toEqual(['Background AI request']);

            releaseWhitespace();
            releaseUnnamed();
            releaseAmbient();
        });
    });

    describe('hasKeepAliveHold', () => {
        test('filters accurately for default, excludeAmbient, and excludeSources', () => {
            const registry = createActivityGuardRegistry();
            expect(registry.hasKeepAliveHold()).toBe(false);

            const rNoKeepAlive = registry.acquireActivityLease({
                source: 'no:keepalive',
                keepAlive: false,
            });
            expect(registry.hasKeepAliveHold()).toBe(false);

            const rAmbient = registry.acquireActivityLease({
                source: 'core:generate-task',
                ambient: true,
                keepAlive: true,
            });
            expect(registry.hasKeepAliveHold()).toBe(true);
            expect(registry.hasKeepAliveHold({ excludeAmbient: true })).toBe(false);
            expect(registry.hasKeepAliveHold({ excludeSources: ['core:generate-task'] })).toBe(false);

            const rGen = registry.acquireActivityLease({
                source: 'core:generation',
                scope: 'chat',
                ambient: false,
                keepAlive: true,
            });
            expect(registry.hasKeepAliveHold({ excludeAmbient: true })).toBe(true);
            expect(registry.hasKeepAliveHold({ excludeAmbient: true, excludeSources: ['core:generation'] })).toBe(false);
            expect(registry.hasKeepAliveHold({ excludeAmbient: true, excludeSources: ['  core:generation  ', ''] })).toBe(false);
            expect(registry.hasKeepAliveHold({ excludeAmbient: true, excludeSources: new Set(['  core:generation  ']) })).toBe(false);

            const rSd = registry.acquireActivityLease({
                source: 'sd:generate',
                ambient: false,
                keepAlive: true,
            });
            expect(registry.hasKeepAliveHold({ excludeAmbient: true, excludeSources: ['core:generation'] })).toBe(true);

            rNoKeepAlive(); rAmbient(); rGen(); rSd();
        });
    });

    describe('getActiveActivities', () => {
        test('returns frozen snapshots omitting onCancel and internal token', () => {
            const registry = createActivityGuardRegistry();
            const onCancel = jest.fn();
            const release = registry.acquireActivityLease({
                source: 'core:gen',
                label: 'Gen',
                scope: 'chat',
                onCancel,
            });

            const snapshots = registry.getActiveActivities();
            expect(snapshots).toHaveLength(1);
            const snap = snapshots[0];

            expect(Object.isFrozen(snap)).toBe(true);
            expect('onCancel' in snap).toBe(false);
            expect(Object.getOwnPropertySymbols(snap)).toEqual([]);
            expect(Object.keys(snap).sort()).toEqual([
                'ambient',
                'guardChatSwitch',
                'guardUnload',
                'keepAlive',
                'label',
                'scope',
                'source',
                'startedAt',
            ]);
            expect(() => { snap.label = 'mutated'; }).toThrow(TypeError);

            snapshots.pop();
            expect(registry.getActiveActivities()).toHaveLength(1);

            release();
        });
    });

    describe('subscribeActivityGuard', () => {
        test('notifies on acquire/release, isolates throwing subscribers via console.error, supports re-entrant release without skipping siblings, and unsubscribe is idempotent', () => {
            const registry = createActivityGuardRegistry();
            const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            try {
                const calls = [];
                let preRelease = registry.acquireActivityLease({ source: 'core:pre' });

                const unsubThrowing = registry.subscribeActivityGuard(() => {
                    calls.push('throwing');
                    throw new Error('subscriber failure');
                });
                const unsubReEntrant = registry.subscribeActivityGuard(() => {
                    calls.push('reentrant');
                    if (preRelease) {
                        const r = preRelease;
                        preRelease = null;
                        r();
                    }
                });
                const unsubSibling = registry.subscribeActivityGuard(() => {
                    calls.push('sibling');
                });

                const r2 = registry.acquireActivityLease({ source: 'core:sub-test' });

                expect(errorSpy).toHaveBeenCalledTimes(2);
                expect(calls).toEqual([
                    'throwing',
                    'reentrant',
                    'throwing',
                    'reentrant',
                    'sibling',
                    'sibling',
                ]);
                expect(registry.hasActiveSource('core:pre')).toBe(false);
                expect(registry.hasActiveSource('core:sub-test')).toBe(true);

                r2();
                expect(errorSpy).toHaveBeenCalledTimes(3);
                expect(registry.getActiveActivities()).toEqual([]);

                unsubThrowing();
                unsubThrowing();
                unsubReEntrant();
                unsubSibling();

                calls.length = 0;
                const r3 = registry.acquireActivityLease({ source: 'core:after-unsub' });
                r3();
                expect(calls).toEqual([]);
            } finally {
                errorSpy.mockRestore();
            }
        });
    });

    describe('cancelChatSwitchActivities', () => {
        test('snapshots guardChatSwitch: true entries, invokes onCancel, isolates throws, handles re-entrant release, ignores guardChatSwitch: false, and does not force-delete entries', () => {
            const registry = createActivityGuardRegistry();
            const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            try {
                const events = [];
                let releaseReEntrant = null;

                const rGlobal = registry.acquireActivityLease({
                    source: 'global:bg',
                    scope: 'global',
                    onCancel: () => events.push('global-should-not-run'),
                });
                const rNoSwitchGuard = registry.acquireActivityLease({
                    source: 'chat:no-switch-guard',
                    scope: 'chat',
                    guardChatSwitch: false,
                    onCancel: () => events.push('no-switch-guard-should-not-run'),
                });
                const rThrow = registry.acquireActivityLease({
                    source: 'chat:throw',
                    scope: 'chat',
                    onCancel: () => {
                        events.push('throw');
                        throw new Error('cancel hook failed');
                    },
                });
                releaseReEntrant = registry.acquireActivityLease({
                    source: 'chat:reentrant',
                    scope: 'chat',
                    onCancel: () => {
                        events.push('reentrant');
                        releaseReEntrant();
                    },
                });
                const rKeep = registry.acquireActivityLease({
                    source: 'chat:kept',
                    scope: 'chat',
                    onCancel: () => {
                        events.push('kept');
                    },
                });
                const rNoHook = registry.acquireActivityLease({
                    source: 'chat:no-hook',
                    scope: 'chat',
                });

                registry.cancelChatSwitchActivities();

                expect(events).toEqual(['throw', 'reentrant', 'kept']);
                expect(errorSpy).toHaveBeenCalledTimes(1);
                // Re-entrant release removed chat:reentrant; cancelChatSwitchActivities did NOT force-delete the others.
                expect(registry.hasActiveSource('chat:reentrant')).toBe(false);
                expect(registry.hasActiveSource('chat:throw')).toBe(true);
                expect(registry.hasActiveSource('chat:kept')).toBe(true);
                expect(registry.hasActiveSource('chat:no-hook')).toBe(true);
                expect(registry.hasActiveSource('global:bg')).toBe(true);
                expect(registry.hasActiveSource('chat:no-switch-guard')).toBe(true);

                rGlobal(); rNoSwitchGuard(); rThrow(); rKeep(); rNoHook();
            } finally {
                errorSpy.mockRestore();
            }
        });
    });

    describe('module singleton exports', () => {
        test('default singleton exports work together and clean up cleanly', async () => {
            const onCancel = jest.fn();
            const unsub = subscribeActivityGuard(() => {});

            try {
                const release = acquireActivityLease({
                    source: 'singleton:test',
                    label: 'Singleton test',
                    scope: 'chat',
                    onCancel,
                });
                try {
                    expect(hasUnloadGuard()).toBe(true);
                    expect(hasChatSwitchGuard()).toBe(true);
                    expect(hasKeepAliveHold()).toBe(true);
                    expect(hasActiveSource('singleton:test')).toBe(true);
                    expect(getChatSwitchBlockingLabels()).toContain('Singleton test');
                    expect(getActiveActivities().some(a => a.source === 'singleton:test')).toBe(true);

                    cancelChatSwitchActivities();
                    expect(onCancel).toHaveBeenCalledTimes(1);
                } finally {
                    release();
                }

                const value = await withActivityLease({ source: 'singleton:with' }, () => 'ok');
                expect(value).toBe('ok');
                expect(hasActiveSource('singleton:with')).toBe(false);
            } finally {
                unsub();
            }
        });
    });

    describe('resolveRequestActivityLeaseOptions', () => {
        test('strips undefined-valued override keys and falls back when defaultLabel is blank', () => {
            const origLuker = globalThis.Luker;
            globalThis.Luker = undefined;
            try {
                expect(resolveRequestActivityLeaseOptions(
                    { source: undefined, ambient: undefined, label: undefined, scope: undefined, guardUnload: undefined, keepAlive: undefined },
                    'core:generate-task',
                    { defaultLabel: '   ' },
                )).toEqual({
                    source: 'core:generate-task',
                    label: expect.stringMatching(/\S/),
                    scope: 'global',
                    ambient: true,
                    guardUnload: true,
                    keepAlive: true,
                });

                expect(resolveRequestActivityLeaseOptions(
                    { label: '', ambient: false },
                    'core:generate-task',
                    { defaultLabel: '' },
                )).toEqual({
                    source: 'core:generate-task',
                    label: '',
                    scope: 'global',
                    ambient: false,
                    guardUnload: true,
                    keepAlive: true,
                });
            } finally {
                globalThis.Luker = origLuker;
            }
        });
    });
});
