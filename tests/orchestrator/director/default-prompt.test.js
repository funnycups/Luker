import { describe, expect, test } from '@jest/globals';
import { buildDirectorDefaultSystemPrompt } from '../../../public/scripts/extensions/orchestrator/director-default-prompt.js';

/**
 * The default director-mode system prompt is STRONGLY COUPLED to the
 * default sub-agent set in `createDefaultDirectorProfile` —
 * voice_critic, continuity_critic, context_scout. It is the operations
 * manual for THAT specific config, not a generic director-mode
 * tutorial. Generic principles live in the Studio iteration prompt
 * (see main.js / buildAiIterationSystemPrompt director branch).
 *
 * These tests pin the coupling: if you change the default sub-agent
 * set, you must update the default prompt too — and vice versa.
 */
describe('director default system prompt — concrete for the default profile', () => {
    test('names the ten default analysts by id', () => {
        const text = buildDirectorDefaultSystemPrompt();
        // Pre-draft scouts:
        expect(text).toContain('chat_scout');
        expect(text).toContain('memory_scout');
        expect(text).toContain('lorebook_scout');
        // Pre-draft notes scout:
        expect(text).toContain('notes_pickup_scout');
        // On-demand external scout:
        expect(text).toContain('canon_scout');
        // Cross-source pre-draft scout:
        expect(text).toContain('epistemic_scout');
        // Mid-stage brainstormer:
        expect(text).toContain('plot_brainstormer');
        // Post-draft critics:
        expect(text).toContain('voice_critic');
        expect(text).toContain('continuity_critic');
        // Post-draft notes curator:
        expect(text).toContain('notes_curator');
        // Old singular context_scout should be gone (now split into three).
        expect(text).not.toContain('context_scout');
    });

    test('main agent default prompt mentions notes anti-pollution policy', () => {
        const prompt = buildDirectorDefaultSystemPrompt();
        expect(prompt).toMatch(/notes/i);
        // Anti-pollution key phrases
        expect(prompt).toMatch(/do not.*record.*just to|don't open.*without|conservative.*notes|notes pollution/i);
    });

    test('main agent default prompt includes notes_pickup_scout and notes_curator dispatch templates', () => {
        const prompt = buildDirectorDefaultSystemPrompt();
        expect(prompt).toMatch(/notes_pickup_scout/);
        expect(prompt).toMatch(/notes_curator/);
    });

    test('teaches a task-brief shape for each analyst', () => {
        const text = buildDirectorDefaultSystemPrompt();
        expect(text).toMatch(/Task brief shape/);
        // Each analyst should have its own brief shape section.
        const briefShapeCount = (text.match(/Task brief shape/g) || []).length;
        expect(briefShapeCount).toBeGreaterThanOrEqual(7);
    });

    test('explains the workflow concretely (pre-draft scouting / draft / post-draft analysis / integrate / finalize)', () => {
        const text = buildDirectorDefaultSystemPrompt();
        expect(text).toMatch(/Pre-draft scout/i);
        expect(text).toMatch(/Draft\./);
        expect(text).toMatch(/Post-draft analysis/i);
        expect(text).toMatch(/Integrate/i);
        expect(text).toMatch(/Finalize/i);
    });

    test('does NOT branch on subAgents arg (function is parameter-free behaviorally)', () => {
        // Old design parameterized on subAgents; new design is hardcoded.
        // Passing different args (or none) yields identical output.
        const noArgs = buildDirectorDefaultSystemPrompt();
        const emptyObj = buildDirectorDefaultSystemPrompt({});
        const withRandomData = buildDirectorDefaultSystemPrompt({
            subAgents: [
                { id: 'random_thing', description: 'something else', systemPrompt: 'whatever' },
            ],
        });
        expect(noArgs).toBe(emptyObj);
        expect(noArgs).toBe(withRandomData);
    });

    test('does NOT leak hidden sub-agent systemPrompt content (description is the main agent\'s view)', () => {
        // Even if a caller passes sub-agents with systemPrompts, the
        // function ignores them. The prompt does not contain raw
        // systemPrompt content for the default analysts either — only
        // a description-level summary the main agent can act on.
        const text = buildDirectorDefaultSystemPrompt({
            subAgents: [
                { id: 'voice_critic', description: 'x', systemPrompt: 'PRIVATE_HIDDEN_DO_NOT_LEAK_xyz123' },
            ],
        });
        expect(text).not.toMatch(/PRIVATE_HIDDEN_DO_NOT_LEAK_xyz123/);
    });

    test('does NOT include generic abstract principles like "direction not verdict" as a top-level concept', () => {
        // We CAN have "directions, not verdicts" as a tactical note
        // about how to brief analysts in this profile — that is
        // operational. But it should not appear as a section header
        // teaching the abstract concept; that belongs in the Studio
        // iteration prompt.
        const text = buildDirectorDefaultSystemPrompt();
        // The phrase can appear (tactical use), but should not be a
        // standalone section like "## Direction, not verdict".
        expect(text).not.toMatch(/^##\s*Direction,\s*not\s*verdict\s*$/m);
    });

    test('documents the dispatch_inline_subagent escape hatch', () => {
        const text = buildDirectorDefaultSystemPrompt();
        expect(text).toContain('dispatch_inline_subagent');
        // And points out it should NOT be used to reinvent configured roles.
        expect(text).toMatch(/(reinvent|use the configured one)/i);
    });

    test('describes runtime completion notification format', () => {
        const text = buildDirectorDefaultSystemPrompt();
        expect(text).toMatch(/\[Runtime\] sub-agent/);
        expect(text).toMatch(/do not.*poll/i);
    });

    test('lists what sub-agents see vs do not see (so main can brief well)', () => {
        const text = buildDirectorDefaultSystemPrompt();
        // The baseline must be enumerated so the main agent knows what
        // is and is not in the sub-agent's context. This is operational
        // fact, not abstract principle — stays in the default prompt.
        expect(text).toMatch(/(sub-agents see|every sub-agent gets|do not see)/i);
        expect(text).toMatch(/chat snapshot/i);
        expect(text).toMatch(/get_draft/);
    });

    test('describes fork-on-dispatch visibility — main reasoning + prior sub outputs ARE visible via digest', () => {
        const text = buildDirectorDefaultSystemPrompt();
        // Confirms the prompt is in sync with the runtime mechanism:
        // sub-agents see main's reasoning + earlier sub outputs via the
        // "Main agent context" digest message. The old "sub-agents do
        // NOT see your reasoning text or your prior tool calls" claim
        // would mis-instruct the main agent under the new mechanism.
        expect(text).toMatch(/Main agent context/);
        expect(text).toMatch(/digest/i);
        // Same-round siblings remain invisible (correct under fork-on-dispatch
        // because each sibling's snapshot was captured before this round).
        expect(text).toMatch(/(same-round|not yet completed)/i);
        // Implication about transcription should be made explicit so the
        // main agent doesn't waste task-brief tokens verbatim-quoting earlier
        // sub outputs.
        expect(text).toMatch(/verbatim-transcribe|do not need to repeat|already see them through the digest/i);
    });

    test('teaches the parallel dispatch pattern (N tool_calls in one assistant message + await_subagents next round)', () => {
        const text = buildDirectorDefaultSystemPrompt();
        // The N-tool-calls-one-message pattern is the core throughput
        // mechanism; the prompt must teach it explicitly or the model
        // defaults to one-per-round sequential dispatch.
        expect(text).toMatch(/parallel/i);
        expect(text).toMatch(/(IN THE SAME ASSISTANT MESSAGE|same assistant message)/i);
        expect(text).toMatch(/await_subagents/);
    });

    test('canon_scout is taught as ON-DEMAND for fanfiction / public-IP only', () => {
        const text = buildDirectorDefaultSystemPrompt();
        // The whole point of canon_scout is "do not waste tokens on
        // original-fiction sessions" — the prompt must say so or the
        // model will dispatch it routinely along with the other scouts.
        expect(text).toMatch(/canon_scout/);
        expect(text).toMatch(/(fanfiction|public[- ]IP|fandom)/i);
        expect(text).toMatch(/(on-demand|optional|skip.*original|do not dispatch routinely)/i);
    });

    test('chat_scout / memory_scout descriptions mention signal-vs-noise judgment', () => {
        const text = buildDirectorDefaultSystemPrompt();
        // The new noise-judgment capability needs to surface in the
        // main agent's view of these scouts; otherwise the main agent
        // does not know to read their "demoted" / "low signal" callouts.
        expect(text).toMatch(/signal[- ]vs[- ]noise|signal.*noise|demote/i);
    });
});
