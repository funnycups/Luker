/**
 * Floor-state adapter for the orchestrator extension.
 *
 * Replaces the legacy two-tier persistence scheme (an index namespace
 * `luker_orchestrator_state` listing anchor playable floors, plus one
 * sidecar namespace `luker_orchestrator_anchor_<N>` per anchor) with a
 * single floor-state-managed data namespace `luker_orchestrator_anchors`
 * whose contents are `{ [playableFloor]: snapshot }`.
 *
 * Each commit tags itself at `(userMessageChatIndex, userMessageSwipeId)`
 * and applies one `add /<playableFloor>` patch op. This shape means:
 *
 *   - swipe of the anchored user turn → commit filtered out by floor-state's
 *     swipe map → the snapshot disappears, exactly what we want
 *   - tail truncation past the anchored floor → commit filtered out by
 *     `truncateCommits` → the snapshot disappears
 *   - branch creation → floor-state's CHAT_BRANCH_CREATED handler copies
 *     surviving commits into the new chat's log → snapshots follow the branch
 *
 * Edit invalidation (the user changes the anchored message text without
 * deleting it) is NOT handled here. The orchestrator stores the anchor's
 * content hash inside each snapshot, and consumers re-validate the hash
 * against the live message before reuse — so stale entries simply fail
 * the validity check instead of being proactively scrubbed. The trade-off
 * is a few orphan KB in the sidecar until the floor is itself deleted /
 * overwritten by a new orchestration; it buys ~150 lines of removed range-
 * invalidation code.
 *
 * Legacy upgrade is one-shot per chat: on first load we read the legacy
 * namespaces, replay each anchor as a floor-state commit, and delete the
 * legacy data. A `__schema` sidecar marks the migration complete so the
 * upgrade is idempotent across reloads.
 */

import {
    getPlayableMessageAt,
    isStoredOrchestrationSnapshotValidForMessages,
    normalizeAnchorPlayableFloor,
    normalizeOrchestrationSnapshot,
} from './anchors.js';
import { DEFAULT_LOOP_SYSTEM_PROMPT } from './loop-default-prompt.js';
import { sanitizeCustomTools } from './custom-tools-sanitize.js';

const STATE_NAMESPACE = 'luker_orchestrator_anchors';
const SCHEMA_NAMESPACE = `${STATE_NAMESPACE}__schema`;
const LEGACY_INDEX_NAMESPACE = 'luker_orchestrator_state';
const LEGACY_ANCHOR_NAMESPACE_PREFIX = 'luker_orchestrator_anchor_';
const SCHEMA_VERSION = 1;

/**
 * Canonical Layer-2 memory tool names. Mirrors the `MEMORY_TOOL_NAMES`
 * frozen export in `memory-graph/orchestrator-tools.js`. Inlined here
 * (rather than imported) to avoid coupling orchestrator persistence to
 * the memory-graph extension's internal module — orchestrator already
 * treats Layer-2 names as an external contract for the legacy-flag
 * translator path. If a memory tool is added / removed, update BOTH
 * lists; the registration test in
 * `tests/memory-graph/orchestrator-tools-register.test.js` will catch
 * drift on the memory-graph side.
 */
const MEMORY_TOOL_NAMES = Object.freeze([
    'memory_list_candidates',
    'memory_edge_summary',
    'memory_node_brief',
    'memory_expand_seeds',
    'memory_schema',
    'memory_keyword_search',
    'memory_vector_search',
    'memory_find_by_name',
    'memory_compaction_candidates',
    'memory_node_create',
    'memory_node_edit',
    'memory_node_delete',
    'memory_link_upsert',
    'memory_link_delete',
    'memory_compact_nodes',
]);

/**
 * Canonical Layer-2 search tool names. Mirrors the `SEARCH_TOOL_NAMES`
 * frozen export in `search-tools/orchestrator-tools.js`. Inlined here
 * (rather than imported) to keep the legacy-flag translator path
 * loosely coupled — same rationale as MEMORY_TOOL_NAMES above. If a
 * search tool is added / removed, update BOTH lists; the registration
 * test in `tests/search-tools/orchestrator-tools-register.test.js`
 * will catch drift on the search-tools side.
 */
const SEARCH_TOOL_NAMES = Object.freeze([
    'search_search',
    'search_visit',
]);

