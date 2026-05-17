// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import path from 'node:path';
import sanitize from 'sanitize-filename';

import { CHAT_COMPLETION_SOURCES } from '../../constants.js';
import { appendMessagesToChatFile } from '../chats.js';
import { getConfigValue, tryParse } from '../../util.js';
import {
    completeInspectionFromStream,
    failInspection,
    abortInspection,
} from '../../request-inspector.js';

const generationJobs = new Map();
const LUKER_GENERATION_JOB_MAX_ITEMS = 128;
const LUKER_GENERATION_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const LUKER_GENERATION_JOB_MAX_EVENTS = 8000;
const LUKER_GENERATION_ACK_GRACE_MS = Math.max(1000, Number(getConfigValue('luker.generationAckGraceMs', 15_000, 'number')) || 15_000);

function normalizePersistJsonlFileName(fileName) {
    const raw = String(fileName || '').trim();
    if (!raw) {
        return '';
    }
    const withExt = path.extname(raw) ? raw : `${raw}.jsonl`;
    return sanitize(path.basename(withExt));
}

function normalizePersistAvatarDirectory(avatarUrl) {
    const raw = String(avatarUrl || '').replace('.png', '').trim();
    if (!raw) {
        return '';
    }
    return sanitize(path.basename(raw));
}

function extractTextFromOpenAIMessageContent(content) {
    return extractTextFromStructuredContent(content);
}

function normalizeGenerationSource(source) {
    return String(source || '').trim().toLowerCase();
}

function isStructuredThinkingPart(part) {
    if (!part || typeof part !== 'object') {
        return false;
    }

    return Boolean(part.thought)
        || part.type === 'thinking'
        || Array.isArray(part.thinking)
        || typeof part.thinking === 'string';
}

function extractTextFromStructuredContent(content, options = {}) {
    const skipThoughts = options.skipThoughts !== false;

    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content.map(part => extractTextFromStructuredContent(part, { skipThoughts })).join('');
    }

    if (!content || typeof content !== 'object') {
        return '';
    }

    if (skipThoughts && isStructuredThinkingPart(content)) {
        return '';
    }

    if (typeof content.text === 'string') {
        return content.text;
    }

    if (typeof content.content === 'string') {
        return content.content;
    }

    if (Array.isArray(content.content)) {
        return extractTextFromStructuredContent(content.content, { skipThoughts });
    }

    if (content.content && typeof content.content === 'object') {
        return extractTextFromStructuredContent(content.content, { skipThoughts });
    }

    if (Array.isArray(content.text)) {
        return extractTextFromStructuredContent(content.text, { skipThoughts });
    }

    if (Array.isArray(content.message?.content)) {
        return extractTextFromStructuredContent(content.message.content, { skipThoughts });
    }

    return '';
}

function extractTextFromGeminiParts(parts, options = {}) {
    if (!Array.isArray(parts)) {
        return '';
    }

    const joiner = typeof options.joiner === 'string' ? options.joiner : '';
    const nonThoughtText = parts
        .filter(part => !part?.thought)
        .map(part => typeof part?.text === 'string' ? part.text : '')
        .filter(Boolean);

    return nonThoughtText.join(joiner);
}

