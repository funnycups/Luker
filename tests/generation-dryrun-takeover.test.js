import { describe, expect, test } from '@jest/globals';

import { event_types } from '../public/scripts/events.js';
import {
    abortGenerationControllers,
    computeContinuedGenerationStart,
    createMessageEditorHandle,
    resolveGenerationOwnership,
    runTakeoverLifecycle,
} from '../public/scripts/message-takeover.js';

function createHost() {
    let nowIso = '2026-01-01T00:00:10.000Z';
    const now = () => new Date(nowIso);
    const effects = [];
    const saved = [];

    const state = {
        abortController: new AbortController(),
        quietAbortController: null,
        isSendPress: false,
        generationStarted: new Date('2026-01-01T00:00:00.000Z'),
        chat: [{ is_user: true, mes: 'input', extra: {} }],
        chatTransitionEpoch: 0,
        emitEvent: async (event) => { effects.push(event); },
    };

    async function initialize(type = 'normal', options = {}, dryRun = false) {
        const genEpoch = state.chatTransitionEpoch;
        const ownership = resolveGenerationOwnership({
            type,
            dryRun,
            isSendPress: state.isSendPress,
            abortController: state.abortController,
            quietAbortController: state.quietAbortController,
            externalSignal: options.signal ?? null,
            generationStarted: state.generationStarted,
            now,
        });
        state.abortController = ownership.abortController;
        state.quietAbortController = ownership.quietAbortController;
        state.generationStarted = ownership.generationStarted;

        const continuedStart = computeContinuedGenerationStart({
            dryRun,
            isContinue: type === 'continue',
            lastMessage: state.chat[state.chat.length - 1] ?? null,
            now,
        });
        if (continuedStart) {
            state.generationStarted = continuedStart;
        }

        const aborted = ownership.isGenerationAborted();
        let exited = false;
        if (aborted) {
            if (state.chatTransitionEpoch === genEpoch && !dryRun && type !== 'quiet') {
                effects.push('unblock');
            }
            exited = true;
        }
        return {
            signal: ownership.generationAbortController.signal,
            aborted,
            exited,
            sharesInFlightController: ownership.sharesInFlightController,
        };
    }

    async function startTakeover(type = 'normal') {
        const myAbortController = state.abortController;
        const genEpoch = state.chatTransitionEpoch;
        const handle = createMessageEditorHandle({
            generationType: type,
            abortSignal: myAbortController.signal,
            flushIntervalMs: 0,
        });
        let ready;
        const attached = new Promise(resolve => { ready = resolve; });
        const origSetOnUpdate = handle.setOnUpdate;
        handle.setOnUpdate = (callback) => {
            origSetOnUpdate(callback);
            if (callback) ready();
        };

        const complete = runTakeoverLifecycle({
            type,
            handle,
            isContinue: type === 'continue',
            isImpersonate: false,
            genEpoch,
            myAbortController,
            getAbortController: () => state.abortController,
            getChatTransitionEpoch: () => state.chatTransitionEpoch,
            getChat: () => state.chat,
            powerUser: { message_token_count_enabled: false },
            now,
            getMessageTimeStamp: () => nowIso,
            getGeneratingApi: () => 'custom',
            getGeneratingModel: () => 'test-model',
            acquireTakeoverPlaceholder: async (genType) => {
                if (genType === 'continue' || genType === 'swipe') {
                    return state.chat.length - 1;
                }
                const placeholder = {
                    name: 'Assistant',
                    is_user: false,
                    is_system: false,
                    mes: '',
                    send_date: nowIso,
                    gen_started: state.generationStarted,
                    gen_finished: now(),
                    swipe_id: 0,
                    swipes: [''],
                    swipe_info: [{ send_date: nowIso, gen_started: state.generationStarted, gen_finished: now(), extra: {} }],
                    extra: {},
                };
                state.chat.push(placeholder);
                return state.chat.length - 1;
            },
            rollbackTakeoverPlaceholder: async (messageId, genType, origText, origReasoning) => {
                if (genType === 'normal' || genType === 'regenerate') {
                    state.chat.splice(messageId, 1);
                    return;
                }
                if (state.chat[messageId]) {
                    state.chat[messageId].mes = origText;
                    state.chat[messageId].extra = { ...(state.chat[messageId].extra || {}), reasoning: origReasoning };
                }
            },
            applyPostGenerationText: (text) => text,
            resolveAssistantTokenCount: async () => 0,
            extractMessageById: () => {},
            redrawMessageBubble: () => {},
            hideSwipeButtons: () => {},
            showSwipeButtons: () => {},
            appendChatMessages: async (messages) => {
                saved.push(structuredClone(messages));
                return true;
            },
            saveChatConditional: async () => {
                saved.push(structuredClone(state.chat.slice(-1)));
            },
            isLastLukerReplyPersistedByServerForApi: () => false,
            emitEvent: (event, ...args) => state.emitEvent(event, ...args),
            unblockThisGeneration: () => { effects.push('unblock'); },
            triggerAutoContinue: () => { effects.push('autoContinue'); },
        });
        await attached;
        return { handle, complete };
    }

    return {
        state,
        effects,
        saved,
        initialize,
        startTakeover,
        stop: () => abortGenerationControllers({
            abortController: state.abortController,
            quietAbortController: state.quietAbortController,
        }),
        setTime: (time) => { nowIso = time; },
    };
}