/**
 * Loop execution mode marker (V3 profile schema). Lives next to
 * `ORCH_EXECUTION_MODE_SPEC` / `ORCH_EXECUTION_MODE_AGENDA` defined in
 * `defaults.js`; we keep the loop literal here because the loop profile's
 * canonical sanitizer (`sanitizeLoopProfile`) is colocated with the
 * floor-state binding it ultimately persists into.
 */
export const ORCH_EXECUTION_MODE_LOOP = 'loop';

/**
 * Frozen V3 default profile. Callers should always run input through
 * `sanitizeLoopProfile` rather than mutating this object — the freeze is
 * a guardrail, not the contract.
 *
 * Field semantics (full design lives in
 * `docs/superpowers/specs/2026-05-06-orchestrator-loop-mode-design.md`):
 *
 *   - mode                  literal 'loop'; coerced on every sanitize
 *   - apiPresetName         Connection Manager profile (empty = global)
 *   - promptPresetName      chat completion preset (empty = global)
 *   - system_prompt         agent system instruction; missing falls back to
 *                            `DEFAULT_LOOP_SYSTEM_PROMPT` so fresh installs
 *                            ship with a usable RP director prompt. Existing
 *                            user-authored values (including explicit empty
 *                            string) are preserved verbatim.
 *   - tools.note.{open, close}  persistent note tool (per-chat, cross-run);
 *                            `close` lets the agent prune notes whose role
 *                            is exhausted (foreshadowing fired, setting
 *                            superseded) so the system-prompt note block
 *                            doesn't degenerate into noise
 *   - tools.chat.{read_range, search}  in-chat history tools
 *   - tools.lorebook.{search, get}      world-info lookup tools
 *   - tools.custom.{memory_*, search_*, ...}  Layer-2 extension tools
 *                            (registered by memory-graph / search-tools)
 *                            and any Layer-3 character-card customTools.
 *                            memory-graph and search-tools verbs default
 *                            ON via LOOP_PROFILE_DEFAULTS so first-run
 *                            users keep their out-of-box tool pipeline.
 *                            Legacy `tools.memory.<verb>` /
 *                            `tools.search.<verb>` inputs are translated
 *                            into `tools.custom.memory_<verb>` /
 *                            `tools.custom.search_<verb>` by
 *                            `sanitizeAgentToolFlags` so upgraded
 *                            profiles keep their enabled set.
 *   - tools.finalize        FORCED true; the loop has no other terminator
 *   - max_rounds            hard upper bound on tool-call rounds [1, 50]
 *   - wall_clock_budget_ms  loop deadline; floored at 10000ms (10s)
 *   - capsule_inject        same shape as spec/agenda capsule injection
 */
const LOOP_PROFILE_DEFAULTS = Object.freeze({
    mode: ORCH_EXECUTION_MODE_LOOP,
    apiPresetName: '',
    promptPresetName: '',
    system_prompt: DEFAULT_LOOP_SYSTEM_PROMPT,
    tools: Object.freeze({
        note: Object.freeze({ open: true, close: true }),
        chat: Object.freeze({ read_range: true, search: true }),
        lorebook: Object.freeze({ search: true, get: true }),
        custom: Object.freeze({
            // memory-graph tools — registered by memory-graph itself via
            // Layer-2; enabled by default so first-run users get the
            // same out-of-box pipeline they had before the namespace drop.
            memory_schema: true,
            memory_list_candidates: true,
            memory_edge_summary: true,
            memory_node_brief: true,
            memory_expand_seeds: true,
            memory_keyword_search: true,
            memory_vector_search: true,
            memory_find_by_name: true,
            memory_compaction_candidates: true,
            memory_node_create: true,
            memory_node_edit: true,
            memory_node_delete: true,
            memory_link_upsert: true,
            memory_link_delete: true,
            memory_compact_nodes: true,
            // search-tools — registered by search-tools itself via
            // Layer-2; enabled by default so first-run users keep web
            // search available out of the box. The plugin's own enable
            // flag still gates execution at runtime — when it's
            // disabled the Layer-2 exec raises SEARCH_DISABLED /
            // SEARCH_UNAVAILABLE as a structured error.
            search_search: true,
            search_visit: true,
        }),
        finalize: true,
    }),
    max_rounds: 20,
    wall_clock_budget_ms: 300000,
    capsule_inject: Object.freeze({
        position: 'atDepth',
        depth: 0,
        role: 'system',
        customInstruction: '',
    }),
});

