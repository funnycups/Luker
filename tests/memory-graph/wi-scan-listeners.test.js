/**
 * Tests for memory-graph's GENERATION_BEFORE/AFTER_WORLD_INFO_SCAN handlers.
 *
 * Two regressions are pinned here:
 *
 *   (1) Dry-run / quiet payloads must be a hard no-op.
 *       PromptManager fires `Generate('normal', {}, true)` (dryRun=true) on
 *       a debounced requestIdleCallback whenever its DOM re-renders — and
 *       MESSAGE_DELETED triggers exactly such a re-render. If the
 *       AFTER_WI listener honors dry-runs, the dry-run call falls into
 *       safeInjectMemoryPrompts, bumps `activeRecallRunToken`, and aborts
 *       the real Generate's `activeRecallAbortController` mid-flight. The
 *       real recall then throws AbortError → "Memory recall cancelled by
 *       user." status + `payload.requestRescan` never set → stale
 *       persistent lorebook entries that have already been cleared on
 *       disk still get sent to the LLM (because core captured the WI
 *       scan snapshot before the clear landed).
 *
 *   (2) Persistent lorebook (corePacket) must be drained + synced BEFORE
 *       WI scan, not after.
 *       core's Generate flow is:
 *         emit(GENERATION_STARTED)
 *         emit(GENERATION_BEFORE_WORLD_INFO_SCAN)   ← awaited
 *         runWIScan()                                ← captures lorebook
 *         emit(GENERATION_AFTER_WORLD_INFO_SCAN)
 *       Doing the drain on AFTER_WI means WI scan already read stale
 *       entries. We move corePacket sync to BEFORE_WI so the WI scan
 *       sees a fresh lorebook by the time it reads. The AFTER_WI handler
 *       keeps recall + focusPacket (those depend on `payload.coreChat`,
 *       which only exists post-scan).
 *
 * These tests exercise the listener entry points directly via the
 * `_handle*ForTest` exports rather than through `eventSource.emit` —
 * the jQuery init that registers the listeners is mocked out by
 * `main-module-stack.js`, so the registrations themselves never run.
 */

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import './_mocks/main-module-stack.js';

let handleWiAfterScan;
let handleWiBeforeScan;
let getRecallRuntimeState;
let resetRecallRuntimeStateForTest;
let setSafeInjectMemoryPromptsHookForTest;
let setPersistentDrainHookForTest;

beforeAll(async () => {
    const main = await import('../../public/scripts/extensions/memory-graph/main.js');
    handleWiAfterScan = main._handleWiAfterScanForTest;
    handleWiBeforeScan = main._handleWiBeforeScanForTest;
    getRecallRuntimeState = main._getRecallRuntimeStateForTest;
    resetRecallRuntimeStateForTest = main._resetRecallRuntimeStateForTest;
    setSafeInjectMemoryPromptsHookForTest = main._setSafeInjectMemoryPromptsHookForTest;
    setPersistentDrainHookForTest = main._setPersistentDrainHookForTest;
});

beforeEach(() => {
    resetRecallRuntimeStateForTest();
    setSafeInjectMemoryPromptsHookForTest(null);
    setPersistentDrainHookForTest(null);
});

