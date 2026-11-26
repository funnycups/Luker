// SPDX-License-Identifier: AGPL-3.0-or-later
// Request Inspector — per-user ring buffer for generation request diagnostics.

import express from 'express';
import { randomUUID } from 'node:crypto';
import { getConfigValue } from './util.js';
import { ByteBudgetLedger } from './util/byte-budget.js';
import { getGlobalProxyInfo } from './request-proxy.js';
import {
    ProtocolParseError,
    createProtocolStreamParser,
    extractProviderErrorMessage,
    isParsedTurnEmpty,
    parseProtocolResponse,
    resolveWireProtocol,
    toInspectorUsage,
} from '../public/scripts/lib/protocol-parser/index.js';
import { getRequestTransientSession } from './transient-sessions.js';

const RING_BUFFER_SIZE = 200;
// Completed records are diagnostic snapshots, not durable data — 2h covers
// "look back at what happened this session" without holding full message
// bodies (which can be megabytes) in the heap all day.
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
// Sweep cadence. Coarser than the TTL on purpose: expiry is lazy, so a
// stale record survives at most TTL + interval past its deadline.
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MIN_CLEANUP_INTERVAL_MS = 10 * 1000;
const MIN_TTL_MS = 10 * 1000;
// Running requests can legitimately span hours (long generations, stalled
// streams waiting on the client). Expire them on a separate, much longer
// clock so an in-flight record is never swept before its completion
// callback runs.
const ACTIVE_ENTRY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Read a numeric tuning value from config.yaml (or its env override via
 * getConfigValue). Values below `minimum` fall back to the default so a
 * mistyped `0` / negative can't turn the sweeper into a hot loop.
 * @param {string} key config.yaml key
 * @param {number} fallback default when unset or invalid
 * @param {number} minimum smallest accepted value
 * @returns {number}
 */
function readTuningNumber(key, fallback, minimum) {
    const value = Number(getConfigValue(key, fallback, 'number'));
    if (!Number.isFinite(value) || value < minimum) return fallback;
    return Math.floor(value);
}

const REQUEST_INSPECTOR_TTL_MS = readTuningNumber(
    'requestInspector.ttlMs',
    DEFAULT_TTL_MS,
    MIN_TTL_MS,
);
const REQUEST_INSPECTOR_CLEANUP_INTERVAL_MS = readTuningNumber(
    'requestInspector.cleanupIntervalMs',
    DEFAULT_CLEANUP_INTERVAL_MS,
    MIN_CLEANUP_INTERVAL_MS,
);
// Byte budget across every user's ring buffers. Entry count and TTL bound
// records, not memory: entries carry full request/response bodies, and
// image-bearing chats clone those bytes twice (fullMessages + wireRequest),
// so 200 records can retain gigabytes. 256 MB ≈ 6% of Node's ~4 GB default
// old-space keeps a full debugging session intact while capping retention.
const DEFAULT_BYTE_BUDGET_BYTES = 256 * 1024 * 1024;
const MIN_BYTE_BUDGET_BYTES = 16 * 1024 * 1024;
const REQUEST_INSPECTOR_BYTE_BUDGET_BYTES = readTuningNumber(
    'requestInspector.byteBudgetBytes',
    DEFAULT_BYTE_BUDGET_BYTES,
    MIN_BYTE_BUDGET_BYTES,
);
const inspectorLedger = new ByteBudgetLedger(REQUEST_INSPECTOR_BYTE_BUDGET_BYTES);

/** @type {Map<string, InspectorEntry[]>} handle -> entries */
const buffers = new Map();

/**
 * AbortControllers for request types that do not run through the generation
 * job runner (embedding / rerank). Chat, text and image requests carry a
 * `generationJobId` and are aborted through the job's own controller.
 *
 * Keyed by inspector entry id. Entries are removed on completion, failure,
 * eviction, or abort so a long-lived server never accumulates controllers.
 *
 * @type {Map<string, AbortController>}
 */
const inspectionAbortControllers = new Map();

function getBuffer(handle) {
    if (!buffers.has(handle)) {
        buffers.set(handle, []);
    }
    return buffers.get(handle);
}

/**
 * Return a copy of the inspector ring buffer for a given user handle. Used by
 * the debug-export endpoint to bundle every captured request — full
 * `fullMessages` / `responseText` / `wireRequest`, no truncation. Caller owns
 * the returned array (it's a shallow clone) but the entries themselves still
 * point at the live objects, so don't mutate them.
 *
 * @param {string} handle
 * @returns {object[]}
 */
export function getBufferForHandle(handle) {
    const h = String(handle || '');
    if (!h || !buffers.has(h)) return [];
    return buffers.get(h).slice();
}

function pushEntry(handle, entry) {
    const buf = getBuffer(handle);
    buf.push(entry);
    inspectorLedger.track(entry);
    if (buf.length > RING_BUFFER_SIZE) {
        removeEntry(handle, buf[0]);
    }
    enforceByteBudget();
}

function removeEntry(handle, entry) {
    const buffer = buffers.get(handle);
    if (!buffer) return false;

    const index = buffer.indexOf(entry);
    if (index === -1) return false;

    buffer.splice(index, 1);
    inspectorLedger.untrack(entry);
    releaseInspectionAbortController(entry);
    if (buffer.length === 0) buffers.delete(handle);
    return true;
}

/**
 * Drop the per-entry AbortController. If the entry is still running when it
 * is evicted (TTL / byte budget), abort the controller first so the upstream
 * request does not keep running with no record left to stop it.
 *
 * @param {object} entry
 */
function releaseInspectionAbortController(entry) {
    const id = String(entry?.id || '');
    if (!id) return;
    const controller = inspectionAbortControllers.get(id);
    if (!controller) return;
    inspectionAbortControllers.delete(id);
    if (entry.status === 'running' && !controller.signal.aborted) {
        try { controller.abort('inspection entry evicted'); } catch { /* ignore */ }
    }
}

/**
 * Drop the oldest evictable records until the ledger is back under the byte
 * budget. Running records are exempt — an in-flight request must survive
 * until its completion callback runs, same principle as ACTIVE_ENTRY_MAX_AGE
 * — and the single newest record always survives so a record larger than the
 * whole budget is still captured instead of silently dropped.
 */
function enforceByteBudget() {
    if (!inspectorLedger.isOver()) return;

    const candidates = [];
    for (const [handle, buffer] of buffers) {
        for (const entry of buffer) {
            if (entry.status === 'running') continue;
            candidates.push({ handle, entry });
        }
    }
    candidates.sort((a, b) => a.entry.timestamp - b.entry.timestamp);

    // `length - 1` keeps the newest evictable record.
    for (let i = 0; i < candidates.length - 1 && inspectorLedger.isOver(); i++) {
        removeEntry(candidates[i].handle, candidates[i].entry);
    }
}

/**
 * 清理已过期的请求记录。正在运行的请求保留更长时间，避免响应完成前被移除。
 * @param {number} [now]
 * @returns {number} 本次清理的记录数量
 */
export function cleanupExpiredEntries(now = Date.now()) {
    let removed = 0;

    for (const [handle, buffer] of buffers) {
        for (const entry of [...buffer]) {
            const age = now - Number(entry.timestamp);
            const isRunning = entry.status === 'running';
            const isExpired = isRunning
                ? age >= Math.max(REQUEST_INSPECTOR_TTL_MS, ACTIVE_ENTRY_MAX_AGE_MS)
                : age >= REQUEST_INSPECTOR_TTL_MS;

            if (isExpired && removeEntry(handle, entry)) removed++;
        }
        // Empty buffers (e.g. every record expired, or the /list route
        // re-created one for a user with no live records) hold no data —
        // drop the Map key so idle users don't leave entries behind.
        if (buffer.length === 0) {
            buffers.delete(handle);
        }
    }

    return removed;
}

