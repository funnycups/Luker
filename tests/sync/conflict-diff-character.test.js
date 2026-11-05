import { describe, test, expect } from '@jest/globals';

import { cardPayload, renderCharacter } from '../../src/sync/conflict-diff/character-card.js';
import { createBuilder } from '../../src/sync/conflict-diff/tree.js';

const card = overrides => ({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
        name: 'Seraphina',
        description: 'A quiet keeper.',
        personality: 'Patient',
        scenario: 'A lighthouse.',
        first_mes: 'Welcome.',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['keeper'],
        creator: 'Desk',
        character_version: '1.0',
        extensions: { depth_prompt: { depth: 4, prompt: 'Stay calm.' } },
        character_book: {
            name: 'Lighthouse lore',
            entries: [
                { id: 1, comment: 'The lamp', content: 'The lamp burns.', keys: ['lamp'], enabled: true },
            ],
        },
        ...overrides,
    },
});

function build(left, right) {
    const builder = createBuilder();
    const sections = renderCharacter(left, right, builder);
    return builder.finalize(sections);
}

const section = (sections, label) => sections.find(item => item.label === label);
const item = (parent, label) => parent.children.find(child => child.label === label);

describe('character card conflict renderer', () => {
    test('reads the V2 data payload and the flat V1 document', () => {
        expect(cardPayload(card())).toMatchObject({ name: 'Seraphina' });
        expect(cardPayload({ name: 'Flat', description: 'old' })).toMatchObject({ name: 'Flat' });
    });

    test('separates profile, embedded world book and extensions', () => {
        const left = card();
        const right = card();
        right.data.description = 'A loud keeper.';
        right.data.character_book.entries[0].content = 'The lamp is out.';
        right.data.extensions.depth_prompt.prompt = 'Stay loud.';
        const { sections, values } = build(left, right);

        const profile = section(sections, 'Profile');
        expect(profile.children.map(child => child.label)).toEqual(['Description']);
        const description = profile.children[0];
        expect(values.get(description.id)()).toEqual({ mode: 'cells', before: 'A quiet keeper.', after: 'A loud keeper.' });
        expect(profile.children.some(child => child.label === 'Embedded world book')).toBe(false);
        expect(profile.children.some(child => child.label === 'Extensions')).toBe(false);

        const book = section(sections, 'Embedded world book');
        const lamp = item(book, 'The lamp');
        const content = item(lamp, 'Content');
        expect(values.get(content.id)()).toEqual({ mode: 'cells', before: 'The lamp burns.', after: 'The lamp is out.' });

        const extensions = section(sections, 'Extensions');
        const depth = item(extensions, 'Depth prompt');
        const prompt = item(depth, 'Prompt');
        expect(values.get(prompt.id)()).toEqual({ mode: 'cells', before: 'Stay calm.', after: 'Stay loud.' });
    });

    test('aligns character book entries by id', () => {
        const left = card();
        const right = card();
        left.data.character_book.entries.push({ id: 2, comment: 'The stairs', content: 'Old stairs.', keys: [] });
        right.data.character_book.entries.push({ id: 2, comment: 'The stairs', content: 'New stairs.', keys: [] });
        right.data.character_book.entries[0].content = 'The lamp is bright.';
        const { sections } = build(left, right);
        const book = section(sections, 'Embedded world book');
        expect(book.children.map(child => child.label).sort()).toEqual(['The lamp', 'The stairs']);
        expect(item(book, 'The stairs').children[0]).toMatchObject({ label: 'Content', status: 'changed' });
    });

    test('returns no sections for an identical payload', () => {
        expect(build(card(), card()).sections).toEqual([]);
    });
});
