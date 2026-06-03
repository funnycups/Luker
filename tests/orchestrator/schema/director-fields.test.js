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
import { sanitizeAgentToolFlags } from '../../../public/scripts/extensions/orchestrator/persistence.js';
import { getEnabledToolSchemas } from '../../../public/scripts/extensions/orchestrator/loop-tools.js';

describe('sanitizeAgentToolFlags: note flag migration', () => {
    test('legacy note.add/delete migrated to note.open/close', () => {
        const sanitized = sanitizeAgentToolFlags({
            note: { add: true, delete: false },
        });
        expect(sanitized.note).toEqual({ open: true, close: false });
        expect(sanitized.note.add).toBeUndefined();
        expect(sanitized.note.delete).toBeUndefined();
    });

    test('new note.open/close pass through unchanged', () => {
        const sanitized = sanitizeAgentToolFlags({
            note: { open: false, close: true },
        });
        expect(sanitized.note).toEqual({ open: false, close: true });
    });

    test('mixed old+new: new takes precedence', () => {
        const sanitized = sanitizeAgentToolFlags({
            note: { add: true, open: false, delete: true, close: false },
        });
        expect(sanitized.note).toEqual({ open: false, close: false });
    });

    test('empty note section under defaultAllOn:true gets both on', () => {
        const sanitized = sanitizeAgentToolFlags({}, { defaultAllOn: true });
        expect(sanitized.note).toEqual({ open: true, close: true });
    });
});

describe('sanitizeAgentToolFlags: collab namespace (main-agent dispatchers)', () => {
    test('explicit collab flags pass through unchanged', () => {
        const sanitized = sanitizeAgentToolFlags({
            collab: { dispatch_subagent: false, dispatch_inline_subagent: true },
        });
        expect(sanitized.collab).toEqual({
            dispatch_subagent: false,
            dispatch_inline_subagent: true,
        });
    });

    test('missing collab namespace defaults all off under defaultAllOn:false', () => {
        const sanitized = sanitizeAgentToolFlags({});
        expect(sanitized.collab).toEqual({
            dispatch_subagent: false,
            dispatch_inline_subagent: false,
        });
    });

    test('missing collab namespace defaults all on under defaultAllOn:true', () => {
        const sanitized = sanitizeAgentToolFlags({}, { defaultAllOn: true });
        expect(sanitized.collab).toEqual({
            dispatch_subagent: true,
            dispatch_inline_subagent: true,
        });
    });

    test('partial collab section: specified flag wins, others fall back to default', () => {
        const sanitized = sanitizeAgentToolFlags(
            { collab: { dispatch_inline_subagent: false } },
            { defaultAllOn: true },
        );
        expect(sanitized.collab.dispatch_subagent).toBe(true);
        expect(sanitized.collab.dispatch_inline_subagent).toBe(false);
    });
});

describe('sanitizeDirectorProfile: legacy-collab migration', () => {
    // Pre-existing director profiles persisted before the collab namespace
    // shipped have a `tools` object with no `collab` key. The director
    // sanitizer must treat that case as legacy (both dispatchers on),
    // otherwise upgrading the plugin would silently strip every existing
    // user's sub-agent dispatchers on the first load. Explicit collab
    // blocks pass through unchanged.

    test('director.tools with no collab key → both dispatchers on (legacy migration)', () => {
        const sanitized = sanitizeDirectorProfile({
            director: {
                tools: {
                    chat: { read_range: true, search: false },
                    // intentionally no `collab` — simulates a pre-upgrade profile
                },
            },
        });
        expect(sanitized.tools.collab).toEqual({
            dispatch_subagent: true,
            dispatch_inline_subagent: true,
        });
        // Legacy migration must not silently re-enable other explicitly-
        // disabled flags — only the missing namespace is filled.
        expect(sanitized.tools.chat.read_range).toBe(true);
        expect(sanitized.tools.chat.search).toBe(false);
    });

    test('director.tools.collab present passes through unchanged (no migration)', () => {
        const sanitized = sanitizeDirectorProfile({
            director: {
                tools: {
                    collab: { dispatch_subagent: false, dispatch_inline_subagent: false },
                },
            },
        });
        expect(sanitized.tools.collab).toEqual({
            dispatch_subagent: false,
            dispatch_inline_subagent: false,
        });
    });

    test('mainAgent.tools override with no collab key → both dispatchers on (legacy migration)', () => {
        const sanitized = sanitizeDirectorProfile({
            director: {
                mainAgent: {
                    tools: {
                        chat: { read_range: true },
                        // no collab — legacy override
                    },
                },
            },
        });
        expect(sanitized.mainAgent.tools.collab).toEqual({
            dispatch_subagent: true,
            dispatch_inline_subagent: true,
        });
    });

    test('mainAgent.tools override with explicit collab passes through unchanged', () => {
        const sanitized = sanitizeDirectorProfile({
            director: {
                mainAgent: {
                    tools: {
                        collab: { dispatch_subagent: false, dispatch_inline_subagent: true },
                    },
                },
            },
        });
        expect(sanitized.mainAgent.tools.collab).toEqual({
            dispatch_subagent: false,
            dispatch_inline_subagent: true,
        });
    });
});