function extractTextFromStreamingPayload(payload, source) {
    const normalizedSource = normalizeGenerationSource(source);
    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const defaultContent = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? '';

    switch (normalizedSource) {
        case CHAT_COMPLETION_SOURCES.CLAUDE:
            return typeof payload?.delta?.text === 'string' ? payload.delta.text : '';
        case CHAT_COMPLETION_SOURCES.MAKERSUITE:
        case CHAT_COMPLETION_SOURCES.VERTEXAI:
            return extractTextFromGeminiParts(payload?.candidates?.[0]?.content?.parts);
        case CHAT_COMPLETION_SOURCES.COHERE:
            return payload?.delta?.message?.content?.text ?? payload?.delta?.message?.tool_plan ?? '';
        case CHAT_COMPLETION_SOURCES.DEEPSEEK:
        case CHAT_COMPLETION_SOURCES.XAI:
            return choice?.delta?.content ?? '';
        case CHAT_COMPLETION_SOURCES.OPENROUTER:
            return extractTextFromOpenAIMessageContent(defaultContent);
        case CHAT_COMPLETION_SOURCES.CUSTOM:
        case CHAT_COMPLETION_SOURCES.POLLINATIONS:
        case CHAT_COMPLETION_SOURCES.AIMLAPI:
        case CHAT_COMPLETION_SOURCES.MOONSHOT:
        case CHAT_COMPLETION_SOURCES.COMETAPI:
        case CHAT_COMPLETION_SOURCES.ELECTRONHUB:
        case CHAT_COMPLETION_SOURCES.NANOGPT:
        case CHAT_COMPLETION_SOURCES.ZAI:
        case CHAT_COMPLETION_SOURCES.SILICONFLOW:
        case CHAT_COMPLETION_SOURCES.CHUTES:
        case CHAT_COMPLETION_SOURCES.AZURE_OPENAI:
        case CHAT_COMPLETION_SOURCES.AI21:
            return extractTextFromOpenAIMessageContent(defaultContent);
        case CHAT_COMPLETION_SOURCES.MISTRALAI: {
            const content = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? '';
            return extractTextFromOpenAIMessageContent(content);
        }
        default:
            return extractTextFromOpenAIMessageContent(defaultContent);
    }
}

export function extractTextFromFinalPayload(payload) {
    if (!payload) {
        return '';
    }

    if (typeof payload === 'string') {
        return payload;
    }

    if (typeof payload !== 'object') {
        return '';
    }

    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    if (choice) {
        const choiceContent = choice?.message?.content ?? choice?.delta?.content ?? choice?.text ?? '';
        const extractedChoiceText = extractTextFromOpenAIMessageContent(choiceContent);
        if (extractedChoiceText) {
            return extractedChoiceText;
        }
        if (typeof choice?.message?.tool_plan === 'string') {
            return choice.message.tool_plan;
        }
    }

    const result = Array.isArray(payload?.results) ? payload.results[0] : null;
    if (result) {
        const resultContent = result?.message?.content ?? result?.content ?? result?.text ?? '';
        const extractedResultText = extractTextFromOpenAIMessageContent(resultContent);
        if (extractedResultText) {
            return extractedResultText;
        }
        if (typeof result?.message?.tool_plan === 'string') {
            return result.message.tool_plan;
        }
    }

    const responseContentText = extractTextFromGeminiParts(payload?.responseContent?.parts, { joiner: '\n\n' });
    if (responseContentText) {
        return responseContentText;
    }

    const payloadContentText = extractTextFromOpenAIMessageContent(payload?.content);
    if (payloadContentText) {
        return payloadContentText;
    }

    const payloadMessageContentText = extractTextFromOpenAIMessageContent(payload?.message?.content);
    if (payloadMessageContentText) {
        return payloadMessageContentText;
    }

    if (typeof payload?.message?.tool_plan === 'string') {
        return payload.message.tool_plan;
    }
    if (typeof payload.response === 'string') {
        return payload.response;
    }
    if (typeof payload.token === 'string') {
        return payload.token;
    }
    if (typeof payload.text === 'string') {
        return payload.text;
    }
    if (typeof payload.output === 'string') {
        return payload.output;
    }

    return '';
}

export function extractTextFromStreamingFrameData(rawData, source = '') {
    if (!rawData || rawData === '[DONE]') {
        return '';
    }

    try {
        const parsed = JSON.parse(rawData);
        if (parsed?.luker && typeof parsed.luker === 'object') {
            return '';
        }
        return extractTextFromStreamingPayload(parsed, source) || extractTextFromFinalPayload(parsed);
    } catch {
        return '';
    }
}

