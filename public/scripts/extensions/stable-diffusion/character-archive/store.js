// SPDX-License-Identifier: AGPL-3.0-or-later

import { makeIllustrationId } from '../illustration/presets.js';

export const CHARACTER_PROFILES_NAMESPACE = 'sd_character_profiles';

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

export function normalizeCharacterOutfit(raw, index = 0) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const id = String(raw.id || '').trim() || makeIllustrationId(`outfit_${index + 1}`);
    const name = String(raw.name || '').trim() || (index === 0 ? 'Default' : `Outfit ${index + 1}`);
    return {
        id,
        name,
        tags: cleanStringList(raw.tags),
        prose: String(raw.prose || '').trim(),
        referenceImages: cleanStringList(raw.referenceImages ?? raw.reference_images),
    };
}

export function normalizeCharacterProfile(raw, now = Date.now()) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const name = String(raw.name || '').trim();
    if (!name) {
        return null;
    }
    const id = String(raw.id || '').trim() || makeIllustrationId('char');
    const outfits = Array.isArray(raw.outfits)
        ? raw.outfits.map((entry, idx) => normalizeCharacterOutfit(entry, idx)).filter(Boolean)
        : [];
    if (outfits.length === 0) {
        outfits.push({
            id: 'outfit_default',
            name: 'Default',
            tags: cleanStringList(raw.outfitTags),
            prose: '',
            referenceImages: cleanStringList(raw.referenceImages),
        });
    }
    const requestedDefault = String(raw.defaultOutfitId || '').trim();
    const defaultOutfitId = outfits.some(o => o.id === requestedDefault)
        ? requestedDefault
        : outfits[0].id;

    return {
        id,
        name,
        aliases: cleanStringList(raw.aliases),
        sourceWork: String(raw.sourceWork || '').trim(),
        sourceCardAvatars: cleanStringList(raw.sourceCardAvatars),
        canonicalTags: cleanStringList(raw.canonicalTags),
        negativeTags: cleanStringList(raw.negativeTags),
        proseDescription: String(raw.proseDescription || '').trim(),
        outfits,
        defaultOutfitId,
        createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : now,
        updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : now,
    };
}

export function resolveProfileAssets(profile, { outfitId = '' } = {}) {
    if (!profile || typeof profile !== 'object') {
        return null;
    }
    const outfits = Array.isArray(profile.outfits) ? profile.outfits : [];
    const targetId = String(outfitId || '').trim();
    const selectedOutfit = (targetId && outfits.find(o => o.id === targetId))
        || outfits.find(o => o.id === profile.defaultOutfitId)
        || outfits[0]
        || null;

    return {
        profileId: profile.id,
        name: profile.name,
        outfitId: selectedOutfit?.id || '',
        outfitName: selectedOutfit?.name || '',
        canonicalTags: cleanStringList(profile.canonicalTags),
        outfitTags: cleanStringList(selectedOutfit?.tags),
        negativeTags: cleanStringList(profile.negativeTags),
        proseDescription: String(profile.proseDescription || ''),
        outfitProse: String(selectedOutfit?.prose || ''),
        referenceImages: cleanStringList(selectedOutfit?.referenceImages),
    };
}

export function buildCompactProfileIndex(profiles = []) {
    if (!Array.isArray(profiles) || profiles.length === 0) {
        return '';
    }
    return profiles.map((profile, idx) => {
        const outfits = Array.isArray(profile.outfits) ? profile.outfits : [];
        const outfitSummary = outfits
            .map(o => `${o.id}:${o.name}(refs=${Array.isArray(o.referenceImages) ? o.referenceImages.length : 0})`)
            .join(',');
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
        if (outfitSummary) {
            fields.push(`outfits=${outfitSummary}`);
        }
        if (profile.defaultOutfitId) {
            fields.push(`defaultOutfit=${profile.defaultOutfitId}`);
        }
        return fields.join(' | ');
    }).join('\n');
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
    const normalized = {};
    for (const [key, entry] of Object.entries(rawMap)) {
        const clean = normalizeCharacterProfile({ ...entry, id: entry?.id || key });
        if (clean) {
            normalized[clean.id] = clean;
        }
    }
    return normalized;
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

        buildCompactProfileIndex(profiles) {
            return buildCompactProfileIndex(profiles);
        },

        async upsertProfile(input, now = Date.now()) {
            if (typeof context?.updateGlobalState !== 'function') {
                throw new Error('GlobalState API (context.updateGlobalState) is unavailable.');
            }
            let savedProfile = null;
            const res = await context.updateGlobalState(CHARACTER_PROFILES_NAMESPACE, (current) => {
                const existingProfiles = (current?.profiles && typeof current.profiles === 'object' && !Array.isArray(current.profiles))
                    ? { ...current.profiles }
                    : {};
                const requestedId = String(input?.id || '').trim();
                const previous = requestedId && existingProfiles[requestedId]
                    ? normalizeCharacterProfile(existingProfiles[requestedId], now)
                    : null;

                const merged = normalizeCharacterProfile({
                    ...(previous || {}),
                    ...(input || {}),
                    id: previous?.id || requestedId || makeIllustrationId('char'),
                    createdAt: previous?.createdAt ?? input?.createdAt ?? now,
                    updatedAt: now,
                }, now);

                if (!merged) {
                    throw new Error('Character profile requires a non-empty name.');
                }
                existingProfiles[merged.id] = merged;
                savedProfile = merged;
                return {
                    ...current,
                    version: 1,
                    profiles: existingProfiles,
                };
            }, { asyncDiff: false });

            if (!res?.ok) {
                throw new Error(`Failed to persist character profile: ${res?.hint || res?.reason || 'unknown error'}`);
            }
            return savedProfile;
        },

        async deleteProfile(id) {
            const target = String(id || '').trim();
            if (!target) {
                return false;
            }
            if (typeof context?.updateGlobalState !== 'function') {
                throw new Error('GlobalState API (context.updateGlobalState) is unavailable.');
            }
            let deleted = false;
            const res = await context.updateGlobalState(CHARACTER_PROFILES_NAMESPACE, (current) => {
                const existingProfiles = (current?.profiles && typeof current.profiles === 'object' && !Array.isArray(current.profiles))
                    ? { ...current.profiles }
                    : {};
                if (!Object.hasOwn(existingProfiles, target)) {
                    return null;
                }
                delete existingProfiles[target];
                deleted = true;
                return {
                    ...current,
                    version: 1,
                    profiles: existingProfiles,
                };
            }, { asyncDiff: false });

            if (!res?.ok) {
                throw new Error(`Failed to delete character profile "${target}": ${res?.hint || res?.reason || 'unknown error'}`);
            }
            return deleted;
        },
    };
}
