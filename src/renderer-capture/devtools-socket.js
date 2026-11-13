/**
 * Locating the embedded webview's devtools server.
 *
 * The devtools server listens on an abstract unix socket named after the
 * process that hosts the webview. That process is the application, which is
 * not necessarily the process this module runs in, so the pid arrives through
 * the environment instead of through `process.pid`.
 */
import net from 'node:net';

export const SOCKET_NAME_PREFIX = 'webview_devtools_remote_';
const PAGE_URL_PREFIX = 'http://127.0.0.1:';
const SOCKET_OVERRIDE_ENV = 'LUKER_RENDERER_DEVTOOLS_SOCKET';
const HOST_PID_ENV = 'LUKER_HOST_PID';

/**
 * @param {string|number} hostPid pid of the process that hosts the webview
 * @returns {string} abstract namespace socket path
 */
export function abstractSocketPath(hostPid) {
    return `\0${SOCKET_NAME_PREFIX}${hostPid}`;
}

/**
 * @param {object} [env]
 * @returns {string} the socket path to connect to
 */
export function resolveSocketPath(env = process.env) {
    const override = env[SOCKET_OVERRIDE_ENV];
    if (override) {
        return override;
    }

    const hostPid = env[HOST_PID_ENV];
    if (!hostPid) {
        throw new Error(`renderer-capture: ${HOST_PID_ENV} is not set`);
    }

    return abstractSocketPath(hostPid);
}

/**
 * @param {object[]} targets
 * @returns {object|null} the page target served from the local server
 */
export function selectPageTarget(targets) {
    if (!Array.isArray(targets)) {
        return null;
    }

    return targets.find(target => target
        && target.type === 'page'
        && typeof target.url === 'string'
        && target.url.startsWith(PAGE_URL_PREFIX)) ?? null;
}

/**
 * @param {object|null|undefined} versionInfo
 * @returns {string|null} the browser-level CDP WebSocket URL when advertised
 */
export function selectBrowserWsUrl(versionInfo) {
    if (!versionInfo || typeof versionInfo.webSocketDebuggerUrl !== 'string') {
        return null;
    }
    return versionInfo.webSocketDebuggerUrl.length > 0 ? versionInfo.webSocketDebuggerUrl : null;
}

function parseResponse(buffer) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
        return null;
    }

    const headers = buffer.slice(0, headerEnd).toString('utf8');
    const statusMatch = /^HTTP\/\d+\.\d+\s+(\d+)/.exec(headers);
    if (statusMatch && Number(statusMatch[1]) >= 400) {
        throw new Error(`renderer-capture: devtools HTTP ${statusMatch[1]}`);
    }

    const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(headers);
    if (!match) {
        throw new Error('renderer-capture: devtools response has no Content-Length');
    }

    const length = Number(match[1]);
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length);
    if (body.length < length) {
        return null;
    }

    return JSON.parse(body.toString('utf8'));
}

function httpGetJson(socketPath, requestPath) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ path: socketPath });
        let buffered = Buffer.alloc(0);
        let settled = false;

        const fail = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            reject(error);
        };

        // The embedded devtools server answers with a complete response and
        // then keeps the connection open, so the reply is taken as soon as it
        // is whole rather than when the socket ends.
        const read = () => {
            let payload;
            try {
                payload = parseResponse(buffered);
            } catch (error) {
                fail(error);
                return;
            }
            if (payload === null) {
                return;
            }
            settled = true;
            socket.destroy();
            resolve(payload);
        };

        socket.on('connect', () => {
            socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        });
        socket.on('data', (chunk) => {
            if (settled) {
                return;
            }
            buffered = Buffer.concat([buffered, chunk]);
            read();
        });
        socket.on('error', fail);
        socket.on('end', () => fail(new Error('renderer-capture: the devtools response ended before it was complete')));
        socket.on('close', () => fail(new Error('renderer-capture: the devtools socket closed before a response arrived')));
    });
}

/**
 * @param {string} socketPath
 * @returns {Promise<object[]>} the target list reported by the devtools server
 */
export function fetchTargets(socketPath) {
    return httpGetJson(socketPath, '/json/list');
}

/**
 * @param {string} socketPath
 * @returns {Promise<object>} the version metadata reported by the devtools server
 */
export function fetchVersionInfo(socketPath) {
    return httpGetJson(socketPath, '/json/version');
}
