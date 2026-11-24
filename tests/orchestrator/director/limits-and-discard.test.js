import { describe, expect, test, jest, beforeAll } from '@jest/globals';
import {
    handleDirectorDispatch,
    runMainAgentLoop,
} from '../../../public/scripts/extensions/orchestrator/director-runtime.js';
import { createSubagentDispatcher } from '../../../public/scripts/extensions/orchestrator/director-tools.js';
import { createMessageEditorHandle } from '../../../public/scripts/message-takeover.js';

beforeAll(() => {
    const stub = {
        getContext: () => ({ createMessageEditorHandle }),
    };
    globalThis.Luker = stub;
    globalThis.st = stub;
});

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function makeHandle(abortSignal = undefined, { originalText = '', originalReasoning = '' } = {}) {
    const chat = [{ mes: originalText, extra: { reasoning: originalReasoning }, is_user: false }];
    const handle = createMessageEditorHandle({
        generationType: 'normal',
        originalText,
        originalReasoning,
        flushIntervalMs: 0,
        abortSignal,
    });
    handle.setOnUpdate((text, reasoning) => {
        chat[0].mes = text;
        chat[0].extra.reasoning = reasoning;
    });
    return { chat, handle };
}

describe('director subagent dispatcher — maxConcurrentSubagents semaphore', () => {
    test('caps concurrent subagent executions to maxConcurrentSubagents and completes all queued dispatches', async () => {
        let activeCount = 0;
        let maxObservedActive = 0;
        const startedOrder = [];
        const gates = new Map();

        const generateTask = jest.fn(async (opts) => {
            const taskUserMsg = opts.taskMessages.find(m => m.role === 'system' && String(m.content || '').startsWith('<task>'));
            const taskLabel = String(taskUserMsg?.content || '').replace(/<\/?task>\n?/g, '').trim();
            startedOrder.push(taskLabel);
            activeCount += 1;
            if (activeCount > maxObservedActive) {
                maxObservedActive = activeCount;
            }
            const gate = gates.get(taskLabel);
            try {
                await gate.promise;
                return { assistantText: `done:${taskLabel}`, toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
            } finally {
                activeCount -= 1;
            }
        });

        for (const id of ['job-1', 'job-2', 'job-3', 'job-4']) {
            gates.set(id, createDeferred());
        }

        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 'worker', description: 'w', systemPrompt: 'work' }],
            limits: { maxConcurrentSubagents: 2, maxTotalSubagentRuns: 10 },
            generateTask,
            abortSignal: new AbortController().signal,
        });

        const handles = await Promise.all([
            dispatcher.dispatch({ subagentId: 'worker', task: 'job-1' }),
            dispatcher.dispatch({ subagentId: 'worker', task: 'job-2' }),
            dispatcher.dispatch({ subagentId: 'worker', task: 'job-3' }),
            dispatcher.dispatch({ subagentId: 'worker', task: 'job-4' }),
        ]);

        // Allow microtasks to enter generateTask for the first 2 slots.
        await new Promise(r => setTimeout(r, 20));
        expect(activeCount).toBe(2);
        expect(maxObservedActive).toBe(2);
        expect(startedOrder).toEqual(['job-1', 'job-2']);

        // Release slot 1 -> job-3 enters, still capped at 2.
        gates.get('job-1').resolve();
        await new Promise(r => setTimeout(r, 20));
        expect(maxObservedActive).toBe(2);
        expect(startedOrder).toEqual(['job-1', 'job-2', 'job-3']);

        // Release slot 2 -> job-4 enters.
        gates.get('job-2').resolve();
        await new Promise(r => setTimeout(r, 20));
        expect(maxObservedActive).toBe(2);
        expect(startedOrder).toEqual(['job-1', 'job-2', 'job-3', 'job-4']);

        gates.get('job-3').resolve();
        gates.get('job-4').resolve();

        const results = await dispatcher.awaitAll(handles);
        expect(results.map(r => r.outputText)).toEqual([
            'done:job-1',
            'done:job-2',
            'done:job-3',
            'done:job-4',
        ]);
        expect(maxObservedActive).toBe(2);
    });

    test('Review Focus #5: aborting parentAbortSignal unblocks sub-agent queued behind semaphore without deadlocking', async () => {
        const parentAc = new AbortController();
        let activeCount = 0;

        // Sub-agent #1 hangs forever and ignores abortSignal so the semaphore slot is never released.
        const generateTask = jest.fn(async () => {
            activeCount += 1;
            return new Promise(() => { /* intentionally never resolves */ });
        });

        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 'worker', description: 'w', systemPrompt: 'work' }],
            limits: { maxConcurrentSubagents: 1, maxTotalSubagentRuns: 5 },
            generateTask,
            abortSignal: parentAc.signal,
        });

        const h1 = await dispatcher.dispatch({ subagentId: 'worker', task: 'blocking-first' });
        const h2 = await dispatcher.dispatch({ subagentId: 'worker', task: 'queued-second' });

        await new Promise(r => setTimeout(r, 20));
        expect(activeCount).toBe(1);
        expect(generateTask).toHaveBeenCalledTimes(1);

        const startedAt = Date.now();
        parentAc.abort();

        // Queued sub-agent #2 must settle promptly on parent abort even while #1 remains blocked.
        const [res2] = await dispatcher.awaitAll([h2]);
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(1000);
        expect(res2).toEqual({
            handleId: h2,
            subagentId: 'worker',
            error: 'cancelled',
        });
        expect(generateTask).toHaveBeenCalledTimes(1);

        const notifs = dispatcher.drainCompletionNotifications();
        expect(notifs).toContainEqual({
            handleId: h2,
            subagentId: 'worker',
            status: 'cancelled',
            summary: 'cancelled',
        });
        expect(h1).toBe('subagent-0');
    });

    test('cancelling a queued sub-agent unblocks it immediately without leaking a semaphore slot', async () => {
        const firstGate = createDeferred();
        const thirdGate = createDeferred();
        const started = [];

        const generateTask = jest.fn(async (opts) => {
            const taskMsg = opts.taskMessages.find(m => m.role === 'system' && String(m.content || '').startsWith('<task>'));
            const label = String(taskMsg?.content || '').replace(/<\/?task>\n?/g, '').trim();
            started.push(label);
            if (label === 'first') await firstGate.promise;
            if (label === 'third') await thirdGate.promise;
            return { assistantText: `ok:${label}`, toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 'worker', description: 'w', systemPrompt: 'work' }],
            limits: { maxConcurrentSubagents: 1, maxTotalSubagentRuns: 5 },
            generateTask,
            abortSignal: new AbortController().signal,
        });

        const h1 = await dispatcher.dispatch({ subagentId: 'worker', task: 'first' });
        const h2 = await dispatcher.dispatch({ subagentId: 'worker', task: 'second-cancelled' });

        await new Promise(r => setTimeout(r, 20));
        expect(started).toEqual(['first']);

        const cancelRes = dispatcher.cancel(h2);
        expect(cancelRes).toEqual({ ok: true });

        const [res2] = await dispatcher.awaitAll([h2]);
        expect(res2).toEqual({ handleId: h2, subagentId: 'worker', error: 'cancelled' });

        // Release #1, then dispatch #3 — must acquire slot cleanly (no leaked slot).
        firstGate.resolve();
        const [res1] = await dispatcher.awaitAll([h1]);
        expect(res1.outputText).toBe('ok:first');

        const h3 = await dispatcher.dispatch({ subagentId: 'worker', task: 'third' });
        thirdGate.resolve();
        const [res3] = await dispatcher.awaitAll([h3]);
        expect(res3.outputText).toBe('ok:third');
        expect(started).toEqual(['first', 'third']);
    });
});