const LOOP_MAX_ROUNDS_FLOOR = 1;
const LOOP_MAX_ROUNDS_HARD_CAP = 50;
const LOOP_WALL_CLOCK_FLOOR_MS = 10000;

function clampInteger(value, lo, hi, fallback) {
    // Treat null / undefined / NaN / non-numeric strings as "missing" and
    // fall back. Explicit numeric inputs (including 0 and negatives) are
    // clamped into [lo, hi] so callers cannot accidentally bypass the
    // floor by passing 0.
    if (value === null || value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.floor(n), lo), hi);
}

function readBooleanFlag(input, defaultValue) {
    // Treats only an explicit `false` as a disable signal — every other
    // shape (undefined / true / truthy / falsy non-false / non-boolean)
    // collapses to the default. This matches the plan's "default-on"
    // ergonomics: callers pass `{ tools: { chat: { search: false } }}` to
    // disable, and missing fields stay enabled.
    if (input === false) return false;
    if (input === true) return true;
    return defaultValue;
}

function sanitizeLoopToolFlags(input) {
    // Loop mode defaults every flag ON — the agent has the full tool set
    // unless the user explicitly disables a flag. `sanitizeAgentToolFlags`
    // below is the shared sanitizer; for spec / agenda nodes it defaults
    // OFF (no tools) when no input was provided. Loop's all-on policy
    // stays the standalone outlier because loop has no "inherit"
    // semantics — its profile root *is* the tools spec.
    //
    // memory + search tools live in Layer-2 (`tools.custom.<name>`) now,
    // so to preserve the "all on by default" loop policy we pre-resolve
    // their flags into `tools.custom` here BEFORE the shared sanitizer
    // sees the input:
    //
    //   priority (highest first):
    //   1. caller's explicit `tools.custom.<name>` (always wins)
    //   2. caller's legacy `tools.memory.<verb>` / `tools.search.<verb>`
    //      (auto-translated via sanitizeAgentToolFlags's translator —
    //      kept here so an explicit `false` from the user overrides the
    //      default `true`, even though the default would otherwise have
    //      survived in slot 3 below)
    //   3. LOOP_PROFILE_DEFAULTS.tools.custom (memory_* / search_*
    //      default enabled so a bare profile retains the same enabled
    //      tool set it had before the namespace drop)
    const callerTools = input && typeof input === 'object' ? input : {};
    const callerCustom = callerTools.custom && typeof callerTools.custom === 'object'
        ? callerTools.custom
        : {};
    // First translate legacy memory + search into the custom name space so
    // we can decide priority deterministically.
    const translatedFromLegacy = {};
    const legacyMemory = callerTools.memory && typeof callerTools.memory === 'object'
        ? callerTools.memory
        : {};
    for (const [verb, on] of Object.entries(legacyMemory)) {
        translatedFromLegacy[`memory_${verb}`] = on !== false;
    }
    const legacySearch = callerTools.search && typeof callerTools.search === 'object'
        ? callerTools.search
        : {};
    for (const [verb, on] of Object.entries(legacySearch)) {
        translatedFromLegacy[`search_${verb}`] = on !== false;
    }
    // Defaults provide the baseline; legacy overrides defaults; explicit
    // custom overrides everything.
    const mergedCustom = {
        ...LOOP_PROFILE_DEFAULTS.tools.custom,
        ...translatedFromLegacy,
        ...callerCustom,
    };
    // Drop the legacy memory + search namespaces from what we hand the
    // shared sanitizer — we've already translated them, no second pass
    // needed.
    const seeded = { ...callerTools, memory: undefined, search: undefined, custom: mergedCustom };
    return sanitizeAgentToolFlags(seeded, { defaultAllOn: true, forceFinalize: true });
}

/**
 * Canonical tool-flag sanitizer used by spec node / agenda agent /
 * profile defaultTools / loop profile. Caller picks the default disposition:
 *
 *   - `defaultAllOn: true`  → missing fields default to enabled. Used by
 *                              loop mode where the agent always has tools.
 *   - `defaultAllOn: false` → missing fields default to disabled. Used by
 *                              spec / agenda where tools are opt-in.
 *
 * `forceFinalize: true` forces `finalize: true` regardless of input. Loop
 * needs it (the agent has no other terminator); spec / agenda nodes don't,
 * since their wrapping driver provides its own finalize when the cascade
 * resolves to a non-empty tool set.
 *
 * Returns the canonical flag object. The cascade is performed elsewhere
 * (`resolveAgentToolFlags`) — this function never returns null; it always
 * builds a complete shape. Callers wanting "inherit" semantics pass
 * `null` / `undefined` to the cascade resolver directly.
 */
