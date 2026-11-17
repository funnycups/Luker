// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import net from 'node:net';
import path from 'node:path';

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

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*[a-zA-Z]/g;

/**
 * Strips terminal ANSI color sequences and normalizes newlines for display in the failure page.
 * @param {string} rawLog
 * @returns {string}
 */
export function cleanBootLog(rawLog) {
    return String(rawLog || '')
        .replace(ANSI_ESCAPE_PATTERN, '')
        .replace(/\r\n/g, '\n')
        .trim();
}

/**
 * Updates the top-level `port` entry in config.yaml text while preserving comments and formatting.
 * @param {string} configText
 * @param {number} newPort
 * @returns {string}
 */
export function updateConfigPort(configText, newPort) {
    if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
        throw new RangeError(`Port must be an integer between 1 and 65535 (got ${newPort}).`);
    }
    const text = String(configText ?? '');
    if (/^port:\s*.*$/m.test(text)) {
        return text.replace(/^port:\s*.*$/m, `port: ${newPort}`);
    }
    const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    return `${text}${separator}port: ${newPort}\n`;
}

/**
 * Checks whether a `file:` frame URL resolves to `expectedPath` on `platform`,
 * accounting for percent-encoding and Windows drive-letter / path casing.
 * @param {string} rawUrl
 * @param {string} expectedPath
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isSameFileUrl(rawUrl, expectedPath, platform = process.platform) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'file:') {
        return false;
    }
    let decodedPathname;
    try {
        decodedPathname = decodeURIComponent(parsed.pathname);
    } catch {
        return false;
    }
    if (platform === 'win32') {
        const fromUrl = path.win32.normalize(decodedPathname.replace(/^\/([a-zA-Z]:)/, '$1')).toLowerCase();
        const target = path.win32.normalize(expectedPath).toLowerCase();
        return fromUrl === target;
    }
    return path.posix.normalize(decodedPathname) === path.posix.normalize(expectedPath);
}
