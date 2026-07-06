import util from 'node:util';

const WRAPPED_ORIGINAL = Symbol('luker.log.capture.original');
const LOG_LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
// Aligned with users-admin.js /logs/get per-request clamp and public/scripts/user.js MAX_LOG_VIEW_LIMIT; in-memory ring buffer.
const DEFAULT_CAPACITY = 5000;

/** @type {{ id: number; timestamp: number; level: string; message: string }[]} */
const entries = [];

let nextId = 1;
const capacity = DEFAULT_CAPACITY;

function stripAnsiArtifacts(input) {
    return String(input)
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/(?:^|[\s])\[(?:\d{1,3}(?:;\d{1,3})*)m/g, (match) => match.startsWith(' ') ? ' ' : '')
        .replace(/\[(?:\d{1,3}(?:;\d{1,3})*)m(?=[^\s])/g, '');
}

function toSafeString(value) {
    if (typeof value === 'string') {
        return stripAnsiArtifacts(value);
    }

    const inspected = util.inspect(value, {
        depth: 8,
        maxArrayLength: null,
        maxStringLength: null,
        breakLength: 140,
        compact: 2,
    });

    return stripAnsiArtifacts(inspected);
}

function appendEntry(level, args) {
    const message = args.map(toSafeString).join(' ');
    entries.push({
        id: nextId++,
        timestamp: Date.now(),
        level,
        message,
    });

    if (entries.length > capacity) {
        entries.splice(0, entries.length - capacity);
    }
}

function getBaseMethod(method) {
    if (typeof method !== 'function') {
        return () => { };
    }

    if (Object.prototype.hasOwnProperty.call(method, WRAPPED_ORIGINAL)) {
        return method[WRAPPED_ORIGINAL];
    }

    return method.bind(globalThis.console);
}

/**
 * Installs console method wrappers so logs can be queried from the frontend.
 * Calling this more than once is safe and will not double-capture logs.
 */
export function installLogCapture() {
    for (const level of LOG_LEVELS) {
        const current = globalThis.console[level];
        const base = getBaseMethod(current);

        /** @type {(...args: any[]) => void} */
        const wrapped = (...args) => {
            appendEntry(level, args);
            base(...args);
        };

        wrapped[WRAPPED_ORIGINAL] = base;
        globalThis.console[level] = wrapped;
    }
}

/**
 * Clears all captured entries.
 */
export function clearCapturedLogs() {
    entries.length = 0;
}

function normalizeOptionalTimestamp(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.max(0, Math.floor(numericValue)) : null;
}

/**
 * Gets captured logs.
 * @param {{ sinceId?: number; limit?: number; levels?: string[]; startTime?: number; endTime?: number; searchTerm?: string }} [options]
 * @returns {{ entries: { id: number; timestamp: number; level: string; message: string }[]; latestId: number }}
 */
export function getCapturedLogs(options = {}) {
    const sinceId = Number.isFinite(Number(options.sinceId)) ? Math.max(0, Math.floor(Number(options.sinceId))) : 0;
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.floor(Number(options.limit))) : 500;
    const startTime = normalizeOptionalTimestamp(options.startTime);
    const endTime = normalizeOptionalTimestamp(options.endTime);
    const normalizedSearchTerm = String(options.searchTerm || '').trim().toLowerCase();
    const normalizedLevels = Array.isArray(options.levels)
        ? new Set(options.levels.map(level => String(level || '').toLowerCase()).filter(level => LOG_LEVELS.includes(level)))
        : null;

    let filtered = entries;
    if (sinceId > 0) {
        filtered = filtered.filter(entry => entry.id > sinceId);
    }

    if (normalizedLevels && normalizedLevels.size > 0) {
        filtered = filtered.filter(entry => normalizedLevels.has(entry.level));
    }

    if (startTime !== null) {
        filtered = filtered.filter(entry => entry.timestamp >= startTime);
    }

    if (endTime !== null) {
        filtered = filtered.filter(entry => entry.timestamp <= endTime);
    }

    if (normalizedSearchTerm) {
        filtered = filtered.filter(entry => entry.level.toLowerCase().includes(normalizedSearchTerm) || entry.message.toLowerCase().includes(normalizedSearchTerm));
    }

    if (filtered.length > limit) {
        filtered = filtered.slice(filtered.length - limit);
    }

    return {
        entries: filtered.map(entry => ({ ...entry })),
        latestId: entries.length > 0 ? entries[entries.length - 1].id : 0,
    };
}
