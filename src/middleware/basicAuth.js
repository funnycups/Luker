/**
 * When applied, this middleware will ensure the request contains the required header for basic authentication and only
 * allow access to the endpoint after successful authentication.
 */
import { Buffer } from 'node:buffer';
import path from 'node:path';
import storage from 'node-persist';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getAllUserHandles, toKey, getPasswordHash } from '../users.js';
import { getConfigValue, safeReadFileSync } from '../util.js';
import { LAN_MIGRATION_PATH_PREFIX } from '../lan-migration.js';
import { getIpAddress } from '../express-common.js';

const PER_USER_BASIC_AUTH = !!getConfigValue('perUserBasicAuth', false, 'boolean');
const ENABLE_ACCOUNTS = !!getConfigValue('enableUserAccounts', false, 'boolean');
const PREFER_REAL_IP_HEADER = !!getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const BASIC_AUTH_ATTEMPTS = getConfigValue('rateLimiting.basicAuthMaxAttempts', 5, 'number');
const LAN_MIGRATION_TRANSFER_PATH_PATTERN = new RegExp(`^${LAN_MIGRATION_PATH_PREFIX}[a-f0-9]{64}$`, 'i');

const basicAuthLimiter = new RateLimiterMemory({
    points: BASIC_AUTH_ATTEMPTS > 0 ? BASIC_AUTH_ATTEMPTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});

/**
 * Marker for requests dispatched in-process by the WS proxy. Such requests
 * already crossed the WS authentication boundary and must not be re-challenged
 * by Basic Auth, which is an HTTP-layer gate the WS upgrade itself cannot
 * always carry (browsers / tunnels frequently strip Authorization on upgrade).
 *
 * Set on the mock IncomingMessage in `src/ws-proxy.js`. Symbol-keyed so it
 * cannot be smuggled in via headers or query params.
 */
export const WS_PROXY_AUTH_BYPASS = Symbol('WS_PROXY_AUTH_BYPASS');

export function isBasicAuthExemptRequest(request) {
    const method = String(request?.method || '').toUpperCase();
    if (method !== 'GET') {
        return false;
    }

    const requestPath = typeof request?.path === 'string'
        ? request.path
        : String(request?.originalUrl || '').split('?')[0];
    return LAN_MIGRATION_TRANSFER_PATH_PATTERN.test(requestPath);
}

/**
 * Validate Basic Auth credentials on a request without sending a response.
 * Used by both the Express middleware and the WS upgrade gate so the WS
 * channel itself can serve as the auth boundary.
 *
 * @param {{ headers: Record<string, any>, ip?: string }} request
 * @returns {Promise<{ ok: boolean, reason?: string, status?: number, retryAfter?: number }>}
 */
export async function tryBasicAuth(request) {
    const ip = request.ip || getIpAddress(request, PREFER_REAL_IP_HEADER);

    const basicAuthUserName = getConfigValue('basicAuthUser.username');
    const basicAuthUserPassword = getConfigValue('basicAuthUser.password');
    const authHeader = request.headers?.authorization;

    if (!authHeader) {
        return { ok: false, reason: 'missing_authorization', status: 401 };
    }

    const [scheme, credentials] = authHeader.split(' ');

    if (scheme !== 'Basic' || !credentials) {
        return { ok: false, reason: 'invalid_scheme', status: 401 };
    }

    try {
        const rateLimit = await basicAuthLimiter.get(ip);
        if (rateLimit !== null && rateLimit.consumedPoints > basicAuthLimiter.points) {
            throw rateLimit;
        }

        const usePerUserAuth = PER_USER_BASIC_AUTH && ENABLE_ACCOUNTS;
        const [username, ...passwordParts] = Buffer.from(credentials, 'base64')
            .toString('utf8')
            .split(':');
        const password = passwordParts.join(':');

        if (!usePerUserAuth && username === basicAuthUserName && password === basicAuthUserPassword) {
            await basicAuthLimiter.delete(ip);
            return { ok: true };
        } else if (usePerUserAuth) {
            const userHandles = await getAllUserHandles();
            for (const userHandle of userHandles) {
                if (username === userHandle) {
                    const user = await storage.getItem(toKey(userHandle));
                    if (user && user.enabled && (user.password && user.password === getPasswordHash(password, user.salt))) {
                        await basicAuthLimiter.delete(ip);
                        return { ok: true };
                    }
                }
            }
            await basicAuthLimiter.consume(ip);
            return { ok: false, reason: 'wrong_user_credentials', status: 401 };
        }

        await basicAuthLimiter.consume(ip);
        return { ok: false, reason: 'wrong_credentials', status: 401 };
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return {
                ok: false,
                reason: 'rate_limited',
                status: 429,
                retryAfter: Math.ceil(error.msBeforeNext / 1000),
            };
        }
        throw error;
    }
}

const basicAuthMiddleware = async function (request, response, callback) {
    // WS proxy dispatches in-process requests through app.handle(); the WS
    // connection itself is the auth boundary (validated at the upgrade), so
    // re-running Basic Auth here would just duplicate work.
    if (request[WS_PROXY_AUTH_BYPASS] === true) {
        return callback();
    }

    // LAN migration tokens are one-time, high-entropy secrets with a short TTL, so this
    // public transfer route can safely rely on the token instead of a second auth challenge.
    if (isBasicAuthExemptRequest(request)) {
        return callback();
    }

    const unauthorizedResponse = (res, reason = 'no_credentials') => {
        console.warn(`[basicAuth] 401 rejected: ${reason} path=${res.req?.path} ip=${res.req?.ip}`);
        const unauthorizedWebpage = safeReadFileSync(path.join(globalThis.DATA_ROOT, '_errors', 'unauthorized.html')) ?? '';
        res.set('WWW-Authenticate', 'Basic realm="Luker", charset="UTF-8"');
        return res.status(401).send(unauthorizedWebpage);
    };

    try {
        const result = await tryBasicAuth(request);
        if (result.ok) {
            return callback();
        }
        if (result.status === 429) {
            console.error('Basic auth failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER), request.method, request.originalUrl);
            response.set('Retry-After', String(result.retryAfter ?? 60));
            return response.sendStatus(429);
        }
        return unauthorizedResponse(response, result.reason);
    } catch (error) {
        console.error('Basic auth error:', error);
        return response.sendStatus(500);
    }
};

export default basicAuthMiddleware;
