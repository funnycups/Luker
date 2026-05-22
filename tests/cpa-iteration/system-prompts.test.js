// tests/cpa-iteration/system-prompts.test.js
import { describe, test, expect } from '@jest/globals';
import {
    buildModelSystemPrompt,
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

    test('buildModelSystemPrompt default produces a non-trivial string', () => {
        const out = buildModelSystemPrompt();
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(50);
    });

    test('buildModelSystemPrompt with hasReference: true produces longer output than without', () => {
        const without = buildModelSystemPrompt({ hasReference: false });
        const withRef = buildModelSystemPrompt({ hasReference: true });
        expect(withRef.length).toBeGreaterThan(without.length);
    });

    test('buildModelSystemPrompt with an alternate mode differs from default mode', () => {
        const def = buildModelSystemPrompt({ mode: SESSION_MODE_DEFAULT });
        const others = SESSION_MODES.filter(m => m !== SESSION_MODE_DEFAULT);
        if (others.length === 0) {
            // Only one mode exists — skip this assertion (modes may not gate prompts yet)
            return;
        }
        const altMode = others[0];
        const alt = buildModelSystemPrompt({ mode: altMode });
        // At least one of the alternate modes should produce different output;
        // if not, the test is overly strict — adapter the test if so.
        expect(alt).not.toBe(def);
    });
});
