import { ADD_IMAGE_PROMPT_TOOL } from './tools.js';

function speakerName(message) {
    const name = String(message?.name || '').trim();
    if (name) {
        return name;
    }
    return message?.is_user ? 'User' : 'Assistant';
}

function isUsableContextMessage(message) {
    if (!message || message.is_system) {
        return false;
    }
    return String(message.mes || '').trim().length > 0;
}

export function buildIllustrationContext({ chat, messageId, contextMessageCount, stripMarkup }) {
    const list = Array.isArray(chat) ? chat : [];
    const currentMessage = list[messageId];
    if (!currentMessage) {
        throw new Error(`Message not found at index ${messageId}`);
    }
    const strip = typeof stripMarkup === 'function' ? stripMarkup : (text => text);
    const current = strip(String(currentMessage.mes || '')).trim();

    const count = Math.max(0, Number(contextMessageCount) || 0);
    const history = count === 0 ? [] : list
        .slice(0, messageId)
        .filter(isUsableContextMessage)
        .slice(-count)
        .map(message => `[${speakerName(message)}]: ${strip(String(message.mes || '')).trim()}`);

    return {
        context: history.join('\n'),
        current,
    };
}

export function buildIllustrationTaskMessages({ preset, context, current, memoryRecall }) {
    const systemPrompt = String(preset?.illustrationPrompt || '').trim();
    if (!systemPrompt) {
        throw new Error('Illustration prompt is empty.');
    }
    if (!String(current || '').trim()) {
        throw new Error('Current message is empty.');
    }

    const sections = [];
    const recall = String(memoryRecall || '').trim();
    if (recall) {
        sections.push(`=== MEMORY RECALL ===\n${recall}`);
    }
    const contextText = String(context || '').trim();
    if (contextText) {
        sections.push(`=== CONTEXT ===\n${contextText}`);
    }
    sections.push(`=== CURRENT MESSAGE ===\n${String(current).trim()}`);

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sections.join('\n\n') },
    ];
}

export async function requestIllustrationPrompts({ context, preset, taskMessages, abortSignal }) {
    if (typeof context?.generateTask !== 'function') {
        throw new Error('generateTask is not available.');
    }
    const result = await context.generateTask({
        taskMessages,
        includeCharacterCard: true,
        worldInfoSource: 'task',
        apiPresetName: preset?.llm?.apiPresetName || '',
        llmPresetName: preset?.llm?.llmPresetName || '',
        tools: [ADD_IMAGE_PROMPT_TOOL],
        toolChoice: 'auto',
        functionCallMode: 'auto',
        substituteMacros: true,
        abortSignal,
    });
    const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
    return calls.map(call => ({ name: String(call?.name || ''), args: call?.args || {} }));
}
