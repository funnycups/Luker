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
        // The memory subtree carries the read-api pipeline tools
        // (list_candidates / edge_summary / node_brief / expand_seeds /
        // schema) plus the spec-2 search / find / compaction-candidate
        // tools and the write-api primitives — all default-on so the
        // director's default memory_scout / memory_curator have the full
        // pipeline available.
        expect(p.tools).toEqual(expect.objectContaining({
            chat: expect.objectContaining({ read_range: expect.any(Boolean), search: expect.any(Boolean) }),
            lorebook: expect.objectContaining({ search: expect.any(Boolean), get: expect.any(Boolean) }),
            memory: expect.objectContaining({
                list_candidates: expect.any(Boolean),
                edge_summary: expect.any(Boolean),
                node_brief: expect.any(Boolean),
                expand_seeds: expect.any(Boolean),
                schema: expect.any(Boolean),
                keyword_search: expect.any(Boolean),
                vector_search: expect.any(Boolean),
                find_by_name: expect.any(Boolean),
                compaction_candidates: expect.any(Boolean),
                node_create: expect.any(Boolean),
                node_edit: expect.any(Boolean),
                node_delete: expect.any(Boolean),
                link_upsert: expect.any(Boolean),
                link_delete: expect.any(Boolean),
                compact_nodes: expect.any(Boolean),
            }),
            note: expect.objectContaining({ open: expect.any(Boolean), close: expect.any(Boolean) }),
            search: expect.objectContaining({ search: expect.any(Boolean), visit: expect.any(Boolean) }),
            finalize: false,
        }));
        // Default disposition is all-on across namespaces.
        expect(p.tools.chat.read_range).toBe(true);
        expect(p.tools.note.open).toBe(true);
        // Spec 2: read-api pipeline tools ship on by default so memory_scout
        // can run an LLM-grade recall pass out of the box. A regression here
        // would silently demote memory_scout back to legacy substring search.
        expect(p.tools.memory.list_candidates).toBe(true);
        expect(p.tools.memory.edge_summary).toBe(true);
        expect(p.tools.memory.node_brief).toBe(true);
        expect(p.tools.memory.expand_seeds).toBe(true);
        expect(p.tools.memory.schema).toBe(true);
        // Spec-2 retrieval + compaction tools (replaced the old `rank` aggregate).
        expect(p.tools.memory.keyword_search).toBe(true);
        expect(p.tools.memory.vector_search).toBe(true);
        expect(p.tools.memory.find_by_name).toBe(true);
        expect(p.tools.memory.compaction_candidates).toBe(true);
        // Write-api primitives are default-on so memory_curator can mutate the graph.
        expect(p.tools.memory.node_create).toBe(true);
        expect(p.tools.memory.node_edit).toBe(true);
        expect(p.tools.memory.node_delete).toBe(true);
        expect(p.tools.memory.link_upsert).toBe(true);
        expect(p.tools.memory.link_delete).toBe(true);
        expect(p.tools.memory.compact_nodes).toBe(true);
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
        const p = createDefaultDirectorProfile();
        const byId = Object.fromEntries(p.subAgents.map(a => [a.id, a]));
        // Each scout systemPrompt must contain a "stay in your lane"
        // discipline — meaning: don't read from the other sources.
        expect(byId.chat_scout.systemPrompt).toMatch(/stay in your lane/i);
        expect(byId.memory_scout.systemPrompt).toMatch(/stay in your lane/i);
        expect(byId.lorebook_scout.systemPrompt).toMatch(/stay in your lane/i);
        expect(byId.canon_scout.systemPrompt).toMatch(/stay in your lane/i);
    });

    test('chat_scout systemPrompt includes signal-vs-noise filter', () => {
        // chat_scout retains the original signal-vs-noise judgment shape
        // (it reads chat, which is exactly where engagement signal lives).
        // memory_scout has been overhauled in spec 2 — its noise judgment
        // moved from "did the user engage with this in chat?" to
        // "is this node a structural hub per the read-api?"; see the
        // dedicated `memory_scout (spec 2)` test below.
        const p = createDefaultDirectorProfile();
        const byId = Object.fromEntries(p.subAgents.map(a => [a.id, a]));
        expect(byId.chat_scout.systemPrompt).toMatch(/signal[- ]vs[- ]noise|de-?weight|low signal/i);
    });

    test('memory_scout (spec 2) uses read-api pipeline contract instead of chat-grounded signal', () => {
        // Spec 2 (2026-05-18-memory-scout-uses-readonly-api, refined by the
        // 2026-05-19 extraction/compaction-api spec): memory_scout's
        // description + systemPrompt were rewritten to drive the read-only
        // memory-graph API (enumerate → search → expand → cite — the
        // shortlist step is "search" now that memory_rank has been
        // retired in favour of memory_keyword_search /
        // memory_find_by_name / memory_vector_search). The old
        // "engaged with" / "build on" / "sedimented" / "traverse" framing
        // was removed because it required reading chat, which memory_scout
        // is now explicitly forbidden from doing. Pin both sides — what
        // the new prompt SAYS and what it deliberately no longer says —
        // so future edits cannot silently regress the scout to the
        // pre-read-api workflow.
        const p = createDefaultDirectorProfile();
        const byId = Object.fromEntries(p.subAgents.map(a => [a.id, a]));
        const ms = byId.memory_scout;

        // description: enumerate (not traverse).
        expect(ms.description).not.toMatch(/traverse/i);
        expect(ms.description).toMatch(/enumerate/i);

        // systemPrompt: the new four-verb pipeline shape (enumerate → search
        // → expand → cite) must be teachable to the LLM verbatim.
        expect(ms.systemPrompt).toMatch(/enumerate.*search.*expand.*cite/i);
        expect(ms.systemPrompt).toMatch(/1\.\s*\*\*Enumerate\.\*\*/);
        expect(ms.systemPrompt).toMatch(/2\.\s*\*\*Shortlist\.\*\*/);
        expect(ms.systemPrompt).toMatch(/3\.\s*\*\*Brief\.\*\*/);
        expect(ms.systemPrompt).toMatch(/4\.\s*\*\*Expand/);
        expect(ms.systemPrompt).toMatch(/5\.\s*\*\*Cite\.\*\*/);

        // Stale chat-grounded judgment phrases must be gone.
        expect(ms.systemPrompt).not.toMatch(/engaged with/i);
        expect(ms.systemPrompt).not.toMatch(/build on/i);
        expect(ms.systemPrompt).not.toMatch(/sedimented/i);

        // The "stay in your lane" discipline still applies — pin it here
        // too even though `default pre-draft scouts are each scoped to one
        // source` already covers it, because this test is the dedicated
        // contract test for the spec-2 rewrite.
        expect(ms.systemPrompt).toMatch(/stay in your lane/i);
    });

    test('canon_scout systemPrompt guards against original-fiction misuse', () => {
        const p = createDefaultDirectorProfile();
        const canon = p.subAgents.find(a => a.id === 'canon_scout');
        expect(canon).toBeDefined();
        // canon_scout is on-demand; its description and systemPrompt
        // must signal that running it for original fiction is a waste.
        expect(canon.description).toMatch(/(fanfiction|public IP|fanon)/i);
        expect(canon.description).toMatch(/(do not dispatch|wastes? tokens|original[- ]fiction)/i);
    });

    test('epistemic_scout is cross-source by design and outputs omniscience traps', () => {
        const p = createDefaultDirectorProfile();
        const epi = p.subAgents.find(a => a.id === 'epistemic_scout');
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

    test('voice_critic systemPrompt has a Hard-fail meta-narration scan with enumerated substrate keywords', () => {
        // Regression: the main agent repeatedly leaked author-substrate
        // names ("这是世界书里写的那种 X——X 是 ...") into the in-universe
        // draft body. voice_critic is the post-draft owner of catching
        // this; pin both the scan structure and a representative slice of
        // the keyword/pattern list so future edits cannot quietly strip it.
        const p = createDefaultDirectorProfile();
        const vc = p.subAgents.find(a => a.id === 'voice_critic');
        expect(vc).toBeDefined();
        // Description must advertise the Hard-fail mode so the main agent
        // routes meta-leakage to this critic instead of an inline one.
        expect(vc.description).toMatch(/Hard-fail|HARD-FAIL/);
        expect(vc.description).toMatch(/(meta-narration|fourth-wall)/i);
        // systemPrompt must contain the dedicated section and enumerate
        // both CJK and English substrate keywords + at least one of the
        // forbidden citation patterns.
        expect(vc.systemPrompt).toMatch(/# Hard-fail/);
        expect(vc.systemPrompt).toMatch(/(meta-narration|fourth-wall)/i);
        expect(vc.systemPrompt).toMatch(/世界书/);
        expect(vc.systemPrompt).toMatch(/lorebook/);
        expect(vc.systemPrompt).toMatch(/角色卡|character card/);
        expect(vc.systemPrompt).toMatch(/这是世界书里写的那种|according to the lorebook/);
        // Output format must include a hard-fail tagged exemplar so the
        // model produces the right wire shape on findings.
        expect(vc.systemPrompt).toMatch(/\[Hard-fail\]/);
    });

    test('voice_critic systemPrompt also catches Class B platform-frame leakage (上一轮 / turn references)', () => {
        // Regression: the recurring failure mode where the narrator anchors
        // past events on the conversation structure ("上一轮", "previous round")
        // instead of an in-world time frame. Pinning this prevents a future
        // edit from silently dropping platform-frame coverage and leaving
        // only the config-label scan.
        const p = createDefaultDirectorProfile();
        const vc = p.subAgents.find(a => a.id === 'voice_critic');
        expect(vc).toBeDefined();
        // Description must advertise the platform-frame class.
        expect(vc.description).toMatch(/platform-frame|上一轮|previous round/i);
        expect(vc.description).toMatch(/旁白|narration/i);
        // systemPrompt must enumerate at least one CJK and one English
        // turn/round phrase, plus an in-world replacement to show what the
        // fix should look like.
        expect(vc.systemPrompt).toMatch(/Class B/);
        expect(vc.systemPrompt).toMatch(/上一轮|上一回合|本轮/);
        expect(vc.systemPrompt).toMatch(/previous round|last turn|this turn|last reply/);
        expect(vc.systemPrompt).toMatch(/昨夜|三天前/);
        // Narration must be flagged as the higher-risk site so the critic
        // weights its scan there rather than treating dialogue and narration
        // symmetrically.
        expect(vc.systemPrompt).toMatch(/narration|旁白/i);
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
        expect(sanitized.tools.memory.list_candidates).toBe(true);
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

    test('subAgents[i].tools null → inherit; object → override', () => {
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
        expect(ovr.tools.memory.keyword_search).toBe(true);
        expect(ovr.tools.memory.node_create).toBe(false);  // override defaults missing verbs to off
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
        expect(sById.get('intent_scout').tools.memory.node_brief).toBe(false);

        // memory_scout: memory reads only, no writes
        expect(sById.get('memory_scout').tools.memory.list_candidates).toBe(true);
        expect(sById.get('memory_scout').tools.memory.node_create).toBe(false);
        expect(sById.get('memory_scout').tools.memory.node_edit).toBe(false);

        // memory_curator: full memory read + write
        expect(sById.get('memory_curator').tools.memory.node_create).toBe(true);
        expect(sById.get('memory_curator').tools.memory.compact_nodes).toBe(true);

        // notes_curator: note open + close
        expect(sById.get('notes_curator').tools.note.open).toBe(true);
        expect(sById.get('notes_curator').tools.note.close).toBe(true);

        // plot_brainstormer: no tools at all (pure thinker)
        const pbVerbs = ['note.open', 'note.close', 'chat.read_range', 'chat.search', 'lorebook.search', 'memory.node_brief', 'search.search'];
        for (const path of pbVerbs) {
            const [ns, verb] = path.split('.');
            expect(sById.get('plot_brainstormer').tools[ns][verb]).toBe(false);
        }
    });
});
