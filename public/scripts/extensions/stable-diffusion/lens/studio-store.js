// SPDX-License-Identifier: AGPL-3.0-or-later

import { buildPersistentToolHistoryMessages, createPersistentToolTurnMessage } from '../../../lib/iter-tool-calling.js';
import { makeIllustrationId } from '../illustration/presets.js';

export const STUDIO_SESSIONS_NAMESPACE = 'sd_studio_sessions';
export const STUDIO_TITLE_LENGTH = 60; // cap-ok: bounds sidebar session row title to 60 chars so long prompts do not overflow rail layout

export function sessionTitleFromText(text) {
    return String(text ?? '').trim().slice(0, STUDIO_TITLE_LENGTH);
}

export function createStudioSession({
    presetId = '',
    visualReview = false,
    now = Date.now(),
    title = '',
} = {}) {
    return {
        id: makeIllustrationId('studio'),
        title: String(title || ''),
        presetId: String(presetId || ''),
        visualReview: Boolean(visualReview),
        attachedReferences: [],
        createdAt: now,
        updatedAt: now,
        messages: [],
        images: [],
    };
}

export function normalizeStudioSession(raw, now = Date.now()) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const id = String(raw.id || '').trim() || makeIllustrationId('studio');
    const messages = Array.isArray(raw.messages) ? JSON.parse(JSON.stringify(raw.messages)) : [];
    const images = (Array.isArray(raw.images) ? raw.images : []).map(img => ({
        id: String(img?.id || makeIllustrationId('img')),
        messageId: String(img?.messageId || ''),
        prompt: String(img?.prompt || ''),
        negativePrompt: String(img?.negativePrompt || ''),
        aspectRatio: String(img?.aspectRatio || ''),
        imageUrl: String(img?.imageUrl || ''),
        sourceImageId: String(img?.sourceImageId || ''),
        characterImageIds: Array.isArray(img?.characterImageIds) ? img.characterImageIds.map(String) : [],
        loras: Array.isArray(img?.loras) ? JSON.parse(JSON.stringify(img.loras)) : [],
        status: img?.status === 'failed' ? 'failed' : 'ready',
        error: String(img?.error || ''),
        createdAt: Number.isFinite(Number(img?.createdAt)) ? Number(img.createdAt) : now,
    }));

    return {
        id,
        title: String(raw.title || ''),
        presetId: String(raw.presetId || ''),
        visualReview: Boolean(raw.visualReview),
        attachedReferences: Array.isArray(raw.attachedReferences) ? JSON.parse(JSON.stringify(raw.attachedReferences)) : [],
        createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : now,
        updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : now,
        messages,
        images,
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
            negativePrompt: String(image?.negativePrompt || ''),
            aspectRatio: String(image?.aspectRatio || ''),
            imageUrl: String(image?.imageUrl || ''),
            sourceImageId: String(image?.sourceImageId || ''),
            characterImageIds: Array.isArray(image?.characterImageIds) ? image.characterImageIds.map(String) : [],
            loras: Array.isArray(image?.loras) ? JSON.parse(JSON.stringify(image.loras)) : [],
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

async function readSessionsMap(context) {
    if (typeof context?.getGlobalState !== 'function') {
        throw new Error('GlobalState API (context.getGlobalState) is unavailable.');
    }
    const res = await context.getGlobalState(STUDIO_SESSIONS_NAMESPACE);
    if (!res?.ok) {
        throw new Error(`Failed to read studio sessions (${STUDIO_SESSIONS_NAMESPACE}): ${res?.hint || res?.reason || 'unknown error'}`);
    }
    const rawMap = res.state?.sessions;
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
        return {};
    }
    const normalized = {};
    for (const [key, entry] of Object.entries(rawMap)) {
        const clean = normalizeStudioSession({ ...entry, id: entry?.id || key });
        if (clean) {
            normalized[clean.id] = clean;
        }
    }
    return normalized;
}