export function sanitizeAgentToolFlags(input, { defaultAllOn = false, forceFinalize = false } = {}) {
    const def = Boolean(defaultAllOn);
    const tools = input && typeof input === 'object' ? input : {};
    const noteIn = tools.note && typeof tools.note === 'object' ? tools.note : {};
    const chatIn = tools.chat && typeof tools.chat === 'object' ? tools.chat : {};
    const lorebookIn = tools.lorebook && typeof tools.lorebook === 'object' ? tools.lorebook : {};
    const collabIn = tools.collab && typeof tools.collab === 'object' ? tools.collab : {};
    const customIn = tools.custom && typeof tools.custom === 'object' ? tools.custom : {};
    const customOut = {};
    for (const [k, v] of Object.entries(customIn)) {
        customOut[String(k)] = v === false ? false : true;
    }
    // Legacy → custom translator. memory + search tools used to live in
    // their own top-level namespaces; they are now Layer-2 extension tools
    // registered by memory-graph / search-tools. Translate any legacy
    // `tools.memory.<verb>` / `tools.search.<verb>` flags to
    // `tools.custom.memory_<verb>` / `tools.custom.search_<verb>` so an
    // upgraded profile keeps the same enabled tool set after the namespace
    // drop. User's explicit `custom.<name>` setting wins over the
    // translated legacy flag.
    //
    // Override-mode discipline (defaultAllOn === false): the pre-Layer-2
    // namespace contract was "unspecified verbs default off" regardless of
    // whether the caller mentioned the namespace at all. To preserve that
    // we emit an explicit `false` for every memory_* / search_* verb the
    // caller did NOT explicitly enable — otherwise Layer-2's default-on
    // policy (`customFlags[name] !== false`) would expose every memory /
    // search tool to override-mode callers (sub-agents) that never asked
    // for them.
    //
    // In default-all-on mode (loop) we leave unspecified verbs undefined
    // so the default-on policy applies as before.
    const legacyMemory = tools.memory && typeof tools.memory === 'object' ? tools.memory : null;
    for (const fullName of MEMORY_TOOL_NAMES) {
        const verb = fullName.slice('memory_'.length);
        if (customOut[fullName] !== undefined) continue; // explicit custom.<name> wins
        const explicit = legacyMemory ? legacyMemory[verb] : undefined;
        if (explicit !== undefined) {
            customOut[fullName] = explicit === false ? false : true;
        } else if (!def) {
            // Override mode: omitted verbs are explicitly off, matching
            // the pre-Layer-2 namespace contract.
            customOut[fullName] = false;
        }
        // else (defaultAllOn=true, omitted verb): leave undefined →
        // Layer-2 default-on policy applies in getEnabledToolSchemas.
    }
    const legacySearch = tools.search && typeof tools.search === 'object' ? tools.search : null;
    for (const fullName of SEARCH_TOOL_NAMES) {
        const verb = fullName.slice('search_'.length);
        if (customOut[fullName] !== undefined) continue; // explicit custom.<name> wins
        const explicit = legacySearch ? legacySearch[verb] : undefined;
        if (explicit !== undefined) {
            customOut[fullName] = explicit === false ? false : true;
        } else if (!def) {
            // Override mode: omitted verbs are explicitly off, matching
            // the pre-Layer-2 namespace contract.
            customOut[fullName] = false;
        }
        // else (defaultAllOn=true, omitted verb): leave undefined →
        // Layer-2 default-on policy applies in getEnabledToolSchemas.
    }
    return {
        note: {
            // New keys (open/close) win over legacy keys (add/delete). When the
            // new key is missing we read the legacy key as a one-shot migration
            // so persisted profiles authored before the rename keep working;
            // when both are missing we fall back to the namespace default.
            // After this layer no caller should ever observe `add` / `delete` —
            // the canonical shape is always { open, close }.
            open: readBooleanFlag(noteIn.open, readBooleanFlag(noteIn.add, def)),
            close: readBooleanFlag(noteIn.close, readBooleanFlag(noteIn.delete, def)),
        },
        chat: {
            read_range: readBooleanFlag(chatIn.read_range, def),
            search: readBooleanFlag(chatIn.search, def),
        },
        lorebook: {
            search: readBooleanFlag(lorebookIn.search, def),
            get: readBooleanFlag(lorebookIn.get, def),
        },
        custom: customOut,
        // Director-only collaboration verbs. Sub-agents never see these
        // tools regardless of flag value (buildSubAgentToolSchemas hard-
        // excludes them — only the main agent dispatches). For other
        // modes (loop / spec / agenda) these flags are inert: those
        // runtimes don't construct the dispatcher schemas, so the field
        // round-trips through the profile but has no effect.
        collab: {
            dispatch_subagent: readBooleanFlag(collabIn.dispatch_subagent, def),
            dispatch_inline_subagent: readBooleanFlag(collabIn.dispatch_inline_subagent, def),
        },
        // `finalize` is the only tool the agent can use to stop a tool
        // loop. Loop mode (and spec/agenda nodes that opt into tools)
        // need it forced true so the wrapper driver has a known
        // terminator. Pure-default callers (no `forceFinalize`) still
        // get the default disposition.
        finalize: forceFinalize ? true : readBooleanFlag(tools.finalize, def),
    };
}

