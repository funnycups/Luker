// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    LOREBOOK_READ_TOOL_DEFS,
    isLorebookReadTool,
    runLorebookReadTool,
} from '../../../iteration-library/tools/lorebook-reads.js';
import {
    fetchReferenceImage,
    promoteLocalReferenceImage,
    searchCharacterSources,
    visitCharacterPage,
} from '../character-sources-client.js';

export const EXPLORATION_TOOL_NAMES = Object.freeze({
    READ_CHARACTER_CARD: 'read_character_card',
    LIST_CHARACTER_PROFILES: 'list_character_profiles',
    READ_CHARACTER_PROFILES: 'read_character_profiles',
    SEARCH_CHARACTER_SOURCES: 'search_character_sources',
    VISIT_CHARACTER_PAGE: 'visit_character_page',
    FETCH_REFERENCE_IMAGE: 'fetch_reference_image',
    SAVE_CHARACTER_PROFILE: 'save_character_profile',
});

function resolveCardFromContext(context, requestedAvatar = '') {
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const trimmed = String(requestedAvatar || '').trim();
    if (trimmed) {
        const byAvatar = characters.find(
            c => String(c?.avatar || '') === trimmed || String(c?.name || '') === trimmed,
        );
        if (byAvatar) {
            return byAvatar;
        }
    }
    const idx = Number(context?.characterId);
    if (Number.isInteger(idx) && idx >= 0 && idx < characters.length) {
        return characters[idx];
    }
    return null;
}

export async function readCharacterCardData(context, { cardAvatar = '', abortSignal = null } = {}) {
    const card = resolveCardFromContext(context, cardAvatar);
    if (!card) {
        return { found: false, message: 'No active or matching character card found.' };
    }

    const avatarFile = String(card.avatar || '').trim();
    const avatarStem = avatarFile.replace(/\.[^.]+$/, '');
    const cardData = card.data && typeof card.data === 'object' ? card.data : {};

    let sprites = [];
    if (avatarStem && typeof globalThis.fetch === 'function') {
        try {
            const res = await fetch(`/api/sprites/get?name=${encodeURIComponent(avatarStem)}`, {
                method: 'GET',
                headers: context?.getRequestHeaders?.() || {},
                signal: abortSignal || undefined,
            });
            if (res.ok) {
                const rawSprites = await res.json();
                if (Array.isArray(rawSprites)) {
                    sprites = rawSprites
                        .map(item => ({
                            label: String(item?.label || ''),
                            imagePath: String(item?.path || '').replace(/\?.*$/, ''),
                        }))
                        .filter(item => item.imagePath.startsWith('/characters/'));
                }
            }
        } catch {
            sprites = [];
        }
    }

    return {
        found: true,
        name: String(card.name || cardData.name || ''),
        avatar: avatarFile,
        avatarImagePath: avatarFile ? `/characters/${avatarFile}` : '',
        primaryWorldBook: String(cardData?.extensions?.world || ''),
        description: String(card.description || cardData.description || ''),
        personality: String(card.personality || cardData.personality || ''),
        scenario: String(card.scenario || cardData.scenario || ''),
        firstMessage: String(card.first_mes || cardData.first_mes || ''),
        creatorNotes: String(cardData.creator_notes || card.creatorcomment || ''),
        sprites,
    };
}

