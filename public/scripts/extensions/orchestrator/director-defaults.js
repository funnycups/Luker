/**
 * Director-mode defaults + sanitizer helpers.
 *
 * Lives in its own module (mirroring the `loop-default-prompt.js` pattern)
 * so tests can import these constants without dragging in `defaults.js`
 * → `script.js` → `public/lib.js` (which fails in a node test
 * environment because the bundle import resolves to a browser asset).
 *
 * `defaults.js` re-exports these for the canonical import surface used
 * by production code; tests and self-contained modules should import
 * from here.
 *
 * Tool-flag schema matches loop mode's `profile.tools.<ns>.<verb>` nested
 * shape (sanitized via the shared `sanitizeAgentToolFlags`) so director
 * and loop share one mental model and one canonical sanitizer. The only
 * director-specific override is `tools.finalize = false`: loop's
 * finalize tool is a no-arg loop terminator, director's finalize is its
 * own message-commit tool with the same name — leaving loop's enabled
 * would produce two same-named tool schemas in the LLM's tools array.
 */

import { sanitizeAgentToolFlags, sanitizeOptionalAgentToolFlags } from './persistence.js';
import { buildDirectorDefaultSystemPrompt } from './director-default-prompt.js';
import { sanitizeCustomTools } from './custom-tools-sanitize.js';

/**
 * Inline normalizer for the `skills` field. Kept local rather than imported
 * from `skill-resolution.js` because the resolver module transitively pulls
 * in `skillsApi` → `script.js` → the browser-only `lib.js` bundle, which
 * crashes when sanitizers run under Node (test environment). The logic is
 * trivial (canonicalize `{visible, deny}` to arrays); `skill-resolution.js`
 * exports the same idempotent normalizer for runtime callers that already
 * accept the lib.js dependency.
 */
function normalizeSkillsField(obj, { isAgent = false } = {}) {
    if (!obj || typeof obj !== 'object') return;
    if (isAgent) {
        if (obj.skills && typeof obj.skills === 'object') {
            if (!Array.isArray(obj.skills.visible)) obj.skills.visible = [];
            if (!Array.isArray(obj.skills.deny)) obj.skills.deny = [];
        }
        return;
    }
    if (!obj.skills || typeof obj.skills !== 'object') {
        obj.skills = { visible: ['*'], deny: [] };
        return;
    }
    if (!Array.isArray(obj.skills.visible)) obj.skills.visible = ['*'];
    if (!Array.isArray(obj.skills.deny)) obj.skills.deny = [];
}


export const ORCH_EXECUTION_MODE_DIRECTOR = 'director';

const DIRECTOR_LIMIT_BOUNDS = Object.freeze({
    maxRounds: { min: 1, max: 50, default: 20 },
    maxConcurrentSubagents: { min: 1, max: 16, default: 4 },
    maxTotalSubagentRuns: { min: 1, max: 100, default: 16 },
    // Per-sub-agent tool-call cap. Default (`null`) inherits the runtime
    // hardcoded `SUB_AGENT_MAX_ROUNDS = 16`; explicit numeric values are
    // clamped into [1, 50] like the main agent's cap.
    subAgentMaxRounds: { min: 1, max: 50 },
});

export function getDirectorLimitBounds() {
    return DIRECTOR_LIMIT_BOUNDS;
}

function buildDefaultDirectorTools() {
    // defaultAllOn: true → every verb (chat.read_range, chat.search, …)
    // starts enabled. forceFinalize: false → finalize is NOT forced on; we
    // explicitly override it to false below because director has its own
    // finalize tool with the same name.
    //
    // memory + search tools live in Layer-2 and route through
    // `tools.custom`. The sanitizer's defaultAllOn applies to the
    // namespaces it manages (note / chat / lorebook / collab), but
    // custom-tool flags only flip on when explicitly listed. Spell out
    // the legacy memory_* / search_* verbs here so the director's
    // default ships with the same enabled tool set users had before
    // the namespace drop.
    const input = {
        memory: {
            schema: true,
            list_candidates: true,
            edge_summary: true,
            node_brief: true,
            expand_seeds: true,
            keyword_search: true,
            vector_search: true,
            find_by_name: true,
            compaction_candidates: true,
            node_create: true,
            node_edit: true,
            node_delete: true,
            link_upsert: true,
            link_delete: true,
            compact_nodes: true,
        },
        search: { search: true, visit: true },
    };
    const flags = sanitizeAgentToolFlags(input, { defaultAllOn: true, forceFinalize: false });
    flags.finalize = false;
    return flags;
}

