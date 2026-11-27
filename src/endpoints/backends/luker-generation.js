// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import sanitize from 'sanitize-filename';

import { appendMessagesToChatFile } from '../chats.js';
import { getConfigValue } from '../../util.js';
import { stripJsonlExt } from '../../storage/name-validation.js';
import { dispatchLog as console, withDispatchLogging } from '../../luker-dispatch/logging.js';
import {
    ProtocolParseError,
    createProtocolStreamParser,
    createSseFramer,
    isParsedTurnEmpty,
    parseProtocolResponse,
    resolveWireProtocol,
} from '../../../public/scripts/lib/protocol-parser/index.js';
import {
    getRequestTransientSession,
    getTransientSessionForUser,
    TRANSIENT_SESSION_HEADER,
    TransientSessionError,
} from '../../transient-sessions.js';

const generationJobs = new Map();
// In-memory job registry bounds: cap retained job snapshots and per-job event
// replay queues so long-running servers do not grow heap unboundedly.
const LUKER_GENERATION_JOB_MAX_ITEMS = 128;
const LUKER_GENERATION_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const LUKER_GENERATION_JOB_MAX_EVENTS = 8000;
const LUKER_GENERATION_ACK_GRACE_MS = Math.max(1000, Number(getConfigValue('generationAckGraceMs', 15_000, 'number')) || 15_000);

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

function extractLegacyTextGenFinalPayload(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload;
    if (typeof payload !== 'object') return '';
    if (typeof payload.results?.[0]?.text === 'string') return payload.results[0].text;
    if (typeof payload.choices?.[0]?.text === 'string') return payload.choices[0].text;
    if (typeof payload.response === 'string') return payload.response;
    if (typeof payload.token === 'string') return payload.token;
    if (typeof payload.content === 'string') return payload.content;
    if (typeof payload.text === 'string') return payload.text;
    if (typeof payload.output === 'string') return payload.output;
    return '';
}

function feedLegacySseFrames(job, frames) {
    for (const frame of frames) {
        const raw = typeof frame?.data === 'string' ? frame.data.trim() : '';
        if (!raw || raw === '[DONE]') continue;
        try {
            const parsed = JSON.parse(raw);
            const extracted = extractLegacyTextGenFinalPayload(parsed);
            if (extracted) {
                job.text += extracted;
            }
        } catch {
            // Non-JSON SSE event payloads are ignored for legacy text extraction.
        }
    }
}

function applyParsedTurnToJob(job, turn) {
    if (!job || !turn) return;
    job.parsedTurn = turn;
    if (typeof turn.text === 'string') {
        job.text = turn.text;
    }
}

function isSseFramedText(text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const trimmed = normalized.trimStart();
    if (!trimmed) return false;
    return /^(?:data:|event:|id:|retry:|:)/.test(trimmed);
}

function feedJobStreamFrame(job, protocol, rawData, eventName = '') {
    if (!rawData || job.parseError) return;
    if (!job._protocolParser) {
        job._protocolParser = createProtocolStreamParser(protocol);
    }
    try {
        const delta = job._protocolParser.feedFrame(rawData, eventName);
        if (delta.textDelta) {
            job.text = String(job.text || '') + delta.textDelta;
        }
    } catch (err) {
        if (err instanceof ProtocolParseError) {
            job.parseError = err.toDiagnostic();
            if (err.stage === 'provider_error') {
                applyParsedTurnToJob(job, job._protocolParser.getSnapshot());
            }
        } else {
            console.error('[LukerGeneration] Unexpected error while parsing stream frame:', err);
            job.parseError = new ProtocolParseError({
                protocol,
                stage: 'unexpected',
                location: 'stream',
                message: `Unexpected error while parsing stream frame: ${err?.message || err}`,
                cause: err,
            }).toDiagnostic();
        }
    }
}

/**
 * Flush any buffered SSE tail frames and finalize the shared protocol stream
 * parser on a generation job when the upstream stream ends.
 * @param {object} job
 */
