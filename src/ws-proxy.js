/**
 * WebSocket Proxy — replaces unstable HTTP long-polling with a persistent WS
 * channel for generate requests (LLM + image). The frontend monkey-patches
 * window.fetch so that matched URLs are transparently tunnelled over WS while
 * the rest of the app sees a normal Response object.
 *
 * Key feature: disconnect recovery. When the WS drops mid-stream, the backend
 * keeps the internal dispatch running and buffers chunks. When the client
 * reconnects and sends a "resume" message, buffered data is replayed and
 * live streaming continues seamlessly.
 *
 * Protocol (JSON over WS):
 *
 * Client → Server { type:"request", id, url, method, headers, body }
 * Client → Server { type:"resume", id } // reconnect recovery
 * Client → Server { type:"abort", id }
 * Client → Server { type:"ping" }
 *
 * Server → Client { type:"head", id, status, headers }
 * Server → Client { type:"chunk", id, data } // streaming body (base64)
 * Server → Client { type:"end", id } // body finished
 * Server → Client { type:"error", id, message }
 * Server → Client { type:"pong" }
 */

import { Readable, Writable } from 'node:stream';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { color } from './util.js';
import { WS_PROXY_AUTH_BYPASS } from './middleware/basicAuth.js';

/** @type {WebSocketServer|null} */
let wss = null;

/** @type {import('express').Express|null} */
let app = null;

/**
 * Global job registry — survives WS reconnects.
 * Key: request ID, Value: Job object
 * @type {Map<string, Job>}
 */
const jobs = new Map();

const JOB_ORPHAN_TTL = 5 * 60 * 1000; // 5 min — cleanup orphaned (disconnected + idle) jobs
const JOB_CLEANUP_INTERVAL = 60_000; // check every 60s

// ── WS upgrade ticket store ─────────────────────────────────────────────────
//
// The WS upgrade itself is the auth boundary, but native browser `WebSocket`
// does not let JavaScript set custom headers, and many environments strip the
// `Authorization` header from the upgrade request (iOS WebView, frpc /
// cloudflared, some nginx setups). We therefore mint a one-shot ticket on
// the HTTP path (where Basic Auth + cookieSession + login + CSRF all gate
// access) and validate it on upgrade via `Sec-WebSocket-Protocol`, which
// browsers DO let JS set via `new WebSocket(url, protocols)` and which
// transparent proxies do not mangle.
//
// Tickets: 32-byte random hex (256-bit), 30-second TTL, single-use.
// Storage is in-process — Luker is single-process, so no shared store needed.

const TICKET_TTL_MS = 30_000;
const TICKET_CLEANUP_INTERVAL_MS = 60_000;
export const TICKET_PROTOCOL_PREFIX = 'luker-ws-ticket.';

/** @type {Map<string, { createdAt: number }>} */
const tickets = new Map();

function mintTicket() {
    const ticket = crypto.randomBytes(32).toString('hex');
    tickets.set(ticket, { createdAt: Date.now() });
    return ticket;
}

/**
 * Validate AND consume a ticket atomically. Returns true iff the ticket
 * exists, is not expired, and has not been used. The entry is deleted in
 * either case to enforce single-use semantics.
 */
function consumeTicket(ticket) {
    const entry = tickets.get(ticket);
    if (!entry) return false;
    tickets.delete(ticket);
    if (Date.now() - entry.createdAt > TICKET_TTL_MS) return false;
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [t, entry] of tickets) {
        if (now - entry.createdAt > TICKET_TTL_MS) tickets.delete(t);
    }
}, TICKET_CLEANUP_INTERVAL_MS).unref();

/**
 * Express router exposing `POST /api/ws-ticket`. Mount AFTER basicAuth +
 * cookieSession + setUserData + requireLogin + CSRF so that only fully
 * authenticated callers can mint a ticket.
 */
export const wsTicketRouter = express.Router();

wsTicketRouter.post('/', (_req, res) => {
    const ticket = mintTicket();
    res.json({ ticket });
});

// Test-only hooks — exported so unit tests can drive the store directly.
export const __wsTicketTestUtils = {
    mintTicket,
    consumeTicket,
    clear: () => tickets.clear(),
    size: () => tickets.size,
    forceExpire: (ticket) => {
        const entry = tickets.get(ticket);
        if (entry) entry.createdAt = 0;
    },
};

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {AbortController} ac
 * @property {import('ws').WebSocket|null} ws — current WS (null if disconnected)
 * @property {boolean} headSent
 * @property {object|null} head — { status, headers }
 * @property {string[]} buffer — buffered base64 chunks
 * @property {boolean} done — response fully received
 * @property {string|null} error — error message if failed
 * @property {number} lastActivity — updated on every chunk/head/end
 * @property {object} ctx — { cookie, csrfToken, originalHost }
 */

