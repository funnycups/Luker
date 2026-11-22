// SPDX-License-Identifier: AGPL-3.0-or-later

import { makeIllustrationId } from '../illustration/presets.js';
import { i18n } from '../lens/i18n.js';
import { normalizeLocalImagePath } from '../media-path.js';

export const CHARACTER_PROFILES_NAMESPACE = 'sd_character_profiles';
export const CHARACTER_PROFILES_VERSION = 2;

const VALID_AGENT_PROFILE_MODES = new Set(['text_only', 'image_only', 'text_and_image']);

function cleanStringList(list) {
    if (!Array.isArray(list)) {
        return [];
    }
    const out = [];
    const seen = new Set();
    for (const item of list) {
        const trimmed = String(item ?? '').trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function parseFiniteTimestamp(value, fallback) {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function stripUndefinedFields(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) {
            out[key] = value;
        }
    }
    return out;
}

export function normalizeReferenceImageEntry(raw) {
    if (typeof raw === 'string') {
        const path = raw.trim();
        return path ? { path, label: '' } : null;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const path = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (!path) {
        return null;
    }
    const label = String(raw.label ?? '').trim();
    return { path, label };
}

function normalizeReferenceImages(list) {
    if (!Array.isArray(list)) {
        return [];
    }
    const out = [];
    const byPath = new Map();
    for (const item of list) {
        const entry = normalizeReferenceImageEntry(item);
        if (!entry) {
            continue;
        }
        const existing = byPath.get(entry.path);
        if (existing) {
            if (!existing.label && entry.label) {
                existing.label = entry.label;
            }
            continue;
        }
        byPath.set(entry.path, entry);
        out.push(entry);
    }
    return out;
}

export function normalizeCharacterProfile(raw, now = Date.now()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const name = String(raw.name ?? '').trim();
    if (!name) {
        return null;
    }
    const id = String(raw.id ?? '').trim() || makeIllustrationId('char');
    return {
        id,
        name,
        aliases: cleanStringList(raw.aliases),
        sourceWork: String(raw.sourceWork ?? '').trim(),
        description: String(raw.description ?? '').trim(),
        referenceImages: normalizeReferenceImages(raw.referenceImages),
        createdAt: parseFiniteTimestamp(raw.createdAt, now),
        updatedAt: parseFiniteTimestamp(raw.updatedAt, now),
    };
}

export function profileVersion(profile) {
    if (profile == null) return null;
    // An absent legacy timestamp must not make a version depend on the current clock.
    const normalized = normalizeCharacterProfile(profile, 0);
    return normalized ? JSON.stringify(normalized) : null;
}

function assertExpectedVersion(profile, expectedVersion, exists) {
    if (expectedVersion === undefined) return;
    const changed = expectedVersion === null ? exists : profileVersion(profile) !== expectedVersion;
    if (changed) {
        throw new Error(i18n('The character profile changed. Reload it before continuing.'));
    }
}

function orderV1OutfitsDefaultFirst(outfits, defaultOutfitId) {
    if (!Array.isArray(outfits) || outfits.length === 0) {
        return [];
    }
    const valid = outfits.filter(o => o && typeof o === 'object' && !Array.isArray(o));
    if (valid.length === 0) {
        return [];
    }
    const targetId = String(defaultOutfitId ?? '').trim();
    if (!targetId) {
        return valid;
    }
    const defaultIdx = valid.findIndex(o => String(o.id ?? '').trim() === targetId);
    if (defaultIdx <= 0) {
        return valid;
    }
    return [valid[defaultIdx], ...valid.slice(0, defaultIdx), ...valid.slice(defaultIdx + 1)];
}

export function migrateV1ProfileToV2(rawV1, now = Date.now()) {
    if (!rawV1 || typeof rawV1 !== 'object' || Array.isArray(rawV1)) {
        return null;
    }
    const name = String(rawV1.name ?? '').trim();
    if (!name) {
        return null;
    }

    const orderedOutfits = orderV1OutfitsDefaultFirst(rawV1.outfits, rawV1.defaultOutfitId);
    const sections = [];
    const baseDescription = String(rawV1.description ?? '').trim();
    const proseDescription = String(rawV1.proseDescription ?? '').trim();
    const canonicalTags = cleanStringList(rawV1.canonicalTags);
    const negativeTags = cleanStringList(rawV1.negativeTags);

    if (baseDescription) {
        sections.push(baseDescription);
    }
    if (proseDescription && proseDescription !== baseDescription) {
        sections.push(proseDescription);
    }
    if (canonicalTags.length > 0) {
        sections.push(`Tags: ${canonicalTags.join(', ')}`);
    }
    if (negativeTags.length > 0) {
        sections.push(`Avoid: ${negativeTags.join(', ')}`);
    }

    const imageCandidates = [];
    for (const outfit of orderedOutfits) {
        const outfitName = String(outfit.name ?? '').trim();
        const outfitProse = String(outfit.prose ?? '').trim();
        const outfitTags = cleanStringList(outfit.tags);
        const outfitParts = [];
        if (outfitProse) {
            outfitParts.push(outfitProse);
        }
        if (outfitTags.length > 0) {
            outfitParts.push(`tags: ${outfitTags.join(', ')}`);
        }
        if (outfitParts.length > 0) {
            const prefix = outfitName && outfitName !== 'Default'
                ? `Outfit (${outfitName}): `
                : 'Outfit: ';
            sections.push(`${prefix}${outfitParts.join(' — ')}`);
        }

        const outfitLabel = outfitName === 'Default' ? '' : outfitName;
        const outfitImages = Array.isArray(outfit.referenceImages)
            ? outfit.referenceImages
            : (Array.isArray(outfit.reference_images) ? outfit.reference_images : []);
        for (const item of outfitImages) {
            const entry = normalizeReferenceImageEntry(item);
            if (!entry) {
                continue;
            }
            imageCandidates.push({
                path: entry.path,
                label: entry.label || outfitLabel,
            });
        }
    }

    if (orderedOutfits.length === 0) {
        const fallbackTags = cleanStringList(rawV1.outfitTags);
        if (fallbackTags.length > 0) {
            sections.push(`Outfit: tags: ${fallbackTags.join(', ')}`);
        }
    }

    if (Array.isArray(rawV1.referenceImages)) {
        for (const item of rawV1.referenceImages) {
            const entry = normalizeReferenceImageEntry(item);
            if (entry) {
                imageCandidates.push(entry);
            }
        }
    }

    return normalizeCharacterProfile({
        id: rawV1.id,
        name,
        aliases: rawV1.aliases,
        sourceWork: rawV1.sourceWork,
        description: sections.join('\n\n'),
        referenceImages: normalizeReferenceImages(imageCandidates),
        createdAt: rawV1.createdAt,
        updatedAt: rawV1.updatedAt,
    }, now);
}

export function buildCompactProfileIndex(profiles = [], options = {}) {
    if (!Array.isArray(profiles) || profiles.length === 0) {
        return '';
    }
    const includeImages = options?.includeImages !== false;
    return profiles.map((profile, idx) => {
        const fields = [
            `${idx + 1}: id=${profile.id}`,
            `name=${profile.name}`,
        ];
        if (Array.isArray(profile.aliases) && profile.aliases.length > 0) {
            fields.push(`aliases=${profile.aliases.join(',')}`);
        }
        if (profile.sourceWork) {
            fields.push(`work=${profile.sourceWork}`);
        }
        if (includeImages) {
            const refs = normalizeReferenceImages(profile.referenceImages);
            const labels = refs.map(ref => ref.label).filter(Boolean);
            fields.push(labels.length > 0 ? `refs=${refs.length}(${labels.join(', ')})` : `refs=${refs.length}`);
        }
        return fields.join(' | ');
    }).join('\n');
}

export function formatCharacterProfileForAgent(profile, options = {}) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        return '';
    }
    const rawMode = options?.mode;
    const mode = rawMode == null ? 'text_and_image' : String(rawMode);
    if (!VALID_AGENT_PROFILE_MODES.has(mode)) {
        throw new Error(`Unsupported character profile format mode: ${mode}`);
    }
    const includeText = mode !== 'image_only';
    const includeImages = mode !== 'text_only';

    const lines = [
        `id: ${profile.id}`,
        `name: ${profile.name}`,
    ];
    if (Array.isArray(profile.aliases) && profile.aliases.length > 0) {
        lines.push(`aliases: ${profile.aliases.join(', ')}`);
    }
    if (profile.sourceWork) {
        lines.push(`work: ${profile.sourceWork}`);
    }
    if (includeText) {
        const description = String(profile.description ?? '').trim();
        lines.push(`description: ${description || '(none)'}`);
    }
    if (includeImages) {
        const refs = normalizeReferenceImages(profile.referenceImages);
        if (refs.length === 0) {
            lines.push('reference_images: (none)');
        } else {
            lines.push('reference_images:');
            refs.forEach((img, idx) => {
                lines.push(img.label
                    ? `  ${idx + 1}. path=${img.path} | label=${img.label}`
                    : `  ${idx + 1}. path=${img.path}`);
            });
        }
    }
    return lines.join('\n');
}

