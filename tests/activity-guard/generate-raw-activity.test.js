import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createActivityGuardRegistry } from '../../public/scripts/activity-guard.js';
import { createChatTransitionCoordinator } from '../../public/scripts/lib/chat-transition-coordinator.js';
import { normalizeGenerateRawArgs } from '../../public/scripts/lib/request-activity-lease.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('generateRaw / generateRawData activity lease and argument normalization', () => {
    let registry;
    let translateImpl;
    let coordinator;

    beforeEach(() => {
        registry = createActivityGuardRegistry();
        translateImpl = (key) => key;
        coordinator = createChatTransitionCoordinator({
            isGenerating: () => false,
            hasActiveMessageEdit: () => false,
            getStreamingProcessor: () => null,
            clearStreamingProcessorIfSame: () => {},
            stopGeneration: () => {},
            confirmPopup: async () => 1,
            escapeHtml: (s) => String(s),
            t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)),
            translate: (key) => translateImpl(key),
            activityGuard: registry,
        });
    });

    afterEach(() => {
        const leftover = registry.getActiveActivities();
        if (leftover.length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
        }
    });

    test('runWithGenerateRawLease holds core:generate-raw baseline lease during request and releases on resolve', async () => {
        const gate = deferred();
        let observed = null;
        translateImpl = (key) => `TR:${key}`;

        const reqPromise = coordinator.runWithGenerateRawLease(true, async () => {
            observed = {
                activities: registry.getActiveActivities(),
                unload: registry.hasUnloadGuard(),
                chatSwitch: registry.hasChatSwitchGuard(),
                keepAlive: registry.hasKeepAliveHold(),
                keepAliveNonAmbient: registry.hasKeepAliveHold({ excludeAmbient: true }),
            };
            return await gate.promise;
        });

        expect(observed).toBeTruthy();
        expect(observed.unload).toBe(true);
        expect(observed.chatSwitch).toBe(false);
        expect(observed.keepAlive).toBe(true);
        expect(observed.keepAliveNonAmbient).toBe(false);
        expect(observed.activities).toHaveLength(1);
        expect(observed.activities[0]).toMatchObject({
            source: 'core:generate-raw',
            label: expect.stringMatching(/^TR:\S/),
            scope: 'global',
            ambient: true,
            guardUnload: true,
            guardChatSwitch: false,
            keepAlive: true,
        });

        gate.resolve({ choices: [{ message: { content: 'ok' } }] });
        const result = await reqPromise;
        expect(result).toEqual({ choices: [{ message: { content: 'ok' } }] });
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('runWithGenerateRawLease releases lease on error', async () => {
        await expect(coordinator.runWithGenerateRawLease(true, async () => {
            expect(registry.hasActiveSource('core:generate-raw')).toBe(true);
            throw new Error('raw failure');
        })).rejects.toThrow('raw failure');

        expect(registry.getActiveActivities()).toEqual([]);
        expect(registry.hasUnloadGuard()).toBe(false);
    });

    test('supports activity: false opt-out, custom overrides, and positional generateRaw calls', async () => {
        const listener = jest.fn();
        const unsub = registry.subscribeActivityGuard(listener);
        try {
            let observedOptOut = null;
            const out = await coordinator.runWithGenerateRawLease(false, async () => {
                observedOptOut = registry.getActiveActivities();
                return 'quiet';
            });
            expect(out).toBe('quiet');
            expect(observedOptOut).toEqual([]);
            expect(listener).not.toHaveBeenCalled();

            let observedCustom = null;
            const out2 = await coordinator.runWithGenerateRawLease(
                { scope: 'chat', label: 'Raw override', ambient: false },
                async () => {
                    observedCustom = registry.getActiveActivities();
                    return 'custom reply';
                },
            );
            expect(out2).toBe('custom reply');
            expect(observedCustom).toHaveLength(1);
            expect(observedCustom[0]).toMatchObject({
                source: 'core:generate-raw',
                scope: 'chat',
                label: 'Raw override',
                ambient: false,
                guardChatSwitch: true,
            });

            const positional = normalizeGenerateRawArgs(['Hello positional', 'openai']);
            expect(positional.positional).toBe(true);
            expect(positional.params).toMatchObject({
                prompt: 'Hello positional',
                api: 'openai',
                activity: true,
            });

            let observedPositional = null;
            const out3 = await coordinator.runWithGenerateRawLease(positional.params.activity, async () => {
                observedPositional = registry.getActiveActivities();
                return 'positional reply';
            });
            expect(out3).toBe('positional reply');
            expect(observedPositional).toHaveLength(1);
            expect(observedPositional[0]).toMatchObject({
                source: 'core:generate-raw',
                scope: 'global',
                ambient: true,
                guardUnload: true,
                keepAlive: true,
            });
        } finally {
            unsub();
        }
    });
});
