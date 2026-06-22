import { describe, test, expect } from '@jest/globals';
import { createSkillAuthorHandler, skillAuthor } from '/scripts/iteration-library/proposal-bus/kinds/skill-author.js';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';

describe('skill-author kind descriptor', () => {
    test('factory returns descriptor with kind + targetType', () => {
        const h = createSkillAuthorHandler();
        expect(h.kind).toBe('skill-author');
        expect(h.targetType).toBe('skill-registry');
    });

    test('exported descriptor matches the factory output', () => {
        expect(createSkillAuthorHandler()).toBe(skillAuthor);
    });

    test('bus.registerKind accepts the descriptor without throwing', () => {
        const bus = createBus();
        expect(() => bus.registerKind(skillAuthor.kind, skillAuthor)).not.toThrow();
    });
});