export function finalizeJobProtocolStream(job) {
    if (!job) return;
    if (job._utf8Decoder) {
        const tailText = job._utf8Decoder.end();
        job._utf8Decoder = null;
        if (tailText) {
            accumulateChunkTextIntoJob(job, tailText);
        }
    }
    const protocol = resolveWireProtocol(job?.requestMeta?.api);
    if (!protocol) {
        if (job._sseFramer) {
            feedLegacySseFrames(job, job._sseFramer.flush());
        }
        return;
    }

    if (job._sseFramer) {
        const tailFrames = job._sseFramer.flush();
        for (const frame of tailFrames) {
            feedJobStreamFrame(job, protocol, frame.data, frame.event);
        }
        const invalidDiagnostic = job._sseFramer.getInvalidDiagnostic?.();
        if (!job._protocolParser && !job.parseError && invalidDiagnostic) {
            job.parseError = new ProtocolParseError({
                protocol,
                stage: 'sse',
                location: 'stream',
                message: 'Expected text/event-stream SSE frames, received non-SSE response body.',
                rawDiagnostic: invalidDiagnostic,
            }).toDiagnostic();
        }
    }
    if (job._protocolParser && !job.parseError) {
        try {
            const turn = job._protocolParser.finish();
            applyParsedTurnToJob(job, turn);
        } catch (err) {
            if (err instanceof ProtocolParseError) {
                if (err.stage === 'eof') {
                    const partial = job._protocolParser.getSnapshot();
                    if (!isParsedTurnEmpty(partial) || Boolean(job.text)) {
                        console.warn('[LukerGeneration] Stream closed without terminal marker; preserving received content:', err.message);
                        applyParsedTurnToJob(job, partial);
                    } else {
                        job.parseError = err.toDiagnostic();
                    }
                } else {
                    job.parseError = err.toDiagnostic();
                }
            } else {
                console.error('[LukerGeneration] Unexpected error while finalizing stream parser:', err);
                job.parseError = new ProtocolParseError({
                    protocol,
                    stage: 'unexpected',
                    location: 'eof',
                    message: `Unexpected error while finalizing stream parser: ${err?.message || err}`,
                    cause: err,
                }).toDiagnostic();
            }
        }
    }
    if (!job._sseFramer && !job.parseError && !job.parsedTurn) {
        const remaining = String(job._sseBuffer || '').trim();
        if (remaining) {
            job._sseBuffer = '';
            try {
                const parsed = JSON.parse(remaining);
                const turn = parseProtocolResponse(protocol, parsed);
                applyParsedTurnToJob(job, turn);
                job._parsedRawNonStreamPayload = parsed;
                job._streamMode = 'json';
            } catch (err) {
                if (err instanceof ProtocolParseError) {
                    job.parseError = err.toDiagnostic();
                } else {
                    job.parseError = new ProtocolParseError({
                        protocol,
                        stage: 'json',
                        location: 'body',
                        message: `Malformed non-streaming JSON response: ${err?.message || err}`,
                        cause: err,
                        rawDiagnostic: remaining,
                    }).toDiagnostic();
                }
            }
        }
    }
}

/**
 * Given a raw chunk emitted from a dispatch (Uint8Array / Buffer / string),
 * feed the shared protocol parser for the job's declared wire protocol so
 * `job.text` and `job.parsedTurn` stay in sync with streamed or non-streamed
 * content. Non-chat backends (kobold/novelai/textgen/image) use the legacy
 * non-chat text extractor and never touch chat protocol parsers.
 *
 * @param {object} job
 * @param {Uint8Array | Buffer | string} chunkBytes
 */
