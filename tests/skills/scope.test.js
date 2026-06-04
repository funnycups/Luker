import { describe, test, expect } from '@jest/globals';
import { encodeScopePath, decodeScopePath, isValidScope, scopeLabel } from '../../src/skills/scope.js';

describe('SkillScope helpers', () => {
    describe('encodeScopePath', () => {
        test('encodes global', () => {
            expect(encodeScopePath({ kind: 'global' })).toBe('global');
        });

        test('encodes preset (name only — apiId is intentionally not part of the key)', () => {
            expect(encodeScopePath({ kind: 'preset', name: 'claude-rp-4' }))
                .toBe('preset/claude-rp-4');
        });

        test('encodes character', () => {
            expect(encodeScopePath({ kind: 'character', characterFile: 'alice.png' }))
                .toBe('character/alice.png');
        });

        test('rejects path traversal', () => {
            expect(() => encodeScopePath({ kind: 'character', characterFile: '../etc' }))
                .toThrow(/illegal characters/);
            expect(() => encodeScopePath({ kind: 'preset', name: '.' }))
                .toThrow(/illegal characters/);
        });

        test('rejects unknown kind', () => {
            expect(() => encodeScopePath({ kind: 'profile' })).toThrow(/unknown scope kind/);
        });

        test('accepts non-ASCII names with spaces (CJK, dots, hyphens)', () => {
            // Regression: an earlier ASCII-only allow-list rejected user-typed
            // preset names like the one below with a 400, even though the name
            // round-trips cleanly through Express and the filesystem.
            expect(encodeScopePath({ kind: 'preset', name: '夏瑾 双鱼座 Beta 0.36-orchestrator' }))
                .toBe('preset/夏瑾 双鱼座 Beta 0.36-orchestrator');
            expect(encodeScopePath({ kind: 'character', characterFile: 'アリス v2.png' }))
                .toBe('character/アリス v2.png');
        });

        test('rejects path separators and Windows-illegal characters', () => {
            expect(() => encodeScopePath({ kind: 'preset', name: 'a/b' })).toThrow(/illegal characters/);
            expect(() => encodeScopePath({ kind: 'preset', name: 'a\\b' })).toThrow(/illegal characters/);
            expect(() => encodeScopePath({ kind: 'preset', name: 'a:b' })).toThrow(/illegal characters/);
            expect(() => encodeScopePath({ kind: 'preset', name: 'a*b' })).toThrow(/illegal characters/);
        });
    });

    describe('decodeScopePath', () => {
        test('round-trips global', () => {
            expect(decodeScopePath('global')).toEqual({ kind: 'global' });
        });

        test('round-trips preset', () => {
            expect(decodeScopePath('preset/claude-rp-4'))
                .toEqual({ kind: 'preset', name: 'claude-rp-4' });
        });

        test('round-trips character', () => {
            expect(decodeScopePath('character/alice.png'))
                .toEqual({ kind: 'character', characterFile: 'alice.png' });
        });

        test('throws on unknown kind', () => {
            expect(() => decodeScopePath('unknown/x')).toThrow(/unknown scope kind/);
        });

        test('throws on malformed preset path', () => {
            // Only valid shape now is preset/<name> — both bare 'preset' and
            // the legacy preset/<api>/<name> shape must reject.
            expect(() => decodeScopePath('preset')).toThrow(/preset scope path/);
            expect(() => decodeScopePath('preset/openai/rp4')).toThrow(/preset scope path/);
        });

        test('rejects traversal in preset segment', () => {
            expect(() => decodeScopePath('preset/..')).toThrow(/illegal characters/);
        });

        test('rejects empty segments', () => {
            expect(() => decodeScopePath('preset/')).toThrow(/illegal characters/);
        });

        test('rejects traversal in character segment', () => {
            expect(() => decodeScopePath('character/../foo')).toThrow(/illegal characters/);
        });

        test('round-trips non-ASCII names with spaces', () => {
            const name = '夏瑾 双鱼座 Beta 0.36-orchestrator';
            expect(decodeScopePath(`preset/${name}`))
                .toEqual({ kind: 'preset', name });
            const charFile = 'アリス v2.png';
            expect(decodeScopePath(`character/${charFile}`))
                .toEqual({ kind: 'character', characterFile: charFile });
        });
    });

    describe('isValidScope', () => {
        test('accepts valid', () => {
            expect(isValidScope({ kind: 'global' })).toBe(true);
            expect(isValidScope({ kind: 'preset', name: 'b' })).toBe(true);
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
            expect(scopeLabel({ kind: 'preset', name: 'rp' })).toBe('preset:rp');
            expect(scopeLabel({ kind: 'character', characterFile: 'alice.png' })).toBe('character:alice.png');
        });

        test('handles null gracefully', () => {
            expect(scopeLabel(null)).toBe('unknown');
            expect(scopeLabel(undefined)).toBe('unknown');
        });
    });
});
