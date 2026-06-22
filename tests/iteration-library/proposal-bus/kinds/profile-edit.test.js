import { describe, test, expect } from '@jest/globals';
import { createProfileEditHandler, profileEdit } from '/scripts/iteration-library/proposal-bus/kinds/profile-edit.js';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';

describe('profile-edit kind descriptor', () => {
    test('factory returns descriptor with kind + targetType', () => {
        const h = createProfileEditHandler();
        expect(h.kind).toBe('profile-edit');
        expect(h.targetType).toBe('profile');
    });

    test('exported descriptor matches the factory output', () => {
        expect(createProfileEditHandler()).toBe(profileEdit);
    });

    test('bus.registerKind accepts the descriptor without throwing', () => {
        const bus = createBus();
        expect(() => bus.registerKind(profileEdit.kind, profileEdit)).not.toThrow();
    });
});