export function accumulateChunkTextIntoJob(job, chunkBytes) {
    if (!job || chunkBytes == null) return;

    let text;
    if (typeof chunkBytes === 'string') {
        text = chunkBytes;
    } else if (chunkBytes instanceof Uint8Array || Buffer.isBuffer(chunkBytes)) {
        if (!job._utf8Decoder) {
            job._utf8Decoder = new StringDecoder('utf8');
        }
        const buf = Buffer.isBuffer(chunkBytes)
            ? chunkBytes
            : Buffer.from(chunkBytes.buffer, chunkBytes.byteOffset, chunkBytes.byteLength);
        text = job._utf8Decoder.write(buf);
    } else {
        return;
    }
    if (!text) return;

    const source = job?.requestMeta?.api || '';
    const protocol = resolveWireProtocol(source);
    if (!protocol) {
        if (job._streamMode == null) {
            const probe = String(job._sseBuffer || '') + text;
            if (job?._isStream === true || (job?._isStream !== false && isSseFramedText(probe))) {
                job._streamMode = 'sse';
                job._sseFramer = createSseFramer();
                const combined = String(job._sseBuffer || '') + text;
                job._sseBuffer = '';
                feedLegacySseFrames(job, job._sseFramer.push(combined));
                return;
            }
        }
        if (job._streamMode === 'sse') {
            feedLegacySseFrames(job, job._sseFramer.push(text));
            return;
        }
        job._sseBuffer = String(job._sseBuffer || '') + text;
        const trimmed = job._sseBuffer.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                const extracted = extractLegacyTextGenFinalPayload(parsed);
                if (extracted) {
                    job.text += extracted;
                    job._sseBuffer = '';
                }
            } catch {
                // Incomplete JSON chunk — keep buffering until complete.
            }
        }
        return;
    }

    if (job._streamMode == null) {
        const probe = String(job._sseBuffer || '') + text;
        if (job?._isStream === true || (job?._isStream !== false && isSseFramedText(probe))) {
            job._streamMode = 'sse';
            job._sseFramer = createSseFramer();
            const combined = String(job._sseBuffer || '') + text;
            job._sseBuffer = '';
            const frames = job._sseFramer.push(combined);
            for (const frame of frames) {
                feedJobStreamFrame(job, protocol, frame.data, frame.event);
            }
            return;
        }
        job._sseBuffer = String(job._sseBuffer || '') + text;
        const trimmed = job._sseBuffer.trim();
        if (trimmed.startsWith('{')) {
            try {
                const parsed = JSON.parse(trimmed);
                const turn = parseProtocolResponse(protocol, parsed);
                applyParsedTurnToJob(job, turn);
                job._parsedRawNonStreamPayload = parsed;
                job._sseBuffer = '';
                job._streamMode = 'json';
            } catch (err) {
                if (err instanceof ProtocolParseError) {
                    job.parseError = err.toDiagnostic();
                    job._sseBuffer = '';
                } else if (!(err instanceof SyntaxError)) {
                    console.error('[LukerGeneration] Unexpected error while parsing non-stream response:', err);
                    job.parseError = new ProtocolParseError({
                        protocol,
                        stage: 'unexpected',
                        location: 'body',
                        message: `Unexpected error while parsing response: ${err?.message || err}`,
                        cause: err,
                    }).toDiagnostic();
                    job._sseBuffer = '';
                }
                // SyntaxError from partial JSON chunk keeps buffering.
            }
        }
        return;
    }

    if (job._streamMode === 'sse') {
        const frames = job._sseFramer.push(text);
        for (const frame of frames) {
            feedJobStreamFrame(job, protocol, frame.data, frame.event);
        }
        return;
    }

    job._sseBuffer = String(job._sseBuffer || '') + text;
    const trimmed = job._sseBuffer.trim();
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            const turn = parseProtocolResponse(protocol, parsed);
            applyParsedTurnToJob(job, turn);
            job._parsedRawNonStreamPayload = parsed;
            job._sseBuffer = '';
        } catch (err) {
            if (err instanceof ProtocolParseError) {
                job.parseError = err.toDiagnostic();
                job._sseBuffer = '';
            } else if (!(err instanceof SyntaxError)) {
                console.error('[LukerGeneration] Unexpected error while parsing buffered response:', err);
                job.parseError = new ProtocolParseError({
                    protocol,
                    stage: 'unexpected',
                    location: 'body',
                    message: `Unexpected error while parsing response: ${err?.message || err}`,
                    cause: err,
                }).toDiagnostic();
                job._sseBuffer = '';
            }
        }
    }
}

