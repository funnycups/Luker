// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    SOURCE_READ_TOOL_NAMES,
    assertSourceImagePath,
    buildSourceReadTools,
    executeSourceReadTool,
    isSourceReadTool,
} from './source-policy.js';
import {
    fetchReferenceImage,
    promoteLocalReferenceImage,
    searchCharacterSources,
    visitCharacterPage,
} from '../character-sources-client.js';

export { readCharacterCardData } from './source-policy.js';

export const EXPLORATION_TOOL_NAMES = Object.freeze({
    ...SOURCE_READ_TOOL_NAMES,
    LIST_CHARACTER_PROFILES: 'list_character_profiles',
    READ_CHARACTER_PROFILES: 'read_character_profiles',
    SEARCH_CHARACTER_SOURCES: 'search_character_sources',
    VISIT_CHARACTER_PAGE: 'visit_character_page',
    FETCH_REFERENCE_IMAGE: 'fetch_reference_image',
    SAVE_CHARACTER_PROFILE: 'save_character_profile',
});

export function buildExplorationToolDefs({ sourcePolicy = { kind: 'none' } } = {}) {
    return [
        ...buildSourceReadTools(sourcePolicy),
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
                description: 'Read full visual profile details (description and reference image paths) by profile IDs.',
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
                description: 'Search public character art databases (bangumi, mediawiki, booru) or general web image search (web) for official portraits, appearance details, and Danbooru character tags.',
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
                        description: {
                            type: 'string',
                            description: 'Structured plain-text visual description (appearance, attire variants, distinguishing traits, and Danbooru character tag if one exists).',
                        },
                        reference_images: {
                            type: 'array',
                            description: 'Verified /user/images/_references/... portraits with optional short labels.',
                            items: {
                                type: 'object',
                                properties: {
                                    path: {
                                        type: 'string',
                                        description: 'Verified /user/images/_references/... path from fetch_reference_image.',
                                    },
                                    label: {
                                        type: 'string',
                                        description: 'Optional short portrait label (e.g. default attire, battle attire, close-up).',
                                    },
                                },
                                required: ['path'],
                                additionalProperties: false,
                            },
                        },
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
    sourcePolicy = { kind: 'none' },
    media = null,
    abortSignal = null,
} = {}) {
    const name = String(call?.name || '').trim();
    const args = call?.args && typeof call.args === 'object' ? call.args : {};

    if (isSourceReadTool(name)) {
        return await executeSourceReadTool({ id: call?.id, name, args }, {
            context,
            policy: sourcePolicy,
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
            assertSourceImagePath(sourcePolicy, rawUrl);
            if (typeof media?.fetchReferenceImage === 'function') {
                const staged = await media.fetchReferenceImage({
                    imageUrl: rawUrl,
                    refererUrl: args.referer_url || '',
                    profileId,
                    abortSignal,
                });
                return { ok: true, ...staged };
            }
            const promoted = await promoteLocalReferenceImage({
                context,
                sourcePath: rawUrl,
                profileId,
                abortSignal,
            });
            return { ok: true, ...promoted };
        }
        if (typeof media?.fetchReferenceImage === 'function') {
            const staged = await media.fetchReferenceImage({
                imageUrl: rawUrl,
                refererUrl: args.referer_url || '',
                profileId,
                abortSignal,
            });
            return { ok: true, ...staged };
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
        const hasRefImages = Object.hasOwn(args, 'referenceImages') || Object.hasOwn(args, 'reference_images');
        const rawRefs = Object.hasOwn(args, 'referenceImages') ? args.referenceImages : args.reference_images;
        if (hasRefImages) {
            if (!Array.isArray(rawRefs)) {
                throw new Error(`${name}: invalid_args — reference_images must be an array`);
            }
            for (const item of rawRefs) {
                const imagePath = typeof item === 'string' ? item : item?.path;
                assertSourceImagePath({ kind: 'none' }, imagePath, name);
            }
        }
        const patch = {};
        for (const [argument, field] of Object.entries({
            id: 'id',
            name: 'name',
            aliases: 'aliases',
            source_work: 'sourceWork',
            description: 'description',
        })) {
            if (Object.hasOwn(args, argument)) patch[field] = args[argument];
        }
        if (hasRefImages) {
            patch.referenceImages = rawRefs;
        }
        const saved = await profileStore.upsertProfile(patch);
        return { ok: true, savedProfile: saved };
    }

    throw new Error(`${name}: unknown_tool — unknown exploration tool`);
}
