import { buildPersistentToolHistoryMessages, createPersistentToolTurnMessage } from '../../../../lib/iter-tool-calling.js';
import { makeIllustrationId } from '../presets.js';

export const STUDIO_TITLE_LENGTH = 60;

export function sessionTitleFromText(text) {
    return String(text ?? '').trim().slice(0, STUDIO_TITLE_LENGTH);
}

export function createStudioSession({ presetId = '', now = Date.now(), title = '' } = {}) {
    return {
        id: makeIllustrationId('studio'),
        title: String(title || ''),
        presetId: String(presetId || ''),
        createdAt: now,
        updatedAt: now,
        messages: [],
        images: [],
    };
}

export function appendStudioUserMessage(session, text, now = Date.now()) {
    const content = String(text ?? '').trim();
    const message = {
        id: makeIllustrationId('msg'),
        role: 'user',
        content,
        at: now,
        tool_calls: [],
        tool_results: [],
    };
    session.messages.push(message);
    if (!session.title) {
        session.title = sessionTitleFromText(content);
    }
    session.updatedAt = now;
    return message;
}

function normalizeToolCalls(toolCalls, toolResults) {
    return (Array.isArray(toolCalls) ? toolCalls : []).map((call, index) => {
        const args = call?.arguments ?? call?.function?.arguments ?? {};
        return {
            id: String(call?.id || call?.tool_call_id || toolResults?.[index]?.tool_call_id || ''),
            type: 'function',
            function: {
                name: String(call?.name || call?.function?.name || ''),
                arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
            },
        };
    }).filter(call => call.function.name);
}

export function appendStudioAssistantTurn(session, {
    text = '',
    toolCalls = [],
    toolResults = [],
    images = [],
    now = Date.now(),
} = {}) {
    const normalizedResults = (Array.isArray(toolResults) ? toolResults : []).map(result => ({
        tool_call_id: String(result?.tool_call_id || ''),
        content: String(result?.content ?? ''),
    }));
    const message = createPersistentToolTurnMessage({
        messageId: makeIllustrationId('msg'),
        assistantText: text,
        toolCalls: normalizeToolCalls(toolCalls, normalizedResults),
        toolResults: normalizedResults,
        at: now,
    });
    session.messages.push(message);
    for (const image of Array.isArray(images) ? images : []) {
        session.images.push({
            id: String(image?.id || makeIllustrationId('img')),
            messageId: message.id,
            prompt: String(image?.prompt || ''),
            imageUrl: String(image?.imageUrl || ''),
            status: image?.status === 'failed' ? 'failed' : 'ready',
            error: String(image?.error || ''),
            createdAt: Number(image?.createdAt ?? now),
        });
    }
    session.updatedAt = now;
    return message;
}

export function buildStudioHistoryMessages(session) {
    const history = [];
    for (const message of Array.isArray(session?.messages) ? session.messages : []) {
        const role = String(message?.role || '').trim().toLowerCase();
        if (role === 'user') {
            history.push({ role: 'user', content: String(message.content ?? '') });
            continue;
        }
        if (role === 'system') {
            history.push({ role: 'system', content: String(message.content ?? '') });
            continue;
        }
        if (role !== 'assistant') {
            continue;
        }
        const toolHistory = buildPersistentToolHistoryMessages([message]);
        if (toolHistory.length === 0) {
            history.push({ role: 'assistant', content: String(message.content ?? '') });
            continue;
        }
        history.push(...toolHistory);
    }
    return history;
}