/**
 * Initialize the WS proxy on every HTTP(S) server instance.
 *
 * Every upgrade to `/ws/proxy` must carry a single-use ticket via
 * `Sec-WebSocket-Protocol: luker-ws-ticket.<ticket>`. The ticket itself is
 * minted on `POST /api/ws-ticket` (see `wsTicketRouter`) which is gated by
 * the full HTTP middleware stack — Basic Auth, cookieSession, setUserData,
 * requireLogin, CSRF. Once the upgrade is validated the WS channel is
 * trusted, and dispatched requests bypass HTTP-layer Basic Auth via the
 * `WS_PROXY_AUTH_BYPASS` Symbol while cookieSession / CSRF / requireLogin
 * still run for per-user identity.
 *
 * @param {import('http').Server[]} servers
 * @param {import('express').Express} expressApp
 */
export function initWsProxy(servers, expressApp) {
    app = expressApp;
    wss = new WebSocketServer({
        noServer: true,
        // Picks the same ticket subprotocol back so `ws` writes it into the
        // 101 response. Validation already happened in `server.on('upgrade')`
        // below; here we just echo the chosen string.
        handleProtocols: (protocols) => {
            for (const p of protocols) {
                if (typeof p === 'string' && p.startsWith(TICKET_PROTOCOL_PREFIX)) {
                    return p;
                }
            }
            return false;
        },
    });

    for (const server of servers) {
        server.on('upgrade', (req, socket, head) => {
            const url = new URL(req.url, `http://${req.headers.host}`);
            if (url.pathname !== '/ws/proxy') return;

            const protocols = String(req.headers['sec-websocket-protocol'] || '')
                .split(',').map(s => s.trim()).filter(Boolean);
            const ticketProto = protocols.find(p => p.startsWith(TICKET_PROTOCOL_PREFIX));

            if (!ticketProto) {
                rejectUpgrade(socket, 401, 'missing_ticket', req);
                return;
            }
            const ticket = ticketProto.slice(TICKET_PROTOCOL_PREFIX.length);
            if (!consumeTicket(ticket)) {
                rejectUpgrade(socket, 401, 'invalid_or_expired_ticket', req);
                return;
            }

            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req);
            });
        });
    }

    wss.on('connection', handleConnection);

    // Periodic cleanup of orphaned jobs
    setInterval(cleanupJobs, JOB_CLEANUP_INTERVAL);

    console.log(color.green('WebSocket proxy initialized on /ws/proxy'));
}

function rejectUpgrade(socket, status, reason, req) {
    console.warn(`[ws-proxy] upgrade rejected: ${reason} status=${status} ip=${req?.socket?.remoteAddress}`);
    const lines = [
        `HTTP/1.1 ${status} Unauthorized`,
        'Content-Length: 0',
        'Connection: close',
        '', '',
    ];
    try { socket.write(lines.join('\r\n')); } catch { /* socket may already be dead */ }
    socket.destroy();
}

function cleanupJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) {
        // Only clean up orphaned jobs: no WS attached AND idle for too long
        // Active jobs (ws connected or recently active) are never killed by cleanup
        if (!job.ws && now - job.lastActivity > JOB_ORPHAN_TTL) {
            job.ac.abort();
            jobs.delete(id);
        }
    }
}

/**
 * Handle a single WS connection.
 * @param {import('ws').WebSocket} ws
 * @param {import('http').IncomingMessage} req
 */
function handleConnection(ws, req) {
    const cookie = req.headers.cookie || '';
    const authorization = req.headers.authorization || '';
    const upgradeUrl = new URL(req.url, `http://${req.headers.host}`);
    const csrfToken = upgradeUrl.searchParams.get('csrf') || '';
    const originalHost = req.headers.host || 'localhost';

    const ctx = { cookie, authorization, csrfToken, originalHost };

    /** Track which job IDs this connection owns */
    const ownedJobs = new Set();

    // Server-side keepalive: send WS protocol-level pings every 30s
    // to detect dead TCP connections (NAT timeout, network switch, etc.)
    const wsPingInterval = setInterval(() => {
        if (ws.readyState === 1) ws.ping();
    }, 30000);

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        if (msg.type === 'ping') {
            wsSend(ws, { type: 'pong' });
            return;
        }

        if (msg.type === 'abort') {
            const job = jobs.get(msg.id);
            if (job) {
                job.ac.abort();
                jobs.delete(msg.id);
                ownedJobs.delete(msg.id);
            }
            return;
        }

        if (msg.type === 'resume') {
            handleResume(ws, msg.id, ownedJobs, msg.fromChunk);
            return;
        }

        if (msg.type === 'request') {
            const id = msg.id;
            ownedJobs.add(id);
            startJob(ws, msg, ctx);
        }
    });

    ws.on('close', () => {
        clearInterval(wsPingInterval);
        // Detach WS from all owned jobs — but do NOT abort them.
        // The backend dispatch continues running, buffering chunks.
        for (const id of ownedJobs) {
            const job = jobs.get(id);
            if (job) {
                job.ws = null;
            }
        }
        ownedJobs.clear();
    });

    ws.on('error', (err) => {
        console.error('[ws-proxy] connection error:', err.message);
    });
}

