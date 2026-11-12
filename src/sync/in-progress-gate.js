/**
 * Sync write gate: a per-user reader/writer lock.
 *
 * Gated write requests take a reader slot when they enter and release it
 * when the response finishes or the connection closes. A sync snapshot or
 * reconcile takes the writer side: new readers wait, the writer waits for
 * in-flight readers to drain, and waiting requests continue once the
 * writer releases. Requests are never refused.
 *
 * The lock is keyed by the user's data root, so every backend of one user
 * shares one writer lock and two backends never write live data at the
 * same time. A writer is admitted when no writer holds the gate, no
 * readers are active and no writer is queued ahead of it. While a writer
 * holds or waits, new readers queue. When a writer releases, every queued
 * reader is admitted before the next queued writer, so neither side
 * starves.
 *
 * Writes outside HTTP requests (the stats flush timer, the skills
 * first-use populate) go through `runGatedWrite`. Startup-only writers
 * (schema migrations and content seeding in server-main) run before any
 * sync can start. AsyncLocalStorage records which roots the current task
 * already holds, so a gated handler that calls `runGatedWrite` for its own
 * user runs inline instead of queueing behind a writer that is waiting for
 * that same handler.
 *
 * A gated request that finishes with a 2xx status calls the dirty
 * listener; routes flagged `dirty: false` are reads that may lazily write
 * and only take a reader slot.
 *
 * Process-local: Luker is a single-process server.
 */
import path from 'node:path';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';

import { SYNC_CATEGORIES } from './categories.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * @typedef {{ pattern: RegExp, categories: readonly string[], dirty: boolean, wholesale: boolean }} GatedRoute
 */

/**
 * Express matches `/api/x/save/` to a `/save` route, so every pattern also
 * accepts one trailing slash. `wholesale` marks routes that rewrite the
 * whole user root (restore, reset, data cleanup) rather than one category.
 *
 * @param {RegExp} pattern
 * @param {string[]} categories
 * @param {{ dirty?: boolean, wholesale?: boolean }} [options]
 * @returns {GatedRoute}
 */
function route(pattern, categories, { dirty = true, wholesale = false } = {}) {
    const withSlash = new RegExp(pattern.source.replace(/\$$/, '\\/?$'), pattern.flags);
    return Object.freeze({ pattern: withSlash, categories: Object.freeze([...categories]), dirty, wholesale });
}

const ALL_CATEGORY_IDS = SYNC_CATEGORIES.map(category => category.id);

const PRESET_CATEGORY_IDS = ['openai-presets', 'novelai-presets', 'koboldai-presets', 'textgen-presets', 'instruct', 'context', 'sysprompt', 'reasoning'];

/**
 * Write routes matched against the full request path. The first matching
 * entry wins. The sync protocol under `/api/sync/v1` is never gated
 * because the middleware is mounted after that router.
 *
 * @type {readonly GatedRoute[]}
 */