const cleanupTimer = setInterval(cleanupExpiredEntries, REQUEST_INSPECTOR_CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

/**
 * Produce a redacted fingerprint of an API key suitable for the Inspector UI.
 * Plaintext keys never enter the ring buffer — only a prefix/suffix preview
 * plus the original length, so a user can tell which credential was used
 * without leaking it via JSON export or screenshots.
 *
 * @param {string} apiKey
 * @returns {string}
 */
export function fingerprintApiKey(apiKey) {
    const key = String(apiKey ?? '');
    if (!key) return '';
    const len = key.length;
    if (len <= 8) return `${'*'.repeat(len)} (${len} chars)`;
    return `${key.slice(0, 4)}...${key.slice(-4)} (${len} chars)`;
}

/**
 * Resolve the credential that actually goes on the wire when provider headers
 * merge user-supplied overrides (e.g. `custom_include_headers`) on top of the
 * resolved API key. Scans `headers` case-insensitively for the first of
 * `preferredHeaderNames` that is present; a present header wins over the
 * fallback even when its value is empty, because that is what the wire
 * carries. Strips a leading `Bearer ` (case-insensitive) from the value.
 *
 * @param {object} [headers] final outgoing request headers
 * @param {string} fallbackKey credential resolved from secrets or proxy password
 * @param {string[]} [preferredHeaderNames] candidate header names in priority order
 * @returns {string}
 */
export function resolveEffectiveApiKey(headers, fallbackKey, preferredHeaderNames = ['authorization', 'x-api-key', 'api-key']) {
    if (headers && typeof headers === 'object') {
        const entries = Object.entries(headers);
        for (const preferred of preferredHeaderNames) {
            const match = entries.find(([name]) => String(name).toLowerCase() === preferred);
            if (match) {
                const value = match[1];
                if (value == null) continue;
                return String(value).replace(/^Bearer\s+/i, '');
            }
        }
    }
    return String(fallbackKey ?? '');
}

const REDACT_QUERY_KEYS = new Set(['key', 'api_key', 'apikey', 'access_token', 'token']);

function sanitizeEndpointUrl(endpoint) {
    const raw = String(endpoint || '');
    if (!raw) return '';
    try {
        const url = new URL(raw);
        for (const name of [...url.searchParams.keys()]) {
            if (REDACT_QUERY_KEYS.has(name.toLowerCase())) {
                url.searchParams.set(name, '***');
            }
        }
        return url.toString();
    } catch {
        return raw;
    }
}

/**
 * Attach the resolved upstream endpoint and a redacted key fingerprint to the
 * current inspection entry. Call this right before fetching the upstream
 * provider from any send*Request function.
 *
 * If `wirePayload` is provided, a deep-cloned snapshot of the outbound request
 * body is recorded as `entry.wireRequest` so the Inspector UI can show what
 * actually went on the wire after post-processing and provider-specific
 * conversion (e.g. Claude `system:` extraction). The `fullMessages` snapshot
 * captured by `startInspection` is the pre-conversion input; this snapshot is
 * the post-conversion output.
 *
 * @param {import('express').Request} request
 * @param {string|URL} endpoint Full URL that the server is about to hit
 * @param {string} apiKey Plaintext API key (never stored)
 * @param {object} [wirePayload] Optional outbound request body to snapshot.
 */
export function attachInspectionEndpoint(request, endpoint, apiKey, wirePayload) {
    const entry = findEntry(request);
    if (!entry) return;
    entry.endpoint = sanitizeEndpointUrl(endpoint);
    entry.apiKeyFingerprint = fingerprintApiKey(apiKey);
    if (wirePayload && typeof wirePayload === 'object') {
        try {
            entry.wireRequest = typeof structuredClone === 'function'
                ? structuredClone(wirePayload)
                : JSON.parse(JSON.stringify(wirePayload));
        } catch {
            try { entry.wireRequest = JSON.parse(JSON.stringify(wirePayload)); } catch { /* skip */ }
        }
    }
    // wireRequest can dwarf the rest of the record (full bodies, inlined
    // images) — re-estimate and evict before returning.
    inspectorLedger.retouch(entry);
    enforceByteBudget();
}

/**
 * Remove credentials from a proxy URL. Inspector entries are user-exportable
 * (JSON export, diagnostics bundles), so a proxy password must never reach the
 * stored payload.
 * @param {string} raw Proxy URL
 * @returns {string} URL without userinfo, or '' when it cannot be parsed
 */
function maskProxyUrl(raw) {
    try {
        const parsed = new URL(raw);
        parsed.username = '';
        parsed.password = '';
        return parsed.toString().replace(/\/$/, '');
    } catch {
        return '';
    }
}

/**
 * Describe the proxy a generation request is routed through.
 * @param {import('express').Request} request
 * @returns {{ scope: 'profile' | 'global' | 'direct', url: string }}
 */
export function describeNetworkProxy(request) {
    const profileProxyUrl = String(request?.body?.network_proxy || '').trim();
    if (profileProxyUrl) {
        return { scope: 'profile', url: maskProxyUrl(profileProxyUrl) };
    }

    const globalProxy = getGlobalProxyInfo();
    if (globalProxy.enabled && globalProxy.url) {
        return { scope: 'global', url: maskProxyUrl(globalProxy.url) };
    }

    return { scope: 'direct', url: '' };
}

/**
 * Start tracking a generation request. Call at the top of /generate.
 * Attaches `request.__inspectorId` for later completion.
 * @param {import('express').Request} request
 */
export function startInspection(request) {
    const handle = String(request?.user?.profile?.handle || '');
    if (!handle) return;
    if (getRequestTransientSession(request)) return;

    const body = request.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];

    const entry = {
        id: randomUUID(),
        type: 'chat',
        handle,
        timestamp: Date.now(),
        // Set by the runner before dispatch starts. The inspector abort
        // endpoint uses it to cancel the generation job (and its upstream
        // fetch) without accepting an arbitrary job id from the client.
        generationJobId: String(request?.lukerGenerationJob?.id || ''),
        source: String(body.chat_completion_source || body.api_type || 'unknown'),
        model: String(body.model || ''),
        stream: Boolean(body.stream),
        endpoint: '',
        apiKeyFingerprint: '',
        // Which proxy carries this request. Credentials are stripped at
        // capture time because the entry is exported and bundled verbatim.
        networkProxy: describeNetworkProxy(request),
        messageCount: messages.length,
        messageRoles: messages.map(m => String(m?.role || '?')),
        promptCharLength: messages.reduce((sum, m) => {
            const content = m?.content;
            if (typeof content === 'string') return sum + content.length;
            if (Array.isArray(content)) {
                return sum + content.reduce((s, part) => {
                    if (typeof part === 'string') return s + part.length;
                    if (part?.text) return s + String(part.text).length;
                    if (part?.type === 'image_url' || part?.type === 'image') return s + 100;
                    return s;
                }, 0);
            }
            return sum;
        }, 0),
        maxTokens: body.max_tokens ?? body.max_completion_tokens ?? null,
        // Deep-clone snapshot of the messages array as the client posted it.
        // Downstream send paths mutate request.body.messages in place to fit
        // the upstream provider's schema, so a live reference would expose
        // post-mutation intermediate state at export time.
        fullMessages: (() => {
            try {
                return typeof structuredClone === 'function'
                    ? structuredClone(messages)
                    : JSON.parse(JSON.stringify(messages));
            } catch {
                return JSON.parse(JSON.stringify(messages));
            }
        })(),
        responseText: '',
        responseParts: [],
        usage: {
            prompt_tokens: null,
            completion_tokens: null,
            total_tokens: null,
            cache_read: null,
            cache_write: null,
        },
        durationMs: null,
        status: 'running',
        httpStatus: null,
        error: '',
        parseError: null,
        rawDiagnostic: null,
        plainTextFunctionCall: request?.__lukerPlainTextMeta
            ? {
                enabled: true,
                mode: String(request.__lukerPlainTextMeta.mode || 'prompt_xml'),
                triggerSignal: String(request.__lukerPlainTextMeta.triggerSignal || ''),
                tools: Array.isArray(request.__lukerPlainTextMeta.tools) ? request.__lukerPlainTextMeta.tools : [],
                toolChoice: request.__lukerPlainTextMeta.toolChoice ?? 'auto',
                status: 'pending',
                failureReason: null,
                error: '',
                calls: [],
                displayText: '',
                rawResponseText: '',
                callRegionRaw: '',
                callSpan: null,
                attempt: Number.isInteger(request.__lukerPlainTextMeta.attempt) ? request.__lukerPlainTextMeta.attempt : 1,
                maxAttempts: Number.isInteger(request.__lukerPlainTextMeta.maxAttempts) ? request.__lukerPlainTextMeta.maxAttempts : 1,
                retryOf: request.__lukerPlainTextMeta.retryOf || null,
                originalError: String(request.__lukerPlainTextMeta.originalError || ''),
                finalStatus: null,
            }
            : null,
        retryOf: request?.__inspectorRetryOf || null,
        attempt: Number.isInteger(request?.__inspectorAttempt) ? request.__inspectorAttempt : 1,
        retryEntryIds: [],
        originalError: String(request?.__inspectorOriginalError || ''),
        // Normalized OpenAI-shape stop reason (stop/length/tool_calls/content_filter/…).
        // For native providers we translate their vocabulary into OAI's on capture so
        // list-scan filters and cross-provider stats stay comparable. `null` = never
        // received (still running / failed before response / provider silent).
        finishReason: null,
        // Provider-original stop-reason string, verbatim, before any normalization.
        // Claude=`stop_reason` (end_turn/max_tokens/tool_use/…), Gemini=`finishReason`
        // (STOP/MAX_TOKENS/SAFETY/…), OpenRouter=`native_finish_reason` (upstream
        // provider's string when OR proxies e.g. Groq/Together). Kept separate from
        // `finishReason` because the raw value carries diagnostic info the OAI
        // vocabulary erases (e.g. Gemini SAFETY → OAI `content_filter` loses which
        // safety category tripped; Claude `pause_turn` has no OAI equivalent).
        nativeFinishReason: null,
    };

    pushEntry(handle, entry);
    request.__inspectorId = entry.id;
    request.__inspectorTimestamp = entry.timestamp;
}

