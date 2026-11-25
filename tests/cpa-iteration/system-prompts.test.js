// tests/cpa-iteration/system-prompts.test.js
import { describe, test, expect } from '@jest/globals';
import {
    sanitizeSessionMode,
    SESSION_MODE_DEFAULT,
    SESSION_MODES,
} from '../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/system-prompts.js';

describe('CPA — system prompts', () => {
    test('SESSION_MODES is a non-empty array including the default', () => {
        expect(Array.isArray(SESSION_MODES)).toBe(true);
        expect(SESSION_MODES.length).toBeGreaterThan(0);
        expect(SESSION_MODES).toContain(SESSION_MODE_DEFAULT);
    });

    test('sanitizeSessionMode falls back to default for unknown', () => {
        expect(sanitizeSessionMode('not-a-mode')).toBe(SESSION_MODE_DEFAULT);
        expect(sanitizeSessionMode(SESSION_MODE_DEFAULT)).toBe(SESSION_MODE_DEFAULT);
    });

    test('sanitizeSessionMode accepts every value in SESSION_MODES', () => {
        for (const mode of SESSION_MODES) {
            expect(sanitizeSessionMode(mode)).toBe(mode);
        }
    });
});