function pruneGenerationJobs() {
    const now = Date.now();
    const ordinaryKeys = [];
    for (const [key, job] of generationJobs.entries()) {
        if (job.transientSessionId) continue;
        const updatedAt = Number(job?.updatedAt || job?.createdAt || 0);
        if (!updatedAt || (now - updatedAt) > LUKER_GENERATION_JOB_TTL_MS) {
            clearGenerationJobPersistenceTimer(job);
            generationJobs.delete(key);
        } else {
            ordinaryKeys.push(key);
        }
    }

    for (const oldestKey of ordinaryKeys.slice(0, Math.max(0, ordinaryKeys.length - LUKER_GENERATION_JOB_MAX_ITEMS))) {
        clearGenerationJobPersistenceTimer(generationJobs.get(oldestKey));
        generationJobs.delete(oldestKey);
    }
}

function clearGenerationJobPersistenceTimer(job) {
    // Also owns the text-progress notify timer: every caller of this helper
    // is a state transition (complete / fail / cancel / persist), where a
    // pending progress frame would be stale noise.
    if (job?._textNotifyTimer) {
        clearTimeout(job._textNotifyTimer);
        job._textNotifyTimer = null;
    }
    if (!job?.persistenceTimer) {
        return;
    }

    clearTimeout(job.persistenceTimer);
    job.persistenceTimer = null;
}

// Live-text progress feed for recovery subscribers (/jobs/events-stream).
// Every status frame carries the FULL accumulated job.text, so notifying on
// each chunk would scale wire bytes quadratically with reply length (a
// 100KB reply arriving in 1KB chunks ≈ 5MB of redundant JSON per client).
// The interval bounds that to one frame per tick while the trailing timer
// guarantees the final partial segment is never stranded until completion.
const LUKER_GENERATION_TEXT_PROGRESS_NOTIFY_MS = 300;

/**
 * Throttled status notification during a running stream so recovery clients
 * see the preview text grow live instead of jumping at completion. Leading +
 * trailing edge: fires immediately when the interval has elapsed since the
 * last send, otherwise schedules one trailing send so text accumulated in
 * between is still delivered.
 *
 * No-op once the job leaves 'running' (terminal transitions notify their own
 * status frames), when text length is unchanged, or for jobs without text.
 * @param {object} job
 */
export function notifyJobTextProgress(job) {
    if (!job || String(job.status || '') !== 'running') {
        return;
    }
    const textLen = String(job.text || '').length;
    if (!textLen || textLen === Number(job._lastNotifiedTextLen || 0)) {
        return;
    }
    const now = Date.now();
    const elapsed = now - Number(job._lastTextNotifyAt || 0);
    if (elapsed >= LUKER_GENERATION_TEXT_PROGRESS_NOTIFY_MS) {
        if (job._textNotifyTimer) {
            clearTimeout(job._textNotifyTimer);
            job._textNotifyTimer = null;
        }
        job._lastTextNotifyAt = now;
        job._lastNotifiedTextLen = textLen;
        notifyJobStatus(job);
        return;
    }
    if (job._textNotifyTimer) {
        return;
    }
    job._textNotifyTimer = setTimeout(() => {
        job._textNotifyTimer = null;
        if (String(job.status || '') !== 'running') {
            return;
        }
        const lenNow = String(job.text || '').length;
        if (!lenNow || lenNow === Number(job._lastNotifiedTextLen || 0)) {
            return;
        }
        job._lastTextNotifyAt = Date.now();
        job._lastNotifiedTextLen = lenNow;
        notifyJobStatus(job);
    }, LUKER_GENERATION_TEXT_PROGRESS_NOTIFY_MS - elapsed);
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
        return `group:${stripJsonlExt(persistTarget.id)}`;
    }

    const avatar = String(persistTarget.avatar_url || '');
    const fileName = String(persistTarget.file_name || '');
    if (!avatar || !fileName) {
        return '';
    }
    return `char:${avatar}:${stripJsonlExt(fileName)}`;
}