function pruneGenerationJobs() {
    const now = Date.now();
    for (const [key, job] of generationJobs.entries()) {
        const updatedAt = Number(job?.updatedAt || job?.createdAt || 0);
        if (!updatedAt || (now - updatedAt) > LUKER_GENERATION_JOB_TTL_MS) {
            clearGenerationJobPersistenceTimer(job);
            generationJobs.delete(key);
        }
    }

    while (generationJobs.size > LUKER_GENERATION_JOB_MAX_ITEMS) {
        const oldestKey = generationJobs.keys().next().value;
        clearGenerationJobPersistenceTimer(generationJobs.get(oldestKey));
        generationJobs.delete(oldestKey);
    }
}

function clearGenerationJobPersistenceTimer(job) {
    if (!job?.persistenceTimer) {
        return;
    }

    clearTimeout(job.persistenceTimer);
    job.persistenceTimer = null;
}

function buildGenerationJobRequestMeta(request, persistTarget) {
    return {
        api: String(request.body?.chat_completion_source || request.body?.api_type || request.body?.api || 'unknown'),
        char_name: String(persistTarget?.char_name || request.body?.char_name || 'Assistant'),
        model: String(request.body?.model || ''),
        directories: {
            chats: String(request.user?.directories?.chats || ''),
            groupChats: String(request.user?.directories?.groupChats || ''),
        },
    };
}

export function getPersistChatKey(persistTarget) {
    if (!persistTarget || typeof persistTarget !== 'object') {
        return '';
    }

    if (persistTarget.kind === 'group') {
        return `group:${String(persistTarget.id || '')}`;
    }

    const avatar = String(persistTarget.avatar_url || '');
    const fileName = String(persistTarget.file_name || '');
    if (!avatar || !fileName) {
        return '';
    }
    return `char:${avatar}:${fileName}`;
}

export function createGenerationJob(request, options) {
    if (!options || typeof options !== 'object') {
        return null;
    }

    const jobId = typeof options.job_id === 'string' && options.job_id.trim()
        ? options.job_id.trim()
        : '';
    if (!jobId) {
        return null;
    }

    const now = Date.now();
    const persistTarget = options.persist_target && typeof options.persist_target === 'object'
        ? options.persist_target
        : null;
    const chatKey = getPersistChatKey(persistTarget);
    const existing = generationJobs.get(jobId);
    const job = existing || {
        id: jobId,
        handle: request.user.profile.handle,
        createdAt: now,
        updatedAt: now,
        status: 'running',
        text: '',
        events: [],
        lastSeq: 0,
        error: '',
        persisted: false,
        persistTarget,
        chatKey,
        abortController: null,
        cancelledByUser: false,
        acked: false,
        ackedAt: null,
        finishedAt: null,
        persistenceTimer: null,
        persistenceInFlight: false,
        requestMeta: null,
        modelName: '',
    };

    clearGenerationJobPersistenceTimer(job);
    job.status = 'running';
    job.updatedAt = now;
    job.error = '';
    job.persisted = false;
    job.persistTarget = persistTarget;
    job.chatKey = chatKey;
    job.acked = false;
    job.ackedAt = null;
    job.finishedAt = null;
    job.persistenceInFlight = false;
    job.requestMeta = buildGenerationJobRequestMeta(request, persistTarget);
    job.modelName = String(request.body?.model || '');
    if (!Array.isArray(job.events)) {
        job.events = [];
    }
    job.cancelledByUser = false;
    job.abortController = null;

    generationJobs.set(jobId, job);
    pruneGenerationJobs();
    return job;
}

export function attachJobToRequest(request, job) {
    if (!request || typeof request !== 'object') {
        return;
    }
    request.lukerGenerationJob = job || null;
}

export function getJobFromRequest(request) {
    return request?.lukerGenerationJob || null;
}

export function appendGenerationEvent(job, rawData) {
    if (!job) {
        return;
    }

    const nextSeq = Number(job.lastSeq || 0) + 1;
    job.lastSeq = nextSeq;
    const entry = { seq: nextSeq, data: rawData, ts: Date.now() };
    job.events.push(entry);
    if (job.events.length > LUKER_GENERATION_JOB_MAX_EVENTS) {
        job.events.splice(0, job.events.length - LUKER_GENERATION_JOB_MAX_EVENTS);
    }
    job.updatedAt = Date.now();

    const deltaText = extractTextFromStreamingFrameData(rawData, job?.requestMeta?.api);
    if (deltaText) {
        job.text += deltaText;
    }

    notifyJobSubscribers(job, { type: 'event', entry });
}

