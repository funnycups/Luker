/**
 * When applied, this middleware will ensure the request contains the required header for basic authentication and only
 * allow access to the endpoint after successful authentication.
 */
import { Buffer } from 'node:buffer';
import storage from 'node-persist';
import { getAllUserHandles, toKey, getPasswordHash } from '../users.js';
import { getConfigValue, safeReadFileSync } from '../util.js';
import { LAN_MIGRATION_PATH_PREFIX } from '../lan-migration.js';

const PER_USER_BASIC_AUTH = getConfigValue('perUserBasicAuth', false, 'boolean');
const ENABLE_ACCOUNTS = getConfigValue('enableUserAccounts', false, 'boolean');
const LAN_MIGRATION_TRANSFER_PATH_PATTERN = new RegExp(`^${LAN_MIGRATION_PATH_PREFIX}[a-f0-9]{64}$`, 'i');

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

const basicAuthMiddleware = async function (request, response, callback) {
    // LAN migration tokens are one-time, high-entropy secrets with a short TTL, so this
    // public transfer route can safely rely on the token instead of a second auth challenge.
    if (isBasicAuthExemptRequest(request)) {
        return callback();
    }

    const unauthorizedWebpage = safeReadFileSync('./public/error/unauthorized.html') ?? '';
    const unauthorizedResponse = (res, reason = 'no_credentials') => {
        console.warn(`[basicAuth] 401 rejected: ${reason} path=${res.req?.path} ip=${res.req?.ip}`);
        res.set('WWW-Authenticate', 'Basic realm="Luker", charset="UTF-8"');
        return res.status(401).send(unauthorizedWebpage);
    };

    const basicAuthUserName = getConfigValue('basicAuthUser.username');
    const basicAuthUserPassword = getConfigValue('basicAuthUser.password');
    const authHeader = request.headers.authorization;

    if (!authHeader) {
        return unauthorizedResponse(response, 'missing_authorization');
    }

    const [scheme, credentials] = authHeader.split(' ');

    if (scheme !== 'Basic' || !credentials) {
        return unauthorizedResponse(response, 'invalid_scheme');
    }

    const usePerUserAuth = PER_USER_BASIC_AUTH && ENABLE_ACCOUNTS;
    const [username, ...passwordParts] = Buffer.from(credentials, 'base64')
        .toString('utf8')
        .split(':');
    const password = passwordParts.join(':');

    if (!usePerUserAuth && username === basicAuthUserName && password === basicAuthUserPassword) {
        return callback();
    } else if (usePerUserAuth) {
        const userHandles = await getAllUserHandles();
        for (const userHandle of userHandles) {
            if (username === userHandle) {
                const user = await storage.getItem(toKey(userHandle));
                if (user && user.enabled && (user.password && user.password === getPasswordHash(password, user.salt))) {
                    return callback();
                }
            }
        }
    }
    return unauthorizedResponse(response);
};

export default basicAuthMiddleware;