export function buildExplorationToolDefs() {
    return [
        {
            type: 'function',
            function: {
                name: EXPLORATION_TOOL_NAMES.READ_CHARACTER_CARD,
                description: 'Read character card text fields, primary avatar image path (/characters/...), and local expression sprite paths.',
                parameters: {
                    type: 'object',
                    properties: {
                        card_avatar: {
                            type: 'string',
                            description: 'Optional character card avatar filename or character name. Omit to read the active character card.',
                        },
                    },
                    additionalProperties: false,
                },
            },
        },
        ...LOREBOOK_READ_TOOL_DEFS,
        {
            type: 'function',
            function: {
                name: EXPLORATION_TOOL_NAMES.LIST_CHARACTER_PROFILES,
                description: 'List compact index lines for all saved profiles in the global character visual archive.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
        },
        {
            type: 'function',
            function: {
                name: EXPLORATION_TOOL_NAMES.READ_CHARACTER_PROFILES,
                description: 'Read full visual profile details (tags, prose, outfits, reference image paths) by profile IDs.',
                parameters: {
                    type: 'object',
                    properties: {
                        ids: {
                            type: 'array',
                            items: { type: 'string' },
                            minItems: 1,
                            description: 'Character profile IDs to read.',
                        },
                    },
                    required: ['ids'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: EXPLORATION_TOOL_NAMES.SEARCH_CHARACTER_SOURCES,
                description: 'Search public character art databases (bangumi, mediawiki, booru) or general web image search (web) for official portraits and canonical visual tags.',
                parameters: {
                    type: 'object',
                    properties: {
                        source: {
                            type: 'string',
                            enum: ['bangumi', 'mediawiki', 'booru', 'web'],
                            description: 'Target source adapter.',
                        },
                        query: {
                            type: 'string',
                            description: 'Character name query.',
                        },
                        work: {
                            type: 'string',
                            description: 'Optional source work / franchise name.',
                        },
                        wiki_host: {
                            type: 'string',
                            description: 'Optional MediaWiki domain when source is mediawiki (e.g. zh.moegirl.org.cn, en.wikipedia.org, <franchise>.fandom.com).',
                        },
                        booru_site: {
                            type: 'string',
                            enum: ['safebooru', 'danbooru'],
                            description: 'Optional Booru site when source is booru.',
                        },
                    },
                    required: ['source', 'query'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: EXPLORATION_TOOL_NAMES.VISIT_CHARACTER_PAGE,
                description: 'Extract candidate high-resolution character portrait URLs and captions from a wiki or character page URL.',
                parameters: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'HTTP/HTTPS page URL.' },
                    },
                    required: ['url'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: EXPLORATION_TOOL_NAMES.FETCH_REFERENCE_IMAGE,
                description: 'Download an external http(s) character image URL or promote a local /characters/... asset into verified /user/images/_references/ storage.',
                parameters: {
                    type: 'object',
                    properties: {
                        image_url: {
                            type: 'string',
                            description: 'HTTP/HTTPS image URL or local /characters/... path.',
                        },
                        referer_url: {
                            type: 'string',
                            description: 'Optional page URL where the image was found, used as HTTP Referer.',
                        },
                        profile_id: {
                            type: 'string',
                            description: 'Target character profile ID stem.',
                        },
                    },
                    required: ['image_url'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: EXPLORATION_TOOL_NAMES.SAVE_CHARACTER_PROFILE,
                description: 'Create or update a character visual profile in the global archive.',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Optional existing profile ID to update, or slug ID such as char_name.' },
                        name: { type: 'string', description: 'Canonical character display name.' },
                        aliases: { type: 'array', items: { type: 'string' } },
                        source_work: { type: 'string', description: 'Source franchise / work title, or empty for original characters.' },
                        source_card_avatars: { type: 'array', items: { type: 'string' } },
                        canonical_tags: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Stable core appearance tags (hair, eyes, build, species traits).',
                        },
                        negative_tags: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Optional negative tags to avoid common visual mistakes.',
                        },
                        prose_description: {
                            type: 'string',
                            description: 'Concise natural-language appearance description for multimodal/prose image models.',
                        },
                        outfits: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    name: { type: 'string' },
                                    tags: { type: 'array', items: { type: 'string' } },
                                    prose: { type: 'string' },
                                    reference_images: {
                                        type: 'array',
                                        items: { type: 'string' },
                                        description: 'Verified /user/images/_references/... paths from fetch_reference_image.',
                                    },
                                    referenceImages: {
                                        type: 'array',
                                        items: { type: 'string' },
                                        description: 'Verified /user/images/_references/... paths from fetch_reference_image.',
                                    },
                                },
                                required: ['name'],
                                additionalProperties: false,
                            },
                        },
                        default_outfit_id: { type: 'string' },
                    },
                    required: ['name'],
                    additionalProperties: false,
                },
            },
        },
    ];
}

export async function executeExplorationToolCall(call, {
    context,
    profileStore,
    defaultAvatar = '',
    abortSignal = null,
} = {}) {
    const name = String(call?.name || '').trim();
    const args = call?.args && typeof call.args === 'object' ? call.args : {};

    if (isLorebookReadTool(name)) {
        const card = resolveCardFromContext(context, defaultAvatar);
        return await runLorebookReadTool(
            { id: call?.id, name, args },
            { context, avatar: card?.avatar || defaultAvatar },
        );
    }

    if (name === EXPLORATION_TOOL_NAMES.READ_CHARACTER_CARD) {
        return await readCharacterCardData(context, {
            cardAvatar: args.card_avatar || defaultAvatar,
            abortSignal,
        });
    }

    if (name === EXPLORATION_TOOL_NAMES.LIST_CHARACTER_PROFILES) {
        const profiles = await profileStore.listProfiles();
        return profileStore.buildCompactProfileIndex(profiles);
    }

    if (name === EXPLORATION_TOOL_NAMES.READ_CHARACTER_PROFILES) {
        const profiles = await profileStore.getProfilesByIds(Array.isArray(args.ids) ? args.ids : []);
        return { profiles };
    }

    if (name === EXPLORATION_TOOL_NAMES.SEARCH_CHARACTER_SOURCES) {
        const res = await searchCharacterSources({
            context,
            source: args.source,
            query: args.query,
            work: args.work || '',
            wikiHost: args.wiki_host || '',
            booruSite: args.booru_site || 'safebooru',
            abortSignal,
        });
        return res.formattedLines || '(no matching candidates)';
    }

    if (name === EXPLORATION_TOOL_NAMES.VISIT_CHARACTER_PAGE) {
        const res = await visitCharacterPage({
            context,
            url: args.url,
            abortSignal,
        });
        return res.formattedLines || '(no candidate images found on page)';
    }

    if (name === EXPLORATION_TOOL_NAMES.FETCH_REFERENCE_IMAGE) {
        const rawUrl = String(args.image_url || '').trim();
        const profileId = String(args.profile_id || 'char').trim();
        if (rawUrl.startsWith('/')) {
            const promoted = await promoteLocalReferenceImage({
                context,
                sourcePath: rawUrl,
                profileId,
                abortSignal,
            });
            return { ok: true, ...promoted };
        }
        const downloaded = await fetchReferenceImage({
            context,
            imageUrl: rawUrl,
            refererUrl: args.referer_url || '',
            profileId,
            abortSignal,
        });
        return { ok: true, ...downloaded };
    }

    if (name === EXPLORATION_TOOL_NAMES.SAVE_CHARACTER_PROFILE) {
        const saved = await profileStore.upsertProfile({
            id: args.id,
            name: args.name,
            aliases: args.aliases,
            sourceWork: args.source_work,
            sourceCardAvatars: args.source_card_avatars,
            canonicalTags: args.canonical_tags,
            negativeTags: args.negative_tags,
            proseDescription: args.prose_description,
            outfits: args.outfits,
            defaultOutfitId: args.default_outfit_id,
        });
        return { ok: true, savedProfile: saved };
    }

    return { ok: false, error: `Unknown exploration tool: ${name}` };
}