/**
 * Find the entry for a request.
 * @param {import('express').Request} request
 * @returns {object|null}
 */
export function findEntry(request) {
    const handle = String(request?.user?.profile?.handle || '');
    const id = request?.__inspectorId;
    if (!handle || !id) return null;
    const buf = buffers.get(handle);
    if (!buf) return null;
    for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].id === id) return buf[i];
    }
    return null;
}

/**
 * Abort signal for the current inspector entry, if the request type uses a
 * per-entry controller (embedding / rerank). Chat, text and image requests
 * return null — they are aborted through their generation job instead.
 *
 * @param {import('express').Request} request
 * @returns {AbortSignal|null}
 */
export function getInspectionAbortSignal(request) {
    const signal = request?.__inspectorAbortController?.signal;
    return signal || null;
}

/**
 * Mark a running entry as aborted. Keeps the original start timestamp so the
 * duration reflects the time the request actually ran before the abort.
 *
 * @param {object} entry
 * @param {string} reason
 * @returns {boolean}
 */
function markEntryAborted(entry, reason) {
    if (!entry || entry.status !== 'running') return false;
    entry.status = 'aborted';
    entry.durationMs = Date.now() - entry.timestamp;
    entry.error = String(reason || '');
    if (entry.plainTextFunctionCall?.enabled
        && (entry.plainTextFunctionCall.status === 'pending' || entry.plainTextFunctionCall.status === 'parsing')) {
        entry.plainTextFunctionCall.status = 'aborted';
        entry.plainTextFunctionCall.failureReason = 'aborted';
        entry.plainTextFunctionCall.error = entry.error;
        entry.plainTextFunctionCall.finalStatus = 'aborted';
    }
    return true;
}

/**
 * Abort the inspector entry that belongs to a generation job. Called by the
 * generation-control abort endpoint after it has verified job ownership.
 *
 * @param {string} handle
 * @param {string} jobId
 * @param {string} [reason]
 * @returns {object|null} the aborted entry, or null when no running entry matches
 */
export function abortInspectionByJobId(handle, jobId, reason = 'Aborted from request inspector') {
    const h = String(handle || '');
    const id = String(jobId || '');
    if (!h || !id) return null;
    const buf = buffers.get(h);
    if (!buf) return null;
    for (let i = buf.length - 1; i >= 0; i--) {
        const entry = buf[i];
        if (entry.generationJobId === id && markEntryAborted(entry, reason)) {
            return entry;
        }
    }
    return null;
}

/**
 * Abort a non-job inspector entry (embedding / rerank) through its own
 * AbortController. The pending HTTP request then fails with an AbortError,
 * which the route translates into a 499 response.
 *
 * @param {string} handle
 * @param {string} entryId
 * @param {string} [reason]
 * @returns {object|null} the aborted entry, or null when not abortable
 */
export function abortInspectionEntry(handle, entryId, reason = 'Aborted from request inspector') {
    const h = String(handle || '');
    const id = String(entryId || '');
    if (!h || !id) return null;
    const buf = buffers.get(h);
    if (!buf) return null;
    const entry = buf.find(e => e.id === id);
    if (!entry || entry.status !== 'running') return null;
    const controller = inspectionAbortControllers.get(id);
    if (!controller) return null;
    if (!markEntryAborted(entry, reason)) return null;
    inspectionAbortControllers.delete(id);
    try { controller.abort(reason); } catch { /* already aborted */ }
    return entry;
}

/**
 * How the inspector UI should abort this entry:
 *   - 'job'     — cancel the generation job (chat / text / image)
 *   - 'request' — abort the entry's own controller (embedding / rerank)
 *   - ''        — not abortable
 *
 * @param {object} entry
 * @returns {'job'|'request'|''}
 */
export function getAbortKind(entry) {
    if (!entry || entry.status !== 'running') return '';
    if (entry.generationJobId) return 'job';
    if (inspectionAbortControllers.has(entry.id)) return 'request';
    return '';
}

// ---- Shared protocol parser integration ----

/**
 * SSE events come in two shapes depending on the caller:
 *   - inspector stream tap pushes plain strings (the SSE data line)
 *   - luker-generation jobs push { seq, data, ts } objects
 * Normalize to the string data line while preserving payload whitespace.
 */
function normalizeEvent(e) {
    let raw = '';
    if (typeof e === 'string') raw = e;
    else if (e && typeof e.data === 'string') raw = e.data;
    if (!raw) return '';
    if (raw.startsWith('data:')) {
        raw = raw.startsWith('data: ') ? raw.slice(6) : raw.slice(5);
    }
    return raw;
}

function applyParsedTurnToEntry(entry, turn) {
    Object.assign(entry.usage, toInspectorUsage(turn.usage));
    entry.responseText = turn.text;
    entry.responseParts = turn.parts;
    entry.finishReason = turn.finishReason;
    entry.nativeFinishReason = turn.nativeFinishReason;
}

