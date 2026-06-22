import { describe, test, expect } from '@jest/globals';
import { createPresetCloneHandler, presetClone } from '/scripts/iteration-library/proposal-bus/kinds/preset-clone.js';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';

describe('preset-clone kind descriptor', () => {
    test('factory returns descriptor with kind + targetType', () => {
        const h = createPresetCloneHandler();
        expect(h.kind).toBe('preset-clone');
        expect(h.targetType).toBe('preset');
    });

    test('exported descriptor matches the factory output', () => {
        expect(createPresetCloneHandler()).toBe(presetClone);
    });

    test('bus.registerKind accepts the descriptor without throwing', () => {
        const bus = createBus();
        expect(() => bus.registerKind(presetClone.kind, presetClone)).not.toThrow();
    });
});
