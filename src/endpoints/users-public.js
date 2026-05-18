import crypto from 'node:crypto';

import storage from 'node-persist';
import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getIpAddress, retryAfter } from '../express-common.js';
import { color, Cache, getConfigValue } from '../util.js';
import { getAdminSettings } from '../admin-settings.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import { KEY_PREFIX, getUserAvatar, toKey, getPasswordHash, getPasswordSalt, getAccountVersion, getAllUserHandles, getUserDirectories, ensurePublicDirectoriesExist, createBackupArchive } from '../users.js';
import { consumeLanMigrationOffer } from '../lan-migration.js';

const DISCREET_LOGIN = getConfigValue('enableDiscreetLogin', false, 'boolean');
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const LOGIN_POINTS = getConfigValue('rateLimiting.accountsLoginMaxAttempts', 5, 'number');
const RECOVER_POINTS = getConfigValue('rateLimiting.accountsRecoverMaxAttempts', 5, 'number');
const REGISTER_POINTS = getConfigValue('rateLimiting.accountsRegisterMaxAttempts', 3, 'number');
const MFA_CACHE = new Cache(5 * 60 * 1000);
const OAUTH_STATE_CACHE = new Cache(10 * 60 * 1000);

const generateRecoveryCode = () => Array.from({ length: 6 }, () => crypto.randomInt(0, 10)).join('');

export const router = express.Router();
const loginLimiter = new RateLimiterMemory({
    points: LOGIN_POINTS > 0 ? LOGIN_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});
const recoverLimiter = new RateLimiterMemory({
    points: RECOVER_POINTS > 0 ? RECOVER_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});
const registerLimiter = new RateLimiterMemory({
    points: REGISTER_POINTS > 0 ? REGISTER_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});

function getBaseUrl(request) {
    const forwardedProto = request.get('x-forwarded-proto');
    const protocol = forwardedProto || request.protocol || 'http';
    const host = request.get('x-forwarded-host') || request.get('host');
    return `${protocol}://${host}`;
}

function getOAuthProviderSettings(provider, settings) {
    if (provider === 'github') {
        return settings?.oauth?.github;
    }

    if (provider === 'discord') {
        return settings?.oauth?.discord;
    }

    return null;
}

function toKebabHandle(value) {
    const candidate = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return candidate || 'user';
}

function sanitizeRequestedHandle(value) {
    const trimmed = String(value || '').toLowerCase().trim();
    if (!trimmed) {
        return '';
    }
    return trimmed
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}

async function findUserByOAuth(provider, externalId) {
    /** @type {import('../users.js').User[]} */
    const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));
    return users.find(user => String(user?.oauth?.[provider]?.id || '') === String(externalId)) || null;
}

async function createUserFromOAuth(provider, profile, adminSettings) {
    const handles = await getAllUserHandles();
    const seed = provider === 'github'
        ? (profile?.login || profile?.name || profile?.email || 'github-user')
        : (profile?.username || profile?.global_name || profile?.email || 'discord-user');

    const baseHandle = toKebabHandle(seed);
    let handle = baseHandle;
    let suffix = 2;
    while (handles.includes(handle)) {
        handle = `${baseHandle}-${suffix++}`;
    }

    const salt = getPasswordSalt();
    const defaultQuotaBytes = Number(adminSettings?.storage?.defaultUserQuotaBytes);
    const identity = provider === 'github'
        ? {
            id: String(profile.id),
            login: String(profile.login || ''),
            email: String(profile.email || ''),
        }
        : {
            id: String(profile.id),
            username: String(profile.username || ''),
            email: String(profile.email || ''),
        };

    /** @type {import('../users.js').User} */
    const newUser = {
        handle,
        name: String(profile.name || profile.username || profile.login || handle),
        created: Date.now(),
        password: '',
        salt: salt,
        admin: false,
        enabled: true,
        oauth: {
            [provider]: identity,
        },
        storageQuotaBytes: Number.isFinite(defaultQuotaBytes) && defaultQuotaBytes >= 0 ? Math.floor(defaultQuotaBytes) : undefined,
    };

    await storage.setItem(toKey(handle), newUser);
    await ensurePublicDirectoriesExist();
    const directories = getUserDirectories(handle);
    await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);

    return newUser;
}

