import { describe, expect, test } from '@jest/globals';
import { requireStoredPrompt } from '../../public/scripts/lib/prompt-values.js';
import * as promptValues from '../../public/scripts/lib/prompt-values.js';

describe('stored prompt execution boundary', () => {
    test('preserves the exact nonempty stored text', () => {
        const value = '  Describe the scene.\n\n';
        expect(requireStoredPrompt(value, 'Enter a prompt.')).toBe(value);
    });

    test.each(['', ' \n', undefined, null, 0, {}])('rejects an empty or invalid stored value: %p', value => {
        expect(() => requireStoredPrompt(value, 'Enter a prompt.')).toThrow('Enter a prompt.');
    });
});

describe('one-time prompt initialization', () => {
    test('initializes blank legacy defaults and preserves custom bytes', () => {
        expect(typeof promptValues.initializePromptDefaults).toBe('function');
        const settings = { first: '', second: '  Custom instructions.\n', other: 7 };
        expect(promptValues.initializePromptDefaults(settings, { first: 'First default', second: 'Second default' })).toBe(true);
        expect(settings).toEqual({
            first: 'First default',
            second: '  Custom instructions.\n',
            other: 7,
            promptDefaultsInitialized: true,
        });
    });

    test('does not replace later empty edits', () => {
        expect(typeof promptValues.initializePromptDefaults).toBe('function');
        const settings = { first: '', promptDefaultsInitialized: true };
        expect(promptValues.initializePromptDefaults(settings, { first: 'First default' })).toBe(false);
        expect(settings.first).toBe('');
    });

    test('keeps absent inherited fields absent in a sparse scope', () => {
        expect(typeof promptValues.initializePromptDefaults).toBe('function');
        const settings = { first: '' };
        promptValues.initializePromptDefaults(settings, { first: 'First default', second: 'Second default' }, { sparse: true });
        expect(settings.first).toBe('First default');
        expect(Object.hasOwn(settings, 'second')).toBe(false);
    });
});
