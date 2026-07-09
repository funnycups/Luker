/**
 * WS upgrade ticket store + Express router.
 *
 * The WebSocket upgrade itself is the auth boundary, but native browser
 * `WebSocket` does not let JavaScript set custom headers, and many
 * environments strip the `Authorization` header from the upgrade request
 * (iOS WebView, frpc / cloudflared, some nginx setups). We therefore mint
 * a one-shot ticket on the HTTP path (where Basic Auth + cookieSession +
 * login + CSRF all gate access) and validate it on upgrade via
 * `Sec-WebSocket-Protocol`, which browsers DO let JS set via
 * `new WebSocket(url, protocols)` and which transparent proxies do not
 * mangle.
 *
 * Tickets: 32-byte random hex (256-bit), 30-second TTL, single-use.
 * Storage is in-process — Luker is single-process, so no shared store
 * needed.
 */

import crypto from 'node:crypto';
import express from 'express';

const TICKET_TTL_MS = 30_000;
const TICKET_CLEANUP_INTERVAL_MS = 60_000;
export const TICKET_PROTOCOL_PREFIX = 'luker-ws-ticket.';

/** @type {Map<string, { createdAt: number, userHandle: string }>} */
const tickets = new Map();

function mintTicket(userHandle = '') {
    const ticket = crypto.randomBytes(32).toString('hex');
    tickets.set(ticket, { createdAt: Date.now(), userHandle: String(userHandle || '') });
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

/**
 * Verify AND consume a ticket for the ws-delivery layer. Same single-use
 * semantics as `consumeTicket` but returns the caller's `{user_handle}` so
 * delivery can authorize per-job subscriptions. Throws on invalid, expired,
 * or already-consumed tickets. The stored handle is populated by
 * `wsTicketRouter` from `req.user.profile.handle` (the router runs after
 * full auth middleware, so the identity is trusted).
 *
 * @param {string} ticket
 * @returns {{ user_handle: string }}
 */
export function verifyWsTicket(ticket) {
    if (typeof ticket !== 'string' || !ticket) {
        throw new Error('missing ticket');
    }
    const entry = tickets.get(ticket);
    if (!entry) {
        throw new Error('invalid ticket');
    }
    tickets.delete(ticket);
    if (Date.now() - entry.createdAt > TICKET_TTL_MS) {
        throw new Error('expired ticket');
    }
    return { user_handle: entry.userHandle };
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

wsTicketRouter.post('/', (req, res) => {
    const userHandle = req?.user?.profile?.handle || '';
    const ticket = mintTicket(userHandle);
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
