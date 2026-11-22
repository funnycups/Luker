import { expect, test } from '@jest/globals';
import {
    buildIllustrationContext,
    buildIllustrationTaskMessages,
    formatBackendCapabilitiesBlock,
    formatCharacterReferencePolicyBlock,
    requestIllustrationPrompts,
} from '../public/scripts/extensions/stable-diffusion/illustration/task.js';
import { applyMacroSubstitution } from '../public/scripts/generate-task.js';

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

test('illustration prompt requests only macro-substitute the system prompt and keep chat transcript braces literal', async () => {
    let captured;
    await requestIllustrationPrompts({
        context: {
            generateTask: async value => {
                captured = value;
                return { toolCalls: [], assistantText: '', finishReason: '' };
            },
        },
        preset: { llm: { apiPresetName: 'api', llmPresetName: 'llm' } },
        taskMessages: [
            { role: 'system', content: 'Illustrate {{char}}' },
            { role: 'user', content: '=== CURRENT MESSAGE ===\nLiteral {{unclosed and {{unknown_macro}} prose.' },
        ],
    });

    expect(captured.taskMessages[0].substituteMacros).toBeUndefined();
    expect(captured.taskMessages[1].substituteMacros).toBe(false);

    const substituted = applyMacroSubstitution(captured.taskMessages, (content) => {
        if (content.includes('{{unclosed') || content.includes('{{unknown_macro}}')) {
            throw new Error('Strict macro engine should not evaluate chat transcript text');
        }
        return content.replace('{{char}}', 'Lyra');
    });
    expect(substituted).toEqual([
        { role: 'system', content: 'Illustrate Lyra' },
        { role: 'user', content: '=== CURRENT MESSAGE ===\nLiteral {{unclosed and {{unknown_macro}} prose.' },
    ]);
});

test('formatCharacterReferencePolicyBlock and buildIllustrationTaskMessages gate policy and archive blocks on characterReferenceEnabled', () => {
    expect(formatCharacterReferencePolicyBlock({ characterReferenceEnabled: false })).toBe('');
    expect(formatCharacterReferencePolicyBlock(null)).toBe('');

    const textOnlyPolicy = formatCharacterReferencePolicyBlock({
        characterReferenceEnabled: true,
        characterReferenceMode: 'text_only',
    });
    const imageOnlyPolicy = formatCharacterReferencePolicyBlock({
        characterReferenceEnabled: true,
        characterReferenceMode: 'image_only',
    });
    const bothPolicy = formatCharacterReferencePolicyBlock({
        characterReferenceEnabled: true,
        characterReferenceMode: 'text_and_image',
    });

    expect(textOnlyPolicy).toContain('<character_reference_policy>');
    expect(imageOnlyPolicy).toContain('<character_reference_policy>');
    expect(bothPolicy).toContain('<character_reference_policy>');
    expect(textOnlyPolicy).not.toBe(imageOnlyPolicy);
    expect(imageOnlyPolicy).not.toBe(bothPolicy);

    const disabledMsgs = buildIllustrationTaskMessages({
        preset: { illustrationPrompt: 'TASK' },
        current: 'now',
        characterArchiveIndex: '1: id=char_1 | name=Lyra',
        capabilities: {
            source: 'google',
            model: 'gemini',
            characterReferenceEnabled: false,
            characterReferenceMode: 'text_only',
            supportsCharacterReference: false,
        },
    });
    expect(disabledMsgs[1].content).not.toContain('<character_reference_policy>');
    expect(disabledMsgs[1].content).not.toContain('<character_archive>');

    const enabledMsgs = buildIllustrationTaskMessages({
        preset: { illustrationPrompt: 'TASK' },
        current: 'now',
        characterArchiveIndex: '1: id=char_1 | name=Lyra',
        capabilities: {
            source: 'google',
            model: 'gemini',
            characterReferenceEnabled: true,
            characterReferenceMode: 'text_only',
            supportsCharacterReference: false,
        },
    });
    expect(enabledMsgs[1].content).toContain('<character_reference_policy>');
    expect(enabledMsgs[1].content).toContain('<character_archive>\n1: id=char_1 | name=Lyra\n</character_archive>');
    expect(formatBackendCapabilitiesBlock({ source: 'google', characterReferenceEnabled: false })).toContain('<backend_capabilities>');
});