export function createStudioSessionStore(context) {
    return {
        async migrateLegacySettingsSessionsOnce(illustrationSettings, saveSettings) {
            if (!illustrationSettings || typeof illustrationSettings !== 'object') {
                return false;
            }
            if (!Object.hasOwn(illustrationSettings, 'studioSessions')) {
                return false;
            }
            const rawLegacy = illustrationSettings.studioSessions;
            const entries = (rawLegacy && typeof rawLegacy === 'object' && !Array.isArray(rawLegacy))
                ? Object.entries(rawLegacy)
                : [];

            if (entries.length > 0) {
                const res = await context.updateGlobalState(STUDIO_SESSIONS_NAMESPACE, (current) => {
                    const existing = (current?.sessions && typeof current.sessions === 'object' && !Array.isArray(current.sessions))
                        ? { ...current.sessions }
                        : {};
                    for (const [id, rawSession] of entries) {
                        const clean = normalizeStudioSession({ ...rawSession, id: rawSession?.id || id });
                        if (clean && !existing[clean.id]) {
                            existing[clean.id] = clean;
                        }
                    }
                    return {
                        ...current,
                        version: 1,
                        sessions: existing,
                    };
                }, { asyncDiff: false });

                if (!res?.ok) {
                    throw new Error(`Failed to migrate legacy studioSessions to GlobalState: ${res?.hint || res?.reason || 'unknown error'}`);
                }
            }

            delete illustrationSettings.studioSessions;
            await saveSettings?.();
            return entries.length > 0;
        },

        async listSessions() {
            const map = await readSessionsMap(context);
            return Object.values(map).sort((a, b) => (b.updatedAt - a.updatedAt) || String(a.id).localeCompare(String(b.id)));
        },

        async getSession(id) {
            const target = String(id || '').trim();
            if (!target) {
                return null;
            }
            const map = await readSessionsMap(context);
            return map[target] || null;
        },

        async saveSession(session, now = Date.now()) {
            const clean = normalizeStudioSession({ ...session, updatedAt: session?.updatedAt ?? now }, now);
            if (!clean) {
                throw new Error('Invalid studio session payload.');
            }
            const res = await context.updateGlobalState(STUDIO_SESSIONS_NAMESPACE, (current) => {
                const existing = (current?.sessions && typeof current.sessions === 'object' && !Array.isArray(current.sessions))
                    ? { ...current.sessions }
                    : {};
                existing[clean.id] = clean;
                return {
                    ...current,
                    version: 1,
                    sessions: existing,
                };
            }, { asyncDiff: false });

            if (!res?.ok) {
                throw new Error(`Failed to save studio session: ${res?.hint || res?.reason || 'unknown error'}`);
            }
            return clean;
        },

        async forkSessionAt(id, messageCount, now = Date.now()) {
            const source = await this.getSession(id);
            if (!source) {
                throw new Error(`Studio session "${id}" not found.`);
            }
            const count = Math.max(0, Math.min(source.messages.length, Math.floor(Number(messageCount) || 0)));
            const keptMessages = source.messages.slice(0, count);
            const keptMessageIds = new Set(keptMessages.map(m => m.id));
            const keptImages = source.images.filter(img => !img.messageId || keptMessageIds.has(img.messageId));

            const forked = normalizeStudioSession({
                ...source,
                id: makeIllustrationId('studio'),
                title: source.title ? `${source.title} (fork)` : '',
                createdAt: now,
                updatedAt: now,
                messages: keptMessages,
                images: keptImages,
            }, now);

            return await this.saveSession(forked, now);
        },

        async deleteSession(id) {
            const target = String(id || '').trim();
            if (!target) {
                return false;
            }
            let deleted = false;
            const res = await context.updateGlobalState(STUDIO_SESSIONS_NAMESPACE, (current) => {
                const existing = (current?.sessions && typeof current.sessions === 'object' && !Array.isArray(current.sessions))
                    ? { ...current.sessions }
                    : {};
                if (!Object.hasOwn(existing, target)) {
                    return null;
                }
                delete existing[target];
                deleted = true;
                return {
                    ...current,
                    version: 1,
                    sessions: existing,
                };
            }, { asyncDiff: false });

            if (!res?.ok) {
                throw new Error(`Failed to delete studio session "${target}": ${res?.hint || res?.reason || 'unknown error'}`);
            }
            return deleted;
        },
    };
}
