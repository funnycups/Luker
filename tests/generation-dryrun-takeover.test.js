import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { event_types } from '../public/scripts/events.js';
import { createMessageEditorHandle } from '../public/scripts/message-takeover.js';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');

function between(start, end) {
    const startAt = source.indexOf(start);
    const endAt = source.indexOf(end, startAt + start.length);
    if (startAt < 0 || endAt < 0) throw new Error(`Missing host source boundary: ${start}`);
    return source.slice(startAt, endAt);
}

// Run the host's state initialization, continuation timer and WI signal payload
// without assembling a browser prompt or dispatching a model request. Keep the
// takeover finalizer, placeholder acquisition and saveReply bodies intact.
const initializationSource = between('async function generateInternal(', '\n    // OpenAI doesn\'t need instruct mode.')
    + '\nconst lastMessage = chat[chat.length - 1];\n'
    + between('    const isContinue = type == \'continue\';', '\n    if (!dryRun) {\n        deactivateSendButtons();')
    + between('    const wiScanPayload = {', '\n    await eventSource.emit(event_types.GENERATION_BEFORE_WORLD_INFO_SCAN, wiScanPayload);')
    + '\nreturn { signal: wiScanPayload.signal, aborted: isGenerationAborted(), exited: exitAbortedGenerationIfNeeded() };\n}';
const takeoverSource = between('                const handle = dispatchEvent.takeoverHandle;', '\n            }\n        }\n\n        if (isStreamingEnabled()');
const saveReplySource = between('export async function saveReply(', '\n/**\n * Creates a message\'s').replace('export ', '');
const acquireSource = between('async function acquireTakeoverPlaceholder(', '\n/**\n * Roll back the placeholder');
const stopSource = between('export function stopGeneration() {', '\n/**\n * Injects extension prompts').replace('export ', '');

