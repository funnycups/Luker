import { resolve4, resolve6 } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { Agent } from 'agent-base';
import ipaddr from 'ipaddr.js';
import fetch from 'node-fetch';
import { syncError } from './errors.js';
import { getConfigValue } from '../util.js';

export function guardedLanFetch(owner, network) {
    return createSyncFetch({
        owner,
        enableAccounts: getConfigValue('enableUserAccounts', false, 'boolean'),
        allowPrivateAddressesForUsers: getConfigValue('sync.allowPrivateAddressesForUsers', false, 'boolean'),
        network,
    });
}

/**
 * Constructor-only network fixtures may replace DNS and certificate trust, not
 * policy, the selected dial address, or TLS identity verification.
 * @typedef {{ resolveAll?: (hostname: string) => Promise<Array<{address: string, family: 4|6}>>, ca?: string|Buffer, onValidatedDial?: (observation: {hostname: string, address: string, family: 4|6, port: number}) => void }} NetworkFixtureOptions
 * @typedef {{ owner: import('./pipeline/sync-hooks.js').SyncOwner, enableAccounts: boolean, allowPrivateAddressesForUsers?: boolean, network?: NetworkFixtureOptions }} SyncNetworkOptions
 */

const PRIVATE_RANGES = [
    '0.0.0.0/32', '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12',
    '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10',
    '::/128', '::1/128', 'fc00::/7', 'fe80::/10',
].map(range => ipaddr.parseCIDR(range));

/**
 * Invalid addresses fail closed as well.
 * @param {string} address
 * @returns {boolean}
 */
export function isProhibitedSyncAddress(address) {
    if (!net.isIP(address)) return true;
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return PRIVATE_RANGES.some(([range, bits]) => range.kind() === parsed.kind() && parsed.match(range, bits));
}

async function resolveFamily(hostname, resolve, family) {
    try {
        return (await resolve(hostname)).map(address => ({ address, family }));
    } catch (error) {
        // NXDOMAIN, SERVFAIL and timeouts must not be hidden by another family.
        if (error.code === 'ENODATA') return [];
        throw error;
    }
}

async function resolveAll(hostname) {
    return (await Promise.all([resolveFamily(hostname, resolve4, 4), resolveFamily(hostname, resolve6, 6)])).flat();
}

function privateAddressError() {
    return syncError('SYNC_PRIVATE_ADDRESS', 'Outbound sync connection is not permitted for this user');
}

/**
 * Build agents for native HTTP consumers, including the S3 SDK. No socket is
 * reused: profile and all DNS answers are checked at every connection boundary.
 * @param {SyncNetworkOptions} args
 * @returns {{httpAgent: Agent, httpsAgent: Agent, destroy: () => void}}
 */
