// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from '@jest/globals';
import {
    buildExplorationToolDefs,
    executeExplorationToolCall,
    readCharacterCardData,
} from '../public/scripts/extensions/stable-diffusion/exploration/tools.js';
import { runExplorationAgent } from '../public/scripts/extensions/stable-diffusion/exploration/agent.js';
import { DEFAULT_EXPLORATION_PROMPT } from '../public/scripts/extensions/stable-diffusion/exploration/prompts.js';

const localReadNames = [
    'read_character_card',
    'read_user_persona',
    'world_book_list',
    'lorebook_list',
    'lorebook_query',
    'lorebook_get',
];

const cardPolicy = {
    kind: 'card',
    card: { avatar: 'selected-source.png' },
    worldBooks: [
        { name: 'Selected primary', source: 'character' },
        { name: 'Selected auxiliary', source: 'character_aux' },
    ],
};

describe('explicit character source policy', () => {
    test('local image identity uses one decode and resolved path segments', async () => {
        const imagePaths = await import('../public/scripts/extensions/stable-diffusion/media-path.js');
        expect(typeof imagePaths.normalizeLocalImagePath).toBe('function');
        expect(imagePaths.normalizeLocalImagePath('user/images/_sandbox_tmp/owned/unused/../image%20file.png?preview=1'))
            .toBe('/user/images/_sandbox_tmp/owned/image file.png');
        expect(imagePaths.normalizeLocalImagePath('/user/images/_sandbox_tmp/owned/image%2520file.png'))
            .toBe('/user/images/_sandbox_tmp/owned/image%20file.png');
    });

    test.each([
        '/characters/unselected-source.png',
        '/User Avatars/unselected-persona.png',
        'https://example.org/unmanaged.png',
        '/user/images/../../characters/unselected-source.png',
    ])('profile saves reject unmanaged references before storage: %s', async (path) => {
        await expect(executeExplorationToolCall({
            name: 'save_character_profile',
            args: { name: 'Requested profile', reference_images: [{ path }] },
        }, { sourcePolicy: cardPolicy })).rejects.toThrow('not_allowed');
    });

    test('profile save authorization uses the same reference alias as normalization', async () => {
        await expect(executeExplorationToolCall({
            name: 'save_character_profile',
            args: {
                name: 'Requested profile',
                referenceImages: [{ path: '/characters/unselected-source.png' }],
                reference_images: [{ path: '/user/images/_references/managed.png' }],
            },
        }, { sourcePolicy: cardPolicy })).rejects.toThrow('not_allowed');
    });

    test.each(['', undefined, null, 'missing-source.png', ' selected-source.png'])('missing and inexact card identities never select the active card: %s', async (cardAvatar) => {
        await expect(readCharacterCardData({
            characterId: 0,
            characters: [{ avatar: 'selected-source.png' }],
        }, { cardAvatar })).resolves.toMatchObject({ found: false });
    });

    test.each([null, {}, [{}], [''], [{ name: 0 }]])('rejects malformed targets before reading local data: %j', async (targets) => {
        await expect(runExplorationAgent({
            targets,
            preset: { explorationPrompt: DEFAULT_EXPLORATION_PROMPT },
        })).rejects.toThrow('invalid_args');
    });

    test('omitsUnselectedSourceTools', () => {
        const names = buildExplorationToolDefs({ sourcePolicy: { kind: 'none' } })
            .map(tool => tool.function.name);
        expect(names.filter(name => localReadNames.includes(name))).toEqual([]);
        expect(names).toEqual(expect.arrayContaining([
            'list_character_profiles',
            'read_character_profiles',
            'search_character_sources',
            'visit_character_page',
            'fetch_reference_image',
            'save_character_profile',
        ]));
    });

    test('omitted source selection does not expose local readers', () => {
        const names = buildExplorationToolDefs().map(tool => tool.function.name);
        expect(names.filter(name => localReadNames.includes(name))).toEqual([]);
    });

    test('card sources expose card and book readers without persona access', () => {
        const names = buildExplorationToolDefs({ sourcePolicy: cardPolicy })
            .map(tool => tool.function.name);
        expect(names).toContain('read_character_card');
        expect(names).toContain('world_book_list');
        expect(names).toContain('lorebook_get');
        expect(names).not.toContain('read_user_persona');
    });

    test('persona sources expose only the selected persona reader', () => {
        const names = buildExplorationToolDefs({
            sourcePolicy: { kind: 'persona', persona: { name: 'Selected persona', description: '' } },
        }).map(tool => tool.function.name);
        expect(names.filter(name => localReadNames.includes(name))).toEqual(['read_user_persona']);
    });

    test.each(localReadNames)('an unselected source rejects a forged %s call before data access', async (name) => {
        await expect(executeExplorationToolCall({
            name,
            args: { book_name: 'Unselected setting', uids: [1] },
        }, { sourcePolicy: { kind: 'none' } })).rejects.toThrow('not_allowed');
    });

    test.each(['lorebook_list', 'lorebook_query', 'lorebook_get'])('rejectsForeignWorldBookReads through %s', async (name) => {
        await expect(executeExplorationToolCall({
            name,
            args: { book_name: 'Unselected setting', uids: [1] },
        }, { sourcePolicy: cardPolicy })).rejects.toThrow('not_allowed');
    });

    test('a selected card rejects an explicit different avatar', async () => {
        await expect(executeExplorationToolCall({
            name: 'read_character_card',
            args: { card_avatar: 'unselected-source.png' },
        }, { sourcePolicy: cardPolicy })).rejects.toThrow('not_allowed');
    });

    test.each([
        '/characters/unselected-source.png',
        '/characters/unselected-source/expression.png',
        '/User Avatars/unselected-persona.png',
    ])('an unselected source cannot promote the local asset %s', async (imagePath) => {
        await expect(executeExplorationToolCall({
            name: 'fetch_reference_image',
            args: { image_url: imagePath },
        }, { sourcePolicy: { kind: 'none' } })).rejects.toThrow('not_allowed');
    });

    test.each([
        '/characters/selected-source/../unselected-source.png',
        '/characters/selected-source/%2e%2e/unselected-source.png',
        '/user/images/../../characters/unselected-source.png',
    ])('local reference paths cannot escape their selected source through %s', async (imagePath) => {
        await expect(executeExplorationToolCall({
            name: 'fetch_reference_image',
            args: { image_url: imagePath },
        }, { sourcePolicy: cardPolicy })).rejects.toThrow('not_allowed');
    });

    test.each([
        '/characters/%2573elected-source.png',
        '/characters/%2573elected-source/expression.png',
    ])('local source authorization decodes a path exactly once: %s', async (imagePath) => {
        await expect(executeExplorationToolCall({
            name: 'fetch_reference_image',
            args: { image_url: imagePath },
        }, { sourcePolicy: cardPolicy })).rejects.toThrow('not_allowed');
    });

    test('profile save tools have no card-binding field', () => {
        const save = buildExplorationToolDefs().find(tool => tool.function.name === 'save_character_profile');
        expect(save.function.parameters.properties).not.toHaveProperty('source_card_avatars');
    });
});