export function getTaskByRequestId(requestId, expectedOwner, transientSessionId) {
    const id = String(requestId || '');
    if (!id) return null;
    const job = generationJobs.get(id);
    if (!job) return null;
    if (String(expectedOwner || '') !== String(job.owner || '')) {
        throw new Error('forbidden');
    }
    const session = getTransientSessionForUser(transientSessionId, expectedOwner);
    if (job.transientSessionId !== session?.id) {
        throw new Error('forbidden');
    }
    return job;
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
    const session = getRequestTransientSession(request);
    const persistTarget = !session && options.persist_target && typeof options.persist_target === 'object'
        ? options.persist_target
        : null;
    const chatKey = getPersistChatKey(persistTarget);
    const existing = generationJobs.get(jobId);
    if (existing && (existing.owner !== request.user.profile.handle || existing.transientSessionId !== session?.id)) {
        throw new TransientSessionError(409, 'TRANSIENT_JOB_SCOPE_CONFLICT', 'The generation job belongs to a different request scope.');
    }
    const job = existing || {
        id: jobId,
        handle: request.user.profile.handle,
        owner: request.user.profile.handle,
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
        _parsedRawNonStreamPayload: null,
        ...(session ? { transientSessionId: session.id } : {}),
    };

    // A recycled job_id (the client re-POSTs the same job_id when it retries a
    // request) must start from a clean stream state. Without this reset the
    // retry's `resume from_seq: 1` replays the previous attempt's buffered
    // head/chunk/error frames into the new attempt, so the client treats the
    // old attempt's abort as the retry's own result. The previous attempt's
    // upstream request also survives: its AbortController was only nulled,
    // never aborted, so it keeps generating in parallel with the retry.
    if (existing) {
        try { existing.abortController?.abort('superseded by retry'); } catch { /* ignore */ }
        job.events = [];
        job.lastSeq = 0;
        job.text = '';
        job.parsedTurn = null;
        job.parseError = null;
        job._protocolParser = null;
        job._sseFramer = null;
        job._sseBuffer = '';
        job._streamMode = null;
        job._utf8Decoder = null;
        job._lastNotifiedTextLen = 0;
        job._lastTextNotifyAt = 0;
        job._parsedRawNonStreamPayload = null;
    }

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
    const hasExplicitStream = request.body?.stream !== undefined || request.body?.streaming !== undefined;
    job._isStream = hasExplicitStream
        ? Boolean(request.body?.stream || request.body?.streaming)
        : null;
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
    if (!job.transientSessionId && job.events.length > LUKER_GENERATION_JOB_MAX_EVENTS) {
        job.events.splice(0, job.events.length - LUKER_GENERATION_JOB_MAX_EVENTS);
    }
    job.updatedAt = Date.now();

    if (typeof rawData === 'string') {
        const protocol = resolveWireProtocol(job?.requestMeta?.api);
        if (protocol) {
            feedJobStreamFrame(job, protocol, rawData);
        } else {
            try {
                const parsed = JSON.parse(rawData);
                const extracted = extractLegacyTextGenFinalPayload(parsed);
                if (extracted) job.text += extracted;
            } catch {
                // Raw non-JSON event frames are still recorded in job.events verbatim.
            }
        }
    }

    notifyJobSubscribers(job, { type: 'event', entry });
}

/**
 * In-memory subscribers (typically SSE response writers) per job id. Used by
 * the /jobs/events-stream endpoint to push events without polling. Job
 * completion/failure flushes a terminal status and clears the set.
 */
const jobSubscribers = new Map();

