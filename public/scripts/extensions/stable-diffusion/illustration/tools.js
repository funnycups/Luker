import { findInsertionPoint } from './message.js';

export const ADD_IMAGE_PROMPT_TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'add_image_prompt',
        description: 'Add one image prompt for a distinct visual moment in the current message. Call this once per visual moment.',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'The complete image generation prompt. Follow the active prompt style guidance.',
                },
                insert_after: {
                    type: 'string',
                    description: 'A verbatim snippet from the current message that ends immediately before the insertion point. Use 10 to 40 characters.',
                },
                insert_before: {
                    type: 'string',
                    description: 'A verbatim snippet from the current message that starts immediately after the insertion point. Use 10 to 40 characters.',
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
        description: 'Generate an image from the complete prompt and add it to the studio gallery.',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'The complete image generation prompt. Follow the active prompt style guidance.',
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

export function selectPromptCalls(toolCalls, { maxPrompts = 5, messageText = '' } = {}) {
    const accepted = [];
    const rejected = [];
    const seen = new Set();
    let truncated = 0;
    const limit = Math.max(1, Number(maxPrompts) || 1);

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
        if (accepted.length >= limit) {
            truncated += 1;
            continue;
        }
        accepted.push(value);
    }

    return { accepted, rejected, truncated };
}