/**
 * In-memory subscribers (typically SSE response writers) per job id. Used by
 * the /jobs/events-stream endpoint to push events without polling. Job
 * completion/failure flushes a terminal status and clears the set.
 */
const jobSubscribers = new Map();

export function subscribeToJob(jobId, callback) {
    const id = String(jobId || '');
    if (!id || typeof callback !== 'function') {
        return () => {};
    }
    let set = jobSubscribers.get(id);
    if (!set) {
        set = new Set();
        jobSubscribers.set(id, set);
    }
    set.add(callback);
    return () => {
        const current = jobSubscribers.get(id);
        if (current) {
            current.delete(callback);
            if (current.size === 0) jobSubscribers.delete(id);
        }
    };
}

function notifyJobSubscribers(job, payload) {
    if (!job) return;
    const set = jobSubscribers.get(String(job.id));
    if (!set || set.size === 0) return;
    for (const cb of Array.from(set)) {
        try { cb(payload); } catch (error) {
            console.warn('[LukerGeneration] subscriber threw', error);
        }
    }
}

function notifyJobStatus(job) {
    notifyJobSubscribers(job, {
        type: 'status',
        status: job.status,
        text: job.text,
        last_seq: job.lastSeq,
        error: job.error || '',
        finished_at: job.finishedAt || null,
    });
}

export function failGenerationJob(job, errorMessage = 'Unknown error occurred') {
    if (!job) {
        return;
    }
    if (job.status === 'cancelled') {
        return;
    }
    clearGenerationJobPersistenceTimer(job);
    job.persistenceInFlight = false;
    job.status = 'failed';
    job.error = String(errorMessage || 'Unknown error occurred');
    job.updatedAt = Date.now();
    job.finishedAt = Date.now();
    job.abortController = null;
    notifyJobStatus(job);
}

async function persistGeneratedReply(job, text, generationId = '', modelName = '') {
    const persistTarget = job?.persistTarget;
    if (!persistTarget || typeof persistTarget !== 'object') {
        return false;
    }

    const finalText = String(text || '');
    if (!finalText) {
        return false;
    }

    const message = {
        name: String(job?.requestMeta?.char_name || persistTarget.char_name || 'Assistant'),
        is_user: false,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: finalText,
        extra: {
            api: String(job?.requestMeta?.api || 'unknown'),
            model: modelName || job?.modelName || job?.requestMeta?.model || '',
            luker_server_persisted: true,
            ...(generationId ? { luker_generation_id: generationId } : {}),
        },
    };

    const directories = job?.requestMeta?.directories;
    const chatsDirectory = String(directories?.chats || '');
    const groupChatsDirectory = String(directories?.groupChats || '');

    if (persistTarget.kind === 'group') {
        const groupId = String(persistTarget.id || '');
        if (!groupId || !groupChatsDirectory) {
            return false;
        }

        const chatFilePath = path.join(groupChatsDirectory, sanitize(`${groupId}.jsonl`));
        await appendMessagesToChatFile({
            filePath: chatFilePath,
            messages: [message],
            chatMetadata: persistTarget.chat_metadata || {},
            integritySlug: persistTarget.integrity || '',
            force: Boolean(persistTarget.force),
        });
        return true;
    }

    if (persistTarget.kind === 'character') {
        const avatar = normalizePersistAvatarDirectory(persistTarget.avatar_url);
        const fileName = normalizePersistJsonlFileName(persistTarget.file_name);
        if (!avatar || !fileName || !chatsDirectory) {
            return false;
        }

        const chatFilePath = path.join(
            chatsDirectory,
            avatar,
            fileName,
        );
        await appendMessagesToChatFile({
            filePath: chatFilePath,
            messages: [message],
            chatMetadata: persistTarget.chat_metadata || {},
            integritySlug: persistTarget.integrity || '',
            force: Boolean(persistTarget.force),
        });
        return true;
    }

    return false;
}

