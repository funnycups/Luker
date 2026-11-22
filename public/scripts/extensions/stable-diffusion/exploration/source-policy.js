// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    LOREBOOK_READ_TOOL_DEFS,
    isLorebookReadTool,
    runLorebookReadTool,
} from '../../../iteration-library/tools/lorebook-reads.js';
import { normalizeLocalImagePath } from '../media-path.js';

export const SOURCE_READ_TOOL_NAMES = Object.freeze({
    READ_CHARACTER_CARD: 'read_character_card',
    READ_USER_PERSONA: 'read_user_persona',
});

const READ_CHARACTER_CARD_TOOL = {
    type: 'function',
    function: {
        name: SOURCE_READ_TOOL_NAMES.READ_CHARACTER_CARD,
        description: 'Read the selected source card text, avatar, and expression image paths.',
        parameters: {
            type: 'object',
            properties: {
                card_avatar: {
                    type: 'string',
                    description: 'Optional avatar filename. Must match the selected source card.',
                },
            },
            additionalProperties: false,
        },
    },
};

export const READ_USER_PERSONA_TOOL = {
    type: 'function',
    function: {
        name: SOURCE_READ_TOOL_NAMES.READ_USER_PERSONA,
        description: 'Read the explicitly selected user persona text and avatar image path.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
};

function resolveCardFromContext(context, requestedAvatar) {
    const avatar = String(requestedAvatar ?? '');
    if (!avatar) return null;
    return (context?.characters ?? []).find(card => card?.avatar === avatar) ?? null;
}

async function readCardSnapshot(context, card, abortSignal) {
    if (!card) return { found: false, message: 'No matching source character card found.' };
    const avatarFile = String(card.avatar);
    const avatarStem = avatarFile.replace(/\.[^.]+$/, '');
    const cardData = card.data && typeof card.data === 'object' ? card.data : {};
    const response = await fetch(`/api/sprites/get?name=${encodeURIComponent(avatarStem)}`, {
        method: 'GET',
        headers: context.getRequestHeaders(),
        signal: abortSignal || undefined,
    });
    if (!response.ok) {
        throw new Error(`read_character_card: read_failed — expressions for ${avatarFile} returned HTTP ${response.status}`);
    }
    const rawSprites = await response.json();
    if (!Array.isArray(rawSprites)) {
        throw new Error(`read_character_card: invalid_response — expressions for ${avatarFile} must be an array`);
    }
    return {
        found: true,
        name: String(card.name || cardData.name || ''),
        avatar: avatarFile,
        avatarImagePath: `/characters/${avatarFile}`,
        primaryWorldBook: String(cardData?.extensions?.world || ''),
        description: String(card.description || cardData.description || ''),
        personality: String(card.personality || cardData.personality || ''),
        scenario: String(card.scenario || cardData.scenario || ''),
        firstMessage: String(card.first_mes || cardData.first_mes || ''),
        creatorNotes: String(cardData.creator_notes || card.creatorcomment || ''),
        sprites: rawSprites.map(item => ({
            label: String(item?.label || ''),
            imagePath: String(item?.path || '').replace(/\?.*$/, ''),
        })).filter(item => item.imagePath.startsWith(`/characters/${avatarStem}/`)),
    };
}

export async function readCharacterCardData(context, { cardAvatar = '', abortSignal = null } = {}) {
    return await readCardSnapshot(context, resolveCardFromContext(context, cardAvatar), abortSignal);
}

export function readUserPersonaData(context) {
    const avatar = String(
        context?.userAvatar
        || globalThis.document?.querySelector('#user_avatar_block .avatar.selected')?.getAttribute('imgfile')
        || '',
    ).trim();
    return {
        name: String(context?.name1 || 'User'),
        description: String(context?.powerUserSettings?.persona_description || '').trim(),
        avatarImagePath: avatar ? `/User Avatars/${avatar}` : '',
    };
}

export async function createSourcePolicy(context, selection = null) {
    if (selection == null || selection.kind === 'none') return { kind: 'none' };
    if (selection.kind === 'persona') return { kind: 'persona', persona: readUserPersonaData(context) };
    if (selection.kind !== 'card' || typeof selection.card_avatar !== 'string') {
        throw new Error('source: invalid_args — select none, a card avatar, or the user persona');
    }
    const card = resolveCardFromContext(context, selection.card_avatar);
    if (!card) throw new Error(`source: not_found — character card ${selection.card_avatar}`);
    const snapshot = JSON.parse(JSON.stringify(card));
    const worldBooks = [];
    const addBook = (value, source) => {
        const name = String(value || '').trim();
        if (name && !worldBooks.some(book => book.name === name)) worldBooks.push({ name, source });
    };
    addBook(snapshot.data?.extensions?.world, 'character');
    const fileName = context.getCharaFilename(null, { manualAvatarKey: snapshot.avatar });
    for (const name of context.getCharaAuxWorlds(fileName, { storedOnly: true })) addBook(name, 'character_aux');
    return { kind: 'card', card: snapshot, worldBooks };
}

export function buildSourceReadTools(policy) {
    const tools = policy.kind === 'card'
        ? [READ_CHARACTER_CARD_TOOL, ...LOREBOOK_READ_TOOL_DEFS]
        : policy.kind === 'persona' ? [READ_USER_PERSONA_TOOL] : [];
    const definitions = JSON.parse(JSON.stringify(tools));
    const bookList = definitions.find(tool => tool.function.name === 'world_book_list');
    if (bookList) {
        bookList.function.description = 'List world books bound to the selected source card. Call before reading a book.';
    }
    return definitions;
}

export function isSourceReadTool(name) {
    return name === SOURCE_READ_TOOL_NAMES.READ_CHARACTER_CARD
        || name === SOURCE_READ_TOOL_NAMES.READ_USER_PERSONA
        || isLorebookReadTool(name);
}

function notAllowed(name, detail) {
    throw new Error(`${name}: not_allowed — ${detail}`);
}

export async function executeSourceReadTool(call, { context, policy, abortSignal = null }) {
    const { name, args = {} } = call;
    if (name === SOURCE_READ_TOOL_NAMES.READ_USER_PERSONA) {
        if (policy.kind !== 'persona') notAllowed(name, 'no user persona source was selected');
        return { ...policy.persona };
    }
    if (policy.kind !== 'card') notAllowed(name, 'no character card source was selected');
    if (name === SOURCE_READ_TOOL_NAMES.READ_CHARACTER_CARD) {
        if (args.card_avatar !== undefined && args.card_avatar !== policy.card.avatar) {
            notAllowed(name, 'the avatar does not match the selected source card');
        }
        return await readCardSnapshot(context, policy.card, abortSignal);
    }
    if (name === 'world_book_list') {
        return {
            ok: true,
            result: {
                books: policy.worldBooks.map(book => book.name),
                sources: policy.worldBooks.map(book => ({ ...book })),
            },
        };
    }
    if (typeof args.book_name !== 'string' || !args.book_name.trim()) {
        throw new Error(`${name}: invalid_args — book_name must be a non-empty string`);
    }
    const bookName = args.book_name.trim();
    if (!policy.worldBooks.some(book => book.name === bookName)) {
        notAllowed(name, `world book ${bookName} is not bound to the selected source card`);
    }
    const result = await runLorebookReadTool({ ...call, args: { ...args, book_name: bookName } }, {
        context,
        avatar: policy.card.avatar,
    });
    if (!result.ok) throw new Error(`${name}: ${result.reason || 'read_failed'} — ${result.error}`);
    return result;
}

export function assertSourceImagePath(policy, imagePath, toolName = 'fetch_reference_image') {
    const pathname = normalizeLocalImagePath(imagePath, toolName);
    if (pathname.startsWith('/user/images/')) return;
    if (policy.kind === 'persona' && pathname === policy.persona.avatarImagePath) return;
    if (policy.kind === 'card') {
        const avatar = policy.card.avatar;
        const stem = avatar.replace(/\.[^.]+$/, '');
        if (pathname === `/characters/${avatar}` || pathname.startsWith(`/characters/${stem}/`)) return;
    }
    notAllowed(toolName, 'the local asset is not part of the selected source');
}