/**
 * Optional-input variant: `null` / `undefined` mean "inherit from upstream"
 * and pass through unchanged. Otherwise delegates to
 * `sanitizeAgentToolFlags` with the caller's defaults. Used by spec node
 * and agenda agent sanitizers where the persisted shape is `null | object`.
 */
export function sanitizeOptionalAgentToolFlags(input, opts = {}) {
    if (input === null || input === undefined) return null;
    return sanitizeAgentToolFlags(input, opts);
}

/**
 * Cascade resolver for an agent invocation. Returns the canonical flag
 * object to apply at runtime:
 *
 *   1. If the node / agent has its own `tools` field set (object), use it.
 *   2. Otherwise, fall back to the profile's `defaultTools` (object).
 *   3. Otherwise, return the built-in fallback (`builtinDefault`, which
 *      callers can pass as either an all-off shape — spec / agenda — or
 *      an all-on shape — single mode if it ever opts in).
 *
 * All three layers should already be sanitized; this helper just picks
 * the highest-priority non-null one.
 */
export function resolveAgentToolFlags(nodeTools, profileDefaultTools, builtinDefault = null) {
    if (nodeTools && typeof nodeTools === 'object') return nodeTools;
    if (profileDefaultTools && typeof profileDefaultTools === 'object') return profileDefaultTools;
    if (builtinDefault && typeof builtinDefault === 'object') return builtinDefault;
    return null;
}

/**
 * Returns true when any flag in the canonical shape is enabled. Used
 * by spec / agenda runtime to decide whether a node needs the
 * multi-round tool-loop driver instead of the single-forced-function
 * code path. `finalize` alone doesn't count as "enabled tools" — the
 * tool loop is pointless without at least one non-terminator tool.
 *
 * `tools.custom` is walked too so Layer-2 / Layer-3 tools (memory-graph,
 * search-tools, character-card customTools) opt the loop driver in even
 * when no builtin namespace has a true flag.
 */
export function hasAnyToolEnabled(flags) {
    if (!flags || typeof flags !== 'object') return false;
    const groups = ['note', 'chat', 'lorebook'];
    for (const group of groups) {
        const bag = flags[group];
        if (bag && typeof bag === 'object') {
            for (const key of Object.keys(bag)) {
                if (bag[key] === true) return true;
            }
        }
    }
    const custom = flags.custom;
    if (custom && typeof custom === 'object') {
        for (const key of Object.keys(custom)) {
            if (custom[key] === true) return true;
        }
    }
    return false;
}

function sanitizeLoopCapsuleInject(input) {
    const inject = input && typeof input === 'object' ? input : {};
    return {
        position: typeof inject.position === 'string' && inject.position
            ? inject.position
            : LOOP_PROFILE_DEFAULTS.capsule_inject.position,
        depth: Number.isFinite(Number(inject.depth))
            ? Math.floor(Number(inject.depth))
            : LOOP_PROFILE_DEFAULTS.capsule_inject.depth,
        role: typeof inject.role === 'string' && inject.role
            ? inject.role
            : LOOP_PROFILE_DEFAULTS.capsule_inject.role,
        customInstruction: typeof inject.customInstruction === 'string'
            ? inject.customInstruction
            : LOOP_PROFILE_DEFAULTS.capsule_inject.customInstruction,
    };
}