export async function completeGenerationJobFromText(request, job, text, modelName = '') {
    if (!job) {
        return false;
    }
    if (job.status === 'cancelled') {
        clearGenerationJobPersistenceTimer(job);
        job.persistenceInFlight = false;
        job.updatedAt = Date.now();
        job.finishedAt = Date.now();
        job.abortController = null;
        job.persisted = false;
        return false;
    }

    const finalText = String(text || '');
    job.text = finalText || job.text || '';
    job.modelName = String(modelName || job.modelName || request.body?.model || '');
    job.status = 'awaiting_ack';
    job.updatedAt = Date.now();
    job.finishedAt = null;
    job.persisted = false;
    job.persistenceInFlight = false;
    job.abortController = null;
    clearGenerationJobPersistenceTimer(job);
    job.persistenceTimer = setTimeout(() => {
        void persistGenerationJobIfUnacked(job);
    }, LUKER_GENERATION_ACK_GRACE_MS);
    notifyJobStatus(job);
    return false;
}

export async function completeGenerationJobFromPayload(request, job, payload, modelName = '') {
    const text = extractTextFromFinalPayload(payload);
    return await completeGenerationJobFromText(request, job, text, modelName);
}

export function bindRequestCloseAbort(request, controller, options = {}) {
    const onAbortClose = typeof options.onAbortClose === 'function' ? options.onAbortClose : null;
    const keepAliveWhenJob = options.keepAliveWhenJob !== false;
    const response = options.response && typeof options.response === 'object'
        ? options.response
        : request?.res;
    const job = getJobFromRequest(request);
    const hasJob = keepAliveWhenJob && Boolean(job);
    let handled = false;

    if (job) {
        job.abortController = controller || null;
    }

    const cleanup = () => {
        request?.removeListener?.('aborted', handleAbort);
        request?.socket?.removeListener?.('close', handleSocketClose);
        response?.removeListener?.('close', handleResponseClose);
    };

    const abortUpstream = async () => {
        if (handled) {
            return;
        }
        handled = true;
        cleanup();
        if (hasJob) {
            return;
        }
        if (onAbortClose) {
            await onAbortClose();
        }
        if (controller && !controller.signal?.aborted) {
            controller.abort();
        }
    };

    const handleAbort = () => {
        void abortUpstream();
    };

    const handleSocketClose = () => {
        if (response?.writableEnded || response?.finished) {
            cleanup();
            return;
        }
        void abortUpstream();
    };

    const handleResponseClose = () => {
        if (response?.writableEnded || response?.finished) {
            cleanup();
            return;
        }
        void abortUpstream();
    };

    request?.on?.('aborted', handleAbort);
    request?.socket?.on?.('close', handleSocketClose);
    response?.on?.('close', handleResponseClose);
}

export function cancelGenerationJobForRequest(request, jobId, reason = 'Cancelled by user') {
    pruneGenerationJobs();
    const id = String(jobId || '').trim();
    if (!id) {
        return { ok: false, status: 400, message: 'Job id is required.' };
    }

    const job = generationJobs.get(id);
    if (!job || job.handle !== request.user.profile.handle) {
        return { ok: false, status: 404, message: 'Job not found.' };
    }

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        return { ok: true, status: 200, cancelled: false, job };
    }

    clearGenerationJobPersistenceTimer(job);
    job.persistenceInFlight = false;
    job.status = 'cancelled';
    job.cancelledByUser = true;
    job.error = String(reason || 'Cancelled by user');
    job.updatedAt = Date.now();
    job.finishedAt = Date.now();
    job.persisted = false;

    if (job.abortController && !job.abortController.signal?.aborted) {
        try {
            job.abortController.abort(job.error);
        } catch {
            // ignore abort propagation failures
        }
    }
    job.abortController = null;
    notifyJobStatus(job);

    return { ok: true, status: 200, cancelled: true, job };
}

