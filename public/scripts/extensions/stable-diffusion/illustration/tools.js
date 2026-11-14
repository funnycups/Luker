import { findInsertionPoint } from './message.js';

export const ADD_IMAGE_PROMPT_TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'add_image_prompt',
        description: 'Add an image prompt to the current message.',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'Image generation prompt.',
                },
                insert_after: {
                    type: 'string',
                    description: 'Text from the current message that ends immediately before the insertion point.',
                },
                insert_before: {
                    type: 'string',
                    description: 'Text from the current message that starts immediately after the insertion point.',
                },
            },
            required: ['prompt', 'insert_after', 'insert_before'],
        },
    },
});

export const GENERATE_IMAGE_TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'generate_image',
        description: 'Generate an image and add it to the studio gallery.',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'Image generation prompt.',
                },
            },
            required: ['prompt'],
        },
    },
});

export function validateAddImagePromptArgs(args) {
    const prompt = String(args?.prompt ?? '').trim();
    const insertAfter = String(args?.insert_after ?? '').trim();
    const insertBefore = String(args?.insert_before ?? '').trim();
    if (!prompt) {
        return { ok: false, error: 'prompt is required' };
    }
    if (!insertAfter) {
        return { ok: false, error: 'insert_after is required' };
    }
    if (!insertBefore) {
        return { ok: false, error: 'insert_before is required' };
    }
    return { ok: true, value: { prompt, insertAfter, insertBefore } };
}

export function validateGenerateImageArgs(args) {
    const prompt = String(args?.prompt ?? '').trim();
    if (!prompt) {
        return { ok: false, error: 'prompt is required' };
    }
    return { ok: true, value: { prompt } };
}

export function selectPromptCalls(toolCalls, { messageText = '' } = {}) {
    const accepted = [];
    const rejected = [];
    const seen = new Set();

    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        if (call?.name !== ADD_IMAGE_PROMPT_TOOL.function.name) {
            rejected.push({ reason: 'unknown tool', call });
            continue;
        }
        const validation = validateAddImagePromptArgs(call.args);
        if (!validation.ok) {
            rejected.push({ reason: validation.error, call });
            continue;
        }
        const value = validation.value;
        if (findInsertionPoint(messageText, value.insertAfter, value.insertBefore) === null) {
            rejected.push({ reason: 'anchors not found', call });
            continue;
        }
        const key = JSON.stringify([value.prompt, value.insertAfter, value.insertBefore]);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        accepted.push(value);
    }

    return { accepted, rejected };
}
