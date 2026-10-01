// TCP reachability probe for the optional database test suites.
//
// The Mysql/Pg-backed suites (storage harnesses, init-storage-mode smoke,
// pool-timeout, round-trip parity, sync materialize, ...) are gated on
// `LUKER_DISABLE_MYSQL_TESTS` / `LUKER_DISABLE_POSTGRES_TESTS`. Nothing sets
// those on a machine without containers, so the suites used to run and fail
// with ECONNREFUSED instead of skipping. jest.setup.js probes the configured
// endpoints once per test file and sets the disable flag when nothing is
// listening, which makes "no database configured" mean "skip", not "fail".

import net from 'node:net';

/**
 * Resolve the host/port an engine URL points at, falling back to the
 * documented local-container defaults when the env override is absent or
 * unparsable.
 * @param {string|undefined} url
 * @param {{host: string, port: number}} fallback
 * @returns {{host: string, port: number}}
 */
export function resolveDbEndpoint(url, fallback) {
    if (!url) {
        return fallback;
    }
    try {
        const parsed = new URL(url);
        return {
            host: parsed.hostname || fallback.host,
            port: parsed.port ? Number(parsed.port) : fallback.port,
        };
    } catch {
        return fallback;
    }
}

/**
 * Probe a TCP endpoint. Resolves true when a connection is accepted within
 * the timeout, false on refusal / timeout / any other network error.
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function probeTcp(host, port, timeoutMs = 500) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            socket.removeAllListeners();
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}