function applyParseFailureToEntry(entry, err, rawDiagnostic) {
    entry.status = 'error';
    entry.error = err.message;
    entry.parseError = err instanceof ProtocolParseError
        ? err.toDiagnostic()
        : { protocol: String(entry.source || 'unknown'), stage: 'payload', location: 'root', message: String(err?.message || err) };
    entry.rawDiagnostic = rawDiagnostic;
    entry.responseText = '';
    entry.responseParts = [];
    entry.finishReason = null;
    entry.nativeFinishReason = null;
    if (entry.plainTextFunctionCall?.enabled
        && (entry.plainTextFunctionCall.status === 'pending' || entry.plainTextFunctionCall.status === 'parsing')) {
        entry.plainTextFunctionCall.status = 'parse_failed';
        entry.plainTextFunctionCall.failureReason = 'syntax';
        entry.plainTextFunctionCall.error = entry.error;
        entry.plainTextFunctionCall.finalStatus = 'parse_failed';
    }
}

function extractLegacyTextGenText(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.results?.[0]?.text === 'string') return payload.results[0].text;
    if (typeof payload.output === 'string') return payload.output;
    if (typeof payload.choices?.[0]?.text === 'string') return payload.choices[0].text;
    if (typeof payload.response === 'string') return payload.response;
    if (typeof payload.text === 'string') return payload.text;
    return '';
}

/**
 * Complete an inspection from a non-streaming response using the shared
 * strict protocol parser. Never switches protocols on mismatch and never
 * renders invalid responses as valid output.
 * @param {import('express').Request} request
 * @param {object} payload
 * @param {object} [rawApiResponse]
 */
export function completeInspection(request, payload, rawApiResponse) {
    const entry = findEntry(request);
    if (!entry) return;
    // An inspector abort may race the dispatch's completion callback. The
    // abort wins: never overwrite an explicit user-visible abort with success.
    if (entry.status === 'aborted') return;

    entry.status = 'success';
    entry.durationMs = Date.now() - entry.timestamp;
    entry.httpStatus = 200;
    entry.parseError = null;
    entry.rawDiagnostic = null;

    const protocol = resolveWireProtocol(entry.source);
    if (!protocol) {
        if (payload && typeof payload === 'object' && payload.error != null) {
            entry.status = 'error';
            entry.error = extractProviderErrorMessage(payload.error);
        } else {
            const text = extractLegacyTextGenText(rawApiResponse ?? payload);
            entry.responseText = text;
            entry.responseParts = text ? [{ type: 'text', text }] : [];
        }
        inspectorLedger.retouch(entry);
        enforceByteBudget();
        return;
    }

    const wirePayload = (rawApiResponse !== undefined && rawApiResponse !== null) ? rawApiResponse : payload;

    try {
        const turn = parseProtocolResponse(protocol, wirePayload);
        applyParsedTurnToEntry(entry, turn);
        // Preserve upstream provider-error classification if a caller still
        // passes an explicit error envelope alongside rawApiResponse.
        if (payload && typeof payload === 'object' && payload.error != null) {
            entry.status = 'error';
            entry.error = extractProviderErrorMessage(payload.error);
        }
    } catch (err) {
        if (err instanceof ProtocolParseError && err.stage === 'provider_error') {
            entry.status = 'error';
            entry.error = err.message;
            if (entry.plainTextFunctionCall?.enabled
                && (entry.plainTextFunctionCall.status === 'pending' || entry.plainTextFunctionCall.status === 'parsing')) {
                entry.plainTextFunctionCall.status = 'network_error';
                entry.plainTextFunctionCall.failureReason = 'network';
                entry.plainTextFunctionCall.error = entry.error;
                entry.plainTextFunctionCall.finalStatus = 'network_error';
            }
        } else {
            applyParseFailureToEntry(entry, err, {
                kind: 'non-streaming',
                protocol,
                payload: wirePayload,
            });
        }
    }

    inspectorLedger.retouch(entry);
    enforceByteBudget();
}

/**
 * Complete an inspection from streaming SSE events using the shared strict
 * protocol parser. Invalid JSON, cross-protocol mismatches, broken tool
 * correlation, and premature EOF fail with structured parseError + rawDiagnostic.
 *
 * @param {import('express').Request} request
 * @param {Array<string|{data:string,event?:string}>} events
 * @param {string} [_accumulatedText] Deprecated legacy parameter; text is derived solely from the shared parser
 */
export function completeInspectionFromStream(request, events, _accumulatedText) {
    const entry = findEntry(request);
    if (!entry) return;
    if (entry.status === 'aborted') return;

    entry.status = 'success';
    entry.durationMs = Date.now() - entry.timestamp;
    entry.httpStatus = 200;
    entry.parseError = null;
    entry.rawDiagnostic = null;

    const protocol = resolveWireProtocol(entry.source);
    if (!protocol) {
        const text = typeof _accumulatedText === 'string' ? _accumulatedText : '';
        entry.responseText = text;
        entry.responseParts = text ? [{ type: 'text', text }] : [];
        inspectorLedger.retouch(entry);
        enforceByteBudget();
        return;
    }

    const normalizedEvents = Array.isArray(events) ? events : [];
    const parser = createProtocolStreamParser(protocol);

    try {
        for (const ev of normalizedEvents) {
            const raw = normalizeEvent(ev);
            if (!raw) continue;
            const eventName = (ev && typeof ev === 'object' && typeof ev.event === 'string') ? ev.event : '';
            parser.feedFrame(raw, eventName);
        }
        const turn = parser.finish();
        applyParsedTurnToEntry(entry, turn);
    } catch (err) {
        if (err instanceof ProtocolParseError && err.stage === 'eof') {
            const partial = parser.getSnapshot();
            if (!isParsedTurnEmpty(partial)) {
                applyParsedTurnToEntry(entry, partial);
            } else {
                applyParseFailureToEntry(entry, err, {
                    kind: 'stream',
                    protocol,
                    events: normalizedEvents.map(normalizeEvent),
                });
            }
        } else if (err instanceof ProtocolParseError && err.stage === 'provider_error') {
            const partial = parser.getSnapshot();
            applyParsedTurnToEntry(entry, partial);
            entry.status = 'error';
            entry.error = err.message;
            if (entry.plainTextFunctionCall?.enabled
                && (entry.plainTextFunctionCall.status === 'pending' || entry.plainTextFunctionCall.status === 'parsing')) {
                entry.plainTextFunctionCall.status = 'network_error';
                entry.plainTextFunctionCall.failureReason = 'network';
                entry.plainTextFunctionCall.error = entry.error;
                entry.plainTextFunctionCall.finalStatus = 'network_error';
            }
        } else {
            applyParseFailureToEntry(entry, err, {
                kind: 'stream',
                protocol,
                events: normalizedEvents.map(normalizeEvent),
            });
        }
    }

    inspectorLedger.retouch(entry);
    enforceByteBudget();
}

/**
 * Mark an inspection as failed with a structured parse error and labeled raw
 * diagnostic payload (e.g. non-JSON body returned on HTTP 200).
 * @param {import('express').Request} request
 * @param {Error} err
 * @param {*} rawDiagnostic
 * @param {number} [httpStatus]
 */
export function failInspectionParseError(request, err, rawDiagnostic, httpStatus = 200) {
    const entry = findEntry(request);
    if (!entry) return;
    if (entry.status === 'aborted') return;

    entry.durationMs = Date.now() - entry.timestamp;
    entry.httpStatus = httpStatus;
    applyParseFailureToEntry(entry, err, rawDiagnostic);
    inspectorLedger.retouch(entry);
    enforceByteBudget();
}