async function fetchGitHubProfile(accessToken) {
    const userResponse = await fetch('https://api.github.com/user', {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'Luker OAuth',
        },
    });
    if (!userResponse.ok) {
        throw new Error('Failed to fetch GitHub profile');
    }
    const user = await userResponse.json();

    if (!user.email) {
        const emailResponse = await fetch('https://api.github.com/user/emails', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'Luker OAuth',
            },
        });

        if (emailResponse.ok) {
            const emails = await emailResponse.json();
            const primary = emails.find(x => x.primary && x.verified) || emails.find(x => x.verified) || emails[0];
            user.email = primary?.email || '';
        }
    }

    return user;
}

async function validateDiscordGuildMembership(accessToken, providerSettings) {
    if (!providerSettings?.requireGuildMembership) {
        return { ok: true };
    }

    const allowedGuildIds = Array.isArray(providerSettings.allowedGuildIds) ? providerSettings.allowedGuildIds : [];
    if (!allowedGuildIds.length) {
        return { ok: false, reason: 'Discord server allowlist is empty.' };
    }

    const guildResponse = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
        },
    });

    if (!guildResponse.ok) {
        return { ok: false, reason: 'Unable to verify Discord server membership.' };
    }

    const guilds = await guildResponse.json();
    const matchedGuilds = guilds.filter(g => allowedGuildIds.includes(String(g.id)));

    if (!matchedGuilds.length) {
        return { ok: false, reason: 'Discord account is not in the required server.' };
    }

    const requiredRoleIds = Array.isArray(providerSettings.requiredRoleIds) ? providerSettings.requiredRoleIds : [];
    if (!requiredRoleIds.length) {
        return { ok: true };
    }

    for (const guild of matchedGuilds) {
        const memberResponse = await fetch(`https://discord.com/api/users/@me/guilds/${guild.id}/member`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
            },
        });

        if (!memberResponse.ok) {
            continue;
        }

        const member = await memberResponse.json();
        const roles = Array.isArray(member?.roles) ? member.roles.map(String) : [];
        if (requiredRoleIds.some(role => roles.includes(String(role)))) {
            return { ok: true };
        }
    }

    return { ok: false, reason: 'Discord account does not have the required role.' };
}

function redirectToLoginWithError(response, reason) {
    const params = new URLSearchParams();
    if (reason) {
        params.set('error', reason);
    }
    const suffix = params.toString();
    const target = suffix ? `/login?${suffix}` : '/login';
    return response.redirect(target);
}

router.get('/transfer/backup/:token', async (request, response) => {
    try {
        const offer = consumeLanMigrationOffer(request.params.token);
        if (!offer) {
            return response.status(410).send('Migration link expired or already used.');
        }

        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Robots-Tag', 'noindex');
        await createBackupArchive(offer.handle, response, offer.selection, {
            includeGlobalExtensions: Boolean(offer.includeGlobalExtensions),
        });
    } catch (error) {
        console.error('LAN migration backup transfer failed:', error);
        if (!response.headersSent) {
            return response.sendStatus(500);
        }
        response.end();
    }
});

