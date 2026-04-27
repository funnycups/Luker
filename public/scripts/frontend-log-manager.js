const FRONTEND_LOG_LIMIT = 3000;
const ALWAYS_VISIBLE_LEVELS = new Set(['error']);
const WRAPPED_CONSOLE_LEVELS = Object.freeze(['trace', 'debug', 'log', 'info', 'warn', 'error']);

const frontendLogBuffer = [];
const baseConsoleMethods = new Map();

let frontendLogNextId = 1;
let frontendLogCaptureInstalled = false;
let frontendConsoleDebugLoggingEnabled = false;
let frontendFetchNextId = 1;

const FRONTEND_FETCH_LOG_PREFIX = '[FrontendFetch]';
const FETCH_LOG_PATH_PREFIX = '/api/';
const FETCH_LOG_EXTRA_PATHS = new Set(['/csrf-token', '/version']);

function normalizeLevel(level) {
    const normalized = String(level || 'log').toLowerCase();
    return WRAPPED_CONSOLE_LEVELS.includes(normalized) ? normalized : 'log';
}

function shouldEmitConsoleLevel(level) {
    return ALWAYS_VISIBLE_LEVELS.has(level) || frontendConsoleDebugLoggingEnabled;
}

function serializeFrontendLogValue(value) {
    if (value instanceof Error) {
        return value.stack || `${value.name}: ${value.message}`;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (value === undefined) {
        return 'undefined';
    }

    if (value === null) {
        return 'null';
    }

    if (typeof value === 'function') {
        return `[Function ${value.name || 'anonymous'}]`;
    }

    try {
        return JSON.stringify(value, (_, nestedValue) => {
            if (nestedValue instanceof Error) {
                return nestedValue.stack || `${nestedValue.name}: ${nestedValue.message}`;
            }
            if (typeof nestedValue === 'bigint') {
                return `${nestedValue}n`;
            }
            return nestedValue;
        });
    } catch {
        return String(value);
    }
}

function getBaseConsoleMethod(level) {
    const normalizedLevel = normalizeLevel(level);

    if (!baseConsoleMethods.has(normalizedLevel)) {
        const current = globalThis.console?.[normalizedLevel];
        baseConsoleMethods.set(
            normalizedLevel,
            typeof current === 'function'
                ? current.bind(globalThis.console)
                : () => { },
        );
    }

    return baseConsoleMethods.get(normalizedLevel);
}

function truncateLogString(value, maxLength = 160) {
    const stringValue = String(value ?? '');
    return stringValue.length > maxLength
        ? `${stringValue.slice(0, maxLength - 1)}...`
        : stringValue;
}

function sanitizeHeaderName(name) {
    return String(name || '').trim().toLowerCase();
}

function normalizeHeaderEntries(headers) {
    if (!headers) {
        return [];
    }

    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return [...headers.entries()];
    }

    if (Array.isArray(headers)) {
        return headers.map(([name, value]) => [String(name || ''), String(value || '')]);
    }

    if (typeof headers === 'object') {
        return Object.entries(headers).map(([name, value]) => {
            const normalizedValue = Array.isArray(value) ? value.join(', ') : String(value || '');
            return [String(name || ''), normalizedValue];
        });
    }

    return [];
}

function summarizeHeadersForLog(headers, { response = false } = {}) {
    const headerEntries = normalizeHeaderEntries(headers);
    if (!headerEntries.length) {
        return undefined;
    }

    const summary = {};
    for (const [name, value] of headerEntries) {
        const normalizedName = sanitizeHeaderName(name);
        if (normalizedName === 'content-type' || normalizedName === 'accept') {
            summary[normalizedName.replace(/-/g, '_')] = truncateLogString(value, 120);
        } else if (normalizedName === 'x-csrf-token') {
            summary.x_csrf_token = 'present';
        } else if (response && normalizedName === 'x-luker-generation-id' && value) {
            summary.luker_generation_id = String(value);
        } else if (response && normalizedName === 'x-luker-server-persisted' && (value === '0' || value === '1')) {
            summary.luker_server_persisted = value === '1';
        }
    }

    return Object.keys(summary).length > 0 ? summary : undefined;
}