export function createSyncAgents({ owner, enableAccounts, allowPrivateAddressesForUsers = false, network = {} }) {
    async function permitsPrivate() {
        if (enableAccounts === false) return true;
        const profile = await owner.getCurrentProfile?.();
        if (profile?.enabled !== true) throw privateAddressError();
        return profile.admin === true || allowPrivateAddressesForUsers === true;
    }

    class SyncAgent extends Agent {
        constructor(secure) {
            super({ keepAlive: false });
            this.secure = secure;
            this.protocol = secure ? 'https:' : 'http:';
            this.defaultPort = secure ? 443 : 80;
            this.disposed = false;
            this.pendingConnections = new Set();
            this.ownedSockets = new Set();
        }

        destroy() {
            this.disposed = true;
            for (const cancel of this.pendingConnections) cancel();
            for (const socket of this.ownedSockets) socket.destroy();
            super.destroy();
        }

        async connect(req, options) {
            const checkActive = () => {
                if (this.disposed) throw syncError('SYNC_AGENT_DESTROYED', 'Sync transport has been destroyed');
                if (req.destroyed || req.aborted) throw syncError('ABORT_ERR', 'Sync request was aborted');
            };
            checkActive();
            let producedSocket;
            let rejectCancellation;
            const cancellation = new Promise((_resolve, reject) => { rejectCancellation = reject; });
            const cancel = () => {
                producedSocket?.destroy();
                rejectCancellation(syncError(this.disposed ? 'SYNC_AGENT_DESTROYED' : 'ABORT_ERR', 'Sync connection was canceled'));
            };
            this.pendingConnections.add(cancel);
            req.once('abort', cancel);
            req.once('close', cancel);
            try {
                return await Promise.race([this.connectActive(options, checkActive, socket => { producedSocket = socket; }), cancellation]);
            } finally {
                this.pendingConnections.delete(cancel);
                req.removeListener('abort', cancel);
                req.removeListener('close', cancel);
            }
        }

        async connectActive(options, checkActive, onSocket) {
            const hostname = options.host.replace(/^\[|\]$/g, '');
            const literalFamily = net.isIP(hostname);
            const initialPermission = await permitsPrivate();
            checkActive();
            if (literalFamily && !initialPermission && isProhibitedSyncAddress(hostname)) throw privateAddressError();
            const answers = literalFamily
                ? [{ address: hostname, family: literalFamily }]
                : await (network.resolveAll ?? resolveAll)(hostname);
            checkActive();
            if (!answers.length || answers.some(answer => !net.isIP(answer.address) || net.isIP(answer.address) !== answer.family)) {
                throw syncError('SYNC_DNS_ERROR', 'Sync hostname has no valid address');
            }
            const containsPrivate = answers.some(answer => isProhibitedSyncAddress(answer.address));
            const permitted = await permitsPrivate();
            checkActive();
            if (containsPrivate && !permitted) throw privateAddressError();
            const { address, family } = answers[0];
            const port = Number(options.port);
            // A separate immutable observation cannot change the selected target.
            network.onValidatedDial?.(Object.freeze({ hostname, address, family, port }));
            checkActive();
            const target = { host: address, port, family };
            const socket = this.secure ? tls.connect({
                ...target,
                ca: network.ca,
                rejectUnauthorized: true,
                servername: literalFamily ? undefined : hostname,
                checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(hostname, cert),
            }) : net.connect(target);
            // Own the socket before agent-base's asynchronous registration, so
            // teardown cannot miss a socket in the connect-to-registration gap.
            this.ownedSockets.add(socket);
            onSocket(socket);
            socket.once('close', () => this.ownedSockets.delete(socket));
            try {
                checkActive();
            } catch (error) {
                socket.destroy();
                throw error;
            }
            return socket;
        }
    }

    const httpAgent = new SyncAgent(false);
    const httpsAgent = new SyncAgent(true);
    return { httpAgent, httpsAgent, destroy: () => { httpAgent.destroy(); httpsAgent.destroy(); } };
}

const FETCH_OPTIONS = new Set(['method', 'headers', 'body', 'signal', 'compress', 'size', 'highWaterMark']);

/**
 * Explicit node-fetch keeps the guard identical on normal and jitless Node.
 * Only request data options are accepted; transport and redirects are owned here.
 * @param {SyncNetworkOptions} args
 * @returns {(url: string|URL, init?: object) => Promise<import('node-fetch').Response>}
 */
export function createSyncFetch(args) {
    const { httpAgent, httpsAgent } = createSyncAgents(args);
    return async (input, init = {}) => {
        if (!init || Object.keys(init).some(key => !FETCH_OPTIONS.has(key))) {
            throw syncError('INVALID_SYNC_OPTIONS', 'Sync request transport options cannot be overridden');
        }
        let url;
        try {
            if (typeof input !== 'string' && !(input instanceof URL)) throw new Error('Invalid input');
            url = new URL(input);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid URL');
        } catch {
            throw syncError('INVALID_SYNC_URL', 'Sync requires an HTTP or HTTPS URL without credentials');
        }
        return fetch(url, { ...init, redirect: 'error', agent: url.protocol === 'https:' ? httpsAgent : httpAgent });
    };
}