router.post('/oauth/providers', async (_request, response) => {
    try {
        const settings = await getAdminSettings();
        const providers = {
            github: Boolean(settings?.oauth?.github?.enabled && settings?.oauth?.github?.clientId && settings?.oauth?.github?.clientSecret),
            discord: Boolean(settings?.oauth?.discord?.enabled && settings?.oauth?.discord?.clientId && settings?.oauth?.discord?.clientSecret),
        };

        return response.json({ providers });
    } catch (error) {
        console.error('OAuth providers request failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/registration/info', async (_request, response) => {
    try {
        const settings = await getAdminSettings();
        return response.json({ enabled: Boolean(settings?.accountRegistration?.enabled) });
    } catch (error) {
        console.error('Registration info request failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/register', async (request, response) => {
    try {
        const settings = await getAdminSettings();
        if (!settings?.accountRegistration?.enabled) {
            return response.status(403).json({ error: 'Account registration is disabled.' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await registerLimiter.consume(ip);

        const rawHandle = String(request.body?.handle || '').trim();
        const rawName = String(request.body?.name || '').trim();
        const password = String(request.body?.password || '');

        if (!rawHandle || !rawName || !password) {
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const handle = sanitizeRequestedHandle(rawHandle);
        if (!handle) {
            return response.status(400).json({ error: 'Invalid handle' });
        }

        const handles = await getAllUserHandles();
        if (handles.includes(handle)) {
            return response.status(409).json({ error: 'User already exists' });
        }

        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }

        const salt = getPasswordSalt();
        const defaultQuotaBytes = Number(settings?.storage?.defaultUserQuotaBytes);

        /** @type {import('../users.js').User} */
        const newUser = {
            handle,
            name: rawName,
            created: Date.now(),
            password: getPasswordHash(password, salt),
            salt,
            admin: false,
            enabled: true,
            storageQuotaBytes: Number.isFinite(defaultQuotaBytes) && defaultQuotaBytes >= 0 ? Math.floor(defaultQuotaBytes) : undefined,
        };

        await storage.setItem(toKey(handle), newUser);
        await ensurePublicDirectoriesExist();
        const directories = getUserDirectories(handle);
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);

        await registerLimiter.delete(ip);
        request.session.handle = newUser.handle;
        request.session.version = getAccountVersion(newUser);
        console.info('Registration successful:', newUser.handle, 'from', ip, 'at', new Date().toLocaleString());
        return response.json({ handle: newUser.handle });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.warn('Registration failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later.' });
        }

        console.error('Registration failed:', error);
        return response.sendStatus(500);
    }
});

router.get('/oauth/start/:provider', async (request, response) => {
    try {
        const provider = String(request.params.provider || '').toLowerCase();
        if (!['github', 'discord'].includes(provider)) {
            return redirectToLoginWithError(response, 'unsupported_provider');
        }

        if (!request.session) {
            return response.sendStatus(500);
        }

        const settings = await getAdminSettings();
        const providerSettings = getOAuthProviderSettings(provider, settings);
        if (!providerSettings?.enabled || !providerSettings?.clientId || !providerSettings?.clientSecret) {
            return redirectToLoginWithError(response, 'provider_not_configured');
        }

        const state = crypto.randomBytes(24).toString('hex');
        OAUTH_STATE_CACHE.set(state, { provider, issuedAt: Date.now() });
        const callbackUri = `${getBaseUrl(request)}/api/users/oauth/callback/${provider}`;

        if (provider === 'github') {
            const authUrl = new URL('https://github.com/login/oauth/authorize');
            authUrl.searchParams.set('client_id', providerSettings.clientId);
            authUrl.searchParams.set('redirect_uri', callbackUri);
            authUrl.searchParams.set('scope', 'read:user user:email');
            authUrl.searchParams.set('state', state);
            return response.redirect(authUrl.toString());
        }

        const authUrl = new URL('https://discord.com/api/oauth2/authorize');
        const configuredScopes = Array.isArray(providerSettings.scopes) ? providerSettings.scopes : [];
        const scopes = new Set(['identify']);
        for (const scope of configuredScopes) {
            const normalizedScope = String(scope || '').trim().toLowerCase();
            if (normalizedScope && normalizedScope !== 'identify') {
                scopes.add(normalizedScope);
            }
        }

        if (providerSettings.requireGuildMembership) {
            scopes.add('guilds');
            if ((providerSettings.requiredRoleIds || []).length > 0) {
                scopes.add('guilds.members.read');
            }
        }

        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', providerSettings.clientId);
        authUrl.searchParams.set('redirect_uri', callbackUri);
        authUrl.searchParams.set('scope', Array.from(scopes).join(' '));
        authUrl.searchParams.set('state', state);
        return response.redirect(authUrl.toString());
    } catch (error) {
        console.error('OAuth start failed:', error);
        return redirectToLoginWithError(response, 'oauth_start_failed');
    }
});

router.get('/oauth/callback/:provider', async (request, response) => {
    try {
        const provider = String(request.params.provider || '').toLowerCase();
        const code = String(request.query.code || '');
        const state = String(request.query.state || '');

        if (!['github', 'discord'].includes(provider) || !code || !state) {
            return redirectToLoginWithError(response, 'oauth_invalid_callback');
        }

        if (!request.session) {
            return response.sendStatus(500);
        }

        const cachedState = OAUTH_STATE_CACHE.get(state);
        OAUTH_STATE_CACHE.remove(state);
        if (!cachedState || cachedState.provider !== provider) {
            return redirectToLoginWithError(response, 'oauth_state_mismatch');
        }

        const settings = await getAdminSettings();
        const providerSettings = getOAuthProviderSettings(provider, settings);
        if (!providerSettings?.enabled || !providerSettings?.clientId || !providerSettings?.clientSecret) {
            return redirectToLoginWithError(response, 'provider_not_configured');
        }

        const callbackUri = `${getBaseUrl(request)}/api/users/oauth/callback/${provider}`;

        let accessToken = '';
        if (provider === 'github') {
            const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    client_id: providerSettings.clientId,
                    client_secret: providerSettings.clientSecret,
                    code,
                    redirect_uri: callbackUri,
                }),
            });

            if (!tokenRes.ok) {
                return redirectToLoginWithError(response, 'oauth_token_failed');
            }

            const tokenData = await tokenRes.json();
            accessToken = String(tokenData.access_token || '');
        } else {
            const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    client_id: providerSettings.clientId,
                    client_secret: providerSettings.clientSecret,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: callbackUri,
                }).toString(),
            });

            if (!tokenRes.ok) {
                return redirectToLoginWithError(response, 'oauth_token_failed');
            }

            const tokenData = await tokenRes.json();
            accessToken = String(tokenData.access_token || '');
        }

        if (!accessToken) {
            return redirectToLoginWithError(response, 'oauth_token_empty');
        }

        let profile = null;
        if (provider === 'github') {
            profile = await fetchGitHubProfile(accessToken);
        } else {
            const profileRes = await fetch('https://discord.com/api/users/@me', {
                headers: { 'Authorization': `Bearer ${accessToken}` },
            });

            if (!profileRes.ok) {
                return redirectToLoginWithError(response, 'oauth_profile_failed');
            }

            profile = await profileRes.json();
        }

        if (!profile?.id) {
            return redirectToLoginWithError(response, 'oauth_profile_failed');
        }

        if (provider === 'discord') {
            const membership = await validateDiscordGuildMembership(accessToken, providerSettings);
            if (!membership.ok) {
                return redirectToLoginWithError(response, 'discord_guild_check_failed');
            }
        }

        let user = await findUserByOAuth(provider, String(profile.id));

        if (!user) {
            if (!providerSettings.allowAutoCreate) {
                return redirectToLoginWithError(response, 'oauth_user_not_linked');
            }

            user = await createUserFromOAuth(provider, profile, settings);
        } else if (!user.enabled) {
            return redirectToLoginWithError(response, 'oauth_user_disabled');
        }

        if (!user.oauth || !user.oauth[provider] || String(user.oauth[provider].id) !== String(profile.id)) {
            user.oauth = user.oauth || {};
            user.oauth[provider] = provider === 'github'
                ? {
                    id: String(profile.id),
                    login: String(profile.login || ''),
                    email: String(profile.email || ''),
                }
                : {
                    id: String(profile.id),
                    username: String(profile.username || ''),
                    email: String(profile.email || ''),
                };
            await storage.setItem(toKey(user.handle), user);
        }

        request.session.handle = user.handle;
        return response.redirect('/');
    } catch (error) {
        console.error('OAuth callback failed:', error);
        return redirectToLoginWithError(response, 'oauth_callback_failed');
    }
});