/**
 * Update live plain-text function-call metadata on a running inspection entry
 * (e.g. transitioning into `parsing` while streaming or recording abort/network
 * failure reasons).
 * @param {import('express').Request} request
 * @param {object} patch
 */
export function updateInspectionPlainTextState(request, patch) {
    const entry = findEntry(request);
    if (!entry || !patch || typeof patch !== 'object') return;
    if (!entry.plainTextFunctionCall) {
        entry.plainTextFunctionCall = { enabled: true };
    }
    Object.assign(entry.plainTextFunctionCall, patch);
    inspectorLedger.retouch(entry);
}

/**
 * Apply the authoritative backend plain-text function-call parse result onto
 * an inspection entry, preserving preceding thinking/text parts in exact order
 * and replacing only the call region with a toggleable `plain_text_tool_calls`
 * part.
 * @param {import('express').Request} request
 * @param {{ turn: object, ptResult: object, config: object, attempt?: number, maxAttempts?: number, retryOf?: string|null, originalError?: string }} params
 */
export function applyInspectionPlainTextResult(request, {
    turn,
    ptResult,
    config,
    responseParts = null,
    attempt = 1,
    maxAttempts = 1,
    retryOf = null,
    originalError = '',
} = {}) {
    const entry = findEntry(request);
    if (!entry || !ptResult) return;
    if (entry.status === 'aborted') return;

    const existing = entry.plainTextFunctionCall || {};
    entry.plainTextFunctionCall = {
        ...existing,
        enabled: true,
        mode: String(config?.mode || existing.mode || 'prompt_xml'),
        triggerSignal: String(config?.triggerSignal || existing.triggerSignal || ''),
        tools: Array.isArray(config?.tools) ? config.tools : (existing.tools || []),
        toolChoice: config?.toolChoice ?? existing.toolChoice ?? 'auto',
        status: ptResult.status,
        failureReason: ptResult.failureReason || null,
        error: String(ptResult.error || ''),
        calls: Array.isArray(ptResult.calls) ? ptResult.calls : [],
        displayText: String(ptResult.displayText ?? ''),
        rawResponseText: String(ptResult.rawResponseText ?? turn?.text ?? ''),
        callRegionRaw: String(ptResult.callRegionRaw ?? ''),
        callSpan: ptResult.callSpan ? { ...ptResult.callSpan } : null,
        attempt,
        maxAttempts,
        retryOf: retryOf || entry.retryOf || null,
        originalError: String(originalError || entry.originalError || ''),
        finalStatus: ptResult.status,
    };

    if (Array.isArray(responseParts)) {
        entry.responseParts = responseParts;
    }

    if (ptResult.status === 'parsed') {
        entry.responseText = ptResult.displayText ?? '';
        entry.finishReason = 'tool_calls';
    } else if (ptResult.status === 'parse_failed' || ptResult.status === 'network_error') {
        entry.status = 'error';
        entry.error = ptResult.error || 'Plain-text function call parse failed.';
        entry.responseText = ptResult.displayText ?? '';
    }

    inspectorLedger.retouch(entry);
    enforceByteBudget();
}

/**
 * Link a retry inspection entry back to its original failed attempt so the
 * Request Inspector UI shows the complete retry chain and final status.
 * @param {string} handle
 * @param {string} originalEntryId
 * @param {string} retryEntryId
 * @param {string} finalStatus
 */
export function linkInspectionRetry(handle, originalEntryId, retryEntryId, finalStatus) {
    const h = String(handle || '');
    if (!h || !originalEntryId || !retryEntryId) return;
    const buf = buffers.get(h);
    if (!buf) return;
    const original = buf.find(e => e.id === originalEntryId);
    if (!original) return;
    if (!Array.isArray(original.retryEntryIds)) {
        original.retryEntryIds = [];
    }
    if (!original.retryEntryIds.includes(retryEntryId)) {
        original.retryEntryIds.push(retryEntryId);
    }
    if (original.plainTextFunctionCall) {
        original.plainTextFunctionCall.finalStatus = finalStatus || original.plainTextFunctionCall.finalStatus;
    }
    inspectorLedger.retouch(original);
}

/**
 * Mark an inspection as failed.
 * @param {import('express').Request} request
 * @param {string} errorMessage
 * @param {number} [httpStatus]
 */
export function failInspection(request, errorMessage, httpStatus) {
    const entry = findEntry(request);
    if (!entry) return;
    if (entry.status === 'aborted') return;

    entry.status = 'error';
    entry.durationMs = Date.now() - entry.timestamp;
    entry.httpStatus = httpStatus ?? null;
    entry.error = String(errorMessage || 'Unknown error');
    if (entry.plainTextFunctionCall?.enabled
        && (entry.plainTextFunctionCall.status === 'pending' || entry.plainTextFunctionCall.status === 'parsing')) {
        entry.plainTextFunctionCall.status = 'network_error';
        entry.plainTextFunctionCall.failureReason = 'network';
        entry.plainTextFunctionCall.error = entry.error;
        entry.plainTextFunctionCall.finalStatus = 'network_error';
    }

    // error strings are bounded but can still carry a whole provider body.
    inspectorLedger.retouch(entry);
    enforceByteBudget();
}

/**
 * Mark an inspection as aborted.
 * @param {import('express').Request} request
 */
export function abortInspection(request) {
    const entry = findEntry(request);
    if (!entry) return;
    markEntryAborted(entry, 'Aborted');
}

// ---- ComfyUI Workflow Parsing ----

/**
 * Best-effort extraction of generation parameters from a ComfyUI workflow JSON.
 * @param {string|object} promptData - The workflow (body.prompt is a JSON string)
 * @returns {object}
 */
function parseComfyWorkflow(promptData) {
    const result = { prompt: '', negativePrompt: '', model: '', width: null, height: null, steps: null, cfgScale: null, seed: null, sampler: null };
    let workflow;
    try {
        workflow = typeof promptData === 'string' ? JSON.parse(promptData) : promptData;
    } catch {
        return result;
    }
    if (!workflow || typeof workflow !== 'object') return result;

    // The client posts `body.prompt` verbatim to ComfyUI's /prompt route, so
    // the node graph is nested under `prompt` (with an optional client_id
    // sibling). Accept a bare node graph as well.
    if (workflow.prompt && typeof workflow.prompt === 'object' && !Array.isArray(workflow.prompt)) {
        workflow = workflow.prompt;
    }

    const textByNodeId = new Map();
    let samplerInputs = null;

    for (const [nodeId, node] of Object.entries(workflow)) {
        const cls = node?.class_type;
        const inputs = node?.inputs;
        if (!cls || !inputs) continue;

        if (cls === 'KSampler' || cls === 'KSamplerAdvanced') {
            result.steps = inputs.steps ?? result.steps;
            result.cfgScale = inputs.cfg ?? result.cfgScale;
            result.seed = inputs.seed ?? inputs.noise_seed ?? result.seed;
            result.sampler = inputs.sampler_name ?? result.sampler;
            if (!samplerInputs && inputs.positive && inputs.negative) samplerInputs = inputs;
        } else if (cls === 'CLIPTextEncode' || cls === 'CLIPTextEncodeSDXL') {
            const text = typeof inputs.text === 'string'
                ? inputs.text
                : (typeof inputs.text_g === 'string' ? inputs.text_g : '');
            if (text) textByNodeId.set(String(nodeId), text);
        } else if (cls === 'CheckpointLoaderSimple' || cls === 'CheckpointLoader') {
            result.model = inputs.ckpt_name ?? result.model;
        } else if (cls === 'EmptyLatentImage') {
            result.width = inputs.width ?? result.width;
            result.height = inputs.height ?? result.height;
        }
    }

    const linkedText = (link) => {
        if (!Array.isArray(link)) return '';
        return textByNodeId.get(String(link[0])) ?? '';
    };

    if (samplerInputs) {
        result.prompt = linkedText(samplerInputs.positive);
        result.negativePrompt = linkedText(samplerInputs.negative);
    }

    // Fallback for workflows whose sampler does not link straight to text
    // nodes: first remaining text is the prompt, a shorter one is negative.
    if (!result.prompt || !result.negativePrompt) {
        const remaining = [...textByNodeId.values()].filter(text => text !== result.prompt);
        if (!result.prompt) result.prompt = remaining.shift() ?? '';
        if (!result.negativePrompt && remaining.length) {
            result.negativePrompt = remaining.find(text => text.length < result.prompt.length) ?? remaining[0];
        }
    }

    return result;
}

