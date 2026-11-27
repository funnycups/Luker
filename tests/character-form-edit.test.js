// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import {
    planCharacterFormEdit,
    resolveCharacterFormEditTarget,
} from '../public/scripts/lib/character-form-edit.js';

function makeCharacter(avatar, fields = {}, extensions = {}, { shallow = false } = {}) {
    const data = {
        name: fields.name ?? avatar.replace(/\.png$/i, ''),
        description: fields.description ?? '',
        personality: fields.personality ?? '',
        scenario: fields.scenario ?? '',
        first_mes: fields.first_mes ?? '',
        mes_example: fields.mes_example ?? '',
        creator_notes: fields.creator_notes ?? '',
        system_prompt: fields.system_prompt ?? '',
        post_history_instructions: fields.post_history_instructions ?? '',
        creator: fields.creator ?? '',
        character_version: fields.character_version ?? '',
        tags: fields.tags ?? [],
        alternate_greetings: fields.alternate_greetings ?? [],
        extensions,
    };
    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: data.name,
        avatar,
        data,
        ...(shallow ? { shallow: true } : { json_data: JSON.stringify({ spec: 'chara_card_v2', data }) }),
    };
    return card;
}

function makeFormData(entries) {
    const map = new Map(Object.entries(entries));
    return {
        get: (name) => (map.has(name) ? map.get(name) : null),
    };
}

describe('character form edit target resolution and planning', () => {
    test('binds stale Alice form strictly to Alice even when Bob is another loaded character', () => {
        const alice = makeCharacter('alice.png', {
            name: 'Alice',
            description: 'Alice old description',
            alternate_greetings: ['Hi from Alice'],
        }, { custom_ext: { owner: 'alice' } });
        const bob = makeCharacter('bob.png', {
            name: 'Bob',
            description: 'Bob description',
            alternate_greetings: ['Hi from Bob'],
        }, { custom_ext: { owner: 'bob' } });
        const characters = [alice, bob];

        const formData = makeFormData({
            avatar_url: 'alice.png',
            ch_name: 'Alice',
            description: 'Alice edited description',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            creator: '',
            character_version: '',
            tags: '',
            talkativeness: '0.5',
            fav: 'false',
            world: '',
            depth_prompt_prompt: '',
            depth_prompt_depth: '4',
            depth_prompt_role: 'system',
        });

        const plan = planCharacterFormEdit({ characters, formData });

        expect(plan.target.chid).toBe('0');
        expect(plan.target.avatar).toBe('alice.png');
        expect(plan.target.character).toBe(alice);
        expect(plan.canPatch).toBe(true);
        expect(plan.operations).toEqual([
            { op: 'add', path: '/data/description', value: 'Alice edited description' },
        ]);
        expect(plan.alternateGreetings).toEqual(['Hi from Alice']);
        expect(plan.editingExtensions).toEqual({ custom_ext: { owner: 'alice' } });
        // Bob is untouched
        expect(bob.data.description).toBe('Bob description');
    });

    test('refuses to save when avatar_url was cleared during a character switch or target is absent', () => {
        const characters = [
            makeCharacter('alice.png', { description: 'Alice' }),
            makeCharacter('bob.png', { description: 'Bob' }),
        ];

        expect(resolveCharacterFormEditTarget(characters, '')).toBeNull();
        expect(resolveCharacterFormEditTarget(characters, 'missing.png')).toBeNull();

        expect(() => planCharacterFormEdit({
            characters,
            formData: makeFormData({ avatar_url: '', ch_name: 'Alice', description: 'Alice' }),
        })).toThrow(/not loaded/i);

        expect(() => planCharacterFormEdit({
            characters,
            formData: makeFormData({ avatar_url: 'deleted.png', ch_name: 'Deleted', description: 'x' }),
        })).toThrow(/deleted\.png/);
    });

    test('never uses patch mode for shallow characters or when form-level extensions changed', () => {
        const shallowAlice = makeCharacter('alice.png', { description: 'shallow' }, {}, { shallow: true });
        const shallowPlan = planCharacterFormEdit({
            characters: [shallowAlice],
            formData: makeFormData({
                avatar_url: 'alice.png',
                ch_name: 'alice',
                description: 'updated',
                fav: 'false',
            }),
        });
        expect(shallowPlan.canPatch).toBe(false);

        const fullAlice = makeCharacter('alice.png', { description: 'old' }, { fav: false, other: 1 });
        const extChangedPlan = planCharacterFormEdit({
            characters: [fullAlice],
            formData: makeFormData({
                avatar_url: 'alice.png',
                ch_name: 'alice',
                description: 'old',
                fav: 'true',
            }),
        });
        expect(extChangedPlan.canPatch).toBe(false);
        expect(extChangedPlan.editingExtensions).toEqual({ fav: false, other: 1 });
    });
});