async function persistGenerationJobIfUnacked(job) {
    if (!job || job.status === 'cancelled' || job.status === 'failed' || job.persisted || job.acked) {
        return Boolean(job?.persisted);
    }

    clearGenerationJobPersistenceTimer(job);

    if (!job.text) {
        job.status = 'completed';
        job.updatedAt = Date.now();
        job.finishedAt = Date.now();
        notifyJobStatus(job);
        return false;
    }

    job.status = 'persisting';
    job.persistenceInFlight = true;
    job.updatedAt = Date.now();
    notifyJobStatus(job);

    try {
        const persisted = await persistGeneratedReply(job, job.text, job.id, job.modelName);
        job.persisted = Boolean(persisted);
        job.status = persisted ? 'completed' : 'failed';
        job.error = persisted ? '' : 'Generation could not be persisted on server.';
        job.updatedAt = Date.now();
        job.finishedAt = Date.now();
        notifyJobStatus(job);
        return Boolean(job.persisted);
    } catch (error) {
        job.persisted = false;
        job.status = 'failed';
        job.error = String(error?.message || 'Generation could not be persisted on server.');
        job.updatedAt = Date.now();
        job.finishedAt = Date.now();
        notifyJobStatus(job);
        return false;
    } finally {
        job.persistenceInFlight = false;
    }
}

export function acknowledgeGenerationJobsForRequest(request, generationIds = []) {
    pruneGenerationJobs();
    const handle = String(request?.user?.profile?.handle || '');
    const ids = Array.from(new Set(
        Array.isArray(generationIds)
            ? generationIds.map(id => String(id || '').trim()).filter(Boolean)
            : [],
    ));

    /** @type {string[]} */
    const acknowledged = [];
    const acknowledgedAt = Date.now();

    for (const id of ids) {
        const job = generationJobs.get(id);
        if (!job || job.handle !== handle) {
            continue;
        }
        if (job.persisted || job.persistenceInFlight) {
            continue;
        }
        if (!['awaiting_ack', 'completed'].includes(String(job.status || ''))) {
            continue;
        }

        clearGenerationJobPersistenceTimer(job);
        job.acked = true;
        job.ackedAt = acknowledgedAt;
        job.status = 'completed';
        job.error = '';
        job.updatedAt = acknowledgedAt;
        job.finishedAt = acknowledgedAt;
        job.abortController = null;
        acknowledged.push(id);
    }

    return acknowledged;
}

/**
 * Acknowledge a single unpersisted generation job for a persist target when
 * the client saved chat state without forwarding an explicit generation id.
 * This keeps server-side recovery for true disconnects, while allowing
 * message-hijack flows to confirm ownership after any successful chat write.
 * @param {import('express').Request} request
 * @param {object} persistTarget
 * @param {{statuses?: string[], maxJobs?: number}} [options]
 * @returns {string[]}
 */
export function acknowledgeGenerationJobsForPersistTarget(request, persistTarget, options = {}) {
    pruneGenerationJobs();
    const handle = String(request?.user?.profile?.handle || '');
    const chatKey = getPersistChatKey(persistTarget);
    if (!handle || !chatKey) {
        return [];
    }

    const statuses = new Set(
        Array.isArray(options?.statuses) && options.statuses.length
            ? options.statuses.map(status => String(status || '').trim()).filter(Boolean)
            : ['awaiting_ack'],
    );
    const maxJobs = Math.max(1, Number(options?.maxJobs) || 1);

    const candidates = Array.from(generationJobs.values())
        .filter(job => job.handle === handle
            && job.chatKey === chatKey
            && !job.persisted
            && !job.persistenceInFlight
            && statuses.has(String(job.status || '')))
        .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));

    if (candidates.length === 0 || candidates.length > maxJobs) {
        return [];
    }

    return acknowledgeGenerationJobsForRequest(request, candidates.map(job => job.id));
}