export const GATED_ROUTES = Object.freeze([
    route(/^\/api\/chats\/(save|append|patch|merge|split|meta|meta\/patch|state\/patch|state\/delete|rename|delete|import|group\/save|group\/append|group\/patch|group\/merge|group\/split|group\/meta|group\/meta\/patch|group\/import|group\/delete)$/i, ['chats']),
    route(/^\/api\/groups\/(create|edit|delete)$/i, ['chats']),
    route(/^\/api\/settings\/(save|patch|make-snapshot|restore-snapshot|load-snapshot)$/i, ['settings']),
    route(/^\/api\/users\/me\/settings\/save$/i, ['settings']),
    route(/^\/api\/users\/reset-settings$/i, ['settings']),
    route(/^\/api\/users\/(reset-step2|restore-backup|restore-backup\/uploads\/[^/]+\/finalize|import\/data-zip|lan-migration\/import)$/i, ALL_CATEGORY_IDS, { wholesale: true }),
    route(/^\/api\/presets\/(save|patch|delete|restore|state\/patch|state\/delete|state\/delete-all|state\/rename)$/i, PRESET_CATEGORY_IDS),
    route(/^\/api\/sysprompt\/(save|delete)$/i, ['sysprompt']),
    route(/^\/api\/instruct\/(save|delete)$/i, ['instruct']),
    route(/^\/api\/context\/(save|delete)$/i, ['context']),
    route(/^\/api\/reasoning\/(save|delete)$/i, ['reasoning']),
    route(/^\/api\/themes\/(save|delete)$/i, ['themes']),
    route(/^\/api\/quick-replies\/(save|delete)$/i, ['quickreplies']),
    route(/^\/api\/moving-ui\/save$/i, ['movingUI']),
    route(/^\/api\/worldinfo\/(edit|patch|delete|import)$/i, ['worlds']),
    route(/^\/api\/characters\/(create|rename|edit|patch|edit-avatar|edit-attribute|merge-attributes|delete|import|duplicate|state\/set|state\/patch|state\/delete)$/i, ['characters', 'chats']),
    route(/^\/api\/sprites\/(delete|upload-zip|upload)$/i, ['characters']),
    route(/^\/api\/card-app\/[^/]+\/.+$/i, ['card-apps']),
    route(/^\/api\/skills\/(pack-for-embed|extract-embed\/preview)$/i, ['skills'], { dirty: false }),
    route(/^\/api\/skills\/(?!import-from-url(\/|$))[^/]+(\/[^/]+)?(\/(file|file\/rename|file\/write|file\/edit|rename|move-scope))?$/i, ['skills']),
    route(/^\/api\/backgrounds\/(rename|delete|upload)$/i, ['backgrounds', 'image-metadata']),
    route(/^\/api\/backgrounds\/all$/i, ['image-metadata'], { dirty: false }),
    route(/^\/api\/assets\/delete$/i, ['assets']),
    route(/^\/api\/assets\/get$/i, ['assets'], { dirty: false }),
    route(/^\/api\/avatars\/(upload|delete)$/i, ['avatars']),
    route(/^\/api\/files\/(upload|delete)$/i, ['user-files']),
    route(/^\/api\/images\/(upload|delete)$/i, ['user-images', 'chats']),
    route(/^\/api\/media\/delete$/i, ['user-images', 'characters', 'chats']),
    route(/^\/api\/sd\/comfy\/(save-workflow|delete-workflow|rename-workflow)$/i, ['comfy-workflows']),
    route(/^\/api\/image-metadata\/(folders\/(create|set-thumbnails|update|delete|assign|unassign)|cleanup)$/i, ['image-metadata']),
    route(/^\/api\/image-metadata(\/|\/all|\/folders\/get)?$/i, ['image-metadata'], { dirty: false }),
    route(/^\/api\/vector\/(delete|purge|purge-all)$/i, ['vectors']),
    route(/^\/api\/secrets\/(write|delete|rotate|rename)$/i, ['secrets']),
    route(/^\/api\/secrets\/(read|view|find|settings)$/i, ['secrets'], { dirty: false }),
    route(/^\/api\/extensions\/(switch|move|delete)$/i, ['extensions']),
    route(/^\/api\/stats\/recreate$/i, ['stats']),
    route(/^\/api\/data-maid\/delete$/i, ALL_CATEGORY_IDS, { wholesale: true }),
]);

/** @typedef {{ readers: number, writerHeld: boolean, readerWaiters: Array<() => void>, writerWaiters: Array<() => void> }} Gate */

/** @type {Map<string, Gate>} */
const GATES = new Map();
/**
 * Slots the current async task holds, keyed by gate key. Each value is a
 * token whose `held` flag turns false when the slot is released, so work
 * that outlives its request (a promise started inside a handler) does not
 * mistake an inherited, already-released slot for a live one.
 *
 * @typedef {{ held: boolean }} SlotToken
 * @type {AsyncLocalStorage<Map<string, SlotToken>>}
 */
const readerScope = new AsyncLocalStorage();
/** @type {AsyncLocalStorage<Map<string, SlotToken>>} */
const writerScope = new AsyncLocalStorage();
/** Request attribution is independent of gate slots, including ungated handlers. */
const requestScope = new AsyncLocalStorage();
/** @type {((info: { handle: string|null, userRoot: string }) => unknown) | null} */
let dirtyListener = null;

function gateKey(userRoot) {
    if (typeof userRoot !== 'string' || !userRoot) {
        throw new TypeError('sync write gate: userRoot must be a non-empty string');
    }
    return path.resolve(userRoot);
}