/**
 * Canonical V3 loop-profile normalizer. Coerces the input into the
 * runtime shape, clamps numeric budgets to the hard bounds, forces the
 * mode literal and `tools.finalize` regardless of caller intent, and
 * fills missing tool flags with the default-on state.
 *
 * Mirrors the role `sanitizeSpec` plays for V1 and `sanitizeAgendaWorkingProfile`
 * for V2. There is intentionally no top-level dispatcher in this module
 * (V1 and V2 sanitizers each live next to their data); callers that
 * need to choose between sanitizers do so by inspecting `input?.mode`
 * upstream (e.g. `runOrchestration` in main.js).
 *
 * @param {object | null | undefined} input
 * @returns {{
 *   mode: 'loop',
 *   apiPresetName: string,
 *   promptPresetName: string,
 *   system_prompt: string,
 *   tools: {
 *     note: { open: boolean, close: boolean },
 *     chat: { read_range: boolean, search: boolean },
 *     lorebook: { search: boolean, get: boolean },
 *     custom: { [toolName: string]: boolean },
 *     finalize: true,
 *   },
 *   max_rounds: number,
 *   wall_clock_budget_ms: number,
 *   capsule_inject: { position: string, depth: number, role: string, customInstruction: string },
 * }}
 */
export function sanitizeLoopProfile(input) {
    const source = input && typeof input === 'object' ? input : {};
    return {
        mode: ORCH_EXECUTION_MODE_LOOP,
        apiPresetName: source.apiPresetName == null ? '' : String(source.apiPresetName),
        promptPresetName: source.promptPresetName == null ? '' : String(source.promptPresetName),
        // Missing field (no `system_prompt` key at all) → ship the default RP
        // director prompt. Existing string values, including '', are kept
        // verbatim so users who deliberately cleared the textarea aren't
        // re-overwritten on every sanitize roundtrip.
        system_prompt: source.system_prompt == null
            ? LOOP_PROFILE_DEFAULTS.system_prompt
            : String(source.system_prompt),
        tools: sanitizeLoopToolFlags(source.tools),
        max_rounds: clampInteger(
            source.max_rounds,
            LOOP_MAX_ROUNDS_FLOOR,
            LOOP_MAX_ROUNDS_HARD_CAP,
            LOOP_PROFILE_DEFAULTS.max_rounds,
        ),
        wall_clock_budget_ms: (() => {
            // null/undefined → default; explicit numbers below the floor
            // get raised to LOOP_WALL_CLOCK_FLOOR_MS rather than silently
            // adopting the (much larger) default.
            if (source.wall_clock_budget_ms === null || source.wall_clock_budget_ms === undefined) {
                return LOOP_PROFILE_DEFAULTS.wall_clock_budget_ms;
            }
            const n = Number(source.wall_clock_budget_ms);
            if (!Number.isFinite(n)) return LOOP_PROFILE_DEFAULTS.wall_clock_budget_ms;
            return Math.max(LOOP_WALL_CLOCK_FLOOR_MS, Math.floor(n));
        })(),
        capsule_inject: sanitizeLoopCapsuleInject(source.capsule_inject),
        customTools: sanitizeCustomTools(source.customTools),
    };
}

let floorStatePromise = null;

/**
 * Lazy singleton holding the floor-state instance for orchestrator anchors.
 * The instance lives for the page session; its data namespace is kept in
 * sync with chat structure by core driving `settleXxx` from `floor-state.js`
 * on every structural transition — callers do not need to recreate it.
 */
export async function getFloorStateInstance(context) {
    if (!floorStatePromise) {
        if (typeof context?.createFloorState !== 'function') {
            throw new Error('[orchestrator] createFloorState API is unavailable in extension context.');
        }
        floorStatePromise = context.createFloorState({ namespace: STATE_NAMESPACE });
    }
    return floorStatePromise;
}

/**
 * Test escape hatch: drop the cached singleton so subsequent
 * `getFloorStateInstance` calls create a fresh instance. Production code
 * never needs this — the instance lives for the page session.
 */
export function resetFloorStateInstanceForTesting() {
    floorStatePromise = null;
}

function getLegacyAnchorNamespace(playableFloor) {
    const normalized = normalizeAnchorPlayableFloor(playableFloor);
    if (!normalized) return '';
    return `${LEGACY_ANCHOR_NAMESPACE_PREFIX}${normalized}`;
}

/**
 * Read the schema sidecar that records whether legacy data has been
 * migrated for this chat. Returns 0 when no sidecar exists.
 */