// ---- Image Inspection ----

/**
 * Parse a `WxH` size string into numeric dimensions.
 * @param {*} size
 * @returns {{width: number, height: number}|null}
 */
function parseSizeDimensions(size) {
    if (typeof size !== 'string') return null;
    const [width, height] = size.toLowerCase().split('x').map(Number);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
}

/**
 * Extract normalized image generation metadata from various backend request bodies.
 * @param {string} source - Backend identifier
 * @param {object} body - request.body
 * @returns {object} Normalized meta
 */
export function extractImageMeta(source, body) {
    const meta = {
        source,
        prompt: '',
        negativePrompt: '',
        model: '',
        width: null,
        height: null,
        steps: null,
        cfgScale: null,
        seed: null,
        sampler: null,
    };

    switch (source) {
        case 'comfyui':
        case 'comfyui_runpod': {
            const parsed = parseComfyWorkflow(body.prompt);
            Object.assign(meta, parsed);
            break;
        }
        case 'sd_webui':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.model = body.override_settings?.sd_model_checkpoint || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.cfg_scale ?? null;
            meta.seed = body.seed ?? null;
            meta.sampler = body.sampler_name || null;
            break;
        case 'sd_cpp':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.cfg_scale ?? null;
            meta.seed = body.seed ?? null;
            meta.sampler = body.sampler_name || null;
            break;
        case 'drawthings':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.cfg_scale ?? null;
            meta.seed = body.seed ?? null;
            break;
        case 'together':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.seed = body.seed ?? null;
            break;
        case 'pollinations':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.seed = body.seed ?? null;
            break;
        case 'stability':
            meta.prompt = body.payload?.prompt || '';
            meta.negativePrompt = body.payload?.negative_prompt || '';
            meta.model = body.model || '';
            meta.seed = body.payload?.seed ?? null;
            break;
        case 'electronhub': {
            meta.prompt = body.prompt || '';
            meta.model = body.model || '';
            const dims = parseSizeDimensions(body.size);
            if (dims) { meta.width = dims.width; meta.height = dims.height; }
            break;
        }
        case 'chutes':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.guidance_scale ?? body.guidance ?? null;
            meta.seed = body.seed ?? null;
            break;
        case 'bfl':
            meta.prompt = body.prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.guidance ?? null;
            meta.seed = body.seed ?? null;
            break;
        case 'falai':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.guidance ?? null;
            meta.seed = body.seed ?? null;
            break;
        case 'nanogpt':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.num_steps ?? null;
            meta.cfgScale = body.scale ?? null;
            break;
        case 'aimlapi': {
            meta.prompt = body.prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.guidance ?? null;
            meta.seed = body.seed ?? null;
            const dims = parseSizeDimensions(body.size);
            if (dims) { meta.width = dims.width; meta.height = dims.height; }
            break;
        }
        case 'workersai':
            meta.prompt = body.prompt || '';
            meta.negativePrompt = body.negative_prompt || '';
            meta.model = body.model || '';
            meta.width = body.width ?? null;
            meta.height = body.height ?? null;
            meta.steps = body.steps ?? null;
            meta.cfgScale = body.scale ?? null;
            meta.seed = body.seed ?? null;
            break;
        case 'zai': {
            meta.prompt = body.prompt || '';
            meta.model = body.model || '';
            const dims = parseSizeDimensions(body.size);
            if (dims) { meta.width = dims.width; meta.height = dims.height; }
            break;
        }
        default:
            // huggingface, xai, and any future backends
            meta.prompt = body.prompt || body.inputs || '';
            meta.model = body.model || '';
            break;
    }

    return meta;
}

/**
 * Mime type for an image file extension captured from the upstream output.
 * @param {string|null} format
 * @returns {string}
 */
function imageMimeFromFormat(format) {
    const f = String(format || '').toLowerCase();
    if (!f) return '';
    return f === 'jpg' ? 'image/jpeg' : `image/${f}`;
}

/**
 * Start tracking an image generation request.
 * @param {import('express').Request} request
 * @param {object} meta - from extractImageMeta()
 */
export function startImageInspection(request, meta) {
    const handle = String(request?.user?.profile?.handle || '');
    if (!handle) return;
    if (getRequestTransientSession(request)) return;

    const entry = {
        id: randomUUID(),
        type: 'image',
        handle,
        timestamp: Date.now(),
        generationJobId: String(request?.lukerGenerationJob?.id || ''),
        source: String(meta.source || 'unknown'),
        prompt: String(meta.prompt || ''),
        negativePrompt: String(meta.negativePrompt || ''),
        model: String(meta.model || ''),
        endpoint: '',
        apiKeyFingerprint: '',
        width: meta.width ?? null,
        height: meta.height ?? null,
        steps: meta.steps ?? null,
        cfgScale: meta.cfgScale ?? null,
        seed: meta.seed ?? null,
        sampler: meta.sampler || null,
        durationMs: null,
        status: 'running',
        httpStatus: null,
        error: '',
        outputFormat: null,
        outputSizeBytes: null,
        outputImage: null,
    };

    pushEntry(handle, entry);
    request.__inspectorId = entry.id;
    request.__inspectorTimestamp = entry.timestamp;
}

/**
 * Complete an image inspection with success.
 * @param {import('express').Request} request
 * @param {object} [resultMeta] - { format, sizeBytes, data, mime }
 */
export function completeImageInspection(request, resultMeta) {
    const entry = findEntry(request);
    if (!entry) return;
    if (entry.status === 'aborted') return;

    entry.status = 'success';
    entry.durationMs = Date.now() - entry.timestamp;
    entry.httpStatus = 200;
    if (resultMeta) {
        const data = typeof resultMeta.data === 'string' ? resultMeta.data : '';
        entry.outputFormat = resultMeta.format || null;
        entry.outputSizeBytes = resultMeta.sizeBytes
            ?? (data ? Buffer.byteLength(data, 'base64') : null);
        if (data) {
            entry.outputImage = {
                type: 'image',
                mime: String(resultMeta.mime || imageMimeFromFormat(entry.outputFormat)),
                data,
            };
        }
    }

    // The generated image can be several megabytes — re-estimate and evict
    // before returning.
    inspectorLedger.retouch(entry);
    enforceByteBudget();
}

/**
 * Mark an image inspection as failed.
 * @param {import('express').Request} request
 * @param {string} errorMessage
 * @param {number} [httpStatus]
 */
export function failImageInspection(request, errorMessage, httpStatus) {
    const entry = findEntry(request);
    if (!entry) return;
    if (entry.status === 'aborted') return;

    entry.status = 'error';
    entry.durationMs = Date.now() - entry.timestamp;
    entry.httpStatus = httpStatus ?? null;
    entry.error = String(errorMessage || 'Unknown error');
}

