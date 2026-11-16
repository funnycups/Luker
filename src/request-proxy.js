import process from 'node:process';
import http from 'node:http';
import https from 'node:https';
import { ProxyAgent, proxies } from 'proxy-agent';
import { isValidUrl, color } from './util.js';

const LOG_HEADER = '[Request Proxy]';

// Every cached agent owns a socket pool, so the same proxy URL reuses one
// agent across requests instead of building a new pool each time.
/** @type {Map<string, ProxyAgent>} */
const requestProxyAgents = new Map();
let requestProxyKeepAlive = false;
let globalProxyUrl = '';

/**
 * The global proxy configured at startup. The inspector reports it so a
 * request's route can be explained after the fact.
 * @returns {{ enabled: boolean, url: string }}
 */
export function getGlobalProxyInfo() {
    return { enabled: Boolean(globalProxyUrl), url: globalProxyUrl };
}

/**
 * Create an agent bound to one proxy URL. Returns undefined when no URL is
 * configured. Explicit agents override the global agents installed by
 * initRequestProxy, which is what makes a per-profile proxy take precedence.
 * @param {unknown} url
 * @returns {ProxyAgent | undefined}
 */
export function createRequestProxyAgent(url) {
    const raw = String(url ?? '').trim();
    if (!raw) {
        return undefined;
    }

    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`Invalid proxy URL: ${raw}`);
    }

    const protocol = parsed.protocol.replace(/:$/, '');
    if (!Object.hasOwn(proxies, protocol)) {
        throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
    }

    const cached = requestProxyAgents.get(raw);
    if (cached) {
        return cached;
    }

    const agent = new ProxyAgent({
        getProxyForUrl: () => raw,
        keepAlive: requestProxyKeepAlive,
    });
    requestProxyAgents.set(raw, agent);
    return agent;
}

/**
 * Bind a fetch implementation to an explicit agent.
 * @param {typeof fetch} fetchImpl
 * @param {import('node:http').Agent | undefined} agent
 * @returns {typeof fetch}
 */
export function createProxyBoundFetch(fetchImpl, agent) {
    if (!agent) {
        return fetchImpl;
    }
    return (url, options = {}) => fetchImpl(url, { ...options, agent });
}

/**
 * Initialize request proxy.
 * @param {ProxySettings} settings Proxy settings.
 * @typedef {object} ProxySettings
 * @property {boolean} enabled Whether proxy is enabled.
 * @property {string} url Proxy URL.
 * @property {string[]} bypass List of URLs to bypass proxy.
 * @property {boolean} enableKeepAlive Enable HTTP/HTTPS keep-alive.
 * @property {boolean} privateRequestFilterEnabled Whether the private request filter is enabled.
 */
export default function initRequestProxy({ enabled, url, bypass, enableKeepAlive, privateRequestFilterEnabled }) {
    requestProxyKeepAlive = Boolean(enableKeepAlive);
    globalProxyUrl = enabled ? String(url || '').trim() : '';

    try {
        // No proxy is enabled, so return
        if (!enabled) {
            return;
        }

        if (privateRequestFilterEnabled) {
            console.warn(color.yellow(LOG_HEADER), 'Warning: Request proxy is enabled while private request filter is also enabled. Only URLs that BYPASS the request proxy will be checked.');
            console.warn(color.yellow(LOG_HEADER), 'To ensure all requests are properly filtered, disable the request proxy.');
        }

        if (!url) {
            console.error(color.red(LOG_HEADER), 'No proxy URL provided');
            return;
        }

        if (!isValidUrl(url)) {
            console.error(color.red(LOG_HEADER), 'Invalid proxy URL provided');
            return;
        }

        // ProxyAgent uses proxy-from-env under the hood
        // Reference: https://github.com/Rob--W/proxy-from-env
        process.env.all_proxy = url;

        if (Array.isArray(bypass) && bypass.length > 0) {
            process.env.no_proxy = bypass.join(',');
        }

        const httpAgent = http.globalAgent;
        const httpsAgent = https.globalAgent;

        const proxyAgent = new ProxyAgent({ httpAgent, httpsAgent, keepAlive: enableKeepAlive });

        http.globalAgent = proxyAgent;
        https.globalAgent = proxyAgent;

        console.info();
        console.info(color.green(LOG_HEADER), 'Proxy URL is used:', color.blue(url));
        console.info();
    } catch (error) {
        console.error(color.red(LOG_HEADER), 'Failed to initialize request proxy:', error);
    }
}