export async function forwardStreamingWithGenerationJob(fetchResponse, response, request, job, options = {}) {
    const modelName = String(options.modelName || request.body?.model || '');
    let clientClosed = false;
    response.socket?.on('close', () => {
        clientClosed = true;
    });
    if (!response.headersSent) {
        response.setHeader('x-luker-generation-id', job.id);
    }
    if (!fetchResponse.ok) {
        const errorText = await fetchResponse.text().catch(() => '');
        const errorMessage = `${fetchResponse.status} ${fetchResponse.statusText}`.trim();
        console.warn(`Streaming API returned error: ${errorMessage}${errorText ? ` ${errorText}` : ''}`);
        failGenerationJob(job, errorMessage || errorText || 'Streaming request failed');
        failInspection(request, errorMessage || errorText || 'Streaming request failed', fetchResponse.status);
        if (!clientClosed && !response.writableEnded) {
            if (!response.headersSent) {
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            response.end(errorText || '');
        }
        return;
    }

    let statusCode = fetchResponse.status;
    if (statusCode === 401) {
        statusCode = 400;
    }

    response.statusCode = statusCode;
    response.statusMessage = fetchResponse.statusText;
    const contentType = fetchResponse.headers.get('content-type');
    if (contentType) {
        response.setHeader('content-type', contentType);
    }
    // Ensure SSE/proxy path does not buffer stream chunks.
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    if (typeof response.flushHeaders === 'function') {
        response.flushHeaders();
    }

    // Preserve the original byte stream for the client and decode incrementally only for SSE bookkeeping.
    let buffer = '';
    const decoder = new TextDecoder('utf-8');
    try {
        if (fetchResponse.body) {
            for await (const chunk of fetchResponse.body) {
                if (job.status === 'cancelled') {
                    break;
                }
                const chunkBytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
                const chunkText = decoder.decode(chunkBytes, { stream: true });
                if (!clientClosed && !response.writableEnded) {
                    response.write(chunkBytes);
                    if (typeof response.flush === 'function') {
                        response.flush();
                    }
                }

                buffer += chunkText;
                buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                let delimiterIndex = buffer.indexOf('\n\n');
                while (delimiterIndex !== -1) {
                    const frame = buffer.slice(0, delimiterIndex);
                    buffer = buffer.slice(delimiterIndex + 2);
                    const dataLines = frame
                        .split('\n')
                        .map(line => line.trimEnd())
                        .filter(line => line.startsWith('data:'))
                        .map(line => line.slice(5).trimStart());
                    if (dataLines.length > 0) {
                        appendGenerationEvent(job, dataLines.join('\n'));
                    }
                    delimiterIndex = buffer.indexOf('\n\n');
                }
            }
        }
    } catch (error) {
        if (job.status !== 'cancelled') {
            failGenerationJob(job, error?.message || 'Streaming interrupted');
            failInspection(request, error?.message || 'Streaming interrupted');
        } else {
            abortInspection(request);
        }
        if (!clientClosed && !response.writableEnded) {
            response.end();
        }
        return;
    }

    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (buffer.trim()) {
        const dataLines = buffer
            .split('\n')
            .map(line => line.trimEnd())
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart());
        if (dataLines.length > 0) {
            appendGenerationEvent(job, dataLines.join('\n'));
        }
    }

    if (job.status === 'cancelled') {
        abortInspection(request);
        if (!clientClosed && !response.writableEnded) {
            response.end();
        }
        return;
    }

    completeInspectionFromStream(request, job.events, job.text);
    const persisted = await completeGenerationJobFromText(request, job, job.text, modelName);
    const completionEvent = JSON.stringify({
        luker: {
            generation_id: job.id,
            persisted,
            status: job.status,
        },
    });
    appendGenerationEvent(job, completionEvent);
    if (!clientClosed && !response.writableEnded) {
        response.write(`data: ${completionEvent}\n\n`);
        if (typeof response.flush === 'function') {
            response.flush();
        }
        response.end();
    }
}

/**
 * Stream a fetch response to the client while accumulating SSE text for the
 * request-inspector. Mirrors forwardStreamingWithGenerationJob's tap loop
 * minus the generation-job bookkeeping. Use when no luker_generation job is
 * attached but the inspector still needs the response body and completion
 * signal.
 */