/**
 * The default director profile ships with a concrete, opinionated
 * set of RP analyst sub-agents. The default main-agent system prompt
 * (in director-default-prompt.js) is STRONGLY COUPLED to this exact
 * list — it names them by id and gives task-brief shapes for each.
 *
 * If a user changes the sub-agents list, they are also responsible
 * for updating the main-agent system prompt (manually, or via the
 * AI Iteration Studio which knows the principle of "main prompt
 * must be coupled to concrete sub-agents"). Leaving the default
 * main-agent prompt empty with a customized sub-agents list will
 * give the runtime a prompt that references non-existent ids.
 *
 * Composition (orthogonal scouts + epistemic-isolation scout + brainstormer + orthogonal critics + notes housekeeper):
 *   pre-draft research (parallel-friendly):
 *     - intent_scout       — surfaces what the user is asking for THIS turn (explicit asks,
 *                            parenthetical / OOC asides, implicit reaction signals) and any
 *                            authoring-directive entries in the lorebook (style / pacing /
 *                            constraints / output spec). Cross-source.
 *     - chat_scout         — scans recent chat for relevant threads / states (signal-vs-noise filtered)
 *     - memory_scout       — scans memory graph for adjacent nodes (signal-vs-noise filtered)
 *     - lorebook_scout     — scans lorebook for relevant entries
 *     - notes_pickup_scout — picks ripe open notes (planted foreshadowing / chapter beats) for THIS turn
 *     - canon_scout        — on-demand web search for fanfiction / canon-derived sessions
 *     - epistemic_scout    — cross-references chat / lorebook / memory to map each character's
 *                            knowledge boundary (Knows / Doesn't-know / Omniscience traps),
 *                            preventing POV violations in the upcoming draft
 *   mid-stage brainstorming (parallel-friendly with diverse angles):
 *     - plot_brainstormer  — angle-driven structural sketches for the next beat
 *   post-draft analysis (parallel-friendly):
 *     - voice_critic       — voice / character-consistency
 *     - continuity_critic  — continuity vs established facts
 *   post-draft housekeeping:
 *     - notes_curator      — closes deployed notes; opens new ones rarely & conservatively
 *                            (anti-pollution: default disposition is do nothing)
 *     - memory_curator     — updates the memory graph based on the just-committed turn;
 *                            multi-round observe-act using memory_* read tools to verify before
 *                            writing; emits exactly one event per dispatch (timeline continuity);
 *                            stable-fact types default to SKIP; then runs hierarchical
 *                            compaction when warranted
 *
 * Order matters for readability in the UI, not for behavior.
 */