function gateFor(key) {
    let gate = GATES.get(key);
    if (!gate) {
        gate = { readers: 0, writerHeld: false, readerWaiters: [], writerWaiters: [] };
        GATES.set(key, gate);
    }
    return gate;
}

function forgetIfIdle(key, gate) {
    if (gate.readers === 0 && !gate.writerHeld && gate.readerWaiters.length === 0 && gate.writerWaiters.length === 0) {
        GATES.delete(key);
    }
}

function once(fn) {
    let done = false;
    return () => {
        if (done) return;
        done = true;
        fn();
    };
}

function grantNextWriter(gate) {
    const wake = gate.writerWaiters.shift();
    if (!wake) return;
    gate.writerHeld = true;
    wake();
}

function releaseReader(key, gate) {
    gate.readers -= 1;
    if (gate.readers === 0) grantNextWriter(gate);
    forgetIfIdle(key, gate);
}

function releaseWriter(key, gate) {
    gate.writerHeld = false;
    if (gate.readerWaiters.length > 0) {
        const waiting = gate.readerWaiters.splice(0);
        gate.readers += waiting.length;
        for (const wake of waiting) wake();
    } else {
        grantNextWriter(gate);
    }
    forgetIfIdle(key, gate);
}

/**
 * @param {string} userRoot
 * @returns {Promise<() => void>} idempotent release
 */
export function acquireReader(userRoot) {
    const key = gateKey(userRoot);
    const gate = gateFor(key);
    const release = once(() => releaseReader(key, gate));
    if (!gate.writerHeld && gate.writerWaiters.length === 0) {
        gate.readers += 1;
        return Promise.resolve(release);
    }
    return new Promise(resolve => gate.readerWaiters.push(() => resolve(release)));
}

/**
 * @param {string} userRoot
 * @returns {Promise<() => void>} idempotent release
 */
export function acquireWriter(userRoot) {
    const key = gateKey(userRoot);
    const gate = gateFor(key);
    const release = once(() => releaseWriter(key, gate));
    if (!gate.writerHeld && gate.readers === 0 && gate.writerWaiters.length === 0) {
        gate.writerHeld = true;
        return Promise.resolve(release);
    }
    return new Promise(resolve => gate.writerWaiters.push(() => resolve(release)));
}

/**
 * @param {AsyncLocalStorage<Map<string, SlotToken>>} scope
 * @param {string} key
 * @param {SlotToken} token
 * @returns {Map<string, SlotToken>}
 */
function extendScope(scope, key, token) {
    const held = new Map(scope.getStore() ?? []);
    held.set(key, token);
    return held;
}

function holdsSlot(key) {
    return Boolean(readerScope.getStore()?.get(key)?.held || writerScope.getStore()?.get(key)?.held);
}

/**
 * Run `fn` holding the user's writer side.
 *
 * @template T
 * @param {string} userRoot
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withWriterLock(userRoot, fn) {
    const key = gateKey(userRoot);
    if (holdsSlot(key)) {
        throw new Error(`withWriterLock: the current task already holds the write gate for ${key}; waiting would deadlock`);
    }
    const release = await acquireWriter(userRoot);
    const token = { held: true };
    try {
        return await writerScope.run(extendScope(writerScope, key, token), fn);
    } finally {
        token.held = false;
        release();
    }
}

function logDirtyListenerError(error) {
    console.error('[sync] dirty listener failed', error);
}

function notifyDirty(info) {
    // The opt-in test trace records notifications without replacing the listener.
    const traceFile = process.env.LUKER_TEST_DIRTY_TRACE;
    if (traceFile) {
        const attribution = requestScope.getStore();
        try {
            fs.appendFileSync(traceFile, `${JSON.stringify({ ...info, at: Date.now(), method: attribution?.method ?? null, path: attribution?.path ?? null })}\n`);
        } catch (error) {
            console.error('[sync] dirty trace failed', error);
        }
    }
    if (!dirtyListener) return;
    try {
        const result = dirtyListener(info);
        if (result && typeof result.then === 'function') result.then(undefined, logDirtyListenerError);
    } catch (error) {
        logDirtyListenerError(error);
    }
}

/**
 * @param {((info: { handle: string|null, userRoot: string }) => unknown) | null} listener
 */
