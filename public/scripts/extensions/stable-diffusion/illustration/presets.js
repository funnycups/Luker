export const DEFAULT_ILLUSTRATION_PROMPT = `You design image generation prompts for a roleplay conversation.

You receive optional memory recall, recent conversation context, and the current assistant message. Use the context only to keep character appearance, clothing, setting, and lighting consistent. Write prompts for the current message. Do not illustrate earlier messages.

Write one prompt per distinct visual moment. A moment is a change of scene, a new subject, or a major action worth showing. A typical message needs one or two prompts. Never more than five.

Use a short, comma-separated tag list. Put the subject count first, then describe the subject, action, environment, light, style, and quality. Do not write narration, dialogue, or explanation. Do not address the viewer.

For every prompt, provide two anchors copied verbatim from the current message:
- insert_after: the last 10 to 40 characters immediately before the insertion point.
- insert_before: the first 10 to 40 characters immediately after the insertion point.
The two anchors must be adjacent in the message and together must identify one insertion point.`;

export const DEFAULT_STUDIO_PROMPT = `You are an image prompt engineer working interactively with a user.

When the user asks for an image, or gives feedback that should change the current image, call generate_image with the complete prompt. Follow the active prompt style. Keep the prompt short and use a comma-separated tag list with the subject first.

When the user only asks a question or discusses the image, answer in text and do not generate an image.

Use earlier prompts in the conversation to keep the subject, clothing, setting, and style consistent.`;

export const DEFAULT_NATURAL_ILLUSTRATION_PROMPT = `You design image generation prompts for a roleplay conversation.

You receive optional memory recall, recent conversation context, and the current assistant message. Use the context only to keep character appearance, clothing, setting, and lighting consistent. Write prompts for the current message. Do not illustrate earlier messages.

Write one prompt per distinct visual moment. A moment is a change of scene, a new subject, or a major action worth showing. A typical message needs one or two prompts. Never more than five.

Describe the scene in two or three complete sentences. Name the subject first, then the action, environment, light, and mood. Do not write dialogue or address the viewer.

For every prompt, provide two anchors copied verbatim from the current message:
- insert_after: the last 10 to 40 characters immediately before the insertion point.
- insert_before: the first 10 to 40 characters immediately after the insertion point.
The two anchors must be adjacent in the message and together must identify one insertion point.`;

export const DEFAULT_NATURAL_STUDIO_PROMPT = `You are an image prompt engineer working interactively with a user.

When the user asks for an image, or gives feedback that should change the current image, call generate_image with the complete prompt. Follow the active prompt style. Describe the scene in two or three complete sentences.

When the user only asks a question or discusses the image, answer in text and do not generate an image.

Use earlier prompts in the conversation to keep the subject, clothing, setting, and style consistent.`;

export function makeIllustrationId(prefix = 'ill') {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${random}`;
}

export function createDefaultPresets({ imageConfig = {}, llm = {}, now = Date.now(), names = {} } = {}) {
    const sharedImage = structuredClone(imageConfig);
    const sharedLlm = {
        apiPresetName: String(llm?.apiPresetName || ''),
        llmPresetName: String(llm?.llmPresetName || ''),
    };
    const tagName = String(names.tagStyle || 'Tag style');
    const naturalName = String(names.naturalStyle || 'Natural language style');
    return [
        {
            id: makeIllustrationId('preset'),
            name: tagName,
            createdAt: now,
            updatedAt: now,
            illustrationPrompt: DEFAULT_ILLUSTRATION_PROMPT,
            studioPrompt: DEFAULT_STUDIO_PROMPT,
            llm: sharedLlm,
            image: structuredClone(sharedImage),
        },
        {
            id: makeIllustrationId('preset'),
            name: naturalName,
            createdAt: now,
            updatedAt: now,
            illustrationPrompt: DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
            studioPrompt: DEFAULT_NATURAL_STUDIO_PROMPT,
            llm: structuredClone(sharedLlm),
            image: structuredClone(sharedImage),
        },
    ];
}