function summarizePersistTargetForLog(persistTarget) {
    if (!persistTarget || typeof persistTarget !== 'object') {
        return undefined;
    }

    if (persistTarget.kind === 'group') {
        return {
            kind: 'group',
            id: String(persistTarget.id || ''),
        };
    }

    if (persistTarget.kind === 'character') {
        return {
            kind: 'character',
            avatar_url: String(persistTarget.avatar_url || ''),
            file_name: String(persistTarget.file_name || ''),
        };
    }

    return {
        kind: String(persistTarget.kind || ''),
    };
}

function summarizeMessageRoles(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return undefined;
    }

    const roleCounts = {};
    for (const message of messages) {
        const role = typeof message?.role === 'string'
            ? message.role
            : message?.is_user
                ? 'user'
                : message?.is_system
                    ? 'system'
                    : 'assistant';
        roleCounts[role] = Number(roleCounts[role] || 0) + 1;
    }

    return roleCounts;
}

function collectLukerGenerationIdsForLog(value, ids = new Set(), depth = 0) {
    if (!value || depth > 6 || ids.size >= 8) {
        return ids;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectLukerGenerationIdsForLog(item, ids, depth + 1);
            if (ids.size >= 8) {
                break;
            }
        }
        return ids;
    }

    if (typeof value !== 'object') {
        return ids;
    }

    const directId = typeof value?.luker_generation_id === 'string' ? value.luker_generation_id.trim() : '';
    if (directId) {
        ids.add(directId);
    }

    for (const nestedValue of Object.values(value)) {
        collectLukerGenerationIdsForLog(nestedValue, ids, depth + 1);
        if (ids.size >= 8) {
            break;
        }
    }

    return ids;
}

function summarizeJsonBodyForLog(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return undefined;
    }

    const keys = Object.keys(payload);
    const summary = {
        kind: 'json',
        key_count: keys.length,
        keys: keys.slice(0, 16),
    };

    const scalarFields = [
        'type',
        'model',
        'api',
        'api_type',
        'chat_completion_source',
        'stream',
        'streaming',
        'n',
        'max_tokens',
        'reasoning_effort',
        'verbosity',
        'secret_id',
    ];

    for (const field of scalarFields) {
        if (!Object.hasOwn(payload, field)) {
            continue;
        }
        const value = payload[field];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            summary[field] = typeof value === 'string' ? truncateLogString(value, 120) : value;
        }
    }

    if (Array.isArray(payload.messages)) {
        summary.message_count = payload.messages.length;
        summary.message_roles = summarizeMessageRoles(payload.messages);
    }

    if (Array.isArray(payload.chat)) {
        summary.chat_message_count = payload.chat.length;
    }

    if (Array.isArray(payload.operations)) {
        summary.operation_count = payload.operations.length;
    }

    if (Array.isArray(payload.results)) {
        summary.result_count = payload.results.length;
    }

    if (Array.isArray(payload.messages) || Array.isArray(payload.chat) || Array.isArray(payload.operations)) {
        const generationIds = Array.from(collectLukerGenerationIdsForLog(payload));
        if (generationIds.length > 0) {
            summary.luker_generation_ids = generationIds;
        }
    }

    if (payload.luker_generation && typeof payload.luker_generation === 'object') {
        summary.luker_generation = {
            job_id: String(payload.luker_generation.job_id || ''),
            persist_target: summarizePersistTargetForLog(payload.luker_generation.persist_target),
        };
    }

    if (payload.persist_target && typeof payload.persist_target === 'object') {
        summary.persist_target = summarizePersistTargetForLog(payload.persist_target);
    }

    if (typeof payload.file_name === 'string') {
        summary.file_name = payload.file_name;
    }

    if (typeof payload.avatar_url === 'string') {
        summary.avatar_url = payload.avatar_url;
    }

    if (payload.id !== undefined && payload.id !== null) {
        summary.id = String(payload.id);
    }

    return summary;
}