/**
 * Resume a job after WS reconnect — replay buffered data.
 */
function handleResume(ws, id, ownedJobs, fromChunk = 0) {
    const job = jobs.get(id);
    if (!job) {
        // Job expired or never existed
        wsSend(ws, { type: 'error', id, message: 'Job not found (expired or invalid)' });
        return;
    }

    // Re-attach WS to this job
    job.ws = ws;
    ownedJobs.add(id);

    // Replay head if we have it
    if (job.head) {
        wsSend(ws, { type: 'head', id, status: job.head.status, headers: job.head.headers });
    }

    // Replay buffered chunks from the requested offset to avoid duplicates.
    const start = Number.isFinite(fromChunk) ? Math.max(0, Math.floor(fromChunk)) : 0;
    for (let i = start; i < job.buffer.length; i++) {
        const b64 = job.buffer[i];
        wsSend(ws, { type: 'chunk', id, data: b64 });
    }

    // If job already finished, send end/error
    if (job.done) {
        if (job.error) {
            wsSend(ws, { type: 'error', id, message: job.error });
        } else {
            wsSend(ws, { type: 'end', id });
        }
        jobs.delete(id);
        ownedJobs.delete(id);
    }
    // Otherwise, the streaming loop in startJob will continue pushing
    // new chunks to this ws now that job.ws is set again.
}

/**
 * Create a mock ServerResponse that captures write/end calls
 * and feeds them into the job's WS + buffer pipeline.
 *
 * @param {string} id - Job ID
 * @param {import('http').IncomingMessage} req - The mock request
 * @param {Job} job - The job object
 * @returns {import('http').ServerResponse}
 */
function createMockResponse(id, req, job) {
    const res = new http.ServerResponse(req);

    // Mock socket — ServerResponse needs it for internal checks.
    // Use a Writable stream so the response lifecycle (cork/uncork/write/end)
    // works correctly and the 'finish' event fires after res.end().
    const mockSocket = new Writable({
        write(chunk, encoding, callback) { callback(); },
        final(callback) { callback(); },
    });
    mockSocket.readable = true;
    mockSocket.destroy = () => {};
    mockSocket.cork = function () { Writable.prototype.cork.call(this); };
    mockSocket.uncork = function () { Writable.prototype.uncork.call(this); };
    mockSocket.setTimeout = () => mockSocket;
    mockSocket.setNoDelay = () => mockSocket;
    mockSocket.setKeepAlive = () => mockSocket;

    res.socket = mockSocket;
    res.connection = mockSocket;

    const capturedHeaders = {};
    let statusCode = 200;
    let headSent = false;

    const sendHead = () => {
        if (headSent) return;
        headSent = true;
        job.head = { status: statusCode, headers: { ...capturedHeaders } };
        job.headSent = true;
        job.lastActivity = Date.now();
        wsSend(job.ws, { type: 'head', id, status: statusCode, headers: { ...capturedHeaders } });
    };

    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, reasonOrHeaders, headers) => {
        statusCode = status;
        if (typeof reasonOrHeaders === 'object' && reasonOrHeaders !== null) {
            for (const [k, v] of Object.entries(reasonOrHeaders)) {
                capturedHeaders[k.toLowerCase()] = v;
            }
        }
        if (headers && typeof headers === 'object') {
            for (const [k, v] of Object.entries(headers)) {
                capturedHeaders[k.toLowerCase()] = v;
            }
        }
        return origWriteHead(status, reasonOrHeaders, headers);
    };

    const origSetHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
        capturedHeaders[name.toLowerCase()] = value;
        return origSetHeader(name, value);
    };

    const origWrite = res.write.bind(res);
    res.write = (chunk, encoding) => {
        if (!headSent) sendHead();

        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
        const b64 = buf.toString('base64');
        job.buffer.push(b64);
        job.lastActivity = Date.now();
        wsSend(job.ws, { type: 'chunk', id, data: b64 });
        return true;
    };

    const origEnd = res.end.bind(res);
    res.end = (chunk, encoding) => {
        if (chunk) {
            if (!headSent) sendHead();
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
            const b64 = buf.toString('base64');
            job.buffer.push(b64);
            job.lastActivity = Date.now();
            wsSend(job.ws, { type: 'chunk', id, data: b64 });
        } else if (!headSent) {
            // Empty body — still send head
            sendHead();
        }

        job.done = true;
        wsSend(job.ws, { type: 'end', id });
        if (job.ws) jobs.delete(id);
        return origEnd.call(res);
    };

    return res;
}