describe('dry-run generation ownership', () => {
    test.each(['normal', 'regenerate'])('an estimate during %s takeover still finalizes the swipe, save and completion events', async (type) => {
        const host = createHost();
        await host.initialize(type);
        const { handle, complete } = await host.startTakeover(type);
        host.setTime('2026-01-01T00:00:20.000Z');
        await host.initialize('normal', {}, true);
        host.setTime('2026-01-01T00:00:30.000Z');
        handle.setText('final answer');
        handle.setReasoning('final reasoning');
        await handle.commit();
        const result = await complete;

        const message = host.state.chat.at(-1);
        expect(message.swipes[0]).toBe('final answer');
        expect(message.swipe_info[0].extra.reasoning).toBe('final reasoning');
        expect(message.swipe_info[0].gen_started.toISOString()).toBe('2026-01-01T00:00:10.000Z');
        expect(message.send_date).toBe('2026-01-01T00:00:30.000Z');
        expect(host.saved).toEqual([[message]]);
        expect(host.effects.filter(effect => effect === event_types.MESSAGE_RECEIVED)).toHaveLength(1);
        expect(host.effects.filter(effect => effect === event_types.CHARACTER_MESSAGE_RENDERED)).toHaveLength(1);
        expect(host.effects.indexOf('unblock')).toBeLessThan(host.effects.indexOf(event_types.MESSAGE_RECEIVED));
        expect(String(result)).toBe('final answer');
    });

    test.each([false, true])('an estimate preserves live state with an aborted controller: %s', async (aborted) => {
        const host = createHost();
        const controller = host.state.abortController;
        const started = host.state.generationStarted;
        if (aborted) controller.abort();
        const estimate = await host.initialize('normal', {}, true);
        expect(host.state.abortController).toBe(controller);
        expect(host.state.generationStarted).toBe(started);
        expect(estimate.signal).not.toBe(controller.signal);
        expect(estimate.signal.aborted).toBe(false);
        expect(estimate.exited).toBe(false);
    });

    test('an estimate honors its passed abort signal without replacing the live controller', async () => {
        const host = createHost();
        const controller = host.state.abortController;
        const external = new AbortController();
        external.abort();
        const estimate = await host.initialize('normal', { signal: external.signal }, true);
        expect(estimate.aborted).toBe(true);
        expect(estimate.exited).toBe(true);
        expect(host.state.abortController).toBe(controller);
        expect(controller.signal.aborted).toBe(false);
        expect(host.effects).not.toContain('unblock');
    });

    test('a continuation estimate leaves both live and message start times intact', async () => {
        const host = createHost();
        const started = host.state.generationStarted;
        const messageStarted = new Date('2026-01-01T00:00:01.000Z');
        host.state.chat = [{ mes: 'answer', gen_started: messageStarted, gen_finished: new Date('2026-01-01T00:00:04.000Z') }];
        await host.initialize('continue', {}, true);
        expect(host.state.generationStarted).toBe(started);
        expect(host.state.chat[0].gen_started).toBe(messageStarted);
    });

    test('a live continuation reuses its passed controller and extends its timer', async () => {
        const host = createHost();
        const controller = host.state.abortController;
        host.state.chat = [{ mes: 'answer', gen_started: new Date('2026-01-01T00:00:01.000Z'), gen_finished: new Date('2026-01-01T00:00:04.000Z') }];
        const generation = await host.initialize('continue', { signal: controller.signal });
        expect(host.state.abortController).toBe(controller);
        expect(generation.signal).toBe(controller.signal);
        expect(host.state.generationStarted.toISOString()).toBe('2026-01-01T00:00:07.000Z');
        expect(host.state.chat[0].gen_started).toBe(host.state.generationStarted);
        controller.abort();
        expect(generation.signal.aborted).toBe(true);
    });

    test('a new live generation still rejects an older takeover commit', async () => {
        const host = createHost();
        await host.initialize();
        const controller = host.state.abortController;
        const { handle, complete } = await host.startTakeover();
        await host.initialize();
        handle.setText('old answer');
        await handle.commit();
        const result = await complete;

        expect(host.state.abortController).not.toBe(controller);
        expect(host.state.chat.at(-1).swipes[0]).toBe('');
        expect(host.saved).toHaveLength(0);
        expect(host.effects).not.toContain(event_types.MESSAGE_RECEIVED);
        expect(String(result)).toBe('');
    });

    test('stopping the live controller still preserves an aborted partial without finalizing it', async () => {
        const host = createHost();
        await host.initialize();
        const { handle, complete } = await host.startTakeover();
        handle.setText('partial answer');
        host.state.abortController.abort();
        expect(handle.abortSignal.aborted).toBe(true);
        await handle.abort();
        await complete;

        expect(host.state.chat.at(-1).swipes[0]).toBe('partial answer');
        expect(host.saved).toHaveLength(0);
        expect(host.effects).not.toContain(event_types.MESSAGE_RECEIVED);
    });

    test('chat transition epoch bump fences late takeover updates and commit without leaking into new chat', async () => {
        const host = createHost();
        await host.initialize();
        const { handle, complete } = await host.startTakeover();
        host.state.chatTransitionEpoch += 1;
        host.state.chat = [{ is_user: false, mes: 'New chat greeting', extra: {} }];
        handle.setText('stale chunk');
        await handle.commit();
        const result = await complete;

        expect(host.state.chat).toEqual([{ is_user: false, mes: 'New chat greeting', extra: {} }]);
        expect(host.saved).toHaveLength(0);
        expect(host.effects).not.toContain(event_types.MESSAGE_RECEIVED);
        expect(host.effects).not.toContain('unblock');
        expect(String(result)).toBe('');
    });

    test('epoch bump inside MESSAGE_RECEIVED blocks stale CHARACTER_MESSAGE_RENDERED and triggerAutoContinue on takeover commit', async () => {
        const host = createHost();
        await host.initialize();
        const { handle, complete } = await host.startTakeover();

        const origEmit = host.state.emitEvent;
        host.state.emitEvent = async (event, ...args) => {
            await origEmit(event, ...args);
            if (event === event_types.MESSAGE_RECEIVED) {
                host.state.chatTransitionEpoch += 1;
            }
        };

        handle.setText('committed before switch');
        await handle.commit();
        const result = await complete;

        expect(host.effects.filter(effect => effect === event_types.MESSAGE_RECEIVED)).toHaveLength(1);
        expect(host.effects).not.toContain(event_types.CHARACTER_MESSAGE_RENDERED);
        expect(host.effects).not.toContain('autoContinue');
        expect(String(result)).toBe('');
    });
});