function summarizeRequestBodyForLog(body) {
    if (body === undefined || body === null) {
        return undefined;
    }

    if (typeof body === 'string') {
        const trimmedBody = body.trim();
        if ((trimmedBody.startsWith('{') && trimmedBody.endsWith('}')) || (trimmedBody.startsWith('[') && trimmedBody.endsWith(']'))) {
            try {
                const parsed = JSON.parse(trimmedBody);
                return {
                    chars: body.length,
                    ...summarizeJsonBodyForLog(parsed),
                };
            } catch {
                // Fall through to plain string summary.
            }
        }

        return {
            kind: 'string',
            chars: body.length,
        };
    }

    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        const keys = [...new Set(body.keys())];
        return {
            kind: 'url_search_params',
            key_count: keys.length,
            keys: keys.slice(0, 16),
        };
    }

    if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const keys = [];
        const fileKeys = [];
        for (const [key, value] of body.entries()) {
            keys.push(String(key));
            if (typeof Blob !== 'undefined' && value instanceof Blob) {
                fileKeys.push(String(key));
            }
        }

        return {
            kind: 'form_data',
            key_count: keys.length,
            keys: [...new Set(keys)].slice(0, 16),
            file_keys: [...new Set(fileKeys)].slice(0, 16),
        };
    }

    if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return {
            kind: 'blob',
            size: body.size,
            type: body.type || '',
        };
    }

    if (body instanceof ArrayBuffer) {
        return {
            kind: 'array_buffer',
            size: body.byteLength,
        };
    }

    if (ArrayBuffer.isView(body)) {
        return {
            kind: 'typed_array',
            size: body.byteLength,
        };
    }

    return {
        kind: body?.constructor?.name || typeof body,
    };
}

function resolveFetchRequestForLog(input, init) {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const urlValue = request
        ? request.url
        : (typeof input === 'string' || input instanceof URL ? String(input) : '');
    const method = String(init?.method || request?.method || 'GET').toUpperCase();

    try {
        const resolvedUrl = new URL(urlValue, window.location.href);
        return { request, resolvedUrl, method };
    } catch {
        return { request, resolvedUrl: null, method };
    }
}

function shouldLogFetchRequest(resolvedUrl) {
    if (!resolvedUrl || typeof window === 'undefined') {
        return false;
    }

    if (resolvedUrl.origin !== window.location.origin) {
        return false;
    }

    return FETCH_LOG_EXTRA_PATHS.has(resolvedUrl.pathname) || resolvedUrl.pathname.startsWith(FETCH_LOG_PATH_PREFIX);
}

function buildFetchRequestLogEntry(requestId, input, init) {
    const { request, resolvedUrl, method } = resolveFetchRequestForLog(input, init);
    if (!shouldLogFetchRequest(resolvedUrl)) {
        return null;
    }

    const queryKeys = [...new Set(resolvedUrl.searchParams.keys())].filter(Boolean).sort();
    return {
        request_id: requestId,
        method,
        path: resolvedUrl.pathname,
        ...(queryKeys.length > 0 ? { query_keys: queryKeys } : {}),
        ...(summarizeHeadersForLog(init?.headers || request?.headers) ? { headers: summarizeHeadersForLog(init?.headers || request?.headers) } : {}),
        ...(summarizeRequestBodyForLog(init?.body) ? { body: summarizeRequestBodyForLog(init?.body) } : {}),
        ...(init?.cache ? { cache: String(init.cache) } : {}),
    };
}

function getRequestDurationMs(startTime) {
    const endTime = typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    return Math.max(0, Math.round(endTime - startTime));
}

function pushFrontendLog(level, values, source = 'console') {
    const normalizedLevel = normalizeLevel(level);
    const normalizedSource = String(source || 'console');

    if (normalizedSource === 'console' && !shouldEmitConsoleLevel(normalizedLevel)) {
        return false;
    }

    const message = Array.isArray(values)
        ? values.map(serializeFrontendLogValue).join(' ')
        : serializeFrontendLogValue(values);

    frontendLogBuffer.push({
        id: frontendLogNextId++,
        timestamp: Date.now(),
        level: normalizedLevel,
        source: normalizedSource,
        message: String(message || ''),
    });

    if (frontendLogBuffer.length > FRONTEND_LOG_LIMIT) {
        frontendLogBuffer.splice(0, frontendLogBuffer.length - FRONTEND_LOG_LIMIT);
    }

    return true;
}

function emitConsoleToBase(level, args) {
    getBaseConsoleMethod(level)(...args);
}

function normalizeOptionalTimestamp(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.max(0, Math.floor(numericValue)) : null;
}

