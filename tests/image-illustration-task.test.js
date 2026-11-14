import { expect, test } from '@jest/globals';
import {
    buildIllustrationContext, buildIllustrationTaskMessages, requestIllustrationPrompts,
} from '../public/scripts/extensions/stable-diffusion/illustration/task.js';

const chat = [
    { name: 'User', is_user: true, mes: 'hello' },
    { name: 'Seraphina', mes: 'alpha beta gamma' },
    { name: 'System', is_system: true, mes: 'rules' },
    { name: 'Seraphina', mes: '  ' },
    { name: 'Seraphina', mes: 'delta epsilon' },
];

test('builds context without current, system or empty messages', () => {
    const result = buildIllustrationContext({
        chat, messageId: 4, contextMessageCount: 10, stripMarkup: (s) => s,
    });
    expect(result.current).toBe('delta epsilon');
    expect(result.context).toContain('[User]: hello');
    expect(result.context).toContain('[Seraphina]: alpha beta gamma');
    expect(result.context).not.toContain('rules');
    expect(result.context).not.toContain('delta epsilon');
});

test('builds system and user task messages with optional memory', () => {
    const messages = buildIllustrationTaskMessages({
        preset: { illustrationPrompt: 'TASK' },
        context: '[User]: hi',
        current: 'now',
        memoryRecall: 'CORE',
    });
    expect(messages[0]).toEqual({ role: 'system', content: 'TASK' });
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('=== MEMORY RECALL ===\nCORE');
    expect(messages[1].content).toContain('=== CONTEXT ===\n[User]: hi');
    expect(messages[1].content).toContain('=== CURRENT MESSAGE ===\nnow');
});

test('prompt requests keep the response metadata', async () => {
    const result = await requestIllustrationPrompts({
        context: {
            generateTask: async () => ({
                toolCalls: [{ name: 'add_image_prompt', args: { prompt: 'p', insert_after: 'a', insert_before: 'b' } }],
                assistantText: 'reply',
                finishReason: 'stop',
            }),
        },
        preset: { llm: { apiPresetName: 'api', llmPresetName: 'llm' } },
        taskMessages: [{ role: 'user', content: 'now' }],
    });

    expect(result).toEqual({
        toolCalls: [{ name: 'add_image_prompt', args: { prompt: 'p', insert_after: 'a', insert_before: 'b' } }],
        assistantText: 'reply',
        finishReason: 'stop',
    });
});

test('prompt requests activate world info from the live chat', async () => {
    let options;
    await requestIllustrationPrompts({
        context: {
            generateTask: async value => {
                options = value;
                return { toolCalls: [], assistantText: '', finishReason: '' };
            },
        },
        preset: { llm: { apiPresetName: 'api', llmPresetName: 'llm' } },
        taskMessages: [{ role: 'user', content: 'now' }],
    });

    expect(options).toMatchObject({
        worldInfoSource: 'chat',
        apiPresetName: 'api',
        llmPresetName: 'llm',
    });
});