function createHost() {
    let now = '2026-01-01T00:00:10.000Z';
    class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return new Date(now).getTime(); }
    }
    const effects = [], saved = [];
    const context = vm.createContext({
        Date: ClockDate, AbortController, structuredClone,
        console: { log() {}, debug() {}, error() {} },
        event_types,
        eventSource: { emit: async (event) => { effects.push(event); } },
        abortController: new AbortController(),
        quietAbortController: null,
        generation_started: new Date('2026-01-01T00:00:00.000Z'),
        chat: [{ is_user: true, mes: 'input', extra: {} }],
        chat_metadata: {}, name2: 'Assistant', selected_group: null, characters: [{}], this_chid: '0',
        power_user: { trim_spaces: false, message_token_count_enabled: false },
        setGenerationProgress() {}, setActiveWorldInfoPromptSnapshot() {}, unshallowCharacter: async () => {},
        setExtensionPrompt() {}, inject_ids: { QUIET_PROMPT: 'quiet' }, extension_prompt_types: { IN_PROMPT: 0 },
        this_max_context: 4096, coreChat: [], chatForWI: [], globalScanData: {}, runWIScan: async () => {},
        getMessageTimeStamp: () => now,
        getGeneratingApi: () => 'custom', getGeneratingModel: () => 'test-model',
        processImageAttachment: async () => {}, extractMessageById() {}, addOneMessage() {}, statMesProcess() {},
        hideSwipeButtons() {}, showSwipeButtons() {}, redrawMessageBubble() {},
        applyPostGenerationText: (text) => text,
        isLastLukerReplyPersistedByServerForApi: () => false,
        appendChatMessages: async (messages) => { saved.push(structuredClone(messages)); return true; },
        saveChatConditional: async () => { saved.push(structuredClone(context.chat.slice(-1))); },
        unblockGeneration: () => { effects.push('unblock'); },
        triggerAutoContinue: () => { effects.push('autoContinue'); },
        clearMessageProgressNotification() {},
        forceUnblockGenerationUi() { effects.push('forceUnblock'); },
        getLastLukerGenerationIdForApi: () => '',
        streamingProcessor: null,
    });
    vm.runInContext(initializationSource + '\n' + saveReplySource + '\n' + acquireSource + '\n' + stopSource, context);

    async function startTakeover(type = 'normal') {
        const handle = createMessageEditorHandle({ generationType: type, abortSignal: context.abortController.signal, flushIntervalMs: 0 });
        let ready;
        const attached = new Promise(resolve => { ready = resolve; });
        const setOnUpdate = handle.setOnUpdate;
        handle.setOnUpdate = (callback) => { setOnUpdate(callback); if (callback) ready(); };
        context.dispatchEvent = { takeoverHandle: handle };
        context.takeoverType = type;
        const complete = vm.runInContext(`(async (type) => {
            const isContinue = type === 'continue', isImpersonate = false;
            ${takeoverSource}
        })(takeoverType)`, context);
        await attached;
        return { handle, complete };
    }

    return {
        context, effects, saved, startTakeover,
        initialize: (type = 'normal', options = {}, dryRun = false) => context.generateInternal(type, options, dryRun),
        stop: () => context.stopGeneration(),
        setTime: (time) => { now = time; },
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

        const message = host.context.chat.at(-1);
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
        const controller = host.context.abortController;
        const started = host.context.generation_started;
        if (aborted) controller.abort();
        const estimate = await host.initialize('normal', {}, true);
        expect(host.context.abortController).toBe(controller);
        expect(host.context.generation_started).toBe(started);
        expect(estimate.signal).not.toBe(controller.signal);
        expect(estimate.signal.aborted).toBe(false);
        expect(estimate.exited).toBe(false);
    });

    test('an estimate honors its passed abort signal without replacing the live controller', async () => {
        const host = createHost();
        const controller = host.context.abortController;
        const external = new AbortController();
        external.abort();
        const estimate = await host.initialize('normal', { signal: external.signal }, true);
        expect(estimate.aborted).toBe(true);
        expect(estimate.exited).toBe(true);
        expect(host.context.abortController).toBe(controller);
        expect(controller.signal.aborted).toBe(false);
        expect(host.effects).not.toContain('unblock');
    });

    test('a continuation estimate leaves both live and message start times intact', async () => {
        const host = createHost();
        const started = host.context.generation_started;
        const messageStarted = new Date('2026-01-01T00:00:01.000Z');
        host.context.chat = [{ mes: 'answer', gen_started: messageStarted, gen_finished: new Date('2026-01-01T00:00:04.000Z') }];
        await host.initialize('continue', {}, true);
        expect(host.context.generation_started).toBe(started);
        expect(host.context.chat[0].gen_started).toBe(messageStarted);
    });

    test('a live continuation reuses its passed controller and extends its timer', async () => {
        const host = createHost();
        const controller = host.context.abortController;
        host.context.chat = [{ mes: 'answer', gen_started: new Date('2026-01-01T00:00:01.000Z'), gen_finished: new Date('2026-01-01T00:00:04.000Z') }];
        const generation = await host.initialize('continue', { signal: controller.signal });
        expect(host.context.abortController).toBe(controller);
        expect(generation.signal).toBe(controller.signal);
        expect(host.context.generation_started.toISOString()).toBe('2026-01-01T00:00:07.000Z');
        expect(host.context.chat[0].gen_started).toBe(host.context.generation_started);
        controller.abort();
        expect(generation.signal.aborted).toBe(true);
    });

    test('a new live generation still rejects an older takeover commit', async () => {
        const host = createHost();
        await host.initialize();
        const controller = host.context.abortController;
        const { handle, complete } = await host.startTakeover();
        await host.initialize();
        handle.setText('old answer');
        await handle.commit();
        const result = await complete;

        expect(host.context.abortController).not.toBe(controller);
        expect(host.context.chat.at(-1).swipes[0]).toBe('');
        expect(host.saved).toHaveLength(0);
        expect(host.effects).not.toContain(event_types.MESSAGE_RECEIVED);
        expect(String(result)).toBe('');
    });

    test('stopping the live controller still preserves an aborted partial without finalizing it', async () => {
        const host = createHost();
        await host.initialize();
        const { handle, complete } = await host.startTakeover();
        handle.setText('partial answer');
        host.context.abortController.abort();
        expect(handle.abortSignal.aborted).toBe(true);
        await handle.abort();
        await complete;

        expect(host.context.chat.at(-1).swipes[0]).toBe('partial answer');
        expect(host.saved).toHaveLength(0);
        expect(host.effects).not.toContain(event_types.MESSAGE_RECEIVED);
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

        const message = host.context.chat.at(-1);
        expect(message.swipes[0]).toBe('final answer');
        expect(host.saved).toEqual([[message]]);
        expect(host.effects.filter(effect => effect === event_types.MESSAGE_RECEIVED)).toHaveLength(1);
        expect(String(result)).toBe('final answer');
    });

    test('a quiet generation does not replace the live controller or restart its timer', async () => {
        const host = createHost();
        const controller = host.context.abortController;
        const started = host.context.generation_started;
        await host.initialize('quiet', { quiet_prompt: 'classify' });

        expect(host.context.abortController).toBe(controller);
        expect(host.context.generation_started).toBe(started);
        expect(host.context.quietAbortController).not.toBeNull();
        expect(host.context.quietAbortController).not.toBe(controller);
    });

    test('stopping aborts the live controller and the quiet controller', async () => {
        const host = createHost();
        const live = host.context.abortController;
        await host.initialize('quiet', { quiet_prompt: 'classify' });
        const quiet = host.context.quietAbortController;
        expect(quiet).not.toBeNull();

        host.stop();

        expect(live.signal.aborted).toBe(true);
        expect(quiet.signal.aborted).toBe(true);
    });
});