async function readSchemaVersion(context) {
    if (typeof context?.getChatState !== 'function') return 0;
    const raw = await context.getChatState(SCHEMA_NAMESPACE, {});
    return Math.max(0, Math.floor(Number(raw?.version || 0)));
}

async function writeSchemaVersion(context, version) {
    if (typeof context?.updateChatState !== 'function') return;
    await context.updateChatState(SCHEMA_NAMESPACE, () => ({ version: Number(version) || 0 }), {
        maxOperations: 4,
        maxRetries: 1,
    });
}

/**
 * Read every entry in the legacy index + anchor sidecars for the current
 * chat. Returns the parsed legacy payload plus the per-anchor snapshots
 * already keyed by playable floor, or `null` when no legacy data is
 * present (fresh chat or already migrated).
 */
async function readLegacyOrchestratorState(context) {
    if (typeof context?.getChatState !== 'function') return null;
    const indexPayload = await context.getChatState(LEGACY_INDEX_NAMESPACE, {});
    if (!indexPayload || typeof indexPayload !== 'object') return null;

    const rawAnchors = Array.isArray(indexPayload.anchors) ? indexPayload.anchors : [];
    const anchors = [];
    for (const raw of rawAnchors) {
        const normalized = normalizeAnchorPlayableFloor(raw);
        if (normalized > 0 && !anchors.includes(normalized)) {
            anchors.push(normalized);
        }
    }
    anchors.sort((a, b) => a - b);

    const snapshots = new Map();
    for (const anchorPlayableFloor of anchors) {
        const ns = getLegacyAnchorNamespace(anchorPlayableFloor);
        if (!ns) continue;
        const snapshot = await context.getChatState(ns, {});
        const normalized = normalizeOrchestrationSnapshot(snapshot);
        if (normalized) {
            snapshots.set(anchorPlayableFloor, normalized);
        }
    }

    let legacySnapshot = null;
    if (indexPayload.snapshot && typeof indexPayload.snapshot === 'object') {
        const playableFloor = normalizeAnchorPlayableFloor(
            indexPayload.snapshot.anchorPlayableFloor || indexPayload.snapshot.anchorFloor,
        );
        const normalized = normalizeOrchestrationSnapshot(indexPayload.snapshot);
        if (playableFloor > 0 && normalized) {
            legacySnapshot = { playableFloor, snapshot: normalized };
            if (!snapshots.has(playableFloor)) {
                snapshots.set(playableFloor, normalized);
                anchors.push(playableFloor);
                anchors.sort((a, b) => a - b);
            }
        }
    }

    if (anchors.length === 0 && !legacySnapshot) return null;
    return { anchors, snapshots };
}

/**
 * Delete every legacy namespace touched by the migration, including the
 * pre-anchor `snapshot` sidecar and the anchor index itself. Best-effort:
 * a missing `deleteChatState` helper just leaves orphan files behind,
 * which the consumer ignores anyway.
 */
async function deleteLegacyOrchestratorState(context, anchors) {
    if (typeof context?.deleteChatState !== 'function') return;
    for (const playableFloor of anchors) {
        const ns = getLegacyAnchorNamespace(playableFloor);
        if (!ns) continue;
        await context.deleteChatState(ns, {});
    }
    await context.deleteChatState(LEGACY_INDEX_NAMESPACE, {});
}

/**
 * Replay each legacy anchor as a floor-state commit tagged at the user
 * message that owns that playable floor. Anchors whose user message
 * cannot be located in the current chat (e.g. truncated since the
 * snapshot was taken) are dropped.
 *
 * Returns the number of commits written so callers can log progress.
 */
async function replayLegacyAnchorsAsCommits(context, fs, legacy) {
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    let committed = 0;
    for (const playableFloor of legacy.anchors) {
        const snapshot = legacy.snapshots.get(playableFloor);
        if (!snapshot) continue;
        const target = getPlayableMessageAt(messages, playableFloor);
        if (!target?.message || !target.message.is_user) continue;
        const swipeIdRaw = target.message.swipe_id;
        const swipeId = Number.isInteger(swipeIdRaw) && swipeIdRaw >= 0 ? swipeIdRaw : 0;
        const ok = await fs.patch(
            [{ op: 'add', path: `/${playableFloor}`, value: snapshot }],
            { floor: target.index, swipeId },
        );
        if (ok) committed += 1;
    }
    return committed;
}