function normalizeProfilesObject(rawMap, normalizer) {
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
        return {};
    }
    const normalized = {};
    for (const [key, entry] of Object.entries(rawMap)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
        }
        const clean = normalizer({ ...entry, id: entry.id || key });
        if (clean) {
            normalized[clean.id] = clean;
        }
    }
    return normalized;
}

function resolveExistingProfilesForWrite(current, now) {
    const rawMap = current?.profiles;
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
        return {};
    }
    if (current?.version === CHARACTER_PROFILES_VERSION) {
        return { ...rawMap };
    }
    return normalizeProfilesObject(rawMap, entry => migrateV1ProfileToV2(entry, now));
}

async function readProfilesMap(context) {
    if (typeof context?.getGlobalState !== 'function') {
        throw new Error('GlobalState API (context.getGlobalState) is unavailable.');
    }
    const res = await context.getGlobalState(CHARACTER_PROFILES_NAMESPACE);
    if (!res?.ok) {
        throw new Error(`Failed to read character visual archive (${CHARACTER_PROFILES_NAMESPACE}): ${res?.hint || res?.reason || 'unknown error'}`);
    }
    const rawMap = res.state?.profiles;
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
        return {};
    }
    if (res.state?.version === CHARACTER_PROFILES_VERSION) {
        return normalizeProfilesObject(rawMap, entry => normalizeCharacterProfile(entry));
    }

    const now = Date.now();
    const migrated = normalizeProfilesObject(rawMap, entry => migrateV1ProfileToV2(entry, now));
    if (Object.keys(rawMap).length > 0 && typeof context?.updateGlobalState === 'function') {
        const writeRes = await context.updateGlobalState(CHARACTER_PROFILES_NAMESPACE, (current) => {
            if (current?.version === CHARACTER_PROFILES_VERSION) {
                return null;
            }
            const currentMap = current?.profiles;
            if (!currentMap || typeof currentMap !== 'object' || Array.isArray(currentMap)) {
                return null;
            }
            return {
                ...current,
                version: CHARACTER_PROFILES_VERSION,
                profiles: normalizeProfilesObject(currentMap, entry => migrateV1ProfileToV2(entry, now)),
            };
        }, { asyncDiff: false });

        if (!writeRes?.ok) {
            throw new Error(`Failed to migrate character visual archive (${CHARACTER_PROFILES_NAMESPACE}): ${writeRes?.hint || writeRes?.reason || 'unknown error'}`);
        }
        if (writeRes.state?.version === CHARACTER_PROFILES_VERSION && writeRes.state?.profiles) {
            return normalizeProfilesObject(writeRes.state.profiles, entry => normalizeCharacterProfile(entry));
        }
    }
    return migrated;
}

