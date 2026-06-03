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

    test('buildModelSystemPrompt with a mode block appends extra content over the default', () => {
        const def = buildModelSystemPrompt({ mode: SESSION_MODE_DEFAULT });
        const others = SESSION_MODES.filter(m => m !== SESSION_MODE_DEFAULT);
        if (others.length === 0) return;
        for (const altMode of others) {
            const alt = buildModelSystemPrompt({ mode: altMode });
            expect(alt.length).toBeGreaterThan(def.length);
        }
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

    test('documents program-driven auto-continue (any tool call → next round, plain text → stop)', () => {
        // The CPA iter popup's multi-round loop is program-driven by tool-
        // call presence: any tool call triggers another round; plain text
        // with no tool calls ends the iteration. Surface both halves of the
        // contract in the system prompt.
        const out = buildModelSystemPrompt();
        expect(out).not.toMatch(/luker_cpa_continue_iteration/);
        expect(out).not.toMatch(/luker_cpa_finalize_iteration/);
        expect(out.toLowerCase()).toMatch(/auto-continue|tool call/);
        expect(out.toLowerCase()).toMatch(/plain text|no tool calls/);
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

    test('orchestrator-optimize mode block introduces extract-to-skill as a peer disposition', () => {
        // With skills available, multi-paragraph reusable rule blocks should
        // prefer extraction (verbatim → skill + pointer in entry) over the
        // inline strip-and-rewrite that pre-skill versions defaulted to.
        // The mode block must call this out as a first-class disposition,
        // not as an aside, so the AI doesn't keep diluting strong rules into
        // soft cognitive guidance when extraction would preserve them.
        const out = buildModelSystemPrompt({ mode: 'orchestrator-optimize' });
        // Category C must exist alongside A (process coercion) and B (final-
        // output shape).
        expect(out).toMatch(/^C\.\s/m);
        // The category must name skill_create and the splice-in-pointer tools.
        expect(out).toMatch(/skill_create/);
        expect(out).toMatch(/preset_str_delete_in_prompt/);
        expect(out).toMatch(/preset_str_insert_in_prompt/);
        // The verbatim discipline must be named in the mode block (not only
        // in the augmentation), so a user-edited mode-block override that
        // drops the augmentation still preserves the discipline.
        expect(out).toMatch(/[Vv]erbatim|VERBATIM/);
        // The category C entry must explain WHY extraction beats inline
        // rewriting (preservation of imperative force / shareability across
        // sub-agents). At least one of these reasons must be present.
        expect(out).toMatch(/imperative|shareability|sub-agent|verbatim preservation/i);
    });

    test('decision tree adds the orthogonal skill-extraction check', () => {
        // The decision tree should explicitly tell the AI to do the C check
        // BEFORE applying the A/B disposition — otherwise the AI defaults
        // into inline rewriting and never reaches the extraction step.
        const out = buildModelSystemPrompt({ mode: 'orchestrator-optimize' });
        expect(out).toMatch(/reusable rule block|category C/i);
        // The "BEFORE the strip/rewrite" ordering hint must be present —
        // it's the load-bearing fragment that makes the sweep proactive
        // during an adapt round.
        expect(out).toMatch(/BEFORE the strip|before .* strip|extract to skill .* (?:before|first)/i);
    });

    test('Approach checklist names the per-paragraph category-C check', () => {
        // The approach checklist now has a step explicitly telling the AI
        // to run the category-C check on each substantive paragraph. Without
        // it, the AI silently skips extraction because the prior checklist
        // didn't ask for it.
        const out = buildModelSystemPrompt({ mode: 'orchestrator-optimize' });
        const approachStart = out.indexOf('Approach:');
        expect(approachStart).toBeGreaterThanOrEqual(0);
        const approachSlice = out.slice(approachStart);
        expect(approachSlice).toMatch(/category-C|category C/i);
        expect(approachSlice).toMatch(/skill_create/);
    });
});