/**
 * One-shot legacy upgrade. Idempotent — when the schema sidecar already
 * records `SCHEMA_VERSION`, returns immediately without I/O on the
 * legacy namespaces. Safe to call from any chat-loaded entry point.
 *
 * Order is "read legacy → write commits → write schema marker → delete
 * legacy". A crash before the schema marker is written means the next
 * startup re-runs the migration; the commit log is overwrite-only at
 * (floor, swipeId) so the replay is benign. A crash before the legacy
 * delete leaves orphan namespaces that the post-migration code never
 * reads; they are reaped on the next successful migration attempt.
 */
export async function migrateLegacyAnchorsIfNeeded(context) {
    const currentVersion = await readSchemaVersion(context);
    if (currentVersion >= SCHEMA_VERSION) {
        return { migrated: false, reason: 'already-migrated' };
    }

    const legacy = await readLegacyOrchestratorState(context);
    if (!legacy) {
        await writeSchemaVersion(context, SCHEMA_VERSION);
        return { migrated: false, reason: 'no-legacy-data' };
    }

    const fs = await getFloorStateInstance(context);
    await fs.ready();
    const committed = await replayLegacyAnchorsAsCommits(context, fs, legacy);

    await writeSchemaVersion(context, SCHEMA_VERSION);
    await deleteLegacyOrchestratorState(context, legacy.anchors);

    return { migrated: true, committed, anchors: legacy.anchors.slice() };
}

/**
 * Read the current data namespace state. Returns `{}` (not null) so
 * callers can iterate keys without a guard.
 */
export async function loadAnchorMap(context) {
    const fs = await getFloorStateInstance(context);
    await fs.ready();
    const data = await fs.get();
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/**
 * Write a freshly-completed orchestration snapshot. The commit's
 * (floor, swipeId) tag is derived from the anchor's owning user message
 * so floor-state's structural-event handlers can correctly invalidate it
 * later.
 *
 * Returns `false` when the anchor is incomplete (missing chatIndex /
 * playableFloor) or the underlying patch failed; the caller should treat
 * this as a soft error and surface it to the UI.
 *
 * @param {object} context
 * @param {{ playableFloor: number, chatIndex: number, swipeId: number, hash: string }} anchor
 * @param {{ anchorHash: string, capsuleText: string, stageOutputs: object[] }} snapshot
 * @returns {Promise<boolean>}
 */
export async function commitAnchorSnapshot(context, anchor, snapshot) {
    const playableFloor = normalizeAnchorPlayableFloor(anchor?.playableFloor);
    const chatIndex = Number(anchor?.chatIndex);
    const swipeId = Number(anchor?.swipeId);
    if (!playableFloor || !Number.isInteger(chatIndex) || chatIndex < 0) {
        return false;
    }
    const normalizedSnapshot = normalizeOrchestrationSnapshot(snapshot);
    if (!normalizedSnapshot) {
        return false;
    }

    const fs = await getFloorStateInstance(context);
    return fs.patch(
        [{ op: 'add', path: `/${playableFloor}`, value: normalizedSnapshot }],
        { floor: chatIndex, swipeId: Number.isInteger(swipeId) && swipeId >= 0 ? swipeId : 0 },
    );
}

/**
 * Convenience: pick the latest still-valid snapshot from the data map
 * given the current chat. "Valid" = stored playable floor still points
 * at a user message AND the stored anchorHash matches the live message
 * text. Used to populate the in-memory cache that drives capsule
 * injection and UI rendering.
 *
 * @param {object} context
 * @param {Object<number, object>} anchorMap
 * @returns {{ playableFloor: number, snapshot: object } | null}
 */
export function pickLatestValidSnapshot(context, anchorMap) {
    if (!anchorMap || typeof anchorMap !== 'object') return null;
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const sortedFloors = Object.keys(anchorMap)
        .map(Number)
        .filter(Number.isInteger)
        .sort((a, b) => b - a);
    for (const playableFloor of sortedFloors) {
        const snapshot = normalizeOrchestrationSnapshot(anchorMap[playableFloor]);
        if (!snapshot) continue;
        if (isStoredOrchestrationSnapshotValidForMessages(playableFloor, snapshot, messages)) {
            return { playableFloor, snapshot };
        }
    }
    return null;
}

export const constants = Object.freeze({
    STATE_NAMESPACE,
    SCHEMA_NAMESPACE,
    LEGACY_INDEX_NAMESPACE,
    LEGACY_ANCHOR_NAMESPACE_PREFIX,
    SCHEMA_VERSION,
});