export async function forwardStreamingWithInspectorTap(fetchResponse, response, request) {
    const source = String(request.body?.chat_completion_source || request.body?.api_type || '');
    let clientClosed = false;
    response.socket?.on('close', () => { clientClosed = true; });

    if (!fetchResponse.ok) {
        const errorText = await fetchResponse.text().catch(() => '');
        const errorMessage = `${fetchResponse.status} ${fetchResponse.statusText}`.trim();
        console.warn(`Streaming API returned error: ${errorMessage}${errorText ? ` ${errorText}` : ''}`);
        failInspection(request, errorMessage || errorText || 'Streaming request failed', fetchResponse.status);
        if (!clientClosed && !response.writableEnded) {
            if (!response.headersSent) {
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            response.end(errorText || '');
        }
        return;
    }

    let statusCode = fetchResponse.status;
    if (statusCode === 401) statusCode = 400;
    response.statusCode = statusCode;
    response.statusMessage = fetchResponse.statusText;
    const contentType = fetchResponse.headers.get('content-type');
    if (contentType) response.setHeader('content-type', contentType);
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    if (typeof response.flushHeaders === 'function') response.flushHeaders();

    let buffer = '';
    let accumulatedText = '';
    const events = [];
    const decoder = new TextDecoder('utf-8');
    try {
        if (fetchResponse.body) {
            for await (const chunk of fetchResponse.body) {
                const chunkBytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
                const chunkText = decoder.decode(chunkBytes, { stream: true });
                if (!clientClosed && !response.writableEnded) {
                    response.write(chunkBytes);
                    if (typeof response.flush === 'function') response.flush();
                }
                buffer += chunkText;
                buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                let delimiterIndex = buffer.indexOf('\n\n');
                while (delimiterIndex !== -1) {
                    const frame = buffer.slice(0, delimiterIndex);
                    buffer = buffer.slice(delimiterIndex + 2);
                    const dataLines = frame
                        .split('\n')
                        .map(line => line.trimEnd())
                        .filter(line => line.startsWith('data:'))
                        .map(line => line.slice(5).trimStart());
                    if (dataLines.length > 0) {
                        const data = dataLines.join('\n');
                        events.push(data);
                        const deltaText = extractTextFromStreamingFrameData(data, source);
                        if (deltaText) accumulatedText += deltaText;
                    }
                    delimiterIndex = buffer.indexOf('\n\n');
                }
            }
        }
    } catch (error) {
        failInspection(request, error?.message || 'Streaming interrupted');
        if (!clientClosed && !response.writableEnded) response.end();
        return;
    }

    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (buffer.trim()) {
        const dataLines = buffer
            .split('\n')
            .map(line => line.trimEnd())
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart());
        if (dataLines.length > 0) {
            const data = dataLines.join('\n');
            events.push(data);
            const deltaText = extractTextFromStreamingFrameData(data, source);
            if (deltaText) accumulatedText += deltaText;
        }
    }

    completeInspectionFromStream(request, events, accumulatedText);
    if (!clientClosed && !response.writableEnded) response.end();
}

export function getActiveGenerationJobsForRequest(request, persistTarget) {
    const chatKey = getPersistChatKey(persistTarget);
    if (!chatKey) {
        return [];
    }
    pruneGenerationJobs();
    const handle = request.user.profile.handle;
    return Array.from(generationJobs.values())
        .filter(job => job.handle === handle && job.chatKey === chatKey && ['running', 'queued', 'awaiting_ack', 'persisting'].includes(job.status))
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .map(job => ({
            id: job.id,
            status: job.status,
            text: job.text,
            last_seq: job.lastSeq,
            created_at: job.createdAt,
            updated_at: job.updatedAt,
        }));
}

export function getGenerationJobForRequest(request, jobId) {
    pruneGenerationJobs();
    const job = generationJobs.get(String(jobId || ''));
    if (!job || job.handle !== request.user.profile.handle) {
        return null;
    }
    return job;
}