export function setDirtyListener(listener) {
    if (listener !== null && typeof listener !== 'function') {
        throw new TypeError('setDirtyListener: listener must be a function or null');
    }
    dirtyListener = listener;
}

/**
 * Run a non-request write to synced data under a reader slot. Nested inside
 * a reader slot the current task already holds, `fn` runs inline and still
 * marks dirty on success; nested inside the writer side (sync itself) it
 * runs inline and never marks dirty.
 *
 * @template T
 * @param {{ userRoot: string, handle?: string|null }} owner
 * @param {() => Promise<T>} fn
 * @param {{ dirty?: boolean }} [options]
 * @returns {Promise<T>}
 */
export async function runGatedWrite({ userRoot, handle = null }, fn, { dirty = true } = {}) {
    const key = gateKey(userRoot);
    if (writerScope.getStore()?.get(key)?.held) return fn();
    if (readerScope.getStore()?.get(key)?.held) {
        // The enclosing slot may be a `dirty: false` route, so this write
        // signals on its own.
        const result = await fn();
        if (dirty) notifyDirty({ handle, userRoot: key });
        return result;
    }
    const release = await acquireReader(userRoot);
    const token = { held: true };
    let succeeded = false;
    try {
        const result = await readerScope.run(extendScope(readerScope, key, token), fn);
        succeeded = true;
        return result;
    } finally {
        token.held = false;
        release();
        if (succeeded && dirty) notifyDirty({ handle, userRoot: key });
    }
}

/**
 * @param {string} userRoot
 * @returns {{ readers: number, writerHeld: boolean, waitingReaders: number, waitingWriters: number }}
 */
export function getGateState(userRoot) {
    const gate = GATES.get(gateKey(userRoot));
    return {
        readers: gate?.readers ?? 0,
        writerHeld: gate?.writerHeld ?? false,
        waitingReaders: gate?.readerWaiters.length ?? 0,
        waitingWriters: gate?.writerWaiters.length ?? 0,
    };
}

/** Test-only: forget every gate and the dirty listener. */
export function _resetGateForTests() {
    GATES.clear();
    dirtyListener = null;
}

/**
 * @param {unknown} requestPath
 * @returns {GatedRoute | null}
 */
export function matchGatedRoute(requestPath) {
    if (typeof requestPath !== 'string' || !requestPath) return null;
    return GATED_ROUTES.find(entry => entry.pattern.test(requestPath)) ?? null;
}

/**
 * @param {unknown} requestPath
 * @returns {boolean}
 */
export function isGatedPath(requestPath) {
    return matchGatedRoute(requestPath) !== null;
}

/**
 * @returns {import('express').RequestHandler}
 */
export function syncWriteGateMiddleware() {
    return function syncWriteGate(request, response, next) {
        const method = String(request.method || '').toUpperCase();
        const requestPath = typeof request.path === 'string'
            ? request.path
            : String(request.originalUrl || '').split('?')[0];
        const attribution = { method, path: requestPath };
        return requestScope.run(attribution, () => {
            if (!WRITE_METHODS.has(method)) return next();
            const gatedRoute = matchGatedRoute(requestPath);
            if (!gatedRoute) return next();
            const userRoot = request?.user?.directories?.root;
            if (!userRoot) return next();
            const handle = request.user?.profile?.handle ?? null;
            const key = gateKey(userRoot);

            let abandoned = false;
            const onEarlyClose = () => { abandoned = true; };
            response.once('close', onEarlyClose);

            acquireReader(userRoot).then((release) => {
                response.off('close', onEarlyClose);
                if (abandoned) {
                    release();
                    return;
                }
                const token = { held: true };
                let settled = false;
                const settle = (finished) => {
                    if (settled) return;
                    settled = true;
                    token.held = false;
                    release();
                    if (finished && gatedRoute.dirty && response.statusCode >= 200 && response.statusCode < 300) {
                        requestScope.run(attribution, () => notifyDirty({ handle, userRoot: key }));
                    }
                };
                response.once('finish', () => settle(true));
                response.once('close', () => settle(response.writableFinished));
                readerScope.run(extendScope(readerScope, key, token), next);
            });
        });
    };
}
