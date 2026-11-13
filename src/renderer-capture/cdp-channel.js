/**
 * A CDP conversation over the webview's devtools server.
 *
 * The devtools server hands out a websocket URL without a port, so the
 * transport has to be supplied explicitly: the socket the target list came
 * from is also the socket the websocket speaks over. Do not pass an `agent`
 * option here — Node drops `createConnection` when one is present and falls
 * back to dialing the host and port in the URL, which nothing is listening on.
 */
import net from 'node:net';
import WebSocket from 'ws';

/**
 * @param {string} socketPath
 * @param {string} wsUrl
 * @returns {Promise<{ send: (message: object) => void, onEvent: (handler: (message: object) => void) => void, next: () => Promise<object>, close: () => void }>}
 */
export function connectChannel(socketPath, wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
            createConnection: () => net.connect({ path: socketPath }),
        });
        const queue = [];
        const waiters = [];
        const eventHandlers = new Set();
        const closeHandlers = new Set();
        let failure = null;
        let closed = false;

        const fail = (error) => {
            if (failure) {
                return;
            }
            failure = error;
            while (waiters.length > 0) {
                waiters.shift().reject(error);
            }
        };

        ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            let consumed = false;
            if (typeof message.method === 'string') {
                for (const handler of eventHandlers) {
                    if (handler(message) === true) {
                        consumed = true;
                    }
                }
            }
            if (consumed) {
                return;
            }
            const waiter = waiters.shift();
            if (waiter) {
                waiter.resolve(message);
            } else {
                queue.push(message);
            }
        });
        ws.on('close', () => {
            closed = true;
            fail(new Error('renderer-capture: the cdp channel closed'));
            for (const handler of closeHandlers) {
                handler();
            }
        });
        ws.on('error', error => fail(new Error(`renderer-capture: the cdp channel failed: ${error.message}`)));

        ws.on('open', () => {
            resolve({
                get closed() {
                    return closed;
                },
                send(message) {
                    ws.send(JSON.stringify(message));
                },
                onEvent(handler) {
                    eventHandlers.add(handler);
                },
                onClose(handler) {
                    closeHandlers.add(handler);
                },
                next() {
                    if (queue.length > 0) {
                        return Promise.resolve(queue.shift());
                    }
                    if (failure) {
                        return Promise.reject(failure);
                    }
                    return new Promise((resolveNext, rejectNext) => {
                        waiters.push({ resolve: resolveNext, reject: rejectNext });
                    });
                },
                close() {
                    fail(new Error('renderer-capture: the cdp channel is closed'));
                    ws.close();
                },
            });
        });
    });
}