router.post('/list', async (_request, response) => {
    try {
        if (DISCREET_LOGIN) {
            return response.sendStatus(204);
        }

        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        /** @type {Promise<import('../users.js').UserViewModel>[]} */
        const viewModelPromises = users
            .filter(x => x.enabled)
            .map(user => new Promise(async (resolve) => {
                getUserAvatar(user.handle).then(avatar =>
                    resolve({
                        handle: user.handle,
                        name: user.name,
                        created: user.created,
                        avatar: avatar,
                        password: !!user.password,
                    }),
                );
            }));

        const viewModels = await Promise.all(viewModelPromises);
        viewModels.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
        return response.json(viewModels);
    } catch (error) {
        console.error('User list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/login', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Login failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await loginLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Login failed: User', request.body.handle, 'not found');
            return response.status(403).json({ error: 'Incorrect credentials' });
        }

        if (!user.enabled) {
            console.warn('Login failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        if (user.password && user.password !== getPasswordHash(request.body.password, user.salt)) {
            console.warn('Login failed: Incorrect password for', user.handle);
            return response.status(403).json({ error: 'Incorrect credentials' });
        }

        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }

        await loginLimiter.delete(ip);
        request.session.handle = user.handle;
        request.session.version = getAccountVersion(user);
        console.info('Login successful:', user.handle, 'from', ip, 'at', new Date().toLocaleString());
        return response.json({ handle: user.handle });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Login failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or recover your password.' });
        }

        console.error('Login failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/recover-step1', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Recover step 1 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await recoverLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Recover step 1 failed: User', request.body.handle, 'not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            console.error('Recover step 1 failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        const mfaCode = generateRecoveryCode();
        console.log();
        console.log(color.blue(`${user.name}, your password recovery code is: `) + color.magenta(mfaCode));
        console.log();
        MFA_CACHE.set(user.handle, mfaCode);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Recover step 1 failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        console.error('Recover step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/recover-step2', async (request, response) => {
    try {
        if (!request.body.handle || !request.body.code) {
            console.warn('Recover step 2 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));
        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        const rateLimit = await recoverLimiter.get(ip);

        if (rateLimit !== null && rateLimit.consumedPoints > recoverLimiter.points) {
            throw rateLimit;
        }

        if (!user) {
            console.error('Recover step 2 failed: User', request.body.handle, 'not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            console.warn('Recover step 2 failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        const mfaCode = MFA_CACHE.get(user.handle);

        if (request.body.code !== mfaCode) {
            await recoverLimiter.consume(ip);
            console.warn('Recover step 2 failed: Incorrect code');
            return response.status(403).json({ error: 'Incorrect code' });
        }

        if (request.body.newPassword) {
            const salt = getPasswordSalt();
            user.password = getPasswordHash(request.body.newPassword, salt);
            user.salt = salt;
            await storage.setItem(toKey(user.handle), user);
        } else {
            user.password = '';
            user.salt = '';
            await storage.setItem(toKey(user.handle), user);
        }

        if (request.session && request.session.handle === user.handle) {
            request.session.version = getAccountVersion(user);
        }

        await recoverLimiter.delete(ip);
        MFA_CACHE.remove(user.handle);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Recover step 2 failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        console.error('Recover step 2 failed:', error);
        return response.sendStatus(500);
    }
});
