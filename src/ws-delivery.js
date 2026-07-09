// SPDX-License-Identifier: AGPL-3.0-or-later
import { WebSocketServer } from 'ws';
import {
    getTaskByRequestId,
    subscribeToJob,
} from './endpoints/backends/luker-generation.js';

const TICKET_PROTOCOL_PREFIX = 'luker-ws-ticket.';

function extractTicket(req) {
    const protoHeader = String(req.headers['sec-websocket-protocol'] || '');
    for (const part of protoHeader.split(',').map(s => s.trim())) {
        if (part.startsWith(TICKET_PROTOCOL_PREFIX)) {
            return part.slice(TICKET_PROTOCOL_PREFIX.length);
        }
    }
    return '';
}

function sendJson(ws, obj) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

function eventToFrame(requestId, entry) {
    const data = entry?.data;
    if (!data || typeof data !== 'object') {
        return null;
    }
    if (data.kind === 'head') {
        return { type: 'head', request_id: requestId, seq: entry.seq, headers: data.data?.headers, status: data.data?.status };
    }
    if (data.kind === 'chunk') {
        let payload = data.data;
        // Uint8Array/Buffer inputs (e.g. ctx.emit.chunk raw bytes) must be
        // base64-encoded before wire; JSON.stringify would otherwise serialize
        // them as {"0":.., "1":..} object literals. Pre-encoded strings pass
        // through unchanged.
        if (payload instanceof Uint8Array || Buffer.isBuffer(payload)) {
            payload = Buffer.from(payload).toString('base64');
        }
        return { type: 'chunk', request_id: requestId, seq: entry.seq, data: payload };
    }
    if (data.kind === 'end') {
        return { type: 'end', request_id: requestId, seq: entry.seq };
    }
    if (data.kind === 'error') {
        return { type: 'error', request_id: requestId, seq: entry.seq, code: data.data?.code || 'internal', message: data.data?.message || '' };
    }
    return null;
}

export function createDeliveryServer({ httpServer, verifyTicket, path = '/api/ws-delivery' }) {
    const wss = new WebSocketServer({ noServer: true });

    function onUpgrade(req, socket, head) {
        if (req.url !== path && !req.url.startsWith(path + '?')) return;
        let userInfo;
        try { userInfo = verifyTicket(extractTicket(req)); }
        catch (err) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        if (!userInfo || !userInfo.user_handle) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.userHandle = userInfo.user_handle;
            ws.subscriptions = new Map();
            wss.emit('connection', ws, req);
        });
    }

    httpServer.on('upgrade', onUpgrade);

    wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(String(raw)); }
            catch { return; }
            if (!msg || typeof msg !== 'object') return;

            if (msg.type === 'subscribe' || msg.type === 'resume') {
                const requestId = String(msg.request_id || '');
                if (!requestId) return;
                let job;
                try { job = getTaskByRequestId(requestId, ws.userHandle); }
                catch (err) {
                    sendJson(ws, { type: 'error', request_id: requestId, code: 'forbidden', message: 'access denied' });
                    return;
                }
                if (!job) {
                    sendJson(ws, { type: 'error', request_id: requestId, code: 'not_found', message: 'task not found' });
                    return;
                }
                if (ws.subscriptions.has(requestId)) return;  // already subscribed
                const fromSeq = msg.type === 'resume' ? Number(msg.from_seq || 0) : 0;
                const unsub = subscribeToJob(requestId, (payload) => {
                    if (payload.type !== 'event') return;
                    const frame = eventToFrame(requestId, payload.entry);
                    if (frame) sendJson(ws, frame);
                }, { fromSeq });
                ws.subscriptions.set(requestId, unsub);
            } else if (msg.type === 'unsubscribe') {
                const requestId = String(msg.request_id || '');
                const unsub = ws.subscriptions.get(requestId);
                if (unsub) { unsub(); ws.subscriptions.delete(requestId); }
            }
        });

        ws.on('close', () => {
            for (const unsub of ws.subscriptions.values()) {
                try { unsub(); } catch {}
            }
            ws.subscriptions.clear();
        });
    });

    return {
        close() {
            httpServer.off('upgrade', onUpgrade);
            wss.close();
        },
    };
}
