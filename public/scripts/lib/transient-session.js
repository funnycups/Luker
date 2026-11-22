// SPDX-License-Identifier: AGPL-3.0-or-later

export const TRANSIENT_SESSION_HEADER = 'X-Luker-Transient-Session';

export function transientSessionHeaders(sessionId) {
    if (sessionId === undefined) return {};
    if (typeof sessionId !== 'string' || !sessionId || sessionId.trim() !== sessionId) {
        throw new TypeError('Expected a non-empty temporary media session id.');
    }
    return { [TRANSIENT_SESSION_HEADER]: sessionId };
}

async function readResponse(response, label) {
    const text = await response.text();
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text}`);
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`${label} Invalid JSON response: ${text}`, { cause: error });
    }
}

/**
 * Open a dedicated, authenticated owner connection. `closed` observes the
 * connection, while `close()` acknowledges server-side cleanup before closing it.
 */
export async function openTransientSession(context, { abortSignal } = {}) {
    abortSignal?.throwIfAborted();
    const openError = context.translate('Failed to open the temporary media session.');
    const ticketResponse = await fetch('/api/ws-ticket', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        signal: abortSignal,
    });
    const { ticket } = await readResponse(ticketResponse, openError);
    if (typeof ticket !== 'string' || !ticket) throw new Error(`${openError} Missing authentication ticket.`);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/api/ws-delivery`, [
        `luker-ws-ticket.${ticket}`,
    ]);
    const closed = new Promise(resolve => socket.addEventListener('close', () => resolve(), { once: true }));
    let onAbort;
    let sessionId;
    try {
        sessionId = await new Promise((resolve, reject) => {
            const fail = error => {
                reject(error);
                socket.close();
            };
            onAbort = () => fail(abortSignal.reason);
            abortSignal?.addEventListener('abort', onAbort, { once: true });
            socket.addEventListener('open', () => {
                socket.send(JSON.stringify({ type: 'session_open' }));
            }, { once: true });
            socket.addEventListener('error', () => fail(new Error(openError)), { once: true });
            socket.addEventListener('close', () => reject(new Error(context.translate('The temporary media connection closed.'))), { once: true });
            socket.addEventListener('message', event => {
                try {
                    const frame = JSON.parse(event.data);
                    if (frame.type === 'ping') socket.send(JSON.stringify({ type: 'pong', ts: frame.ts }));
                    if (frame.type === 'session_error') fail(new Error(`${openError} ${frame.message}`));
                    if (frame.type === 'session_opened') {
                        if (typeof frame.session_id !== 'string') throw new Error(`${openError} Missing session id.`);
                        transientSessionHeaders(frame.session_id);
                        resolve(frame.session_id);
                    }
                } catch (error) {
                    fail(error);
                }
            });
            if (abortSignal?.aborted) onAbort();
        });
    } finally {
        if (onAbort) abortSignal?.removeEventListener('abort', onAbort);
    }
    let closing = null;
    return {
        sessionId,
        closed,
        requestHeaders: () => transientSessionHeaders(sessionId),
        close() {
            if (!closing) {
                closing = (async () => {
                    const label = context.translate('Failed to close the temporary media session.');
                    const response = await fetch('/api/transient-sessions/close', {
                        method: 'POST',
                        headers: { ...context.getRequestHeaders(), ...transientSessionHeaders(sessionId) },
                        body: '{}',
                    });
                    const result = await readResponse(response, label);
                    if (result.ok !== true) throw new Error(`${label} Cleanup was not acknowledged.`);
                    socket.close();
                    await closed;
                })().catch(error => {
                    closing = null;
                    throw error;
                });
            }
            return closing;
        },
    };
}