describe('director schema fields', () => {
    test('ORCH_EXECUTION_MODE_DIRECTOR exported as the string "director"', () => {
        expect(ORCH_EXECUTION_MODE_DIRECTOR).toBe('director');
    });

    test('createDefaultDirectorProfile returns a usable default', () => {
        const p = createDefaultDirectorProfile();
        expect(p.mode).toBe('director');
        expect(p.mainAgent).toEqual(expect.objectContaining({ promptPresetName: '', apiPresetName: '' }));
        expect(Array.isArray(p.subAgents)).toBe(true);
        expect(p.maxRounds).toBeGreaterThan(0);
        expect(p.maxConcurrentSubagents).toBeGreaterThan(0);
        expect(p.maxTotalSubagentRuns).toBeGreaterThan(0);
        // Tools use the nested loop-style schema. Default = every verb on,
        // except `finalize` which is forced off (director ships its own).
        // memory + search tools live in Layer-2 now; the director default
        // pre-populates `tools.custom` with the full memory_* + search_*
        // verb set so memory_scout / memory_curator / canon_scout have
        // the same default pipeline they had before the namespace drop.
        expect(p.tools).toEqual(expect.objectContaining({
            chat: expect.objectContaining({ read_range: expect.any(Boolean), search: expect.any(Boolean) }),
            lorebook: expect.objectContaining({ search: expect.any(Boolean), get: expect.any(Boolean) }),
            note: expect.objectContaining({ open: expect.any(Boolean), close: expect.any(Boolean) }),
            custom: expect.objectContaining({
                memory_list_candidates: expect.any(Boolean),
                memory_edge_summary: expect.any(Boolean),
                memory_node_brief: expect.any(Boolean),
                memory_expand_seeds: expect.any(Boolean),
                memory_schema: expect.any(Boolean),
                memory_keyword_search: expect.any(Boolean),
                memory_vector_search: expect.any(Boolean),
                memory_find_by_name: expect.any(Boolean),
                memory_compaction_candidates: expect.any(Boolean),
                memory_node_create: expect.any(Boolean),
                memory_node_edit: expect.any(Boolean),
                memory_node_delete: expect.any(Boolean),
                memory_link_upsert: expect.any(Boolean),
                memory_link_delete: expect.any(Boolean),
                memory_compact_nodes: expect.any(Boolean),
                search_search: expect.any(Boolean),
                search_visit: expect.any(Boolean),
            }),
            finalize: false,
        }));
        // Default disposition is all-on across namespaces.
        expect(p.tools.chat.read_range).toBe(true);
        expect(p.tools.note.open).toBe(true);
        expect(p.tools.custom.search_search).toBe(true);
        expect(p.tools.custom.search_visit).toBe(true);
        // legacy `tools.search` namespace is gone post-Unit-5.
        expect(p.tools.search).toBeUndefined();
        // Spec 2: read-api pipeline tools ship on by default so memory_scout
        // can run an LLM-grade recall pass out of the box. A regression here
        // would silently demote memory_scout back to legacy substring search.
        expect(p.tools.custom.memory_list_candidates).toBe(true);
        expect(p.tools.custom.memory_edge_summary).toBe(true);
        expect(p.tools.custom.memory_node_brief).toBe(true);
        expect(p.tools.custom.memory_expand_seeds).toBe(true);
        expect(p.tools.custom.memory_schema).toBe(true);
        // Spec-2 retrieval + compaction tools (replaced the old `rank` aggregate).
        expect(p.tools.custom.memory_keyword_search).toBe(true);
        expect(p.tools.custom.memory_vector_search).toBe(true);
        expect(p.tools.custom.memory_find_by_name).toBe(true);
        expect(p.tools.custom.memory_compaction_candidates).toBe(true);
        // Write-api primitives are default-on so memory_curator can mutate the graph.
        expect(p.tools.custom.memory_node_create).toBe(true);
        expect(p.tools.custom.memory_node_edit).toBe(true);
        expect(p.tools.custom.memory_node_delete).toBe(true);
        expect(p.tools.custom.memory_link_upsert).toBe(true);
        expect(p.tools.custom.memory_link_delete).toBe(true);
        expect(p.tools.custom.memory_compact_nodes).toBe(true);
        expect(p.discardOnAbort).toBe(false);
    });

    test('createDefaultDirectorProfile ships with the twelve default RP analyst sub-agents (1 cross-source intent scout + 3 single-source scouts + 1 external scout + 1 epistemic scout + 1 notes pickup scout + 1 brainstormer + 2 critics + 1 notes curator + 1 memory curator)', () => {
        const p = createDefaultDirectorProfile();
        const ids = p.subAgents.map(a => a.id).sort();
        // The default main-agent prompt (director-default-prompt.js) is
        // strongly coupled to this exact set — it names them by id and
        // gives task-brief shapes for each. Adding / removing / renaming
        // here requires updating that prompt to match.
        expect(ids).toEqual([
            'canon_scout',
            'chat_scout',
            'continuity_critic',
            'epistemic_scout',
            'intent_scout',
            'lorebook_scout',
            'memory_curator',
            'memory_scout',
            'notes_curator',
            'notes_pickup_scout',
            'plot_brainstormer',
            'voice_critic',
        ]);
        // Each must have a non-empty description and systemPrompt — the
        // sanitizer drops sub-agents missing either field.
        for (const a of p.subAgents) {
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
        for (const a of p.subAgents) {
            // notes_curator and memory_curator are post-draft housekeepers, not knowledge-source
            // scouts — their descriptions intentionally do not use the "does NOT know" /
            // "task brief" shape that the scouts share. Exempt them from this structural check.
            if (a.id === 'notes_curator' || a.id === 'memory_curator') continue;
            expect(a.description).toMatch(/(does NOT know|Does NOT know|doesn't know)/);
            expect(a.description).toMatch(/(task brief|brief)/i);
        }
    });

    test('default sub-agents survive sanitize round-trip (no field gets dropped)', () => {
        const p = createDefaultDirectorProfile();
        const sanitized = sanitizeDirectorProfile(p);
        expect(sanitized.subAgents).toHaveLength(12);
        const ids = sanitized.subAgents.map(a => a.id).sort();
        expect(ids).toEqual([
            'canon_scout',
            'chat_scout',
            'continuity_critic',
            'epistemic_scout',
            'intent_scout',
            'lorebook_scout',
            'memory_curator',
            'memory_scout',
            'notes_curator',
            'notes_pickup_scout',
            'plot_brainstormer',
            'voice_critic',
        ]);
        for (const a of sanitized.subAgents) {
            expect(a.description.length).toBeGreaterThan(0);
            expect(a.systemPrompt.length).toBeGreaterThan(0);
        }
    });

    test('default pre-draft scouts are each scoped to one source (orthogonal — stay in your lane)', () => {
        // Per-feedback (no-prompt-regex-tests): the lane-scope discipline lives
        // in the per-sub-agent method skill body, not in the inline systemPrompt.
        // Verify each single-source scout is bound to its method skill, which is
        // where the "stay in your lane" rule is enforced.
        const p = createDefaultDirectorProfile();
        const byId = Object.fromEntries(p.subAgents.map(a => [a.id, a]));
        const expectBound = (id, skill) => {
            const visible = byId[id]?.skills?.visible || [];
            expect(visible).toContain(skill);
        };
        expectBound('chat_scout', 'chat-scout-method-zh');
        expectBound('memory_scout', 'memory-scout-method-zh');
        expectBound('lorebook_scout', 'lorebook-scout-method-zh');
        expectBound('canon_scout', 'canon-scout-method-zh');
    });

    test('chat_scout description signals the signal-vs-noise filter', () => {
        // Per-feedback (no-prompt-regex-tests): inline systemPrompt body no
        // longer enumerates de-weight rules — they live in chat-scout-method-zh.
        // Description is the dispatcher-facing one-liner; pin it here so the
        // main agent can still discover this scout's purpose without skill_read.
        const p = createDefaultDirectorProfile();
        const byId = Object.fromEntries(p.subAgents.map(a => [a.id, a]));
        expect(byId.chat_scout.description).toMatch(/signal[- ]vs[- ]noise|de-?weight|low.signal/i);
    });

    test('memory_scout (spec 2) advertises the read-api pipeline at description level', () => {
        // Per-feedback (no-prompt-regex-tests): the full enumerate → search →
        // expand → cite pipeline + tool-table + stay-in-your-lane / drop-stale-
        // phrasing lives in memory-scout-method-zh. The inline systemPrompt is
        // a role declaration + "Read skill X" trigger + brief reliance only.
        // We only pin description-level signals (the dispatcher-facing contract)
        // and the skill binding here.
        const p = createDefaultDirectorProfile();
        const byId = Object.fromEntries(p.subAgents.map(a => [a.id, a]));
        const ms = byId.memory_scout;

        // description: enumerate (not traverse).
        expect(ms.description).not.toMatch(/traverse/i);
        expect(ms.description).toMatch(/enumerate/i);

        // Skill binding: memory_scout must reference memory-scout-method-zh.
        expect(ms.skills?.visible || []).toContain('memory-scout-method-zh');
    });

    test('canon_scout description guards against original-fiction misuse', () => {
        const p = createDefaultDirectorProfile();
        const canon = p.subAgents.find(a => a.id === 'canon_scout');
        expect(canon).toBeDefined();
        // canon_scout is on-demand; its description must signal that running
        // it for original fiction is a waste.
        expect(canon.description).toMatch(/(fanfiction|public IP|fanon)/i);
        expect(canon.description).toMatch(/(do not dispatch|wastes? tokens|original[- ]fiction)/i);
    });

    test('epistemic_scout is cross-source by design (per description + skill binding)', () => {
        // Per-feedback (no-prompt-regex-tests): the Knows / Doesn't-know /
        // Omniscience-traps structure and the cross-source method are in
        // epistemic-scout-method-zh. Pin description-level signals + binding only.
        const p = createDefaultDirectorProfile();
        const epi = p.subAgents.find(a => a.id === 'epistemic_scout');
        expect(epi).toBeDefined();
        // Description must signal the POV-binding mission and the joined sources.
        expect(epi.description).toMatch(/POV|knowledge boundary|knowledge-boundary/i);
        expect(epi.description).toMatch(/chat/);
        expect(epi.description).toMatch(/lorebook/);
        // Skill binding.
        expect(epi.skills?.visible || []).toContain('epistemic-scout-method-zh');
    });

    test('voice_critic advertises the Hard-fail meta-narration scan at description level', () => {
        // Per-feedback (no-prompt-regex-tests): the Class A (config labels) +
        // Class B (platform-frame leakage) enumerations, the bilingual keyword
        // list, the in-world replacement examples, and the [Hard-fail] output
        // tag live in voice-critic-method-zh. Inline contains only role + skill
        // pointer. Pin description-level + binding.
        const p = createDefaultDirectorProfile();
        const vc = p.subAgents.find(a => a.id === 'voice_critic');
        expect(vc).toBeDefined();
        // Description signals: Hard-fail mode + both classes (config labels + platform frame).
        expect(vc.description).toMatch(/Hard-fail|HARD-FAIL/);
        expect(vc.description).toMatch(/(meta-narration|fourth-wall)/i);
        expect(vc.description).toMatch(/platform-frame|上一轮|previous round/i);
        expect(vc.description).toMatch(/旁白|narration/i);
        // Skill binding.
        expect(vc.skills?.visible || []).toContain('voice-critic-method-zh');
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
                    memory: {
                        list_candidates: true, edge_summary: true, node_brief: true,
                        expand_seeds: true, schema: true,
                        keyword_search: true, vector_search: true, find_by_name: true,
                        compaction_candidates: true,
                        node_create: true, node_edit: true, node_delete: true,
                        link_upsert: true, link_delete: true, compact_nodes: true,
                    },
                    note: { open: false, close: false },
                    search: { search: false, visit: false },
                },
            },
        };
        const sanitized = sanitizeDirectorProfile(profile);
        expect(sanitized.subAgents).toHaveLength(2);
        expect(sanitized.subAgents[0]).toEqual(expect.objectContaining({ id: 'critic' }));
        // Tool flags pass through unchanged (sanitizeAgentToolFlags is the
        // canonical contract; we only verify director respects what was set).
        expect(sanitized.tools.chat.read_range).toBe(true);
        expect(sanitized.tools.chat.search).toBe(false);
        expect(sanitized.tools.custom.memory_list_candidates).toBe(true);
        expect(sanitized.tools.finalize).toBe(false);  // director always strips loop's finalize
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
        expect(sanitized.tools.finalize).toBe(false);
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
        const ids = sanitized.subAgents.map(a => a.id);
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
        expect(sanitized.subAgents).toHaveLength(1);
        expect(sanitized.subAgents[0].description).toBe('second');
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
        expect(sanitized.maxRounds).toBeGreaterThanOrEqual(1);
        expect(sanitized.maxConcurrentSubagents).toBeGreaterThanOrEqual(1);
        expect(sanitized.maxTotalSubagentRuns).toBeLessThanOrEqual(100);
    });

    test('mainAgent.tools null/undefined → inherit (null after sanitize)', () => {
        const sanitizedNull = sanitizeDirectorProfile({
            director: { mainAgent: { tools: null }, subAgents: [] },
        });
        expect(sanitizedNull.mainAgent.tools).toBeNull();

        const sanitizedUndef = sanitizeDirectorProfile({
            director: { mainAgent: {}, subAgents: [] },
        });
        expect(sanitizedUndef.mainAgent.tools).toBeNull();
    });

    test('mainAgent.tools object → override (full canonical shape, finalize:false)', () => {
        const sanitized = sanitizeDirectorProfile({
            director: {
                mainAgent: { tools: { chat: { read_range: true }, finalize: true } },
                subAgents: [],
            },
        });
        expect(sanitized.mainAgent.tools).not.toBeNull();
        expect(sanitized.mainAgent.tools.chat.read_range).toBe(true);
        // Unspecified verbs default off for override (defaultAllOn:false).
        expect(sanitized.mainAgent.tools.chat.search).toBe(false);
        // Director always strips loop's finalize.
        expect(sanitized.mainAgent.tools.finalize).toBe(false);
    });

    test('subAgents[i].tools null → inherit; object → override (narrows)', () => {
        const sanitized = sanitizeDirectorProfile({
            director: {
                mainAgent: {},
                subAgents: [
                    { id: 'inh', description: 'x', systemPrompt: 'x', tools: null },
                    { id: 'ovr', description: 'x', systemPrompt: 'x', tools: { memory: { keyword_search: true } } },
                ],
            },
        });
        const inh = sanitized.subAgents.find(a => a.id === 'inh');
        const ovr = sanitized.subAgents.find(a => a.id === 'ovr');
        expect(inh.tools).toBeNull();
        expect(ovr.tools).not.toBeNull();
        // The memory.* override narrows: only the requested verb is exposed.
        // The other 14 memory verbs must be explicitly false (not just absent
        // from the override) so Layer-2's default-on policy
        // (`customFlags[name] !== false`) keeps them OUT of the schema list.
        expect(ovr.tools.custom.memory_keyword_search).toBe(true);
        expect(ovr.tools.custom.memory_node_create).toBe(false);
        expect(ovr.tools.custom.memory_node_edit).toBe(false);
        expect(ovr.tools.custom.memory_node_delete).toBe(false);
        expect(ovr.tools.custom.memory_list_candidates).toBe(false);
        expect(ovr.tools.custom.memory_edge_summary).toBe(false);
        expect(ovr.tools.custom.memory_node_brief).toBe(false);
        expect(ovr.tools.custom.memory_expand_seeds).toBe(false);
        expect(ovr.tools.custom.memory_schema).toBe(false);
        expect(ovr.tools.custom.memory_vector_search).toBe(false);
        expect(ovr.tools.custom.memory_find_by_name).toBe(false);
        expect(ovr.tools.custom.memory_compaction_candidates).toBe(false);
        expect(ovr.tools.custom.memory_link_upsert).toBe(false);
        expect(ovr.tools.custom.memory_link_delete).toBe(false);
        expect(ovr.tools.custom.memory_compact_nodes).toBe(false);
        // Schema-list contract: getEnabledToolSchemas filters on
        // `customFlags[name] !== false`, so explicit false drops the
        // schema even when the registry exposes the tool. Verify the
        // schema list under a hypothetical full registry: only the
        // requested verb survives.
        const fakeRegistry = new Map([
            ['memory_keyword_search', { schema: { type: 'function', function: { name: 'memory_keyword_search' } } }],
            ['memory_node_create', { schema: { type: 'function', function: { name: 'memory_node_create' } } }],
            ['memory_node_edit', { schema: { type: 'function', function: { name: 'memory_node_edit' } } }],
            ['memory_compact_nodes', { schema: { type: 'function', function: { name: 'memory_compact_nodes' } } }],
        ]);
        const names = getEnabledToolSchemas(ovr, fakeRegistry).map(s => String(s?.function?.name || ''));
        expect(names).toContain('memory_keyword_search');
        expect(names).not.toContain('memory_node_create');
        expect(names).not.toContain('memory_node_edit');
        expect(names).not.toContain('memory_compact_nodes');
        expect(ovr.tools.finalize).toBe(false);
    });

    test('default profile sub-agents carry precise per-role tool overrides', () => {
        const def = createDefaultDirectorProfile();
        const byId = new Map(def.subAgents.map(a => [a.id, a]));

        // Sanity: every default sub-agent should have an override (not null).
        for (const [id, agent] of byId) {
            expect(agent.tools).not.toBeNull();
            expect(typeof agent.tools).toBe('object');
        }

        const sanitized = sanitizeDirectorProfile(def);
        const sById = new Map(sanitized.subAgents.map(a => [a.id, a]));

        // intent_scout: chat + lorebook (no memory, no search)
        expect(sById.get('intent_scout').tools.chat.read_range).toBe(true);
        expect(sById.get('intent_scout').tools.lorebook.search).toBe(true);
        // intent_scout doesn't list memory_* or search_*, so under the
        // override-narrow contract every Layer-2 verb is explicitly false.
        expect(sById.get('intent_scout').tools.custom.memory_node_brief).toBe(false);
        expect(sById.get('intent_scout').tools.custom.search_search).toBe(false);
        expect(sById.get('intent_scout').tools.custom.search_visit).toBe(false);

        // memory_scout: memory reads only, no writes — write verbs
        // explicit false; read verbs true.
        expect(sById.get('memory_scout').tools.custom.memory_list_candidates).toBe(true);
        expect(sById.get('memory_scout').tools.custom.memory_node_create).toBe(false);
        expect(sById.get('memory_scout').tools.custom.memory_node_edit).toBe(false);

        // memory_curator: full memory read + write
        expect(sById.get('memory_curator').tools.custom.memory_node_create).toBe(true);
        expect(sById.get('memory_curator').tools.custom.memory_compact_nodes).toBe(true);

        // canon_scout: external search only — both search verbs explicit
        // true; memory writes explicit false under override-narrowing.
        expect(sById.get('canon_scout').tools.custom.search_search).toBe(true);
        expect(sById.get('canon_scout').tools.custom.search_visit).toBe(true);
        expect(sById.get('canon_scout').tools.custom.memory_node_create).toBe(false);

        // notes_curator: note open + close
        expect(sById.get('notes_curator').tools.note.open).toBe(true);
        expect(sById.get('notes_curator').tools.note.close).toBe(true);

        // plot_brainstormer: no tools at all (pure thinker)
        const pbBuiltinVerbs = ['note.open', 'note.close', 'chat.read_range', 'chat.search', 'lorebook.search'];
        for (const path of pbBuiltinVerbs) {
            const [ns, verb] = path.split('.');
            expect(sById.get('plot_brainstormer').tools[ns][verb]).toBe(false);
        }
        // Layer-2 memory + search verbs default off (explicit false) under
        // override mode so they don't sneak back via the default-on policy.
        expect(sById.get('plot_brainstormer').tools.custom.memory_node_brief).toBe(false);
        expect(sById.get('plot_brainstormer').tools.custom.search_search).toBe(false);
        expect(sById.get('plot_brainstormer').tools.custom.search_visit).toBe(false);
    });
});