/**
 * Start a new proxy job: dispatch internally via app.handle(), stream response, buffer on disconnect.
 */
async function startJob(ws, msg, ctx) {
    const { id, url, method, headers: clientHeaders, body } = msg;
    const ac = new AbortController();

    /** @type {Job} */
    const job = {
        id,
        ac,
        ws,
        headSent: false,
        head: null,
        buffer: [],
        done: false,
        error: null,
        lastActivity: Date.now(),
        ctx,
    };
    jobs.set(id, job);

    try {
        // Construct a mock IncomingMessage
        // http.IncomingMessage requires a Stream (Readable) as its first argument.
        // Using a plain EventEmitter triggers ERR_INVALID_ARG_TYPE when Node's
        // eos() / _destroy internally tries to pipe or destroy the socket.
        const bodyStr = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

        const mockSocket = new Readable({ read() {} });
        mockSocket.readable = true;
        mockSocket.writable = false;
        mockSocket.destroyed = false;
        mockSocket.destroy = function () { this.destroyed = true; };
        mockSocket.remoteAddress = '127.0.0.1';

        const req = new http.IncomingMessage(mockSocket);
        req.method = method || 'POST';
        req.url = url;
        req[WS_PROXY_AUTH_BYPASS] = true;

        // Build request headers — forward client headers + WS context
        const reqHeaders = { ...clientHeaders };
        reqHeaders['host'] = ctx.originalHost;
        if (ctx.cookie) reqHeaders['cookie'] = ctx.cookie;
        if (!reqHeaders['authorization'] && !reqHeaders['Authorization'] && ctx.authorization) {
            reqHeaders['authorization'] = ctx.authorization;
        }
        if (!reqHeaders['x-csrf-token'] && !reqHeaders['X-CSRF-Token'] && ctx.csrfToken) {
            reqHeaders['x-csrf-token'] = ctx.csrfToken;
        }
        if (bodyStr != null && !reqHeaders['content-type']) {
            reqHeaders['content-type'] = 'application/json';
        }
        if (bodyStr != null) {
            reqHeaders['content-length'] = String(Buffer.byteLength(bodyStr));
        }
        req.headers = reqHeaders;

        // Feed body content into the IncomingMessage via push
        if (bodyStr != null) {
            req.push(bodyStr, 'utf8');
        }
        // Mark the request as complete before signalling end-of-stream.
        // Without this, IncomingMessage._destroy() sees readableEnded=true but
        // complete=false (mock sockets bypass the HTTP parser, which normally
        // sets complete=true), fires the 'aborted' event, and
        // bindRequestCloseAbort kills the upstream request with a 502.
        req.complete = true;
        req.push(null); // signal end of body

        // Create mock response that feeds into our WS pipeline
        const res = createMockResponse(id, req, job);

        // Wire up abort signal
        const onAbort = () => {
            // If the handler hasn't finished yet, destroy the response
            if (!job.done && !res.writableEnded) {
                res.destroy();
            }
            jobs.delete(id);
        };
        ac.signal.addEventListener('abort', onAbort, { once: true });

        // Dispatch directly through Express — no HTTP, no middleware auth
        app.handle(req, res, (err) => {
            if (err && !job.done) {
                job.error = err.message || 'Internal dispatch error';
                job.done = true;
                wsSend(job.ws, { type: 'error', id, message: job.error });
                if (job.ws) jobs.delete(id);
            }
        });
    } catch (err) {
        if (err.name !== 'AbortError') {
            job.error = err.message;
            job.done = true;
            wsSend(job.ws, { type: 'error', id, message: job.error });
            if (job.ws) jobs.delete(id);
        } else {
            jobs.delete(id);
        }
    }
}

/**
 * Safe WS send — silently drops if ws is null or not open.
 */
function wsSend(ws, obj) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(obj));
    }
}
