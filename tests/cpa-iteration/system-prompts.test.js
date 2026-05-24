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

    test('documents finalize-sticky ordering so the LLM knows finalize wins over continue in the same round', () => {
        // The popup's onControlCall handler treats finalize as sticky: if a
        // single round emits both continue + finalize, finalize wins and the
        // loop ends. Surface the rule in the system prompt so the model can
        // plan accordingly rather than be surprised by the runner.
        const out = buildModelSystemPrompt();
        expect(out).toMatch(/luker_cpa_continue_iteration/);
        expect(out).toMatch(/luker_cpa_finalize_iteration/);
        expect(out.toLowerCase()).toMatch(/finalize wins/);
    });

    test('mentions preset_clone_to_new in the Session-target tools section', () => {
        // The tool is restored as a session-target side-effecting read tool;
        // every mode + reference combination must document it so the AI knows
        // it can derive a safe copy before destructive edits.
        for (const mode of SESSION_MODES) {
            for (const hasReference of [false, true]) {
                const out = buildModelSystemPrompt({ hasReference, mode });
                expect(out).toMatch(/preset_clone_to_new/);
                expect(out).toMatch(/Session-target tools/);
            }
        }
    });

    test('Session-target listing is separate from the Inspection tools listing', () => {
        // preset_clone_to_new must NOT appear under "Inspection tools" — it
        // has its own section because it mutates session state (saves a new
        // preset, swaps the target).
        const out = buildModelSystemPrompt();
        const inspectionStart = out.indexOf('Inspection tools');
        const sessionStart = out.indexOf('Session-target tools');
        expect(inspectionStart).toBeGreaterThanOrEqual(0);
        expect(sessionStart).toBeGreaterThan(inspectionStart);
        // The Inspection-tools section spans up to just before Session-target
        // tools. preset_clone_to_new must not appear in that slice.
        const inspectionSlice = out.slice(inspectionStart, sessionStart);
        expect(inspectionSlice).not.toMatch(/preset_clone_to_new/);
    });

    test('destructive-edit guidance defaults to suggesting derivation via preset_clone_to_new', () => {
        const out = buildModelSystemPrompt();
        // Match the spirit of the rule rather than the exact wording so future
        // copy-edits don't break the test — but pin enough to ensure the
        // safety-net intent is recoverable.
        expect(out).toMatch(/destructive/i);
        expect(out).toMatch(/preset_clone_to_new/);
    });
});
