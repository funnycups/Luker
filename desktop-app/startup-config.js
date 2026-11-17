// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import net from 'node:net';

export const DEFAULT_PORT = 8000;
// Probe window for a free port, matching the range the mobile shells use.
export const PORT_PROBE_COUNT = 50;

/**
 * Extracts an explicit `--port=<n>` CLI flag, or returns null when absent or invalid.
 * @param {string[]} argv
 * @returns {number | null}
 */
export function readCliPort(argv) {
    const prefix = '--port=';
    for (const arg of argv) {
        if (!arg.startsWith(prefix)) {
            continue;
        }
        const parsed = Number.parseInt(arg.slice(prefix.length), 10);
        if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
            return parsed;
        }
    }
    return null;
}

function parseProtocolFlag(raw, fallback) {
    if (raw === undefined || raw === null) {
        return fallback;
    }
    if (typeof raw === 'boolean') {
        return raw;
    }
    const normalized = String(raw).trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    if (normalized === 'auto') return 'auto';
    return fallback;
}

function stripIpv6Brackets(host) {
    let value = String(host || '').trim();
    if (value.startsWith('[')) {
        value = value.slice(1);
    }
    if (value.endsWith(']')) {
        value = value.slice(0, -1);
    }
    return value;
}

/**
 * Resolves the preferred port and actual socket listen targets from CLI args and config.yaml.
 * If config.yaml cannot be parsed, returns a minimal loopback plan so the backend itself
 * runs and reports the exact configuration syntax error into the boot log.
 * @param {{ cliPort: number | null, configText: string, parseYaml: (text: string) => any, defaultPort?: number }} options
 */
export function resolveStartupListenPlan({
    cliPort,
    configText,
    parseYaml,
    defaultPort = DEFAULT_PORT,
}) {
    let doc = null;
    if (typeof configText === 'string' && configText.length > 0) {
        try {
            const parsed = parseYaml(configText);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                doc = parsed;
            }
        } catch {
            return {
                preferredPort: cliPort ?? defaultPort,
                configPort: defaultPort,
                configValid: false,
                probeTargets: [{ host: '127.0.0.1', ipv6Only: false, optional: false }],
            };
        }
    }

    if (!doc) {
        return {
            preferredPort: cliPort ?? defaultPort,
            configPort: defaultPort,
            configValid: false,
            probeTargets: [{ host: '127.0.0.1', ipv6Only: false, optional: false }],
        };
    }

    const rawPort = Number(doc.port);
    const configPort = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535
        ? rawPort
        : defaultPort;
    const preferredPort = cliPort ?? configPort;

    const listen = doc.listen === true;
    const ipv4Mode = parseProtocolFlag(doc?.protocol?.ipv4, true);
    const ipv6Mode = parseProtocolFlag(doc?.protocol?.ipv6, false);

    const probeTargets = [];
    if (ipv4Mode !== false) {
        const optional = ipv4Mode === 'auto';
        probeTargets.push({ host: '127.0.0.1', ipv6Only: false, optional });
        if (listen) {
            const customIpv4 = String(doc?.listenAddress?.ipv4 || '').trim();
            const listenIpv4 = net.isIPv4(customIpv4) ? customIpv4 : '0.0.0.0';
            if (listenIpv4 !== '127.0.0.1') {
                probeTargets.push({ host: listenIpv4, ipv6Only: false, optional });
            }
        }
    }

    if (ipv6Mode !== false) {
        const optional = ipv6Mode === 'auto';
        if (listen) {
            const customIpv6 = stripIpv6Brackets(doc?.listenAddress?.ipv6);
            const listenIpv6 = net.isIPv6(customIpv6) ? customIpv6 : '::';
            probeTargets.push({ host: listenIpv6, ipv6Only: true, optional });
        } else {
            probeTargets.push({ host: '::1', ipv6Only: true, optional });
        }
    }

    return {
        preferredPort,
        configPort,
        configValid: true,
        probeTargets,
    };
}

function probeSingleTarget(port, target, createServer) {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', (err) => {
            if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
                resolve(false);
                return;
            }
            if (target.optional && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) {
                resolve(true);
                return;
            }
            reject(err);
        });
        const listenOpts = {
            host: target.host,
            port,
            exclusive: true,
            ...(target.ipv6Only ? { ipv6Only: true } : {}),
        };
        probe.listen(listenOpts, () => {
            probe.close(() => resolve(true));
        });
    });
}

/**
 * Checks whether every required listen target can bind `port`.
 * @param {number} port
 * @param {Array<{ host: string, ipv6Only: boolean, optional: boolean }>} probeTargets
 * @param {{ createServer?: () => import('node:net').Server }} [options]
 * @returns {Promise<boolean>}
 */
export async function probePort(port, probeTargets, { createServer = net.createServer } = {}) {
    for (const target of probeTargets) {
        const free = await probeSingleTarget(port, target, createServer);
        if (!free) {
            return false;
        }
    }
    return true;
}

/**
 * Finds the first available port starting at `preferred`.
 * @param {number} preferred
 * @param {{ probeTargets?: Array<{ host: string, ipv6Only: boolean, optional: boolean }>, probeCount?: number, createServer?: () => import('node:net').Server }} [options]
 * @returns {Promise<number>}
 */
export async function pickPort(preferred, {
    probeTargets = [{ host: '127.0.0.1', ipv6Only: false, optional: false }],
    probeCount = PORT_PROBE_COUNT,
    createServer = net.createServer,
} = {}) {
    if (probeTargets.length === 0) {
        return preferred;
    }
    const maxPort = Math.min(65535, preferred + probeCount - 1); // cap-ok: TCP 16-bit unsigned port number ceiling
    for (let port = preferred; port <= maxPort; port++) {
        if (await probePort(port, probeTargets, { createServer })) {
            return port;
        }
    }
    throw new Error(`no free port between ${preferred} and ${maxPort}`);
}