export function subscribeToJob(jobId, callback, options = {}) {
    const id = String(jobId || '');
    if (!id || typeof callback !== 'function') {
        return () => {};
    }
    const fromSeq = Number(options.fromSeq || 0);
    // Replay events with seq >= fromSeq
    if (fromSeq > 0) {
        const job = generationJobs.get(id);
        if (job && Array.isArray(job.events)) {
            for (const entry of job.events) {
                if (entry.seq >= fromSeq) {
                    try {
                        callback({ type: 'event', entry });
                    } catch (error) {
                        console.warn('[LukerGeneration] subscriber threw during replay', error);
                    }
                }
            }
        }
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
    if (job.status === 'cancelled' || job.status === 'failed' || job.status === 'completed') {
        clearGenerationJobPersistenceTimer(job);
        job.abortController = null;
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

    const turn = job?.parsedTurn || null;
    const finalText = String(text || '') || String(turn?.refusal || '');
    if (!finalText) {
        return false;
    }

    const messageExtra = {
        api: String(job?.requestMeta?.api || 'unknown'),
        model: modelName || job?.modelName || job?.requestMeta?.model || '',
        luker_server_persisted: true,
        ...(generationId ? { luker_generation_id: generationId } : {}),
    };
    if (turn) {
        if (typeof turn.reasoning === 'string' && turn.reasoning.length > 0) {
            messageExtra.reasoning = turn.reasoning;
        }
        if (typeof turn.signature === 'string' && turn.signature.length > 0) {
            messageExtra.reasoning_signature = turn.signature;
        }
        if (Array.isArray(turn.reasoningBlocks) && turn.reasoningBlocks.length > 0) {
            messageExtra.reasoning_blocks = turn.reasoningBlocks;
        }
        if (Array.isArray(turn.reasoningDetails) && turn.reasoningDetails.length > 0) {
            messageExtra.reasoning_details = turn.reasoningDetails;
        }
        if (Array.isArray(turn.nativeParts) && turn.nativeParts.length > 0) {
            messageExtra.native_parts = turn.nativeParts;
        }
        if (Array.isArray(turn.nativeContentBlocks) && turn.nativeContentBlocks.length > 0) {
            messageExtra.native_content_blocks = turn.nativeContentBlocks;
        }
        if (Array.isArray(turn.responsesOutputItems) && turn.responsesOutputItems.length > 0) {
            messageExtra.responses_output_items = turn.responsesOutputItems;
        }
        if (Array.isArray(turn.citations) && turn.citations.length > 0) {
            messageExtra.citations = turn.citations;
        }
        if (typeof turn.finishReason === 'string' && turn.finishReason.length > 0) {
            messageExtra.finish_reason = turn.finishReason;
        }
        if (typeof turn.refusal === 'string' && turn.refusal.length > 0) {
            messageExtra.refusal = turn.refusal;
        }
        if (Number.isFinite(turn.usage?.completion_tokens)) {
            messageExtra.token_count = turn.usage.completion_tokens;
        }
    }

    const message = {
        name: String(job?.requestMeta?.char_name || persistTarget.char_name || 'Assistant'),
        is_user: false,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: finalText,
        extra: messageExtra,
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
            // Route through ChatRepo so writes land in the active engine,
            // not just the FS scratch directory. (filePath is still passed
            // so the sidecar gen-id helpers see a stable key.)
            handle: job?.handle || job?.requestMeta?.handle,
            charDir: '',
            name: groupId,
            isGroup: true,
            groupId,
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
        const baseName = fileName.replace(/\.jsonl$/i, '');
        await appendMessagesToChatFile({
            filePath: chatFilePath,
            messages: [message],
            chatMetadata: persistTarget.chat_metadata || {},
            integritySlug: persistTarget.integrity || '',
            force: Boolean(persistTarget.force),
            handle: job?.handle || job?.requestMeta?.handle,
            charDir: avatar,
            name: baseName,
            isGroup: false,
        });
        return true;
    }

    return false;
}

export async function completeGenerationJobFromText(request, job, text, modelName = '') {
    if (!job) {
        return false;
    }
    if (job.status === 'cancelled' || job.status === 'failed') {
        clearGenerationJobPersistenceTimer(job);
        job.persistenceInFlight = false;
        job.updatedAt = Date.now();
        job.finishedAt = job.finishedAt || Date.now();
        job.abortController = null;
        job.persisted = false;
        return false;
    }
    if (job.status === 'completed') {
        clearGenerationJobPersistenceTimer(job);
        job.abortController = null;
        return Boolean(job.persisted);
    }
    if (job.abortController?.signal?.aborted) {
        const reason = job.abortController.signal.reason;
        failGenerationJob(job, reason instanceof Error ? reason.message : String(reason || 'Aborted'));
        return false;
    }

    const finalText = String(text || '');
    job.text = finalText || job.text || '';
    job.modelName = String(modelName || job.modelName || request.body?.model || '');
    job.status = job.transientSessionId ? 'completed' : 'awaiting_ack';
    job.updatedAt = Date.now();
    job.finishedAt = job.transientSessionId ? Date.now() : null;
    job.persisted = false;
    job.persistenceInFlight = false;
    job.abortController = null;
    clearGenerationJobPersistenceTimer(job);
    if (!job.transientSessionId) {
        job.persistenceTimer = setTimeout(() => {
            void persistGenerationJobIfUnacked(job);
        }, LUKER_GENERATION_ACK_GRACE_MS);
        // A pending grace period must not keep the process alive: while serving,
        // the HTTP listener does, and shutdown exits without waiting for it.
        job.persistenceTimer.unref?.();
    }
    notifyJobStatus(job);
    return false;
}

/**
 * Abort a running generation job from the request inspector.
 *
 * Differs from `cancelGenerationJobForRequest` in two ways that matter to the
 * client:
 *   - the job is marked `cancelled` (a user-initiated stop), not `failed`;
 *   - a terminal `error` event with `code: 'aborted'` is appended BEFORE the
 *     upstream AbortController fires. The WS delivery layer turns that code
 *     into a real AbortError on the client, which is what blocks the HTTP
 *     retry loop and the auto-continue / auto-swipe paths. Relying on the
 *     dispatch's own AbortError is not enough: some dispatches swallow it and
 *     return normally, and the generic error frame does not carry the abort
 *     code.
 *
 * @param {object} job
 * @param {string} [reason]
 * @returns {boolean} true when the job was running and is now cancelled
 */
export function abortGenerationJobForInspector(job, reason = 'Aborted from request inspector') {
    if (!job) return false;
    if (!['running', 'queued'].includes(String(job.status || ''))) return false;

    clearGenerationJobPersistenceTimer(job);
    job.persistenceInFlight = false;
    job.status = 'cancelled';
    job.cancelledByUser = true;
    job.error = String(reason || 'Aborted from request inspector');
    job.updatedAt = Date.now();
    job.finishedAt = Date.now();
    job.persisted = false;

    // Append the terminal frame before aborting so subscribers receive an
    // explicit abort even when the dispatch catches the AbortError and
    // returns without emitting one of its own.
    appendGenerationEvent(job, {
        kind: 'error',
        data: { code: 'aborted', message: job.error },
    });

    if (job.abortController && !job.abortController.signal?.aborted) {
        try { job.abortController.abort(job.error); } catch { /* already aborted */ }
    }
    job.abortController = null;
    notifyJobStatus(job);
    return true;
}

export function cancelGenerationJobForRequest(request, jobId, reason = 'Cancelled by user') {
    pruneGenerationJobs();
    const id = String(jobId || '').trim();
    if (!id) {
        return { ok: false, status: 400, message: 'Job id is required.' };
    }

    let job;
    try {
        job = getGenerationJobForRequest(request, id);
    } catch (error) {
        if (error instanceof TransientSessionError) {
            return { ok: false, status: error.status, message: error.message };
        }
        throw error;
    }
    if (!job) {
        return { ok: false, status: 404, message: 'Job not found.' };
    }

    if (job.transientSessionId) {
        const cancelled = withDispatchLogging(true, () => abortGenerationJobForInspector(job, reason));
        return { ok: true, status: 200, cancelled, job };
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

export async function persistGenerationJobIfUnacked(job) {
    if (!job
        || job.status === 'cancelled'
        || job.status === 'failed'
        || job.status === 'completed'
        || job.persisted
        || job.acked
        || job.parseError
        || job.abortController?.signal?.aborted) {
        clearGenerationJobPersistenceTimer(job);
        return Boolean(job?.persisted);
    }

    clearGenerationJobPersistenceTimer(job);

    const persistableText = job.text || String(job.parsedTurn?.refusal || '');
    if (!persistableText) {
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
        const persisted = await persistGeneratedReply(job, persistableText, job.id, job.modelName);
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
    const sessionId = request.headers?.[TRANSIENT_SESSION_HEADER.toLowerCase()];
    const session = getTransientSessionForUser(sessionId, request.user.profile.handle);
    if (job.transientSessionId !== session?.id) return null;
    return job;
}

export function releaseTransientGenerationJobs(session) {
    for (const [id, job] of generationJobs) {
        if (job.transientSessionId !== session.id || job.handle !== session.userHandle) continue;
        clearGenerationJobPersistenceTimer(job);
        jobSubscribers.delete(id);
        generationJobs.delete(id);
        job.events.length = 0;
        job.text = '';
        job.requestMeta = null;
    }
}