describe('director runtime — discardOnAbort enforcement', () => {
    test('runMainAgentLoop between-round abort calls handle.discard() when discardOnAbort is true and handle.abort() when false', async () => {
        const acTrue = new AbortController();
        const { handle: handleDiscard } = makeHandle(undefined, { originalText: 'orig', originalReasoning: 'origR' });
        handleDiscard.setText('partial');
        const discardSpy = jest.spyOn(handleDiscard, 'discard');
        const abortSpyForDiscard = jest.spyOn(handleDiscard, 'abort');
        acTrue.abort();

        await runMainAgentLoop({
            handle: handleDiscard,
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 3, discardOnAbort: true, tools: {} } },
            eventData: { type: 'normal', abortSignal: acTrue.signal },
            deps: {
                generateTaskStreamForMainAgent: jest.fn(),
                generateTask: jest.fn(),
                chat: [{ mes: 'orig', extra: { reasoning: 'origR' }, is_user: false }],
            },
        });

        expect(discardSpy).toHaveBeenCalledTimes(1);
        expect(abortSpyForDiscard).not.toHaveBeenCalled();
        await expect(handleDiscard.complete).resolves.toEqual({
            status: 'discarded',
            finalText: 'orig',
            finalReasoning: 'origR',
        });

        const acFalse = new AbortController();
        const { handle: handleAbort } = makeHandle(undefined, { originalText: 'orig', originalReasoning: 'origR' });
        handleAbort.setText('partial');
        const abortSpy = jest.spyOn(handleAbort, 'abort');
        const discardSpyForAbort = jest.spyOn(handleAbort, 'discard');
        acFalse.abort();

        await runMainAgentLoop({
            handle: handleAbort,
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 3, discardOnAbort: false, tools: {} } },
            eventData: { type: 'normal', abortSignal: acFalse.signal },
            deps: {
                generateTaskStreamForMainAgent: jest.fn(),
                generateTask: jest.fn(),
                chat: [{ mes: 'orig', extra: { reasoning: 'origR' }, is_user: false }],
            },
        });

        expect(abortSpy).toHaveBeenCalledTimes(1);
        expect(discardSpyForAbort).not.toHaveBeenCalled();
        await expect(handleAbort.complete).resolves.toEqual({
            status: 'aborted',
            finalText: 'partial',
            finalReasoning: 'origR',
        });
    });

    test('handleDirectorDispatch discards partial message on user abort when discardOnAbort is true (signal abort + thrown AbortError)', async () => {
        // Case 1: signal abort fires during runMainLoop (legacy nested profile shape)
        const ac1 = new AbortController();
        const ev1 = {
            type: 'normal',
            finalPrompt: 'p',
            generateData: {},
            takeoverHandle: null,
            abortSignal: ac1.signal,
        };
        const chat1 = [{ mes: 'before', extra: { reasoning: 'beforeR' }, is_user: false }];
        await handleDirectorDispatch(ev1, {
            profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], discardOnAbort: true } },
            chat: chat1,
            acquirePlaceholderMessageId: () => 0,
            runMainLoop: async ({ handle }) => {
                handle.setText('partial draft');
                ac1.abort();
                const err = new Error('aborted');
                err.name = 'AbortError';
                throw err;
            },
        });

        await expect(ev1.takeoverHandle.complete).resolves.toEqual({
            status: 'discarded',
            finalText: 'before',
            finalReasoning: 'beforeR',
        });

        // Case 2: flattened profile shape + AbortError thrown directly without prior signal event
        const ev2 = {
            type: 'normal',
            finalPrompt: 'p',
            generateData: {},
            takeoverHandle: null,
            abortSignal: new AbortController().signal,
        };
        const chat2 = [{ mes: 'seed', extra: { reasoning: 'seedR' }, is_user: false }];
        await handleDirectorDispatch(ev2, {
            profile: { mode: 'director', mainAgent: {}, subAgents: [], discardOnAbort: true },
            chat: chat2,
            acquirePlaceholderMessageId: () => 0,
            runMainLoop: async ({ handle }) => {
                handle.setText('partial draft 2');
                const err = new Error('aborted');
                err.name = 'AbortError';
                throw err;
            },
        });

        await expect(ev2.takeoverHandle.complete).resolves.toEqual({
            status: 'discarded',
            finalText: 'seed',
            finalReasoning: 'seedR',
        });
    });

    test('handleDirectorDispatch aborts (keeping partial) on user abort when discardOnAbort is false', async () => {
        const ac = new AbortController();
        const ev = {
            type: 'normal',
            finalPrompt: 'p',
            generateData: {},
            takeoverHandle: null,
            abortSignal: ac.signal,
        };
        const chat = [{ mes: 'before', extra: { reasoning: 'beforeR' }, is_user: false }];
        await handleDirectorDispatch(ev, {
            profile: { mode: 'director', mainAgent: {}, subAgents: [], discardOnAbort: false },
            chat,
            acquirePlaceholderMessageId: () => 0,
            runMainLoop: async ({ handle }) => {
                handle.setText('partial kept');
                const err = new Error('aborted');
                err.name = 'AbortError';
                throw err;
            },
        });

        await expect(ev.takeoverHandle.complete).resolves.toEqual({
            status: 'aborted',
            finalText: 'partial kept',
            finalReasoning: 'beforeR',
        });
    });
});
