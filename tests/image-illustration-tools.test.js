import { expect, test } from '@jest/globals';
import {
    ADD_IMAGE_PROMPT_TOOL, GENERATE_IMAGE_TOOL,
    validateAddImagePromptArgs, validateGenerateImageArgs, selectPromptCalls,
} from '../public/scripts/extensions/stable-diffusion/illustration/tools.js';

test('tool schemas expose the fixed contract', () => {
    expect(ADD_IMAGE_PROMPT_TOOL.function.name).toBe('add_image_prompt');
    expect(ADD_IMAGE_PROMPT_TOOL.function.parameters.required)
        .toEqual(['prompt', 'insert_after', 'insert_before']);
    expect(GENERATE_IMAGE_TOOL.function.name).toBe('generate_image');
    expect(GENERATE_IMAGE_TOOL.function.parameters.required).toEqual(['prompt']);
});

test('rejects empty prompt and anchors', () => {
    expect(validateAddImagePromptArgs({ prompt: ' ', insert_after: 'a', insert_before: 'b' }).ok).toBe(false);
    expect(validateAddImagePromptArgs({ prompt: 'x', insert_after: '', insert_before: 'b' }).ok).toBe(false);
    expect(validateGenerateImageArgs({ prompt: '' }).ok).toBe(false);
});

test('dedupes, filters names and checks anchors', () => {
    const text = 'alpha beta gamma delta';
    const call = (prompt, after, before) => ({ name: 'add_image_prompt', args: { prompt, insert_after: after, insert_before: before } });
    const result = selectPromptCalls([
        call('p1', 'alpha', 'beta'),
        call('p1', 'alpha', 'beta'),
        { name: 'other', args: {} },
        call('p2', 'missing', 'none'),
        call('p3', 'gamma', 'delta'),
    ], { messageText: text });
    expect(result.accepted).toEqual([
        { prompt: 'p1', insertAfter: 'alpha', insertBefore: 'beta' },
        { prompt: 'p3', insertAfter: 'gamma', insertBefore: 'delta' },
    ]);
    expect(result.rejected).toHaveLength(2);
});