export function installFrontendLogCapture() {
    if (frontendLogCaptureInstalled || typeof window === 'undefined') {
        return;
    }

    frontendLogCaptureInstalled = true;

    for (const level of WRAPPED_CONSOLE_LEVELS) {
        const normalizedLevel = normalizeLevel(level);
        getBaseConsoleMethod(normalizedLevel);

        console[normalizedLevel] = (...args) => {
            if (!pushFrontendLog(normalizedLevel, args, 'console')) {
                return;
            }

            const now = new Date();
            const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
            emitConsoleToBase(normalizedLevel, [`[${ts}]`, ...args]);
        };
    }

    const originalFetch = typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : null;
    if (originalFetch) {
        globalThis.fetch = async (input, init) => {
            const debugEnabled = frontendConsoleDebugLoggingEnabled;
            const requestId = frontendFetchNextId++;
            const startTime = typeof performance !== 'undefined' && typeof performance.now === 'function'
                ? performance.now()
                : Date.now();
            const requestLog = debugEnabled ? buildFetchRequestLogEntry(requestId, input, init) : null;

            if (requestLog) {
                console.debug(FRONTEND_FETCH_LOG_PREFIX, { phase: 'request', ...requestLog });
            }

            try {
                const response = await originalFetch(input, init);
                if (requestLog) {
                    console.debug(FRONTEND_FETCH_LOG_PREFIX, {
                        phase: 'response',
                        request_id: requestId,
                        method: requestLog.method,
                        path: requestLog.path,
                        status: response.status,
                        ok: response.ok,
                        duration_ms: getRequestDurationMs(startTime),
                        ...(summarizeHeadersForLog(response.headers, { response: true }) ? { headers: summarizeHeadersForLog(response.headers, { response: true }) } : {}),
                    });
                }
                return response;
            } catch (error) {
                if (requestLog) {
                    console.debug(FRONTEND_FETCH_LOG_PREFIX, {
                        phase: 'error',
                        request_id: requestId,
                        method: requestLog.method,
                        path: requestLog.path,
                        duration_ms: getRequestDurationMs(startTime),
                        aborted: error?.name === 'AbortError',
                        error_name: String(error?.name || ''),
                        error_message: truncateLogString(error?.message || error || '', 240),
                    });
                }
                throw error;
            }
        };
    }

    window.addEventListener('error', (event) => {
        const details = [];
        if (event.message) {
            details.push(event.message);
        }
        if (event.filename) {
            details.push(`${event.filename}:${event.lineno || 0}:${event.colno || 0}`);
        }
        if (event.error) {
            details.push(event.error);
        }
        pushFrontendLog('error', details, 'window.onerror');
    });

    window.addEventListener('unhandledrejection', (event) => {
        pushFrontendLog('error', ['Unhandled promise rejection', event.reason], 'unhandledrejection');
    });
}

export function setFrontendConsoleDebugLoggingEnabled(enabled, options = {}) {
    const announce = options?.announce === true;
    const nextValue = Boolean(enabled);

    frontendConsoleDebugLoggingEnabled = nextValue;

    if (announce && nextValue) {
        const message = 'Frontend debug logging enabled.';
        pushFrontendLog('info', [message], 'system');
        emitConsoleToBase('info', [message]);
    }
}

export function isFrontendConsoleDebugLoggingEnabled() {
    return frontendConsoleDebugLoggingEnabled;
}

export function getFrontendLogsSnapshot(options = {}) {
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.floor(Number(options.limit))) : 300;
    const sinceId = Number.isFinite(Number(options.sinceId)) ? Math.max(0, Math.floor(Number(options.sinceId))) : 0;
    const startTime = normalizeOptionalTimestamp(options.startTime);
    const endTime = normalizeOptionalTimestamp(options.endTime);

    const entries = frontendLogBuffer
        .filter((entry) => Number(entry.id) > sinceId)
        .filter((entry) => startTime === null || Number(entry.timestamp) >= startTime)
        .filter((entry) => endTime === null || Number(entry.timestamp) <= endTime)
        .slice(-limit);
    const latestId = frontendLogBuffer.length ? Number(frontendLogBuffer[frontendLogBuffer.length - 1].id) : 0;

    return { entries, latestId };
}

export function clearFrontendLogs() {
    frontendLogBuffer.length = 0;
}
