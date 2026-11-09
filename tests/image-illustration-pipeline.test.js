/**
 * @jest-environment jsdom
 */
import { expect, test } from '@jest/globals';
import {
    messageFingerprint, getLastAssistantMessage, buildJobKey, createIllustrationPipeline,
} from '../public/scripts/extensions/stable-diffusion/illustration/pipeline.js';

const SETTINGS = {
    enabled: true,
    autoGenerate: true,
    currentPresetId: 'p',
    presets: [{ id: 'p', illustrationPrompt: 'TASK', llm: { apiPresetName: '', llmPresetName: '' } }],
    maxPromptsPerMessage: 5,
    contextMessageCount: 0,
    maxConcurrentGenerations: 1,
    minGenerationInterval: 0,
    imageDisplayWidth: 100,
};

function makeMessage(extra = {}) {
    return {
        name: 'Seraphina',
        is_user: false,
        is_system: false,
        mes: 'alpha <img src="/user/images/old.png" data-illustration-id="old"> beta',
        send_date: 1,
        original_avatar: 'a.png',
        swipe_id: 0,
        swipes: ['alpha <img src="/user/images/old.png" data-illustration-id="old"> beta'],
        swipe_info: [{ extra: {} }],
        ...extra,
    };
}

function makeHarness({ message, generate, confirmReplace } = {}) {
    const chat = [message];
    const toasts = [];
    const calls = { generateTask: 0, confirmReplace: 0 };
    const pipeline = createIllustrationPipeline({
        context: {
            chat,
            chatId: 'chat-1',
            generateTask: async () => {
                calls.generateTask += 1;
                return {
                    toolCalls: [{
                        name: 'add_image_prompt',
                        args: { prompt: 'new prompt', insert_after: 'alpha', insert_before: 'beta' },
                    }],
                };
            },
        },
        imageService: {
            configure() {},
            generate: async prompt => generate(prompt),
        },
        settings: SETTINGS,
        hooks: {
            toast: text => toasts.push(text),
            t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (values[index] ?? ''), ''),
            saveChat: async () => {},
            updateMessageBlock: () => {},
            ensureSwipes: () => {},
            getChatId: () => 'chat-1',
            getChat: () => chat,
            imageConfigFingerprint: () => 'fp',
            confirmReplace: confirmReplace
                ? async () => {
                    calls.confirmReplace += 1;
                    return confirmReplace();
                }
                : undefined,
        },
    });
    return { pipeline, chat, toasts, calls };
}

test('message fingerprint changes with text and send date', () => {
    const base = { send_date: 1, original_avatar: 'a.png', mes: 'hello' };
    expect(messageFingerprint(base)).toBe(messageFingerprint({ ...base }));
    expect(messageFingerprint(base)).not.toBe(messageFingerprint({ ...base, mes: 'hello!' }));
    expect(messageFingerprint(base)).not.toBe(messageFingerprint({ ...base, send_date: 2 }));
});

test('finds the last assistant message and skips user/system', () => {
    const chat = [
        { mes: 'user', is_user: true },
        { mes: 'assistant', name: 'A' },
        { mes: 'system', is_system: true },
    ];
    expect(getLastAssistantMessage(chat)).toEqual({ message: chat[1], index: 1 });
    expect(getLastAssistantMessage([{ mes: 'user', is_user: true }])).toBeNull();
});

test('builds stable job keys', () => {
    expect(buildJobKey({ chatId: 'c', messageId: 2, swipeId: 1 })).toBe('c:2:1');
});

test('manual run confirms, then replaces existing illustrations', async () => {
    const message = makeMessage({
        extra: {
            illustrations: [{
                id: 'old', prompt: 'old', imageUrl: '/user/images/old.png', status: 'ready',
                parentId: null, anchorAfter: 'alpha', anchorBefore: 'beta', createdAt: 1,
            }],
        },
    });
    const { pipeline, calls } = makeHarness({
        message,
        generate: async () => '/user/images/new.png',
        confirmReplace: () => true,
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(calls.confirmReplace).toBe(1);
    expect(message.mes).not.toContain('data-illustration-id="old"');
    expect(message.mes).toContain('/user/images/new.png');
    expect(message.extra.illustrations).toHaveLength(1);
    expect(message.extra.illustrations[0].prompt).toBe('new prompt');
    expect(message.swipes[0]).toBe(message.mes);
});

test('manual run leaves everything untouched when the replace prompt is declined', async () => {
    const message = makeMessage({
        extra: {
            illustrations: [{
                id: 'old', prompt: 'old', imageUrl: '/user/images/old.png', status: 'ready',
                parentId: null, anchorAfter: 'alpha', anchorBefore: 'beta', createdAt: 1,
            }],
        },
    });
    const before = { mes: message.mes, records: message.extra.illustrations };
    const { pipeline, calls } = makeHarness({
        message,
        generate: async () => '/user/images/new.png',
        confirmReplace: () => false,
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(calls.confirmReplace).toBe(1);
    expect(calls.generateTask).toBe(0);
    expect(message.mes).toBe(before.mes);
    expect(message.extra.illustrations).toBe(before.records);
});

test('a configuration change cancels the task instead of inserting a failed placeholder', async () => {
    const message = makeMessage();
    message.mes = 'alpha beta';
    message.swipes = ['alpha beta'];
    const error = new Error('Image generation configuration changed.');
    error.code = 'image_config_changed';
    const { pipeline, toasts } = makeHarness({
        message,
        generate: async () => { throw error; },
        confirmReplace: () => true,
    });

    await pipeline.runForMessage({ messageId: 0, source: 'manual' });

    expect(message.mes).not.toContain('data-illustration-id');
    expect(message.extra?.illustrations || []).toHaveLength(0);
    expect(toasts.join('\n')).toContain('configuration changed');
});

