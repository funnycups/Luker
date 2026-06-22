import { describe, test, expect } from '@jest/globals';
import { createLorebookWriteHandler, lorebookWrite } from '/scripts/iteration-library/proposal-bus/kinds/lorebook-write.js';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';

describe('lorebook-write kind descriptor', () => {
    test('factory returns descriptor with kind + targetType', () => {
        const h = createLorebookWriteHandler();
        expect(h.kind).toBe('lorebook-write');
        expect(h.targetType).toBe('lorebook');
    });

    test('exported descriptor matches the factory output', () => {
        expect(createLorebookWriteHandler()).toBe(lorebookWrite);
    });

    test('bus.registerKind accepts the descriptor without throwing', () => {
        const bus = createBus();
        expect(() => bus.registerKind(lorebookWrite.kind, lorebookWrite)).not.toThrow();
    });
});