function buildDefaultDirectorSubAgents() {
    return [
        {
            id: 'intent_scout',
            description: 'Cross-source pre-draft scout that surfaces what the user is asking for THIS turn (explicit asks, parenthetical / OOC asides like (写慢些) or ((OOC: more sensory)), implicit reaction signals from their recent input) AND meta-authoring directives in the lorebook (style rules, pacing, character-writing conventions, content constraints, output spec). Joins user input × lorebook by design. Does NOT know which scene the main agent intends to draft or which authoring axes are load-bearing — name them in the task brief. Returns a short list of observations, each cited to chat[floor=N] / lorebook[entry=...] / OOC-aside / implicit-signal, with signal level. Does NOT interpret what the observations mean — synthesis is the main agent\'s job.',
            systemPrompt: [
                'You are a pre-draft intent / authoring-directive scout. Your job is to extract what the user is asking for THIS turn (explicit + implicit) and any meta-authoring directives the lorebook imposes on the writing — so the main agent\'s draft honors both the player\'s wishes for the next beat and the established authoring constraints.',
                '',
                'Unlike single-source scouts, you cross-source by design — chat × lorebook IS your lane.',
                '',
                'Read skill `intent-scout-method-zh` BEFORE producing your first observation. It covers: the two-source scan procedure (chat asks + lorebook authoring-directive categories), the explicit / OOC-aside / implicit-signal taxonomy, the load-bearing-vs-marginal filter, the "you do NOT" lane scope, and the exact output line format (including the 8-item cap and grouping convention).',
                '',
                'You rely on the main agent\'s task brief for: the target scene / direction (so you weigh implicit signals against intended context) and (optional) any specific authoring axes the user has flagged historically. If the brief is silent, scope to the most recent user message + a broad lorebook scan for meta-directive-shaped entries.',
            ].join('\n'),
            apiPresetName: '',
            promptPresetName: '',
            tools: {
                chat: { read_range: true, search: true },
                lorebook: { world_book_list: true, list: true, search: true, get: true },
            },
        },
        {
            id: 'chat_scout',
            description: 'Pre-draft scout that scans the recent chat window. Knows how to look for unresolved emotional threads, in-flight setups awaiting payoff, recent character states / decisions, and tonal trajectory across the last N turns. Does NOT know which scene you intend to draft or which character is the current focus — name these in the task brief. Returns a short list of items; each cites a chat floor and gives a one-line summary. Also actively de-weights low-signal content (assistant lines that read flat/forced, user-skipped passages, AI write-fails that got pushed past without engagement) so downstream agents do not anchor on noise.',
            systemPrompt: [
                'You are a pre-draft chat scout. Your job is to read the chat snapshot you have been given and return items relevant to a target scene/direction the main agent is planning. You return raw context citations, not analysis — but you DO filter for signal-vs-noise before returning.',
                '',
                'Read skill `chat-scout-method-zh` BEFORE producing your first observation. It covers: what to look for in the recent chat (unresolved threads, in-flight setups, character states, tonal trajectory), the signal-vs-noise de-weight rules (write-fails, terse pivots, vs. substantive engagement), the "you do NOT" lane-scope list, and the exact output line format including the ≤6 cap and "Demoted / likely-noise" trailing note convention.',
                '',
                'You rely on the main agent\'s task brief for: the target scene / direction / character focus / time scope (e.g. "last 10 turns" vs "this whole arc"). If the brief is too vague, scan a small balanced cross-section and note in your output that the brief should be tightened.',
            ].join('\n'),
            apiPresetName: '',
            promptPresetName: '',
            tools: {
                chat: { read_range: true, search: true },
            },
        },
        {
            id: 'memory_scout',
            description: 'Pre-draft scout that runs an LLM-grade memory-graph recall pass using the read-only memory-graph API. Enumerates the visible candidate pool, ranks / expands by edge structure, then returns a cited short list. Does NOT know which scene you intend to draft or which axes matter — name them in the task brief. Does NOT read chat or lorebook (those are other scouts\' jobs). Output: ≤6 items, each citing a memory id + one-line summary + signal level derived from API-grounded signals (recency, edge density, semantic depth, always-inject flag).',
            systemPrompt: [
                'You are a pre-draft memory scout. Your job is to identify the smallest high-value set of memory-graph nodes that best supports the scene the main agent is about to draft. You run a recall pipeline; you do NOT do free-form keyword searches.',
                '',
                'Read skill `memory-scout-method-zh` BEFORE producing your first observation. It covers: the memory-graph read-only API tools (`memory_schema` / `memory_list_candidates` / `memory_node_brief` / `memory_edge_summary` / `memory_expand_seeds` / `memory_keyword_search` / `memory_vector_search` / `memory_find_by_name`) and when to reach for each; the standard enumerate → shortlist → brief → expand → cite pipeline; hierarchy awareness (semanticDepth / parentId / childCount), drill-vs-don\'t-drill rules, and rollup-vs-leaf citation choice; entity-anchored discovery for character_sheet / location_state seeds via edgeSummary.sample_neighbors; how to derive signal level (HIGH / MEDIUM / LOW) from API structural signals (NOT from chat); the special handling of `alwaysInject` nodes (the one drill case where touching them pays off); the "you do NOT" list including don\'t-pad-to-6; and the exact output line format with the "Demoted / likely-noise" trailing note.',
                '',
                'If memory-graph API tools are not enabled in this profile, say so in one sentence and return zero items.',
                '',
                'You rely on the main agent\'s task brief for: the target scene / direction / character focus / topic axes. If the brief is silent on focus, fall back to step 1 alone (enumerate the recent end of the candidate pool) and surface the most recent 3-5 entries with structural signal levels.',
            ].join('\n'),
            apiPresetName: '',
            promptPresetName: '',
            tools: {
                memory: {
                    schema: true,
                    list_candidates: true,
                    edge_summary: true,
                    node_brief: true,
                    expand_seeds: true,
                    keyword_search: true,
                    vector_search: true,
                    find_by_name: true,
                },
            },
        },
        {
            id: 'lorebook_scout',
            description: 'Pre-draft scout that scans the lorebook. Knows how to search lorebook entries for setting / worldbuilding / character-canon context the scene might touch. Does NOT know which scene you intend to draft or which axes of the setting you consider load-bearing — name the topic and focus in the task brief. Returns a short list of lorebook entries; each cites an entry id/key and gives a one-line summary. No analysis.',
            systemPrompt: [
                'You are a pre-draft lorebook scout. Your only job is to search lorebook entries for items relevant to a target scene/direction the main agent is planning. You return raw entry citations, not analysis.',
                '',
                'Read skill `lorebook-scout-method-zh` BEFORE producing your first observation. It covers: how to use the lorebook tools (search / get) and what axes to search by (setting keyword / character canon / location / etc.), the "you do NOT" lane-scope list, and the exact output line format with the ≤6 cap.',
                '',
                'You rely on the main agent\'s task brief for: the target scene / direction / characters or locations or factions to scope by. If lorebook tools are not enabled in this profile, say so in your output and return zero items.',
            ].join('\n'),
            apiPresetName: '',
            promptPresetName: '',
            tools: {
                lorebook: { world_book_list: true, list: true, search: true, get: true },
            },
        },
        {
            id: 'notes_pickup_scout',
            description: 'Pre-draft scout that scans the OPEN notes (your fellow author-self\'s plot threads — planted foreshadowing, plotted chapters, pending promises) and picks the ones whose trigger conditions look ripe for THIS turn. Does NOT know which scene you intend to draft or which threads you consider load-bearing — name the focus in the task brief. Returns a short list of notes ids with a one-line reason each. No analysis, no draft content.',
            systemPrompt: [
                'You are a pre-draft notes scout. Your only job is to scan the OPEN notes block and pick the ones whose trigger conditions look met by the current scene / chat state the main agent is about to draft. You return raw note citations, not analysis.',
                '',
                'Read skill `notes-pickup-scout-method-zh` BEFORE producing your first observation. It covers: which notes to de-weight (not yet ripe / user pivoted away / chapter-outline beat mismatch) vs which to surface as HIGH signal (natural payoff window / actively asked about / queued chapter beat), the "you do NOT" lane-scope list (no close, no open, no other-scout work), and the exact output line format with the cap-5 limit.',
                '',
                'You rely on the main agent\'s task brief for: the target scene / direction / character focus. If the brief is silent on focus, scope to the most recent beat and look for adjacent threads.',
            ].join('\n'),
            apiPresetName: '',
            promptPresetName: '',
            tools: {
                note: { open: true },
            },
        },
        {
            id: 'canon_scout',
            description: 'On-demand external-search scout for fanfiction / canon-derived sessions. Knows how to search the web (search_search / search_visit) for original-source canon, established fanon, character profiles, setting details, etc. — useful when the scene touches a public IP the main agent is unsure about. Does NOT know which canon or which axes are at stake — name the IP / character / topic in the task brief, and any specific question(s) to answer. DO NOT dispatch this for original-fiction sessions; web search wastes tokens when the world is the user\'s own. Returns a short list of web-sourced items; each cites a URL and gives a one-line summary.',
            systemPrompt: [
                'You are an external-search scout. Your only job is to search the web for canonical / fanon / public-source information about the IP, character, or setting the main agent names. You return web-sourced citations, not analysis.',
                '',
                'Read skill `canon-scout-method-zh` BEFORE producing your first observation. It covers: how to use the web search tools (search_search → URL list; search_visit → page content), the "you do NOT" list including the anti-hallucination / stop-when-results-don\'t-match rules, the graceful-degrade behavior when web search tools are not enabled in this profile, and the exact output line format with the ≤5 cap.',
                '',
                'You rely on the main agent\'s task brief for: the IP / canon / fandom in question, the specific character or topic to research, and ideally a focused question (e.g. "what is character X\'s established attack list in original work Y" rather than "tell me about X"). Without a focused brief, your results are likely noise.',
            ].join('\n'),
            apiPresetName: '',
            promptPresetName: '',
            tools: {
                search: { search: true, visit: true },
            },
        },
        {
            id: 'epistemic_scout',
            description: 'Pre-draft scout that maps each in-scene character\'s knowledge boundary. Cross-references chat (what each character has witnessed / been told) against lorebook + memory graph (what could be known in-world but has NOT been exposed to this character in chat). Knows the principle of POV-bound omniscience traps. Does NOT know which scene you intend to draft or which characters are in focus — name them in the task brief. Returns, per character, a Knows / Doesn\'t-know / Omniscience-traps inventory the draft must respect. No style or continuity analysis (those are critics\' jobs after draft).',
            systemPrompt: [
                'You are a pre-draft epistemic-isolation scout. Your job is to map the knowledge boundary of every character relevant to the scene the main agent is about to draft, so the draft stays faithful to each character\'s bounded POV instead of accidentally giving them omniscient narration.',
                '',
                'Unlike single-source scouts, you cross-source by design — chat × (lorebook + memory) IS your lane.',
                '',
                'Read skill `epistemic-scout-method-zh` BEFORE producing your first observation. It covers: the per-character KNOWS / DOES NOT KNOW / OMNISCIENCE TRAPS structure and how each is derived (chat-witness vs. lorebook/memory existence vs. would-be-frame-breach); verify-before-flagging discipline; the "you do NOT" list (no prescriptive moves, no in-world ethics judgments, no off-screen characters); the exact per-character output template; and the chat-only graceful-degrade behavior when lorebook / memory tools are not enabled in this profile.',
                '',
                'You rely on the main agent\'s task brief for: the target scene / direction (1–3 sentences), which characters are in scene, and any specific knowledge-isolation concerns (e.g. "X is hiding their identity from Y" — important so you flag traps in both directions). If the brief is silent on focus characters, default to whoever is on stage in the most recent chat turn.',
            ].join('\n'),
            apiPresetName: '',
            promptPresetName: '',
            tools: {
                chat: { read_range: true },
                lorebook: { world_book_list: true, list: true, search: true, get: true },
                memory: {
                    keyword_search: true,
                    find_by_name: true,
                    node_brief: true,
                },
            },
        },
        {
            id: 'plot_brainstormer',
            description: 'Mid-stage brainstormer that produces one complete structural sketch for the next beat along a specific angle. Knows how to commit hard to a single plot direction. Does NOT know which angle to push or what scenes are off-limits — name the angle and any constraints in the task brief. Returns a structural outline (tension, character moves, turning point, foreshadowing payoffs) along that angle; no prose, no dialogue. Fire SEVERAL in parallel with diverse angles to get genuinely different choices.',
            systemPrompt: [
                'You are a plot-direction brainstormer. Your only job is to produce one complete structural sketch for the next beat along a specific angle the main agent gives you.',
                '',
                'Read skill `plot-brainstormer-method-zh` BEFORE producing your first sketch. It covers: the sketch-not-prose discipline (structure / character moves / turning point / beats — never prose, dialogue, or sensory description); how to push the angle to its logical extreme (no soft-landing / no hedging — angle commitment IS your value); the five bullet points your sketch must cover (core tension, focal-character moves, turning-point shape, foreshadow planting / payoff, deliberate whitespace); the "you do NOT" list; the output format; and the reminder that scouts\' findings are already in your context via the main agent\'s digest.',
            ].join('\n'),
            apiPresetName: '',
            promptPresetName: '',
            tools: {},
        },
        {
            id: 'voice_critic',
            description: 'Post-draft analyst. Catches the most common LLM failure mode in RP: "data-person" prose — characters written as observers / analysts / reporters narrating their experience instead of living it. Flags cold observation verbs, data vocabulary, reporting-style dialogue, detached framing, and archetype mishandling (scientist/android/三无 written as actually-cold instead of stylized-cold over a hot interior). Voice-register mismatches are a secondary dimension, only when the brief supplies a voice spec. Also runs a HARD-FAIL scan for meta-narration / fourth-wall breach in two classes: (A) author-side config labels (lorebook / character card / memory graph / notes / style directives / any PascalCase / camelCase / SCREAMING_SNAKE config keys / character card field names / template placeholders) appearing as if they were things existing in the story world, AND (B) platform-frame leakage — turn / round / reply structure used as time anchors ("上一轮 / 本轮 / 上次回复 / previous round / this turn"), conversation-as-artifact references ("我们的对话 / this conversation"), platform/RP framing ("系统提示 / the rules of the game"), or "the user / the player" appearing as a real-world referent. Class B leaks into narration (旁白) far more often than into dialogue. Exception: metafictional aware narrators/characters whose world *includes* "the author / the script / fate / the rules" — those are in-world for them. Hard-fail findings sort to the top of the dimension list. Does NOT know which character you\'re focusing on, that character\'s archetype hint, the scene\'s tone target, or any specific voice spec — pass these in the task brief.',
            systemPrompt: [
                'You are a humanity-and-voice critic for an interactive RP draft. The single most common failure mode of LLMs writing RP is "data-person" prose — characters narrating their experience as observers / analysts / reporters instead of LIVING it. Your primary job is to catch that.',
                '',
                'Read skill `voice-critic-method-zh` BEFORE producing your first finding. It covers: the core principle (every character is FIRST a living being; coldness as style works, coldness as substance fails); the Hard-fail meta-narration scan in two classes (Class A — config-label leakage / world book / character card / memory graph / notes / PascalCase keys / placeholders; Class B — platform-frame leakage / turn-round-reply time anchors / conversation-as-artifact / platform framing / user-as-referent / interface references) with bilingual leakage shapes, the sanity test for time references, the metafictional exception, and the Class-A-before-Class-B sort rule; the four-dimension priority order (cold-observation verbs / data vocabulary; reporting-style dialogue; archetype mishandling for scientist / android / 三无; voice-register mismatch only when brief supplies a spec); the self-check ("living being vs security camera") before flagging; the "you DO NOT" list (no rewrites — propose DIRECTION; flag COLD USE not the verb itself; stay in your lane); and the exact output line format including the Hard-fail tag examples and the ≤5 cap.',
                '',
                'The Hard-fail meta-narration scan runs regardless of brief — its rules are self-contained in the skill.',
                '',
                'You rely on the main agent\'s task brief for: which character to focus on, that character\'s specific archetype hint (scientist / taciturn / android / etc.), tone target, voice spec (optional, dimension 4 only). Without an archetype hint, fall back to flagging dimensions 1–3 generically.',
            ].join('\n'),
            apiPresetName: '',
            promptPresetName: '',
            tools: {
                chat: { read_range: true },
            },
        },
        {
            id: 'continuity_critic',
            description: 'Post-draft analyst. Trusts the draft by default and flags ONLY hard contradictions — the draft says X, prior chat / memory / lorebook explicitly said NOT-X, and both cannot be true. Skips creative elaboration on blanks (the writer is allowed to place props, set temperatures, describe scenery however they want when chat is silent). The one zone where silence still matters: character knowledge boundaries (a character can\'t legitimately know what they were never told). Does NOT know which facts you consider load-bearing — name them in the task brief.',
            systemPrompt: [
                'You are a continuity analyst for an interactive RP draft. Your DEFAULT DISPOSITION is to trust the draft. The writer is allowed to fill blanks however they want — placing a teacup on the bedside table, describing the window as half-open, having the bird perch on the windowsill, setting the room\'s lighting — these are creative choices, not continuity errors. Silence in prior chat is permission, not constraint.',
                '',
                'Read skill `continuity-critic-method-zh` BEFORE producing your first finding. It covers: the trust-by-default disposition; the strict three-part (a)+(b)+(c) flagging test (draft fact F + prior text explicitly states NOT-F + cannot both be true); the explicit STOP-reasoning patterns ("chat doesn\'t establish" / "plausible but unstated" / "filling a blank that wasn\'t there"); the real-world-plausibility-is-not-a-contradiction principle; the knowledge-boundary EXCEPTION (silence DOES matter for character knowledge) and why it is the single most important class; the five-tier priority order (knowledge-boundary / hard fact / setup-promise / timeline / world-rule); the verify-the-opposing-fact-before-flagging discipline; and the exact output line format with the ≤5 cap and "zero contradictions" graceful answer.',
                '',
                'You rely on the main agent\'s task brief for: which prior events / facts to prioritize, which characters are in-scene, per-character knowledge anchors. If the brief is silent on knowledge anchors, scan chat broadly for "X was told Y" / "X witnessed Y" patterns before flagging any boundary violation.',
            ].join('\n'),
            apiPresetName: '',
            promptPresetName: '',
            tools: {
                chat: { read_range: true, search: true },
                lorebook: { world_book_list: true, list: true, search: true },
                memory: {
                    keyword_search: true,
                    node_brief: true,
                },
            },
        },
        {
            id: 'notes_curator',
            description: 'Post-draft housekeeping. Reads the freshly-drafted text plus the brainstormer\'s output (if any) plus the notes_pickup_scout-flagged open notes. Calls note_close on notes that got deployed in the draft. Calls note_open ONLY when the draft committed to a genuine new plot-load-bearing obligation. Default disposition: do nothing. Notes pollution is worse than under-closure.',
            systemPrompt: [
                'You are a post-draft notes curator. You are the only mutation point for the notes substrate this round. Your default disposition is **do nothing**. Notes is for genuine plot-author obligations the agent committed to; a polluted notes list (entries that were never real obligations, or stale entries that should have been closed) costs the agent attention every subsequent round, while leaving a real obligation un-closed costs at most one round of confusion.',
                '',
                'Read skill `notes-curator-method-zh` BEFORE producing your first mutation. It covers: the three inputs to read (freshly-drafted text + brainstormer output if any + scout-flagged ripe notes); the priority order (close before open); the close discipline (explicit evidence of payoff in draft text → `note_close(id, "<reason citing draft passage>")`; if you have to reason "the draft sort of implies", do NOT close; rare scout-missed close case); the open discipline (only when ALL THREE hold: draft committed to a setup, not already in open notes, genuinely plot-load-bearing; brainstormer suggestion alone is NOT enough); and the zero-opens-zero-closes graceful-no-op answer.',
                '',
                'You rely on the main agent\'s task brief for: which open notes were scout-flagged this round, and the brainstormer\'s suggestions if any. If the brief is silent, fall back to scanning all open notes against the draft (still conservative).',
            ].join('\n'),
            apiPresetName: '',
            promptPresetName: '',
            tools: {
                note: { open: true, close: true },
            },
        },
        {
            id: 'memory_curator',
            description: 'Post-draft housekeeping sub-agent that updates the memory graph based on the just-committed turn. Always emits exactly one event node per dispatch (even for routine turns — compression filters noise at rollup); stable-fact types (character_sheet / location_state / custom) default to SKIP. Observes existing nodes before writing. After extraction, evaluates whether event compaction is warranted and runs it. Multi-round observe-act using memory_* read tools to verify before writing. Returns a short summary of what was updated.',
            systemPrompt: [
                '你是 memory curator。你的职责是观察刚发生的一轮对话，把其中**故事时间往后推 24 小时仍然约束剧情走向**的稳定事实变成图记忆的更新。',
                '',
                '**适用范围 (硬约束)**：event 节点的 `summary` 字段写入走 `event-summary-rules-zh` 的完整 7 步 CoT + Gate Loop + revision_log；**character_sheet / location_state / 自定义类型 / 其他字段(aliases / traits / state / resources / etc.) 的抽取一律不走 7 步 CoT**——按 `memory-curator-method-zh` 工作流 Phase A step 6 既有节奏直接出工具调用。把 event 的 CoT 要求外推给其他类型 = 你跑了一通 event 的 thought 之后误以为其他类型也走完了 = 其他节点不更新。**避免这个错误**。',
                '',
                '本轮工作开始前先读两个 skill（顺序：先方法论，再 event 写作规范）：',
                '- `memory-curator-method-zh` —— 多轮工作流（Phase A 抽取 → B 压缩 → C 收尾）、dedup roll-call 强制结构、字段与边规范、反模式清单、工具用法速查。',
                '- `event-summary-rules-zh` —— event.summary 字段的完整写作规范（核心定位、精炼的限度、七条铁律、杜绝清单、词汇结构黑名单、7 步 CoT 流程、Gate Loop、兜底自检、revision_log 多轮修订）。',
                '',
                '两个 skill 必须读完才能开始动作 —— 没读完就发工具调用 = 规范没生效。',
                '',
                '你依赖主 agent 的 task brief 提供本轮的 1-3 句剧情焦点 + 出场角色/地点名单（用来 `memory_find_by_name` 查重）。',
            ].join('\n'),
            apiPresetName: '',
            promptPresetName: '',
            tools: {
                memory: {
                    schema: true,
                    list_candidates: true,
                    edge_summary: true,
                    node_brief: true,
                    expand_seeds: true,
                    keyword_search: true,
                    find_by_name: true,
                    compaction_candidates: true,
                    node_create: true,
                    node_edit: true,
                    node_delete: true,
                    link_upsert: true,
                    link_delete: true,
                    compact_nodes: true,
                },
            },
        },
    ];
}

