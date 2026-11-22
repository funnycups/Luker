// SPDX-License-Identifier: AGPL-3.0-or-later

import { makeIllustrationId } from '../illustration/presets.js';
import {
    buildCompactProfileIndex,
    normalizeCharacterProfile,
    profileVersion,
} from '../character-archive/store.js';
import { i18n } from '../lens/i18n.js';

function cloneData(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertSandboxExpectedVersion(profile, expectedVersion, exists) {
    if (expectedVersion === undefined) {
        return;
    }
    const changed = expectedVersion === null ? exists : profileVersion(profile) !== expectedVersion;
    if (changed) {
        throw new Error(i18n('The character profile changed. Reload it before continuing.'));
    }
}

/**
 * Private in-memory ProfileStore sharing the exact async CRUD and sync index
 * contract of `createCharacterProfileStore`, without touching GlobalState or
 * aliasing caller drafts. Temporary `/user/images/_sandbox_tmp/` references are
 * retained for draft/simulation previews.
 *
 * @param {Array<object>} [seedCharacters=[]]
 */
export function createSandboxProfileStore(seedCharacters = []) {
    const profiles = new Map();
    const recordedChanges = new Map();

    if (Array.isArray(seedCharacters)) {
        for (const raw of seedCharacters) {
            const copy = cloneData(raw);
            const fallbackNow = Number.isFinite(Number(copy?.updatedAt))
                ? Number(copy.updatedAt)
                : (Number.isFinite(Number(copy?.createdAt)) ? Number(copy.createdAt) : 0);
            const clean = normalizeCharacterProfile(copy, fallbackNow);
            if (clean) {
                profiles.set(clean.id, clean);
            }
        }
    }

    return {
        async listProfiles() {
            return [...profiles.values()]
                .sort((a, b) => (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name))
                .map(cloneData);
        },

        async getProfile(id) {
            const target = String(id || '').trim();
            if (!target) {
                return null;
            }
            const found = profiles.get(target);
            return found ? cloneData(found) : null;
        },

        async getProfilesByIds(ids = []) {
            if (!Array.isArray(ids) || ids.length === 0) {
                return [];
            }
            const out = [];
            const seen = new Set();
            for (const rawId of ids) {
                const id = String(rawId || '').trim();
                if (!id || seen.has(id) || !profiles.has(id)) {
                    continue;
                }
                seen.add(id);
                out.push(cloneData(profiles.get(id)));
            }
            return out;
        },

        buildCompactProfileIndex(list, options) {
            return buildCompactProfileIndex(list, options);
        },

        async upsertProfile(input, now = Date.now(), { expectedVersion } = {}) {
            const safeInput = input && typeof input === 'object' ? cloneData(input) : {};
            const requestedId = String(safeInput.id || '').trim();
            const exists = Boolean(requestedId && profiles.has(requestedId));
            const previous = exists ? cloneData(profiles.get(requestedId)) : null;
            assertSandboxExpectedVersion(previous, expectedVersion, exists);

            const merged = normalizeCharacterProfile({
                ...(previous || {}),
                ...safeInput,
                id: previous?.id || requestedId || makeIllustrationId('char'),
                createdAt: previous?.createdAt ?? safeInput.createdAt ?? now,
                updatedAt: now,
            }, now);

            if (!merged) {
                throw new Error('Character profile requires a non-empty name.');
            }
            profiles.set(merged.id, cloneData(merged));
            recordedChanges.set(merged.id, cloneData(merged));
            return cloneData(merged);
        },

        async deleteProfile(id, { expectedVersion } = {}) {
            const target = String(id || '').trim();
            if (!target) {
                return false;
            }
            const exists = profiles.has(target);
            const previous = exists ? cloneData(profiles.get(target)) : null;
            assertSandboxExpectedVersion(previous, expectedVersion, exists);
            if (!exists) {
                return false;
            }
            profiles.delete(target);
            recordedChanges.delete(target);
            return true;
        },

        getRecordedChanges() {
            return [...recordedChanges.values()].map(cloneData);
        },
    };
}
