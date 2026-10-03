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

/**
 * LAN-sync session endpoints carry their own bearer token (issued by
 * `src/sync/session.js`) and must therefore bypass HTTP basic auth. The
 * sibling `/api/sync/v1/health` route is intentionally excluded from this
 * pattern — it is a reachability probe and stays gated by basic auth.
 *
 * `/api/sync/v1/session/offer` is excluded by default: it is the route
 * that ISSUES tokens, so the browser-driven call goes through basic auth
 * (or the session cookie) to populate `request.user`. A cross-server
 * caller with no cookie can instead present the shared pairing secret in
 * `X-Sync-Peer-Secret`; that request is let through the middleware
 * because the route handler authenticates it against the peer registry
 * itself (wrong or absent secret still yields 401).
 */
const SYNC_SESSION_PATH_PATTERN = /^\/api\/sync\/v1\/session\//i;
const SYNC_OFFER_PATH_PATTERN = /^\/api\/sync\/v1\/session\/offer\/?$/i;
const SYNC_PEER_CREDENTIAL_HEADERS = ['x-sync-peer-secret', 'x-sync-pair-code'];

const basicAuthLimiter = new RateLimiterMemory({
    points: BASIC_AUTH_ATTEMPTS > 0 ? BASIC_AUTH_ATTEMPTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});

/**
 * Determine whether a request should skip the Basic Auth challenge because
 * an alternative auth boundary applies (LAN-sync bearer tokens, LAN
 * migration one-shot links, etc.).
 */
export function isBasicAuthExemptRequest(request) {
    const requestPath = typeof request?.path === 'string'
        ? request.path
        : String(request?.originalUrl || '').split('?')[0];
    const method = String(request?.method || '').toUpperCase();

    // LAN-sync session endpoints carry their own bearer token, so they
    // bypass basic auth on both GET (manifest, object fetch) and POST
    // (object upload, ref update, close). Other HTTP methods on sync
    // paths still fall through to the basic-auth gate below.
    //
    // `/session/offer` is the exception: it ISSUES tokens. A browser call
    // goes through basic auth so the standard user middleware can
    // populate `request.user`; a cross-server call presenting the shared
    // pairing secret is let through in multi-user mode because the route
    // handler authenticates it against the peer registry (wrong or
    // absent secret → 401 at the route, which also falls back to
    // basic-auth resolution). In single-user mode there is no registry
    // to verify against — the middleware would be the only gate — so the
    // secret does NOT bypass it there; the pair form's basic-auth fields
    // remain the path for a basic-auth-gated single-user peer.
    if (SYNC_SESSION_PATH_PATTERN.test(requestPath)) {
        if (SYNC_OFFER_PATH_PATTERN.test(requestPath)) {
            if (!ENABLE_ACCOUNTS) return false;
            const headers = request?.headers || {};
            return SYNC_PEER_CREDENTIAL_HEADERS.some(name => Boolean(headers[name]));
        }
        return method === 'GET' || method === 'POST';
    }

    // LAN-migration transfer URLs are GET-only (one-shot ZIP download).
    if (method !== 'GET') {
        return false;
    }
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
