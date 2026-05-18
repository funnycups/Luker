// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import storage from 'node-persist';

const ADMIN_SETTINGS_KEY = 'luker:admin-settings:v1';

const DEFAULT_ADMIN_SETTINGS = Object.freeze({
    storage: {
        defaultUserQuotaBytes: -1,
    },
    accountRegistration: {
        enabled: false,
    },
    oauth: {
        github: {
            enabled: false,
            clientId: '',
            clientSecret: '',
            allowAutoCreate: false,
        },
        discord: {
            enabled: false,
            clientId: '',
            clientSecret: '',
            allowAutoCreate: false,
            requireGuildMembership: false,
            allowedGuildIds: [],
            requiredRoleIds: [],
            scopes: ['email'],
        },
    },
});

function cloneDefaultSettings() {
    return JSON.parse(JSON.stringify(DEFAULT_ADMIN_SETTINGS));
}

function normalizeQuotaBytes(value) {
    if (value === undefined || value === null || value === '') {
        return -1;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
        return -1;
    }

    const rounded = Math.floor(parsed);
    if (rounded < 0) {
        return -1;
    }

    return rounded;
}

function normalizeIdList(value) {
    const rawList = Array.isArray(value)
        ? value
        : String(value || '')
            .split(/[\n,]/g)
            .map(x => x.trim());

    const out = [];
    const seen = new Set();
    for (const item of rawList) {
        if (!item) {
            continue;
        }

        if (seen.has(item)) {
            continue;
        }

        seen.add(item);
        out.push(item);
    }

    return out;
}

function normalizeScopeList(value) {
    const rawList = Array.isArray(value)
        ? value
        : String(value || '')
            .split(/[\s,\n,]/g)
            .map(x => x.trim());

    const out = [];
    const seen = new Set();
    for (const item of rawList) {
        const scope = String(item || '').trim().toLowerCase();
        if (!scope) {
            continue;
        }

        if (!/^[a-z0-9._:-]+$/i.test(scope)) {
            continue;
        }

        if (seen.has(scope)) {
            continue;
        }

        seen.add(scope);
        out.push(scope);
    }

    return out;
}

/**
 * Normalizes and sanitizes admin settings.
 * @param {any} rawSettings Raw settings from storage or request body
 * @returns {import('./types/admin-settings.js').AdminSettings}
 */
export function sanitizeAdminSettings(rawSettings) {
    const defaults = cloneDefaultSettings();
    const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const discordSource = source?.oauth?.discord && typeof source.oauth.discord === 'object'
        ? source.oauth.discord
        : {};
    const hasExplicitDiscordScopes = Object.prototype.hasOwnProperty.call(discordSource, 'scopes');
    const discordScopesSource = hasExplicitDiscordScopes
        ? discordSource.scopes
        : defaults.oauth.discord.scopes;

    const settings = {
        storage: {
            defaultUserQuotaBytes: normalizeQuotaBytes(source?.storage?.defaultUserQuotaBytes ?? defaults.storage.defaultUserQuotaBytes),
        },
        accountRegistration: {
            enabled: Boolean(source?.accountRegistration?.enabled),
        },
        oauth: {
            github: {
                enabled: Boolean(source?.oauth?.github?.enabled),
                clientId: String(source?.oauth?.github?.clientId || '').trim(),
                clientSecret: String(source?.oauth?.github?.clientSecret || '').trim(),
                allowAutoCreate: Boolean(source?.oauth?.github?.allowAutoCreate),
            },
            discord: {
                enabled: Boolean(source?.oauth?.discord?.enabled),
                clientId: String(source?.oauth?.discord?.clientId || '').trim(),
                clientSecret: String(source?.oauth?.discord?.clientSecret || '').trim(),
                allowAutoCreate: Boolean(source?.oauth?.discord?.allowAutoCreate),
                requireGuildMembership: Boolean(source?.oauth?.discord?.requireGuildMembership),
                allowedGuildIds: normalizeIdList(source?.oauth?.discord?.allowedGuildIds),
                requiredRoleIds: normalizeIdList(source?.oauth?.discord?.requiredRoleIds),
                scopes: normalizeScopeList(discordScopesSource),
            },
        },
    };

    return settings;
}

/**
 * Reads admin settings from persistent storage.
 * @returns {Promise<import('./types/admin-settings.js').AdminSettings>} Admin settings
 */
export async function getAdminSettings() {
    const stored = await storage.getItem(ADMIN_SETTINGS_KEY);
    return sanitizeAdminSettings(stored);
}

/**
 * Saves admin settings to persistent storage.
 * @param {any} settings Raw settings
 * @returns {Promise<import('./types/admin-settings.js').AdminSettings>} Saved normalized settings
 */
export async function saveAdminSettings(settings) {
    const normalized = sanitizeAdminSettings(settings);
    await storage.setItem(ADMIN_SETTINGS_KEY, normalized);
    return normalized;
}

/**
 * Gets the effective quota bytes for a user.
 * @param {import('./users.js').User} user User object
 * @param {import('./types/admin-settings.js').AdminSettings} adminSettings Admin settings
 * @returns {number} Effective quota in bytes. -1 means unlimited.
 */
export function getEffectiveUserQuotaBytes(user, adminSettings) {
    const userQuota = normalizeQuotaBytes(user?.storageQuotaBytes);
    if (userQuota >= 0) {
        return userQuota;
    }

    return normalizeQuotaBytes(adminSettings?.storage?.defaultUserQuotaBytes);
}

/**
 * Calculates total size of a directory recursively.
 * @param {string} directory Directory path
 * @returns {Promise<number>} Total size in bytes
 */
export async function getDirectorySizeBytes(directory) {
    let totalSize = 0;
    const stack = [directory];

    while (stack.length > 0) {
        const current = stack.pop();
        /** @type {import('node:fs').Dirent[]} */
        let entries = [];

        try {
            entries = await fsPromises.readdir(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);

            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            try {
                const stat = await fsPromises.stat(fullPath);
                totalSize += stat.size;
            } catch {
                // Ignore unreadable files
            }
        }
    }

    return totalSize;
}