// ---- Embedding / Rerank Inspection ----

/**
 * Deep-clone a text list into per-item records suitable for `inputTexts`.
 * Inspector never truncates AI-facing content (matches how chat `fullMessages`
 * and `wireRequest` snapshots preserve the entire request verbatim), so this
 * intentionally keeps the full string. Ring-buffer growth is bounded by
 * `RING_BUFFER_SIZE` at the entry level — see the top of this file.
 *
 * @param {string[]} texts
 * @returns {{index:number, text:string}[]}
 */
function snapshotTexts(texts) {
    if (!Array.isArray(texts)) return [];
    return texts.map((t, i) => ({ index: i, text: String(t ?? '') }));
}

/**
 * Extract normalized embedding / rerank metadata from a vectors router body
 * or the kobold /embed body. `routeKind` disambiguates the body shape:
 *   - 'insert' / 'query' / 'query-multi' / 'rerank': /api/vector/* bodies
 *   - 'kobold-embed': /api/backends/kobold/embed body
 *
 * @param {string} routeKind
 * @param {object} body
 * @returns {object}
 */
export function extractEmbeddingMeta(routeKind, body = {}) {
    const meta = {
        routeKind,
        operation: routeKind === 'rerank' ? 'rerank' : 'embed',
        source: '',
        model: '',
        collectionId: null,
        collectionIds: null,
        inputCount: 0,
        inputCharTotal: 0,
        inputTexts: [],
        query: '',
        topK: null,
        threshold: null,
    };

    switch (routeKind) {
        case 'insert': {
            meta.source = String(body.source || 'unknown');
            meta.model = String(body.model || '');
            meta.collectionId = body.collectionId != null ? String(body.collectionId) : null;
            const items = Array.isArray(body.items) ? body.items : [];
            const texts = items.map(it => String(it?.text ?? ''));
            meta.inputCount = texts.length;
            meta.inputCharTotal = texts.reduce((s, t) => s + t.length, 0);
            meta.inputTexts = snapshotTexts(texts);
            break;
        }
        case 'query': {
            meta.source = String(body.source || 'unknown');
            meta.model = String(body.model || '');
            meta.collectionId = body.collectionId != null ? String(body.collectionId) : null;
            const searchText = String(body.searchText ?? '');
            meta.inputCount = 1;
            meta.inputCharTotal = searchText.length;
            meta.inputTexts = snapshotTexts([searchText]);
            meta.topK = Number(body.topK) || null;
            meta.threshold = Number(body.threshold) || 0;
            break;
        }
        case 'query-multi': {
            meta.source = String(body.source || 'unknown');
            meta.model = String(body.model || '');
            meta.collectionIds = Array.isArray(body.collectionIds)
                ? body.collectionIds.map(String)
                : null;
            const searchText = String(body.searchText ?? '');
            meta.inputCount = 1;
            meta.inputCharTotal = searchText.length;
            meta.inputTexts = snapshotTexts([searchText]);
            meta.topK = Number(body.topK) || null;
            meta.threshold = Number(body.threshold) || 0;
            break;
        }
        case 'rerank': {
            meta.source = String(body.source || 'unknown');
            meta.model = String(body.model || '');
            meta.query = String(body.query ?? '');
            const documents = Array.isArray(body.documents) ? body.documents : [];
            const docTexts = documents.map(d => (typeof d === 'string' ? d : String(d?.text ?? '')));
            meta.inputCount = docTexts.length;
            meta.inputCharTotal = docTexts.reduce((s, t) => s + t.length, 0);
            meta.inputTexts = snapshotTexts(docTexts);
            meta.topK = Number(body.topK) || null;
            break;
        }
        case 'kobold-embed': {
            meta.source = 'koboldcpp';
            meta.model = '';
            const items = Array.isArray(body.items) ? body.items.map(String) : [];
            meta.inputCount = items.length;
            meta.inputCharTotal = items.reduce((s, t) => s + t.length, 0);
            meta.inputTexts = snapshotTexts(items);
            break;
        }
        default:
            meta.source = String(body.source || 'unknown');
            meta.model = String(body.model || '');
            break;
    }

    return meta;
}

/**
 * Start tracking an embedding / rerank request. Attaches
 * `request.__inspectorId` so provider layers can call
 * `attachInspectionEndpoint` before their upstream `fetch`.
 *
 * @param {import('express').Request} request
 * @param {object} meta from extractEmbeddingMeta()
 */
export function startEmbeddingInspection(request, meta) {
    const handle = String(request?.user?.profile?.handle || '');
    if (!handle) return;
    if (getRequestTransientSession(request)) return;

    const entry = {
        id: randomUUID(),
        type: 'embedding',
        handle,
        timestamp: Date.now(),
        generationJobId: '',
        source: String(meta.source || 'unknown'),
        operation: meta.operation === 'rerank' ? 'rerank' : 'embed',
        routeKind: String(meta.routeKind || ''),
        model: String(meta.model || ''),
        endpoint: '',
        apiKeyFingerprint: '',
        collectionId: meta.collectionId ?? null,
        collectionIds: Array.isArray(meta.collectionIds) ? meta.collectionIds.slice() : null,
        inputCount: Number.isFinite(meta.inputCount) ? meta.inputCount : 0,
        inputCharTotal: Number.isFinite(meta.inputCharTotal) ? meta.inputCharTotal : 0,
        inputTexts: Array.isArray(meta.inputTexts) ? meta.inputTexts : [],
        query: String(meta.query || ''),
        topK: meta.topK ?? null,
        threshold: meta.threshold ?? null,
        wireRequest: null,
        durationMs: null,
        status: 'running',
        httpStatus: null,
        error: '',
        resultCount: null,
        vectorDim: null,
        hits: null,
    };

    pushEntry(handle, entry);
    const abortController = new AbortController();
    inspectionAbortControllers.set(entry.id, abortController);
    request.__inspectorAbortController = abortController;
    request.__inspectorId = entry.id;
    request.__inspectorTimestamp = entry.timestamp;
}

/**
 * Complete an embedding / rerank inspection with success.
 *
 * `resultMeta` fields (all optional):
 *   - `resultCount` — number of vectors / hits / reranked docs returned
 *   - `vectorDim`   — dimensionality of the first returned vector (embed only)
 *   - `hits`        — full list of returned hits (query / rerank);
 *                     [{hash, score, text}], never truncated
 *
 * @param {import('express').Request} request
 * @param {object} [resultMeta]
 */
export function completeEmbeddingInspection(request, resultMeta) {
    const entry = findEntry(request);
    if (!entry) return;
    if (entry.status === 'aborted') return;
    releaseInspectionAbortController(entry);

    entry.status = 'success';
    entry.durationMs = Date.now() - entry.timestamp;
    entry.httpStatus = 200;
    if (resultMeta) {
        if (Number.isFinite(resultMeta.resultCount)) entry.resultCount = resultMeta.resultCount;
        if (Number.isFinite(resultMeta.vectorDim)) entry.vectorDim = resultMeta.vectorDim;
        if (Array.isArray(resultMeta.hits)) entry.hits = resultMeta.hits;
    }
}

/**
 * Mark an embedding / rerank inspection as failed.
 * @param {import('express').Request} request
 * @param {string} errorMessage
 * @param {number} [httpStatus]
 */