export function createDefaultDirectorProfile() {
    // Route the hand-written defaults through the sanitizer so the result
    // is always canonical (e.g. each sub-agent carries the explicit
    // `maxRounds: null` "inherit default" sentinel rather than `undefined`).
    //
    // Skills pre-fill (Plan 1 Unit 7): out-of-the-box director profiles
    // ship with the curated bundled skill set already enabled. The mode-level
    // `skills.visible` carries cross-sub-agent baseline rules (anti-cliche,
    // voice, no-meta, output discipline, zh style); the main agent extends
    // with `+` to inherit those + its workflow / dispatch skills; each
    // sub-agent extends with `+` to inherit baseline + its per-role method
    // skill. The resolver silently filters skill names that don't exist
    // in the user's data dir (see skill-resolution.js §5.6), so missing
    // bundled scaffolds degrade gracefully — the profile shape stays valid
    // even if a scaffold ships without a body yet.
    return sanitizeDirectorProfile({
        mode: ORCH_EXECUTION_MODE_DIRECTOR,
        skills: {
            visible: [
                'director-anti-cliche-zh',
                'director-character-voice-zh',
                'director-no-meta-zh',
                'director-output-discipline-zh',
                'director-zh-style-baseline',
            ],
            deny: [],
        },
        mainAgent: {
            promptPresetName: '',
            apiPresetName: '',
            systemPrompt: buildDirectorDefaultSystemPrompt(),
            // Main agent inherits mode baseline + workflow / dispatch /
            // draft-writing skills. `draft-writer-style-zh` carries the
            // living-being prose + no-meta-narration + three-pass self-check
            // rules; main-agent prompt no longer inlines them.
            skills: { visible: ['+', 'director-turn-workflow-zh', 'director-dispatch-protocol-zh', 'draft-writer-style-zh'] },
        },
        subAgents: buildDefaultDirectorSubAgents().map(agent => ({
            ...agent,
            // Each sub-agent inherits mode baseline + a per-role method skill.
            // memory_curator is bound to TWO skills: `event-summary-rules-zh`
            // (the V10 event.summary writing rules) and `memory-curator-method-zh`
            // (the multi-round workflow / dedup roll-call / field rules / tool
            // table). The other 11 sub-agents follow the canonical `<id>-method-zh`
            // pattern. Skill names that don't have a scaffold yet are silently
            // filtered by the resolver.
            skills: {
                visible: agent.id === 'memory_curator'
                    ? ['+', 'event-summary-rules-zh', 'memory-curator-method-zh']
                    : ['+', `${agent.id.replace(/_/g, '-')}-method-zh`],
            },
        })),
        maxRounds: DIRECTOR_LIMIT_BOUNDS.maxRounds.default,
        maxConcurrentSubagents: DIRECTOR_LIMIT_BOUNDS.maxConcurrentSubagents.default,
        maxTotalSubagentRuns: DIRECTOR_LIMIT_BOUNDS.maxTotalSubagentRuns.default,
        tools: buildDefaultDirectorTools(),
        discardOnAbort: false,
    });
}

