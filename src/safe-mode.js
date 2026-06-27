// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import fs from 'node:fs';
import path from 'node:path';

import { getAllUserHandles, getUserDirectories } from './users.js';
import { getSettingsRepo } from './storage/index.js';
import { PUBLIC_DIRECTORIES } from './constants.js';

const SENTINEL_FILE_NAME = '.luker-safe-mode.json';
const APPLIED_LOG_FILE_NAME = '.luker-safe-mode-applied.log';

/**
 * If the native layer (boot watchdog) decided the previous launch died before
 * the server became reachable, it drops a sentinel file at `<dataRoot>/.luker-safe-mode.json`.
 * On the next launch we expand `disabledExtensions` in every user's settings
 * to cover every third-party extension currently on disk, then remove the
 * sentinel. The user can re-enable extensions one by one from the UI to find
 * the offending one without losing their other state.
 *
 * The sentinel-and-extension dance happens in the Node server, not in
 * native, so it works regardless of storage mode (fs/sqlite/mysql/postgres) —
 * SettingsRepo abstracts the backend.
 *
 * @param {string} dataRoot Absolute path to the data root.
 * @returns {Promise<void>}
 */
export async function applyPendingSafeMode(dataRoot) {
    const sentinel = path.join(dataRoot, SENTINEL_FILE_NAME);
    if (!fs.existsSync(sentinel)) {
        return;
    }

    let sentinelReason = '<unspecified>';
    try {
        const raw = fs.readFileSync(sentinel, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.reason === 'string') {
            sentinelReason = parsed.reason;
        }
    } catch {
        // Sentinel may be empty or malformed — treat as "applied with unknown reason".
    }

    const globalExtensions = listExtensionDirs(PUBLIC_DIRECTORIES.globalExtensions, 'third-party/');
    const handles = await getAllUserHandles();
    const repo = getSettingsRepo();

    let disabledCount = 0;
    let userCount = 0;
    for (const handle of handles) {
        const directories = getUserDirectories(handle);
        const localExtensions = listExtensionDirs(directories.extensions, 'third-party/');
        const allNames = [...new Set([...globalExtensions, ...localExtensions])];
        if (allNames.length === 0) continue;

        const settings = (await repo.get(handle)) ?? {};
        if (!settings.extension_settings || typeof settings.extension_settings !== 'object') {
            settings.extension_settings = {};
        }
        const existing = Array.isArray(settings.extension_settings.disabledExtensions)
            ? settings.extension_settings.disabledExtensions
            : [];
        const merged = [...new Set([...existing, ...allNames])];
        if (merged.length === existing.length) continue;

        settings.extension_settings.disabledExtensions = merged;
        await repo.save(handle, settings);
        disabledCount += (merged.length - existing.length);
        userCount += 1;
    }

    const summary = {
        appliedAt: new Date().toISOString(),
        reason: sentinelReason,
        userCount,
        disabledCount,
        globalExtensions,
    };

    try {
        const appliedLog = path.join(dataRoot, APPLIED_LOG_FILE_NAME);
        fs.writeFileSync(appliedLog, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    } catch (err) {
        console.warn('safe-mode: failed to write applied log', err?.message || err);
    }

    try {
        fs.unlinkSync(sentinel);
    } catch (err) {
        console.warn('safe-mode: failed to remove sentinel; next launch may re-disable', err?.message || err);
    }

    console.log(
        `safe-mode: applied (reason=${sentinelReason}); disabled ${disabledCount} extension(s) ` +
        `across ${userCount} user(s).`,
    );
}

function listExtensionDirs(baseDir, prefix) {
    if (!baseDir || !fs.existsSync(baseDir)) {
        return [];
    }
    try {
        return fs
            .readdirSync(baseDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${prefix}${entry.name}`);
    } catch {
        return [];
    }
}
