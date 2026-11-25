import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { clearRegistry, hasTarget, resolveTarget } from '/scripts/iteration-library/storage/target-registry.js';
import { ensureSkillRegistryTarget } from '/scripts/iteration-library/tools/skill-iter-studio.js';

const previousLuker = globalThis.Luker;
globalThis.Luker = { getContext: () => ({ lib: {} }) };

afterAll(() => { globalThis.Luker = previousLuker; });

beforeEach(() => {
    clearRegistry();
});

describe('ensureSkillRegistryTarget', () => {
    test('registers the skill-registry target once', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            ensureSkillRegistryTarget();
            const first = resolveTarget({ type: 'skill-registry' });
            ensureSkillRegistryTarget();
            expect(hasTarget('skill-registry')).toBe(true);
            expect(resolveTarget({ type: 'skill-registry' })).toBe(first);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test('read returns the addressable shape and describe names the skill', async () => {
        ensureSkillRegistryTarget();
        const handler = resolveTarget({ type: 'skill-registry' });
        expect(await handler.read({ type: 'skill-registry', name: 'tide-ledger', path: 'SKILL.md' }))
            .toEqual({ skill: 'tide-ledger', path: 'SKILL.md' });
        expect(handler.describe({ type: 'skill-registry', name: 'tide-ledger' })).toBe('tide-ledger');
        expect(handler.describe({ type: 'skill-registry' })).toBe('skill');
    });

});