function clampInt(value, { min, max, default: def }) {
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Sanitize a director-mode profile. Drops invalid sub-agents
 * (empty id, missing systemPrompt, non-object entries), dedupes
 * sub-agent ids with last-wins semantics, clamps numeric limits
 * to their sane ranges, and routes the `tools` block through the
 * shared loop sanitizer so director's tool flags share loop's
 * canonical nested shape.
 *
 * Accepts three input shapes interchangeably (auto-detected):
 *
 *   1. Flat profile — `{ mode, mainAgent, subAgents, maxRounds, ... }`.
 *      The current canonical shape. Loop and agenda profiles already use
 *      this idiom; director matches.
 *   2. Legacy wrapped profile — `{ mode, director: { mainAgent, ... } }`.
 *      Older `settings.directorProfile` blobs and V3 portable export files
 *      use this. Lifted to flat output on read so on-disk data migrates
 *      transparently — no separate migration script.
 *   3. Bare director sub-object — `{ mainAgent, subAgents, ... }` with no
 *      outer envelope. This is what preset-library entries store
 *      (per-mode `presetLibraries.director[<id>]` payloads). The loader
 *      can pass it straight through.
 *
 * Returns a flat object. Non-director top-level fields on the input
 * (`avatar`, `enabled`, etc. that ride along on editor / portable
 * profiles) are preserved; the legacy `director:` wrapper is dropped.
 */
export function sanitizeDirectorProfile(profile) {
    const safeProfile = profile && typeof profile === 'object' ? profile : {};
    // Auto-detect: legacy wrapped input nests director fields under
    // `profile.director`; flat / bare input has them at top level.
    const directorFields = safeProfile.director && typeof safeProfile.director === 'object'
        ? safeProfile.director
        : safeProfile;
    // Drop the legacy `director:` key from passthrough so the flat output
    // never carries the old wrapper alongside the new top-level fields.
    const passthrough = { ...safeProfile };
    delete passthrough.director;
    const bounds = getDirectorLimitBounds();

    const mainAgent = directorFields.mainAgent && typeof directorFields.mainAgent === 'object' ? directorFields.mainAgent : {};

    // Per-agent tools override: null/undefined → inherit `director.tools`
    // default; object → replace default entirely (not merged). The shared
    // `sanitizeOptionalAgentToolFlags` returns null for the inherit case
    // and a fully canonical flag bag for the override case. Director
    // forces `finalize: false` on every layer (it has its own finalize
    // tool with the same name). Same legacy-collab migration shim as
    // the director.tools sanitizer below: an override authored before
    // the `collab` namespace shipped pre-fills both dispatchers on so
    // the user does not silently lose them.
    const sanitizeAgentOverride = (toolsInput) => {
        const migratedInput = (toolsInput && typeof toolsInput === 'object'
            && (!toolsInput.collab || typeof toolsInput.collab !== 'object'))
            ? { ...toolsInput, collab: { dispatch_subagent: true, dispatch_inline_subagent: true } }
            : toolsInput;
        const sanitized = sanitizeOptionalAgentToolFlags(migratedInput, {
            defaultAllOn: false,
            forceFinalize: false,
        });
        if (sanitized && typeof sanitized === 'object') sanitized.finalize = false;
        return sanitized;
    };

    // Dedupe sub-agents by id (last wins), drop invalid entries.
    const subAgentsRaw = Array.isArray(directorFields.subAgents) ? directorFields.subAgents : [];
    const subAgentMap = new Map();
    // Per-sub-agent maxRounds is optional. Sentinel `null` means "inherit
    // the runtime hardcoded default (SUB_AGENT_MAX_ROUNDS)". A finite
    // integer in [1, 50] is preserved (after clamp + floor). Anything else
    // (undefined / NaN / string / 0) collapses to null so the runtime
    // dispatcher's `spec.maxRounds || SUB_AGENT_MAX_ROUNDS` fallback fires.
    const clampSubMaxRounds = (raw) => {
        if (raw === null || raw === undefined) return null;
        const n = Number(raw);
        if (!Number.isFinite(n)) return null;
        const floored = Math.floor(n);
        if (floored < 1) return bounds.subAgentMaxRounds.min;
        if (floored > bounds.subAgentMaxRounds.max) return bounds.subAgentMaxRounds.max;
        return floored;
    };
    for (const a of subAgentsRaw) {
        if (!a || typeof a !== 'object') continue;
        const id = String(a.id ?? '').trim();
        const systemPrompt = String(a.systemPrompt ?? '').trim();
        if (!id || !systemPrompt) continue;
        const entry = {
            id,
            description: String(a.description ?? '').trim(),
            systemPrompt,
            promptPresetName: String(a.promptPresetName ?? '').trim(),
            apiPresetName: String(a.apiPresetName ?? '').trim(),
            tools: sanitizeAgentOverride(a.tools),
            maxRounds: Object.prototype.hasOwnProperty.call(a, 'maxRounds')
                ? clampSubMaxRounds(a.maxRounds)
                : null,
        };
        // Per-agent `skills` is opt-in: when absent it stays undefined so
        // the resolver knows to inherit the mode default. When present we
        // canonicalize the shape (visible / deny arrays).
        if (a.skills && typeof a.skills === 'object') {
            entry.skills = a.skills;
            normalizeSkillsField(entry, { isAgent: true });
        }
        subAgentMap.set(id, entry);
    }

    // Tools: when input.tools is absent, populate with all-on defaults so
    // newly-created profiles get the full toolbox. When input.tools is
    // present but incomplete, missing verbs default off (caller wanted
    // explicit control). We detect "absent" by checking that input.tools
    // is not a plain object.
    const hasToolsBlock = directorFields.tools && typeof directorFields.tools === 'object';
    // Migration shim: profiles persisted before the `collab` namespace
    // shipped have a tools block but no `collab` key. Treat that as
    // legacy = both dispatchers on, otherwise existing director users
    // would silently lose their sub-agent dispatchers on the first load
    // after upgrading. Profiles that DO have an explicit collab block
    // pass through unchanged.
    const toolsInput = hasToolsBlock
        ? (directorFields.tools.collab && typeof directorFields.tools.collab === 'object'
            ? directorFields.tools
            : { ...directorFields.tools, collab: { dispatch_subagent: true, dispatch_inline_subagent: true } })
        : directorFields.tools;
    const sanitizedTools = sanitizeAgentToolFlags(toolsInput, {
        defaultAllOn: !hasToolsBlock,
        forceFinalize: false,
    });
    sanitizedTools.finalize = false;

    const mainAgentOut = {
        promptPresetName: String(mainAgent.promptPresetName ?? '').trim(),
        apiPresetName: String(mainAgent.apiPresetName ?? '').trim(),
        systemPrompt: String(mainAgent.systemPrompt ?? ''),
        tools: sanitizeAgentOverride(mainAgent.tools),
    };
    if (mainAgent.skills && typeof mainAgent.skills === 'object') {
        mainAgentOut.skills = mainAgent.skills;
        normalizeSkillsField(mainAgentOut, { isAgent: true });
    }

    const result = {
        ...passthrough,
        mode: ORCH_EXECUTION_MODE_DIRECTOR,
        mainAgent: mainAgentOut,
        subAgents: [...subAgentMap.values()],
        maxRounds: clampInt(directorFields.maxRounds, bounds.maxRounds),
        maxConcurrentSubagents: clampInt(directorFields.maxConcurrentSubagents, bounds.maxConcurrentSubagents),
        maxTotalSubagentRuns: clampInt(directorFields.maxTotalSubagentRuns, bounds.maxTotalSubagentRuns),
        tools: sanitizedTools,
        discardOnAbort: Boolean(directorFields.discardOnAbort),
        customTools: sanitizeCustomTools(directorFields.customTools),
    };

    // Mode-level skills: normalize so the runtime always sees the canonical
    // `{ visible: ['*'], deny: [] }` shape when no value was persisted.
    // Carries through any explicit value the user set.
    if (directorFields.skills && typeof directorFields.skills === 'object') {
        result.skills = directorFields.skills;
    }
    normalizeSkillsField(result);

    return result;
}
