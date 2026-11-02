import { buildLanBaseUrlCandidates } from '../../../util.js';
import { guardedLanFetch } from '../../net-guard.js';
import { syncError } from '../../errors.js';

/** Check only health. A reverse offer would consume credentials or recurse. */
export async function checkPairCallback({ owner, baseUrl, network }) {
    if (!baseUrl) throw syncError('PEER_CALLBACK_UNREACHABLE', 'The other device cannot connect back to this device');
    try {
        const response = await guardedLanFetch(owner, network)(`${baseUrl}/api/sync/v1/health`);
        const body = await response.json();
        if (!response.ok || !(Number(body?.protocol) >= LAN_PROTOCOL)) throw new Error('Incompatible callback health');
    } catch (error) {
        if (error?.code === 'SYNC_PRIVATE_ADDRESS') throw error;
        throw syncError('PEER_CALLBACK_UNREACHABLE', 'The other device cannot connect back to this device');
    }
}

/**
 * Version of the LAN sync protocol this server speaks. Peers whose health
 * or offer reports a lower version cannot sync with it.
 */
export const LAN_PROTOCOL = 2;

const CALLBACK_SCHEMES = ['http', 'https'];
const TCP_PORT_MIN = 1;
const TCP_PORT_MAX = 65535; // cap-ok: the TCP port number range

/**
 * @typedef {{ scheme: string, port: number, baseUrls: string[] }} SyncCallback
 */

/**
 * Addresses a peer can use to reach this server, derived from its listen
 * settings. Offers carry it so the other device learns where to notify
 * and push.
 *
 * @param {{ port?: number | string, ssl?: boolean, listen?: boolean, listenAddressIPv4?: string } | null | undefined} cliArgs
 * @returns {SyncCallback | null}
 */
export function selfCallback(cliArgs) {
    const port = Number(cliArgs?.port);
    if (!isTcpPort(port)) return null;
    const scheme = cliArgs.ssl ? 'https' : 'http';
    const primary = `${scheme}://127.0.0.1:${port}`;
    return { scheme, port, baseUrls: [primary, ...buildLanBaseUrlCandidates(primary, cliArgs)] };
}

/**
 * Base URL to reach the device that sent an offer. Only a URL whose host
 * is the address the offer came from is accepted: a listed URL first,
 * otherwise one built from that address and the callback's scheme and
 * port.
 *
 * @param {{ callback: unknown, remoteAddress: string | undefined | null }} args
 * @returns {string | null}
 */
export function pickCallbackBaseUrl({ callback, remoteAddress }) {
    if (!callback || typeof callback !== 'object') return null;
    const { scheme, port, baseUrls } = /** @type {{ scheme?: unknown, port?: unknown, baseUrls?: unknown }} */ (callback);
    if (typeof scheme !== 'string' || !CALLBACK_SCHEMES.includes(scheme)) return null;
    if (typeof port !== 'number' || !isTcpPort(port)) return null;
    const remoteHost = hostOfAddress(remoteAddress);
    if (!remoteHost) return null;
    for (const candidate of Array.isArray(baseUrls) ? baseUrls : []) {
        const url = parseHttpUrl(candidate);
        if (url && url.hostname === remoteHost) return url.origin;
    }
    return parseHttpUrl(`${scheme}://${remoteHost}:${port}`)?.origin ?? null;
}

function isTcpPort(port) {
    return Number.isInteger(port) && port >= TCP_PORT_MIN && port <= TCP_PORT_MAX;
}

/**
 * URL host form of a socket address: IPv4-mapped IPv6 addresses become
 * IPv4, IPv6 addresses are bracketed and canonicalized the way `URL`
 * reports `hostname`.
 *
 * @param {unknown} address
 * @returns {string | null}
 */
function hostOfAddress(address) {
    const raw = String(address ?? '').trim();
    if (!raw) return null;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
    const host = mapped ? mapped[1] : raw.includes(':') ? `[${raw}]` : raw;
    return parseHttpUrl(`http://${host}`)?.hostname ?? null;
}

/**
 * @param {unknown} value
 * @returns {URL | null}
 */
function parseHttpUrl(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}
