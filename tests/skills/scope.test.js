import { describe, test, expect } from '@jest/globals';
import { encodeScopePath, decodeScopePath, isValidScope, scopeLabel } from '../../src/skills/scope.js';

describe('SkillScope helpers', () => {
    describe('encodeScopePath', () => {
        test('encodes global', () => {
            expect(encodeScopePath({ kind: 'global' })).toBe('global');
        });

        test('encodes preset', () => {
            expect(encodeScopePath({ kind: 'preset', apiId: 'openai', name: 'claude-rp-4' }))
                .toBe('preset/openai/claude-rp-4');
        });

        test('encodes character', () => {
            expect(encodeScopePath({ kind: 'character', characterFile: 'alice.png' }))
                .toBe('character/alice.png');
        });

        test('rejects path traversal', () => {
            expect(() => encodeScopePath({ kind: 'character', characterFile: '../etc' }))
                .toThrow(/illegal characters/);
            expect(() => encodeScopePath({ kind: 'preset', apiId: '.', name: 'x' }))
                .toThrow(/illegal characters/);
        });

        test('rejects unknown kind', () => {
            expect(() => encodeScopePath({ kind: 'profile' })).toThrow(/unknown scope kind/);
        });
    });

    describe('decodeScopePath', () => {
        test('round-trips global', () => {
            expect(decodeScopePath('global')).toEqual({ kind: 'global' });
        });

        test('round-trips preset', () => {
            expect(decodeScopePath('preset/openai/claude-rp-4'))
                .toEqual({ kind: 'preset', apiId: 'openai', name: 'claude-rp-4' });
        });

        test('round-trips character', () => {
            expect(decodeScopePath('character/alice.png'))
                .toEqual({ kind: 'character', characterFile: 'alice.png' });
        });

        test('throws on unknown kind', () => {
            expect(() => decodeScopePath('unknown/x')).toThrow(/unknown scope kind/);
        });

        test('throws on malformed preset path', () => {
            expect(() => decodeScopePath('preset/only-one')).toThrow(/preset scope path/);
        });

        test('rejects traversal in preset segments', () => {
            expect(() => decodeScopePath('preset/../x')).toThrow(/illegal characters/);
            expect(() => decodeScopePath('preset/x/..')).toThrow(/illegal characters/);
        });

        test('rejects empty segments', () => {
            expect(() => decodeScopePath('preset//x')).toThrow(/illegal characters/);
            expect(() => decodeScopePath('preset/x/')).toThrow(/illegal characters/);
        });

        test('rejects traversal in character segment', () => {
            expect(() => decodeScopePath('character/../foo')).toThrow(/illegal characters/);
        });
    });

    describe('isValidScope', () => {
        test('accepts valid', () => {
            expect(isValidScope({ kind: 'global' })).toBe(true);
            expect(isValidScope({ kind: 'preset', apiId: 'a', name: 'b' })).toBe(true);
            expect(isValidScope({ kind: 'character', characterFile: 'x.png' })).toBe(true);
        });

        test('rejects malformed', () => {
            expect(isValidScope(null)).toBe(false);
            expect(isValidScope({ kind: 'preset' })).toBe(false);
            expect(isValidScope('global')).toBe(false);
        });
    });

    describe('scopeLabel', () => {
        test('formats human-readable labels', () => {
            expect(scopeLabel({ kind: 'global' })).toBe('global');
            expect(scopeLabel({ kind: 'preset', apiId: 'openai', name: 'rp' })).toBe('preset:openai:rp');
            expect(scopeLabel({ kind: 'character', characterFile: 'alice.png' })).toBe('character:alice.png');
        });

        test('handles null gracefully', () => {
            expect(scopeLabel(null)).toBe('unknown');
            expect(scopeLabel(undefined)).toBe('unknown');
        });
    });
});
