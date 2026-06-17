import { describe, test, expect } from '@jest/globals';
import {
    createDefaultDirectorProfile,
    createFullDirectorProfile,
    createMinimalDirectorProfile,
} from '../../public/scripts/extensions/orchestrator/director-defaults.js';

describe('director factory: Full preset', () => {
    test('createDefaultDirectorProfile is an alias for createFullDirectorProfile (back-compat)', () => {
        const a = createDefaultDirectorProfile();
        const b = createFullDirectorProfile();
        // sanitizeDirectorProfile produces fresh objects; compare normalized ids + key shape
        expect(a.subAgents.map(x => x.id).sort()).toEqual(b.subAgents.map(x => x.id).sort());
        expect(a.mode).toBe(b.mode);
        expect(Object.keys(a.tools).sort()).toEqual(Object.keys(b.tools).sort());
    });

    test('chat_scout removed', () => {
        const ids = createFullDirectorProfile().subAgents.map(a => a.id);
        expect(ids).not.toContain('chat_scout');
    });

    test('memory_scout gets chat.read_range and chat.search tools added', () => {
        const ms = createFullDirectorProfile().subAgents.find(a => a.id === 'memory_scout');
        expect(ms).toBeDefined();
        // Post-sanitize, legacy `tools.memory.*` is rewritten to
        // `tools.custom.memory_*`. memory_scout owns the read-side
        // pipeline, so the canonical "memory tools are wired" marker is
        // memory_list_candidates being explicitly enabled.
        expect(ms.tools.custom?.memory_list_candidates).toBe(true);
        expect(ms.tools.chat?.read_range).toBe(true);
        expect(ms.tools.chat?.search).toBe(true);
    });

    test('memory_curator is preserved unchanged', () => {
        const mc = createFullDirectorProfile().subAgents.find(a => a.id === 'memory_curator');
        expect(mc).toBeDefined();
        // memory_curator's signature ability is graph mutation; pin its
        // post-sanitize write-side verb.
        expect(mc.tools.custom?.memory_node_create).toBe(true);
    });

    test('canon_scout is preserved (search plugin assumed available)', () => {
        const cs = createFullDirectorProfile().subAgents.find(a => a.id === 'canon_scout');
        expect(cs).toBeDefined();
        // Same legacy-namespace rewrite as memory above: post-sanitize
        // `tools.search.*` becomes `tools.custom.search_*`.
        expect(cs.tools.custom?.search_search).toBe(true);
        expect(cs.tools.custom?.search_visit).toBe(true);
    });

    test('mode-level tools include both memory.* and search.* namespaces', () => {
        const tools = createFullDirectorProfile().tools;
        // Same post-sanitize shape note as the per-agent tests above:
        // legacy memory.* / search.* namespaces are rewritten into
        // tools.custom under the canonical memory_* / search_* names.
        expect(tools.custom?.memory_list_candidates).toBe(true);
        expect(tools.custom?.search_search).toBe(true);
    });
});