export function createCharacterProfileStore(context) {
    return {
        async listProfiles() {
            const map = await readProfilesMap(context);
            return Object.values(map).sort((a, b) => (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name));
        },

        async getProfile(id) {
            const target = String(id || '').trim();
            if (!target) {
                return null;
            }
            const map = await readProfilesMap(context);
            return map[target] || null;
        },

        async getProfilesByIds(ids = []) {
            if (!Array.isArray(ids) || ids.length === 0) {
                return [];
            }
            const map = await readProfilesMap(context);
            const out = [];
            const seen = new Set();
            for (const rawId of ids) {
                const id = String(rawId || '').trim();
                if (!id || seen.has(id) || !map[id]) {
                    continue;
                }
                seen.add(id);
                out.push(map[id]);
            }
            return out;
        },

        buildCompactProfileIndex(profiles, options) {
            return buildCompactProfileIndex(profiles, options);
        },

        async upsertProfile(input, now = Date.now(), { expectedVersion, transientSessionId } = {}) {
            if (typeof context?.updateGlobalState !== 'function') {
                throw new Error('GlobalState API (context.updateGlobalState) is unavailable.');
            }
            let savedProfile = null;
            const definedInput = stripUndefinedFields(input);
            const res = await context.updateGlobalState(CHARACTER_PROFILES_NAMESPACE, (current) => {
                const existingProfiles = resolveExistingProfilesForWrite(current, now);
                const requestedId = String(definedInput.id ?? '').trim();
                const exists = Boolean(requestedId && Object.hasOwn(existingProfiles, requestedId));
                const previous = exists
                    ? normalizeCharacterProfile({ ...existingProfiles[requestedId], id: requestedId }, now)
                    : null;
                assertExpectedVersion(previous, expectedVersion, exists);

                const merged = normalizeCharacterProfile({
                    ...(previous || {}),
                    ...definedInput,
                    id: previous?.id || requestedId || makeIllustrationId('char'),
                    createdAt: previous?.createdAt ?? definedInput.createdAt ?? now,
                    updatedAt: now,
                }, now);

                if (!merged) {
                    throw new Error('Character profile requires a non-empty name.');
                }
                for (const entry of merged.referenceImages) {
                    if (normalizeLocalImagePath(entry.path).toLowerCase().startsWith('/user/images/_sandbox_tmp/')) {
                        throw new Error(`${i18n('Promote temporary reference images before saving the character profile.')} ${entry.path}`);
                    }
                }
                existingProfiles[merged.id] = merged;
                savedProfile = merged;
                return {
                    ...current,
                    version: CHARACTER_PROFILES_VERSION,
                    profiles: existingProfiles,
                };
            }, { asyncDiff: false, transientSessionId });

            if (!res?.ok) {
                throw new Error(`Failed to persist character profile: ${res?.hint || res?.reason || 'unknown error'}`);
            }
            return savedProfile;
        },

        async deleteProfile(id, { expectedVersion, transientSessionId } = {}) {
            const target = String(id || '').trim();
            if (!target) {
                return false;
            }
            if (typeof context?.updateGlobalState !== 'function') {
                throw new Error('GlobalState API (context.updateGlobalState) is unavailable.');
            }
            let deleted = false;
            const now = Date.now();
            const res = await context.updateGlobalState(CHARACTER_PROFILES_NAMESPACE, (current) => {
                const existingProfiles = resolveExistingProfilesForWrite(current, now);
                const exists = Object.hasOwn(existingProfiles, target);
                const previous = exists
                    ? normalizeCharacterProfile({ ...existingProfiles[target], id: target })
                    : null;
                assertExpectedVersion(previous, expectedVersion, exists);
                if (!exists) {
                    return null;
                }
                delete existingProfiles[target];
                deleted = true;
                return {
                    ...current,
                    version: CHARACTER_PROFILES_VERSION,
                    profiles: existingProfiles,
                };
            }, { asyncDiff: false, transientSessionId });

            if (!res?.ok) {
                throw new Error(`Failed to delete character profile "${target}": ${res?.hint || res?.reason || 'unknown error'}`);
            }
            return deleted;
        },
    };
}