export function failEmbeddingInspection(request, errorMessage, httpStatus) {
    const entry = findEntry(request);
    if (!entry) return;
    if (entry.status === 'aborted') return;
    releaseInspectionAbortController(entry);

    entry.status = 'error';
    entry.durationMs = Date.now() - entry.timestamp;
    entry.httpStatus = httpStatus ?? null;
    entry.error = String(errorMessage || 'Unknown error');
}

// ---- Express Router ----

export const router = express.Router();

// Transport bound for `/list` summary search snippets (up to 200 entries sent
// in one JSON response); full request/response bodies are served on `/:id`.
const INSPECTOR_LIST_SEARCH_SNIPPET_MAX_CHARS = 8192;

function buildSearchSnippet(entry) {
    if (entry.type === 'image') {
        return [entry.source, entry.model, entry.prompt, entry.negativePrompt, entry.error].filter(Boolean).join(' ');
    }
    if (entry.type === 'embedding') {
        const inputText = Array.isArray(entry.inputTexts)
            ? entry.inputTexts.map(s => s?.text || '').join(' ')
            : '';
        const hitsText = Array.isArray(entry.hits)
            ? entry.hits.map(h => String(h?.text ?? '')).join(' ')
            : '';
        const combined = [
            entry.source,
            entry.model,
            entry.operation,
            entry.collectionId,
            Array.isArray(entry.collectionIds) ? entry.collectionIds.join(' ') : '',
            entry.query,
            inputText,
            hitsText,
            entry.error,
        ].filter(Boolean).join(' ');
        return combined.length > INSPECTOR_LIST_SEARCH_SNIPPET_MAX_CHARS
            ? combined.slice(0, INSPECTOR_LIST_SEARCH_SNIPPET_MAX_CHARS)
            : combined;
    }
    const messageText = Array.isArray(entry.fullMessages)
        ? entry.fullMessages.map(m => {
            const c = m?.content;
            if (typeof c === 'string') return c;
            if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : (p?.text || ''))).join(' ');
            return '';
        }).join(' ')
        : '';
    const combined = [entry.source, entry.model, entry.error, messageText, entry.responseText || ''].filter(Boolean).join(' ');
    return combined.length > INSPECTOR_LIST_SEARCH_SNIPPET_MAX_CHARS
        ? combined.slice(0, INSPECTOR_LIST_SEARCH_SNIPPET_MAX_CHARS)
        : combined;
}

router.get('/list', (req, res) => {
    const handle = String(req?.user?.profile?.handle || '');
    if (!handle) return res.status(401).send({ error: 'Unauthorized' });

    const buf = getBuffer(handle);
    const summaries = buf.map(e => {
        const base = {
            id: e.id,
            type: e.type || 'chat',
            timestamp: e.timestamp,
            source: e.source,
            model: e.model,
            durationMs: e.durationMs,
            status: e.status,
            httpStatus: e.httpStatus,
            error: e.error,
            generationJobId: e.generationJobId || '',
            abortKind: getAbortKind(e),
            searchText: buildSearchSnippet(e),
        };
        if (e.type === 'image') {
            base.prompt = (e.prompt || '').slice(0, 80);
            base.width = e.width;
            base.height = e.height;
            base.outputFormat = e.outputFormat;
            base.outputSizeBytes = e.outputSizeBytes;
        } else if (e.type === 'embedding') {
            base.operation = e.operation;
            base.routeKind = e.routeKind;
            base.collectionId = e.collectionId;
            base.inputCount = e.inputCount;
            base.inputCharTotal = e.inputCharTotal;
            base.query = (e.query || '').slice(0, 80);
            base.topK = e.topK;
            base.resultCount = e.resultCount;
            base.vectorDim = e.vectorDim;
        } else {
            base.stream = e.stream;
            base.messageCount = e.messageCount;
            base.promptCharLength = e.promptCharLength;
            base.maxTokens = e.maxTokens;
            base.usage = e.usage;
            base.responseChars = (e.responseText || '').length;
            if (e.plainTextFunctionCall?.enabled) {
                base.plainTextFunctionCall = {
                    enabled: true,
                    status: e.plainTextFunctionCall.status,
                    callCount: Array.isArray(e.plainTextFunctionCall.calls) ? e.plainTextFunctionCall.calls.length : 0,
                    attempt: e.attempt || 1,
                    retryOf: e.retryOf || null,
                    finalStatus: e.plainTextFunctionCall.finalStatus || e.plainTextFunctionCall.status,
                };
            }
            if (e.parseError) {
                base.parseError = {
                    protocol: e.parseError.protocol,
                    stage: e.parseError.stage,
                    message: e.parseError.message,
                };
            }
        }
        return base;
    });

    summaries.reverse();
    return res.json(summaries);
});

router.post('/:id/abort', (req, res) => {
    const handle = String(req?.user?.profile?.handle || '');
    if (!handle) return res.status(401).send({ error: 'Unauthorized' });

    const buf = getBuffer(handle);
    const entry = buf.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).send({ error: 'Not found' });
    if (entry.status !== 'running') {
        return res.status(409).json({ aborted: false, error: 'not_running' });
    }
    if (entry.generationJobId) {
        // Job-backed entries are aborted through the generation-control
        // endpoint so the job's AbortController and WS terminal frame are
        // handled in one place.
        return res.status(409).json({ aborted: false, error: 'use_generation_abort' });
    }

    const aborted = abortInspectionEntry(handle, entry.id, 'Aborted from request inspector');
    if (!aborted) {
        return res.status(409).json({ aborted: false, error: 'not_abortable' });
    }
    return res.json({ aborted: true });
});

router.get('/:id', (req, res) => {
    const handle = String(req?.user?.profile?.handle || '');
    if (!handle) return res.status(401).send({ error: 'Unauthorized' });

    const buf = getBuffer(handle);
    const entry = buf.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).send({ error: 'Not found' });

    return res.json({ ...entry, abortKind: getAbortKind(entry) });
});

router.get('/:id/export', (req, res) => {
    const handle = String(req?.user?.profile?.handle || '');
    if (!handle) return res.status(401).send({ error: 'Unauthorized' });

    const buf = getBuffer(handle);
    const entry = buf.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).send({ error: 'Not found' });

    // Compute a compact per-message shape summary for exported diagnostic files.
    const exportMessages = Array.isArray(entry.fullMessages) ? entry.fullMessages : [];
    const messageSchemaAtExport = exportMessages.map(m => {
        const content = m?.content;
        const ctype = typeof content === 'string'
            ? 'string'
            : (Array.isArray(content) ? 'array' : (content === null ? 'null' : typeof content));
        let clen = 0;
        let chead = '';
        if (typeof content === 'string') {
            clen = content.length;
            chead = content.slice(0, 60);
        } else if (Array.isArray(content)) {
            clen = content.reduce((s, p) => {
                if (typeof p === 'string') return s + p.length;
                if (p && typeof p.text === 'string') return s + p.text.length;
                return s;
            }, 0);
            chead = content.map(p => (typeof p === 'string' ? p : (p?.text || `<${p?.type || '?'}>`))).join('|').slice(0, 60);
        } else if (content !== null && content !== undefined) {
            try { chead = JSON.stringify(content).slice(0, 60); clen = chead.length; } catch { /* ignore */ }
        }
        return {
            role: String(m?.role || ''),
            contentType: ctype,
            contentLen: clen,
            contentHead: chead,
            hasToolCalls: Array.isArray(m?.tool_calls) && m.tool_calls.length > 0,
            toolCallId: m?.tool_call_id ? String(m.tool_call_id).slice(0, 24) : '',
        };
    });

    const filename = `request-${entry.id.slice(0, 8)}-${entry.timestamp}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(JSON.stringify({ ...entry, messageSchemaAtExport }, null, 2));
});