describe('director factory: Minimal preset', () => {
    test('memory_scout, memory_curator, canon_scout are removed', () => {
        const ids = createMinimalDirectorProfile().subAgents.map(a => a.id);
        expect(ids).not.toContain('memory_scout');
        expect(ids).not.toContain('memory_curator');
        expect(ids).not.toContain('canon_scout');
    });

    test('chat_scout, intent_scout, lorebook_scout, notes_pickup_scout, plot_brainstormer, voice_critic, notes_curator preserved', () => {
        const ids = createMinimalDirectorProfile().subAgents.map(a => a.id);
        for (const id of ['chat_scout', 'intent_scout', 'lorebook_scout', 'notes_pickup_scout', 'plot_brainstormer', 'voice_critic', 'notes_curator']) {
            expect(ids).toContain(id);
        }
    });

    test('epistemic_scout has memory.* stripped but keeps chat + lorebook', () => {
        const es = createMinimalDirectorProfile().subAgents.find(a => a.id === 'epistemic_scout');
        expect(es).toBeDefined();
        // Post-sanitize, every memory_* Layer-2 verb must be explicitly
        // false on this sub-agent (so `customFlags[name] !== false` in
        // `getEnabledToolSchemas` won't auto-enable them). The Full
        // preset has these set to true; Minimal flips them off.
        const customFlags = es.tools.custom || {};
        const memoryEntries = Object.entries(customFlags).filter(([k]) => k.startsWith('memory_'));
        expect(memoryEntries.length).toBeGreaterThan(0);
        for (const [, v] of memoryEntries) expect(v).toBe(false);
        // chat + lorebook must remain wired (default-on namespaces stay on).
        expect(es.tools.chat).toBeDefined();
        expect(es.tools.lorebook).toBeDefined();
        expect(es.tools.chat.read_range).toBe(true);
        expect(es.tools.lorebook.search).toBe(true);
    });

    test('continuity_critic has memory.* stripped but keeps chat + lorebook', () => {
        const cc = createMinimalDirectorProfile().subAgents.find(a => a.id === 'continuity_critic');
        expect(cc).toBeDefined();
        const customFlags = cc.tools.custom || {};
        const memoryEntries = Object.entries(customFlags).filter(([k]) => k.startsWith('memory_'));
        expect(memoryEntries.length).toBeGreaterThan(0);
        for (const [, v] of memoryEntries) expect(v).toBe(false);
        expect(cc.tools.chat).toBeDefined();
        expect(cc.tools.lorebook).toBeDefined();
        expect(cc.tools.chat.read_range).toBe(true);
        expect(cc.tools.lorebook.search).toBe(true);
    });

    test('mode-level tools strip memory.* and search.* namespaces', () => {
        const tools = createMinimalDirectorProfile().tools;
        // Post-sanitize, every memory_* and search_* Layer-2 verb must
        // be explicitly false on the mode-level tools bag too — otherwise
        // the runtime's Layer-2 default-on policy would re-surface the
        // tools for the main agent regardless of preset choice.
        const customFlags = tools.custom || {};
        const memoryEntries = Object.entries(customFlags).filter(([k]) => k.startsWith('memory_'));
        const searchEntries = Object.entries(customFlags).filter(([k]) => k.startsWith('search_'));
        expect(memoryEntries.length).toBeGreaterThan(0);
        expect(searchEntries.length).toBeGreaterThan(0);
        for (const [, v] of memoryEntries) expect(v).toBe(false);
        for (const [, v] of searchEntries) expect(v).toBe(false);
    });

    test('Minimal preset still has the same mode-level skills as Full', () => {
        const full = createFullDirectorProfile();
        const minimal = createMinimalDirectorProfile();
        expect(minimal.skills?.visible?.sort()).toEqual(full.skills?.visible?.sort());
    });

    test('Minimal preset main agent prompt differs from Full (preset-variant aware)', () => {
        // B2 follow-up: the main agent system prompt must reflect the
        // actual sub-agent set for each preset variant. Hard-coding the
        // Full prompt for both would point Minimal's main agent at
        // memory_scout / memory_curator / canon_scout tools that don't
        // exist in the Minimal sub-agent set.
        const full = createFullDirectorProfile();
        const minimal = createMinimalDirectorProfile();
        expect(minimal.mainAgent.systemPrompt).not.toBe(full.mainAgent.systemPrompt);
        // Skills wiring stays identical — only the variant-specific
        // prompt body changes.
        expect(minimal.mainAgent.skills?.visible).toEqual(full.mainAgent.skills?.visible);
    });

    test('Minimal preset shares limits with Full', () => {
        const full = createFullDirectorProfile();
        const minimal = createMinimalDirectorProfile();
        expect(minimal.maxRounds).toBe(full.maxRounds);
        expect(minimal.maxConcurrentSubagents).toBe(full.maxConcurrentSubagents);
        expect(minimal.maxTotalSubagentRuns).toBe(full.maxTotalSubagentRuns);
    });
});