describe('GENERATION_AFTER_WORLD_INFO_SCAN: dry-run / quiet guard', () => {
    test('dryRun:true payload does NOT invoke safeInjectMemoryPrompts', async () => {
        const injectCalls = [];
        setSafeInjectMemoryPromptsHookForTest(async (ctx, payload, trigger) => {
            injectCalls.push({ trigger, type: payload?.type, dryRun: payload?.dryRun });
            return false;
        });

        await handleWiAfterScan({ type: 'normal', dryRun: true, coreChat: [] });

        expect(injectCalls).toEqual([]);
    });

    test('type:"quiet" payload does NOT invoke safeInjectMemoryPrompts', async () => {
        const injectCalls = [];
        setSafeInjectMemoryPromptsHookForTest(async () => {
            injectCalls.push('called');
            return false;
        });

        await handleWiAfterScan({ type: 'quiet', dryRun: false, coreChat: [] });

        expect(injectCalls).toEqual([]);
    });

    test('dryRun:true payload does NOT mutate activeRecallRunToken or activeRecallAbortController', async () => {
        // Simulate a real Generate's recall already in flight: token=42,
        // controller alive. We need the dry-run to leave both untouched —
        // otherwise the in-flight recall would see token mismatch + a
        // pre-aborted controller and surface "cancelled by user".
        const liveController = new AbortController();
        resetRecallRuntimeStateForTest({
            activeRecallRunToken: 42,
            activeRecallAbortController: liveController,
        });

        await handleWiAfterScan({ type: 'normal', dryRun: true, coreChat: [] });

        const state = getRecallRuntimeState();
        expect(state.activeRecallRunToken).toBe(42);
        expect(state.activeRecallAbortController).toBe(liveController);
        expect(liveController.signal.aborted).toBe(false);
    });

    test('type:"quiet" payload does NOT mutate activeRecallRunToken or activeRecallAbortController', async () => {
        const liveController = new AbortController();
        resetRecallRuntimeStateForTest({
            activeRecallRunToken: 7,
            activeRecallAbortController: liveController,
        });

        await handleWiAfterScan({ type: 'quiet', coreChat: [] });

        const state = getRecallRuntimeState();
        expect(state.activeRecallRunToken).toBe(7);
        expect(state.activeRecallAbortController).toBe(liveController);
        expect(liveController.signal.aborted).toBe(false);
    });

    test('normal regenerate payload DOES invoke safeInjectMemoryPrompts', async () => {
        const injectCalls = [];
        setSafeInjectMemoryPromptsHookForTest(async (ctx, payload, trigger) => {
            injectCalls.push({ trigger, type: payload?.type });
            return false;
        });

        await handleWiAfterScan({ type: 'regenerate', dryRun: false, coreChat: [] });

        expect(injectCalls.length).toBe(1);
        expect(injectCalls[0].trigger).toBe('after_world_info_scan');
        expect(injectCalls[0].type).toBe('regenerate');
    });
});

describe('GENERATION_BEFORE_WORLD_INFO_SCAN: pre-scan drain + persistent sync', () => {
    test('normal payload triggers the persistent-lorebook drain', async () => {
        const drainCalls = [];
        setPersistentDrainHookForTest(async () => {
            drainCalls.push(Date.now());
        });

        await handleWiBeforeScan({ type: 'normal', dryRun: false });

        expect(drainCalls.length).toBe(1);
    });

    test('regenerate payload triggers the persistent-lorebook drain', async () => {
        const drainCalls = [];
        setPersistentDrainHookForTest(async () => {
            drainCalls.push('drain');
        });

        await handleWiBeforeScan({ type: 'regenerate', dryRun: false });

        expect(drainCalls).toEqual(['drain']);
    });

    test('dryRun:true payload does NOT trigger the persistent-lorebook drain', async () => {
        const drainCalls = [];
        setPersistentDrainHookForTest(async () => {
            drainCalls.push('drain');
        });

        await handleWiBeforeScan({ type: 'normal', dryRun: true });

        expect(drainCalls).toEqual([]);
    });

    test('type:"quiet" payload does NOT trigger the persistent-lorebook drain', async () => {
        const drainCalls = [];
        setPersistentDrainHookForTest(async () => {
            drainCalls.push('drain');
        });

        await handleWiBeforeScan({ type: 'quiet' });

        expect(drainCalls).toEqual([]);
    });

    test('handleWiBeforeScan awaits the drain (caller can rely on it completing)', async () => {
        // BEFORE_WI is awaited by core, so our handler must NOT return
        // before the drain settles — otherwise WI scan races past it
        // and the whole point of moving the drain pre-scan is lost.
        let drainResolved = false;
        setPersistentDrainHookForTest(() => new Promise((resolve) => {
            setTimeout(() => {
                drainResolved = true;
                resolve();
            }, 25);
        }));

        await handleWiBeforeScan({ type: 'normal' });

        expect(drainResolved).toBe(true);
    });
});
