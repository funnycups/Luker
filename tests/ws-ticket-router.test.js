import { describe, it, beforeEach } from '@jest/globals';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
    wsTicketRouter,
    __wsTicketTestUtils,
    verifyWsTicket,
    TICKET_PROTOCOL_PREFIX,
} from '../src/ws-ticket-router.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function dispatchViaServer(app, { method = 'POST', url = '/', headers = {}, body = null }) {
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        const bodyStr = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        const reqHeaders = { ...headers };
        if (bodyStr != null && !reqHeaders['content-type']) {
            reqHeaders['content-type'] = 'application/json';
        }
        if (bodyStr != null) {
            reqHeaders['content-length'] = String(Buffer.byteLength(bodyStr));
        }

        return await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: url,
                method,
                headers: reqHeaders,
            }, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk.toString()));
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: chunks.join(''),
                    });
                });
            });
            req.on('error', reject);
            if (bodyStr != null) req.write(bodyStr);
            req.end();
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

// ── Test Suite: TICKET_PROTOCOL_PREFIX ──────────────────────────────────────

describe('TICKET_PROTOCOL_PREFIX', () => {
    it('is the well-known "luker-ws-ticket." prefix consumed by ws-delivery', () => {
        // ws-delivery.js line 8 hard-codes the same literal because it must
        // not depend on this module transitively during the upgrade path. If
        // this value drifts here, ws-delivery will silently stop accepting
        // upgrades. Pin the constant.
        assert.equal(TICKET_PROTOCOL_PREFIX, 'luker-ws-ticket.');
    });
});

// ── Test Suite: WS ticket store ─────────────────────────────────────────────

describe('ticket store', () => {

    beforeEach(() => {
        __wsTicketTestUtils.clear();
    });

    it('mintTicket returns a 64-char hex string and stores it', () => {
        const ticket = __wsTicketTestUtils.mintTicket();
        assert.match(ticket, /^[0-9a-f]{64}$/);
        assert.equal(__wsTicketTestUtils.size(), 1);
    });

    it('mintTicket returns unique values', () => {
        const seen = new Set();
        for (let i = 0; i < 100; i++) seen.add(__wsTicketTestUtils.mintTicket());
        assert.equal(seen.size, 100);
        assert.equal(__wsTicketTestUtils.size(), 100);
    });

    it('consumeTicket succeeds once and fails on second use', () => {
        const ticket = __wsTicketTestUtils.mintTicket();
        assert.equal(__wsTicketTestUtils.consumeTicket(ticket), true);
        assert.equal(__wsTicketTestUtils.consumeTicket(ticket), false);
    });

    it('consumeTicket fails for unknown ticket', () => {
        assert.equal(__wsTicketTestUtils.consumeTicket('nope'), false);
    });

    it('consumeTicket fails when ticket has expired', () => {
        const ticket = __wsTicketTestUtils.mintTicket();
        __wsTicketTestUtils.forceExpire(ticket);
        assert.equal(__wsTicketTestUtils.consumeTicket(ticket), false);
        // Expired ticket is still removed (single-use semantics).
        assert.equal(__wsTicketTestUtils.size(), 0);
    });
});

// ── Test Suite: verifyWsTicket (ws-delivery contract) ───────────────────────

describe('verifyWsTicket', () => {

    beforeEach(() => {
        __wsTicketTestUtils.clear();
    });

    it('returns {user_handle} for a valid ticket and consumes it', () => {
        const ticket = __wsTicketTestUtils.mintTicket('alice');
        const result = verifyWsTicket(ticket);
        assert.deepEqual(result, { user_handle: 'alice' });
        // Single-use: second call must throw
        assert.throws(() => verifyWsTicket(ticket), /invalid ticket/);
    });

    it('returns empty user_handle when ticket was minted without one', () => {
        const ticket = __wsTicketTestUtils.mintTicket();
        assert.deepEqual(verifyWsTicket(ticket), { user_handle: '' });
    });

    it('throws on missing / non-string ticket', () => {
        assert.throws(() => verifyWsTicket(''), /missing ticket/);
        assert.throws(() => verifyWsTicket(null), /missing ticket/);
        assert.throws(() => verifyWsTicket(undefined), /missing ticket/);
    });

    it('throws on unknown ticket', () => {
        assert.throws(() => verifyWsTicket('deadbeef'), /invalid ticket/);
    });

    it('throws on expired ticket and removes it from the store', () => {
        const ticket = __wsTicketTestUtils.mintTicket('alice');
        __wsTicketTestUtils.forceExpire(ticket);
        assert.throws(() => verifyWsTicket(ticket), /expired ticket/);
        assert.equal(__wsTicketTestUtils.size(), 0);
    });
});

// ── Test Suite: /api/ws-ticket router ───────────────────────────────────────

describe('/api/ws-ticket router', () => {

    beforeEach(() => {
        __wsTicketTestUtils.clear();
    });

    it('returns a fresh ticket for authorized callers', async () => {
        const expressApp = express();
        expressApp.use('/api/ws-ticket', wsTicketRouter);

        const result = await dispatchViaServer(expressApp, {
            url: '/api/ws-ticket',
            method: 'POST',
            body: {},
        });

        assert.equal(result.statusCode, 200);
        const parsed = JSON.parse(result.body);
        assert.match(parsed.ticket, /^[0-9a-f]{64}$/);
        // Ticket is in the store and ready to be consumed exactly once.
        assert.equal(__wsTicketTestUtils.consumeTicket(parsed.ticket), true);
        assert.equal(__wsTicketTestUtils.consumeTicket(parsed.ticket), false);
    });

    it('stamps the caller\'s user_handle into the minted ticket', async () => {
        // The router mounts after full auth so req.user.profile.handle is
        // trusted. Stub it here with an inline middleware.
        const expressApp = express();
        expressApp.use((req, _res, next) => {
            req.user = { profile: { handle: 'alice' } };
            next();
        });
        expressApp.use('/api/ws-ticket', wsTicketRouter);

        const result = await dispatchViaServer(expressApp, {
            url: '/api/ws-ticket',
            method: 'POST',
            body: {},
        });

        assert.equal(result.statusCode, 200);
        const { ticket } = JSON.parse(result.body);
        // verifyWsTicket surfaces the handle the router stamped in — proves
        // the ticket → user binding survives the round-trip.
        assert.deepEqual(verifyWsTicket(ticket), { user_handle: 'alice' });
    });
});