describe('quiet generation ownership', () => {
    test('a quiet generation during takeover still finalizes the takeover', async () => {
        const host = createHost();
        await host.initialize();
        const { handle, complete } = await host.startTakeover();
        host.setTime('2026-01-01T00:00:20.000Z');
        await host.initialize('quiet', { quiet_prompt: 'classify' });
        host.setTime('2026-01-01T00:00:30.000Z');
        handle.setText('final answer');
        await handle.commit();
        const result = await complete;

        const message = host.state.chat.at(-1);
        expect(message.swipes[0]).toBe('final answer');
        expect(host.saved).toEqual([[message]]);
        expect(host.effects.filter(effect => effect === event_types.MESSAGE_RECEIVED)).toHaveLength(1);
        expect(String(result)).toBe('final answer');
    });

    test('a quiet generation does not replace the live controller or restart its timer', async () => {
        const host = createHost();
        const controller = host.state.abortController;
        const started = host.state.generationStarted;
        await host.initialize('quiet', { quiet_prompt: 'classify' });

        expect(host.state.abortController).toBe(controller);
        expect(host.state.generationStarted).toBe(started);
        expect(host.state.quietAbortController).not.toBeNull();
        expect(host.state.quietAbortController).not.toBe(controller);
    });

    test('stopping aborts the live controller and the quiet controller', async () => {
        const host = createHost();
        const live = host.state.abortController;
        await host.initialize('quiet', { quiet_prompt: 'classify' });
        const quiet = host.state.quietAbortController;
        expect(quiet).not.toBeNull();

        host.stop();

        expect(live.signal.aborted).toBe(true);
        expect(quiet.signal.aborted).toBe(true);
    });
});
