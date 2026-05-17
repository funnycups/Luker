import { describe, expect, test } from '@jest/globals';
// NOTE: We import from `director-defaults.js` instead of `defaults.js` because
// `defaults.js` transitively imports `script.js` → `public/lib.js`, which
// fails to resolve under the node test environment (lib bundles are browser
// assets). `defaults.js` re-exports these same identifiers for production
// callers, so the behavioral contract the plan specifies is unchanged.
import {
    ORCH_EXECUTION_MODE_DIRECTOR,
    createDefaultDirectorProfile,
    sanitizeDirectorProfile,
} from '../../../public/scripts/extensions/orchestrator/director-defaults.js';

describe('director schema fields', () => {
    test('ORCH_EXECUTION_MODE_DIRECTOR exported as the string "director"', () => {
        expect(ORCH_EXECUTION_MODE_DIRECTOR).toBe('director');
    });

    test('createDefaultDirectorProfile returns a usable default', () => {
        const p = createDefaultDirectorProfile();
        expect(p.mode).toBe('director');
        expect(p.director).toBeDefined();
        expect(p.director.mainAgent).toEqual(expect.objectContaining({ promptPresetName: '', apiPresetName: '' }));
        expect(Array.isArray(p.director.subAgents)).toBe(true);
        expect(p.director.maxRounds).toBeGreaterThan(0);
        expect(p.director.maxConcurrentSubagents).toBeGreaterThan(0);
        expect(p.director.maxTotalSubagentRuns).toBeGreaterThan(0);
        // Tools use the nested loop-style schema. Default = every verb on,
        // except `finalize` which is forced off (director ships its own).
        expect(p.director.tools).toEqual(expect.objectContaining({
            chat: expect.objectContaining({ read_range: expect.any(Boolean), search: expect.any(Boolean) }),
            lorebook: expect.objectContaining({ search: expect.any(Boolean), get: expect.any(Boolean) }),
            memory: expect.objectContaining({ search: expect.any(Boolean), list_recent: expect.any(Boolean), get: expect.any(Boolean) }),
            note: expect.objectContaining({ add: expect.any(Boolean), delete: expect.any(Boolean) }),
            search: expect.objectContaining({ search: expect.any(Boolean), visit: expect.any(Boolean) }),
            finalize: false,
        }));
        // Default disposition is all-on across namespaces.
        expect(p.director.tools.chat.read_range).toBe(true);
        expect(p.director.tools.note.add).toBe(true);
        expect(p.director.discardOnAbort).toBe(false);
    });

    test('createDefaultDirectorProfile ships with the eight default RP analyst sub-agents (3 single-source scouts + 1 external scout + 1 epistemic scout + 1 brainstormer + 2 critics)', () => {
        const p = createDefaultDirectorProfile();
        const ids = p.director.subAgents.map(a => a.id).sort();
        // The default main-agent prompt (director-default-prompt.js) is
        // strongly coupled to this exact set — it names them by id and
        // gives task-brief shapes for each. Adding / removing / renaming
        // here requires updating that prompt to match.
        expect(ids).toEqual([
            'canon_scout',
            'chat_scout',
            'continuity_critic',
            'epistemic_scout',
            'lorebook_scout',
            'memory_scout',
            'plot_brainstormer',
            'voice_critic',
        ]);
        // Each must have a non-empty description and systemPrompt — the
        // sanitizer drops sub-agents missing either field.
        for (const a of p.director.subAgents) {
            expect(typeof a.description).toBe('string');
            expect(a.description.length).toBeGreaterThan(0);
            expect(typeof a.systemPrompt).toBe('string');
            expect(a.systemPrompt.length).toBeGreaterThan(0);
        }
    });

    test('default sub-agent descriptions follow the 3-part convention (role / does not know / brief slot)', () => {
        const p = createDefaultDirectorProfile();
        // Each description should communicate: what the sub-agent
        // knows/does, what it does NOT know, and what the main agent
        // must include in the task brief.
        for (const a of p.director.subAgents) {
            expect(a.description).toMatch(/(does NOT know|Does NOT know|doesn't know)/);
            expect(a.description).toMatch(/(task brief|brief)/i);
        }
    });

    test('default sub-agents survive sanitize round-trip (no field gets dropped)', () => {
        const p = createDefaultDirectorProfile();
        const sanitized = sanitizeDirectorProfile(p);
        expect(sanitized.director.subAgents).toHaveLength(8);
        const ids = sanitized.director.subAgents.map(a => a.id).sort();
        expect(ids).toEqual([
            'canon_scout',
            'chat_scout',
            'continuity_critic',
            'epistemic_scout',
            'lorebook_scout',
            'memory_scout',
            'plot_brainstormer',
            'voice_critic',
        ]);
        for (const a of sanitized.director.subAgents) {
            expect(a.description.length).toBeGreaterThan(0);
            expect(a.systemPrompt.length).toBeGreaterThan(0);
        }
    });

    test('default pre-draft scouts are each scoped to one source (orthogonal — stay in your lane)', () => {
        const p = createDefaultDirectorProfile();
        const byId = Object.fromEntries(p.director.subAgents.map(a => [a.id, a]));
        // Each scout systemPrompt must contain a "stay in your lane"
        // discipline — meaning: don't read from the other sources.
        expect(byId.chat_scout.systemPrompt).toMatch(/stay in your lane/i);
        expect(byId.memory_scout.systemPrompt).toMatch(/stay in your lane/i);
        expect(byId.lorebook_scout.systemPrompt).toMatch(/stay in your lane/i);
        expect(byId.canon_scout.systemPrompt).toMatch(/stay in your lane/i);
    });

    test('chat_scout / memory_scout systemPrompts include signal-vs-noise filter', () => {
        const p = createDefaultDirectorProfile();
        const byId = Object.fromEntries(p.director.subAgents.map(a => [a.id, a]));
        // The noise-judgment capability is the user-asked-for upgrade —
        // pin it in the prompts so future edits cannot silently
        // regress the scouts to "return everything they find".
        expect(byId.chat_scout.systemPrompt).toMatch(/signal[- ]vs[- ]noise|de-?weight|low signal/i);
        expect(byId.memory_scout.systemPrompt).toMatch(/signal[- ]vs[- ]noise|de-?weight|low signal/i);
    });

    test('canon_scout systemPrompt guards against original-fiction misuse', () => {
        const p = createDefaultDirectorProfile();
        const canon = p.director.subAgents.find(a => a.id === 'canon_scout');
        expect(canon).toBeDefined();
        // canon_scout is on-demand; its description and systemPrompt
        // must signal that running it for original fiction is a waste.
        expect(canon.description).toMatch(/(fanfiction|public IP|fanon)/i);
        expect(canon.description).toMatch(/(do not dispatch|wastes? tokens|original[- ]fiction)/i);
    });

    test('epistemic_scout is cross-source by design and outputs omniscience traps', () => {
        const p = createDefaultDirectorProfile();
        const epi = p.director.subAgents.find(a => a.id === 'epistemic_scout');
        expect(epi).toBeDefined();
        // epistemic_scout is the only pre-draft scout that cross-references
        // chat against lorebook + memory — the "stay in your lane" rule
        // explicitly does not apply to it, because cross-referencing IS
        // its lane. Pin those facts in the prompts so future edits cannot
        // silently regress the scout to a single-source one.
        expect(epi.systemPrompt).toMatch(/cross[- ]?source|cross[- ]?reference|joins? chat against/i);
        // Must produce the per-character knowledge inventory (Knows / Doesn't-know / Omniscience traps).
        expect(epi.systemPrompt).toMatch(/Knows/);
        expect(epi.systemPrompt).toMatch(/Doesn'?t know|DOES NOT KNOW/i);
        expect(epi.systemPrompt).toMatch(/omniscience trap/i);
        // Description must signal the POV-binding mission and cite the
        // sources it joins, so the main agent knows when to dispatch.
        expect(epi.description).toMatch(/POV|knowledge boundary|knowledge-boundary/i);
        expect(epi.description).toMatch(/chat/);
        expect(epi.description).toMatch(/lorebook/);
    });

    test('sanitizeDirectorProfile preserves director.subAgents entries', () => {
        const profile = {
            mode: 'director',
            director: {
                mainAgent: { systemPrompt: 'main' },
                subAgents: [
                    { id: 'critic', description: 'finds issues', systemPrompt: 'be a critic' },
                    { id: 'planner', description: 'plans structure', systemPrompt: 'plan' },
                ],
                maxRounds: 10,
                maxConcurrentSubagents: 2,
                maxTotalSubagentRuns: 8,
                tools: {
                    chat: { read_range: true, search: false },
                    lorebook: { search: false, get: false },
                    memory: { search: true, list_recent: true, get: true },
                    note: { add: false, delete: false },
                    search: { search: false, visit: false },
                },
            },
        };
        const sanitized = sanitizeDirectorProfile(profile);
        expect(sanitized.director.subAgents).toHaveLength(2);
        expect(sanitized.director.subAgents[0]).toEqual(expect.objectContaining({ id: 'critic' }));
        // Tool flags pass through unchanged (sanitizeAgentToolFlags is the
        // canonical contract; we only verify director respects what was set).
        expect(sanitized.director.tools.chat.read_range).toBe(true);
        expect(sanitized.director.tools.chat.search).toBe(false);
        expect(sanitized.director.tools.memory.search).toBe(true);
        expect(sanitized.director.tools.finalize).toBe(false);  // director always strips loop's finalize
    });

    test('sanitizeDirectorProfile forces tools.finalize to false even if input sets it true', () => {
        const sanitized = sanitizeDirectorProfile({
            mode: 'director',
            director: {
                mainAgent: {},
                subAgents: [],
                tools: { finalize: true, chat: { read_range: true, search: true } },
            },
        });
        // Director's own finalize tool has the same name; allowing loop's
        // would create a duplicate in the LLM tools array.
        expect(sanitized.director.tools.finalize).toBe(false);
    });

    test('sanitizeDirectorProfile drops sub-agents with empty id or missing fields', () => {
        const profile = {
            mode: 'director',
            director: {
                mainAgent: {},
                subAgents: [
                    { id: '', description: 'x', systemPrompt: 'x' },        // empty id
                    { id: 'ok', description: 'x', systemPrompt: 'x' },
                    null,                                                     // not an object
                    { id: 'ok2', description: 'x' },                          // missing systemPrompt
                ],
                maxRounds: 5,
            },
        };
        const sanitized = sanitizeDirectorProfile(profile);
        const ids = sanitized.director.subAgents.map(a => a.id);
        expect(ids).toContain('ok');
        expect(ids).not.toContain('');
        expect(ids).not.toContain('ok2');
    });

    test('sanitizeDirectorProfile dedupes sub-agent ids (last wins)', () => {
        const profile = {
            mode: 'director',
            director: {
                mainAgent: {},
                subAgents: [
                    { id: 'dup', description: 'first', systemPrompt: 'first' },
                    { id: 'dup', description: 'second', systemPrompt: 'second' },
                ],
            },
        };
        const sanitized = sanitizeDirectorProfile(profile);
        expect(sanitized.director.subAgents).toHaveLength(1);
        expect(sanitized.director.subAgents[0].description).toBe('second');
    });

    test('sanitizeDirectorProfile clamps numeric limits to sane ranges', () => {
        const profile = {
            mode: 'director',
            director: {
                mainAgent: {},
                subAgents: [],
                maxRounds: -5,                  // → 1
                maxConcurrentSubagents: 0,      // → 1
                maxTotalSubagentRuns: 9999,     // → clamped to 100
            },
        };
        const sanitized = sanitizeDirectorProfile(profile);
        expect(sanitized.director.maxRounds).toBeGreaterThanOrEqual(1);
        expect(sanitized.director.maxConcurrentSubagents).toBeGreaterThanOrEqual(1);
        expect(sanitized.director.maxTotalSubagentRuns).toBeLessThanOrEqual(100);
    });
});
