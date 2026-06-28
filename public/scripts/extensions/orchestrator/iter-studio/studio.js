// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Orchestrator — AI iteration popup (plugin-owned).
 *
 * Replacement for the legacy iter-studio shell-driven adapter
 * (`iteration-adapter.js`). Single-column chat surface that wires the
 * `iteration-library/*` helpers directly:
 *   - storage  (per-mode, per-scope session bucket via `session-store.js`)
 *   - runner   (`requestToolCallsWithRetry` from `lib/iter-tool-calling.js`)
 *   - render   (Markdown rendering for assistant messages)
 *   - edits    (`applyEdits` from `lib/edits/`)
 *
 * Mode-aware: a single popup template covers spec / loop / agenda /
 * director. The `mode` passed into deps selects per-mode sanitize +
 * clone helpers and routes commit through the orchestrator's existing
 * apply helpers (which fan out to the right per-mode branch).
 *
 * Sandbox-diff (ported inline from iteration-adapter.js L244-L298):
 *   The orchestrator's mode-aware `executeAiIterationToolCalls` mutates a
 *   `session.workingProfile` in place. The popup clones the live profile,
 *   runs the executor against the sandbox, and emits ONE coarse
 *   `set('', newProfile)` edit per turn. Coarse profile-level edits mean
 *   conflict detection is profile-level — acceptable for SP-1; a future
 *   sub-project can swap in per-field op tools when the orchestrator side
 *   ships its own normalizer.
 *
 * Control tools (per-mode reset tools — reset_to_blank / reset_to_global)
 * are filtered out of `toolCalls` BEFORE sandbox-diff normalize. They drive
 * popup flow only: reset → wipe pendingEdits and replace live with a fresh
 * blank or global profile clone. There is no continue / finalize control
 * tool — the multi-round auto-continue loop is program-driven by tool-call
 * presence (any tool call → next round, none → stop).
 *
 * Layout — split workspace (chat + live preview):
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ <details> History … New, Clear                </details>       │
 *   │ <div> Tab bar (Chat | Preview) — mobile only </div>            │
 *   │ ┌─ chat pane ──────────────────┐ │ ┌─ preview pane ────────┐  │
 *   │ │ message list                 │ │ │ live profile          │  │
 *   │ │ finalized banner (when set)  │ │ │ (Pipeline / Loop /    │  │
 *   │ │ pending edits + Apply G/Char │R│ │  Agenda / Director,   │  │
 *   │ │ composer:                    │ │ │  mode-dependent)      │  │
 *   │ │   textarea                   │ │ │                       │  │
 *   │ │   [✓] auto-apply  [Send]     │ │ │                       │  │
 *   │ └──────────────────────────────┘ │ └───────────────────────┘  │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * The popup is mounted via `new Popup(..., POPUP_TYPE.DISPLAY)` so it has no
 * built-in OK / Cancel buttons; the user dismisses it via the dialog's close
 * button (top-right ✕). Sessions auto-persist on every mutation, so closing
 * mid-conversation is safe.
 *
 * Entry point:
 *   `openOrchestratorIterationStudio(deps)`
 *
 * Deps shape — mirrors the bag main.js builds for
 * createOrchestratorIterationAdapter, plus `mode`, `context`, `settings`, `root`:
 *   - mode                              one of ORCH_EXECUTION_MODES.{SPEC,LOOP,AGENDA,DIRECTOR}
 *   - context                           SillyTavern context
 *   - settings                          orchestrator settings root (extension_settings.orchestrator)
 *   - root                              jQuery root passed through to apply helpers' refresh callbacks
 *   - i18n, i18nFormat
 *   - getIterationDefaultScope(ctx)
 *   - syncCharacterEditorWithActiveAvatar(ctx)
 *   - sanitizeLoopProfile, sanitizeAgendaWorkingProfile, sanitizeDirectorProfile
 *   - buildAiIterationToolSet(session)
 *   - buildAiIterationSystemPrompt(settings, session)
 *   - buildAiIterationUserPrompt(settings, session, userText, opts)
 *   - buildAiIterationAutoContinuePrompt(executionResult)
 *   - executeAiIterationToolCalls(ctx, session, calls, signal)
 *   - renderAiIterationWorkingProfile(session, opts)
 *   - resolveOrchestrationRuntimeWorldInfo(ctx, settings, opts)
 *   - applyAiIterationSessionToGlobal(ctx, settings, session, root)
 *   - applyAiIterationSessionToCharacter(ctx, settings, session, root)
 *   - ORCH_EXECUTION_MODES                { SPEC, LOOP, AGENDA, DIRECTOR }
 */

const __ctx = Luker.getContext();
const Popup = __ctx.Popup;
const POPUP_TYPE = __ctx.POPUP_TYPE;
import {
    applyEdits,
    bindIterWorkspaceResizer,
    createRenderScheduler,
    inverseEdit,
    render as ITER_RENDER,
    runner as ITER_RUNNER,
    tools as ITER_TOOLS,
    ui as ITER_UI,
    zoomOverlay as ITER_ZOOM_OVERLAY,
    proposalBus as ITER_PROPOSAL_BUS,
} from '../../../iteration-library/index.js';
import { profileEdit } from '../../../iteration-library/proposal-bus/kinds/profile-edit.js';
import { lorebookWrite } from '../../../iteration-library/proposal-bus/kinds/lorebook-write.js';
import { skillAuthor } from '../../../iteration-library/proposal-bus/kinds/skill-author.js';
import { customToolAuthor } from '../../../iteration-library/proposal-bus/kinds/custom-tool-author.js';
import { registerTarget } from '../../../iteration-library/storage/target-registry.js';
import { mdLiteral } from '../../../iteration-library/markdown-escape.js';
import {
    renderSkillBody,
    skillLabel as skillBodyLabel,
    skillIcon as skillBodyIcon,
    skillTarget as skillBodyTarget,
} from '../../../iteration-library/proposal-bus/diff-bodies/skill.js';
import {
    renderLorebookBody,
    lorebookLabel as lorebookBodyLabel,
    lorebookIcon as lorebookBodyIcon,
    lorebookTarget as lorebookBodyTarget,
} from '../../../iteration-library/proposal-bus/diff-bodies/lorebook-write.js';
import {
    renderCustomToolBody,
    customToolLabel as customToolBodyLabel,
    customToolIcon as customToolBodyIcon,
    customToolTarget as customToolBodyTarget,
} from '../../../iteration-library/proposal-bus/diff-bodies/custom-tool-author.js';
import {
    createOrchestratorIterationSessionStore,
    makeMessageId,
    normalizeMessageShape,
} from './session-store.js';
import { migrateOrchSessionsV2ToSidecar } from './session-migration-v2-to-sidecar.js';
import { ORCH_TOOL_DISPLAY } from './tool-display.js';
import { interpretSandboxOutcome, buildEditCallReply } from './sandbox-result.js';
import { buildDrainOutcomesMessage } from './drain-outcomes-message.js';
// auto-continue gate is now `bus.hasOutstanding()` — the standalone
// gate module + its unit test were retired during the ProposalBus migration.
// Character-editor-assistant publishes its helper-tool surface via
// `registerExtensionApi('character-editor-assistant', {...})`. Resolved
// per-call so a missing CEA install fails at the iter-studio entry
// rather than at module load.
function getCea() {
    const api = __ctx.getExtensionApi('character-editor-assistant');
    if (!api) {
        throw new Error('Orchestrator iter-studio requires the character-editor-assistant extension to be installed and enabled.');
    }
    return api;
}
// Iter-studio skill management catalog. Spliced into the
// tool catalog alongside CONTROL_TOOL_DEFS + lorebook reads/writes, routed
// through the inline-executed path. Three execution shapes:
//   - 4 inventory tools just return read-only data
//   - 3 policy-binding + 1 systemPrompt-splice tool emit a sandbox-diff
//     `pendingEdit` (mutates the working profile, applies through the
//     standard apply pipeline)
//   - 7 authoring tools (+ skill_extract_from_text which composes
//     skill_create) emit a `pendingSkillEdit` blob captured on
//     state.pendingSkillEdits — same per-card Approve/Reject + Apply-time
//     commit pattern lorebook proposals use, so the user sees a line-by-line
//     diff card instead of a silent direct-to-disk write.
import {
    SKILL_ITER_STUDIO_TOOL_DEFS,
    isSkillIterStudioTool,
    runSkillIterStudioTool,
    commitApprovedSkillProposal,
} from '../../../iteration-library/tools/skill-iter-studio.js';
import {
    isCustomToolIterStudioTool,
    commitApprovedCustomToolProposal,
    resanitizeProfileCustomTools,
} from '../custom-tool-iter-studio.js';
import { augmentIterStudioPromptWithSkills } from '../skill-iter-studio-prompt.js';
import { buildSkillRuntimeContext } from '../skill-resolution.js';
import { getActivePreset } from '../preset-library.js';
import { getCurrentAvatar } from '../snapshot-cache.js';

const MODULE = 'orch-iteration';
const STYLESHEET_ID = 'orch_it_studio_stylesheet';
const STYLESHEET_HREF = '/scripts/extensions/orchestrator/iter-studio/studio.css';

/**
 * Return the mode-appropriate enable-flag bucket on a working profile.
 * Mirrors the mapping `getCustomToolEditorBinding` in main.js uses:
 *   loop / director → profile.tools.custom
 *   agenda          → profile.defaultTools.custom
 *   spec            → profile.spec.defaultTools.custom
 * The bucket is created in place if missing so callers can mutate it
 * verbatim.
 */
function getCustomToolFlagBucket(profile, mode) {
    if (!profile || typeof profile !== 'object') return {};
    if (mode === 'agenda') {
        if (!profile.defaultTools || typeof profile.defaultTools !== 'object') profile.defaultTools = {};
        if (!profile.defaultTools.custom || typeof profile.defaultTools.custom !== 'object') profile.defaultTools.custom = {};
        return profile.defaultTools.custom;
    }
    if (mode === 'spec') {
        if (!profile.spec || typeof profile.spec !== 'object') profile.spec = {};
        if (!profile.spec.defaultTools || typeof profile.spec.defaultTools !== 'object') profile.spec.defaultTools = {};
        if (!profile.spec.defaultTools.custom || typeof profile.spec.defaultTools.custom !== 'object') profile.spec.defaultTools.custom = {};
        return profile.spec.defaultTools.custom;
    }
    // loop + director
    if (!profile.tools || typeof profile.tools !== 'object') profile.tools = {};
    if (!profile.tools.custom || typeof profile.tools.custom !== 'object') profile.tools.custom = {};
    return profile.tools.custom;
}

// ──────────────────────────────────────────────────────────────────────────
// Lorebook read tools (borrowed from the unified CEA editor's surface).
// ──────────────────────────────────────────────────────────────────────────
// Lorebook read tools
//
// The orchestration designer often needs to read lorebook content while
// shaping nodes — e.g. to decide what kind of constraints a `lorebook_reader`
// node should enforce, or to confirm that the active world books actually
// contain the categories of facts a node assumes. These read tools give
// the iteration AI the same lorebook visibility the CEA editor has.
//
// Implementation: shared with sibling iter popups (memory-graph schema
// iter, CEA editor) via `iteration-library/tools/lorebook-reads.js` and
// `lorebook-writes.js`. Plugin-agnostic — only needs the SillyTavern
// context + the active avatar.
//
// IMPORTANT: results are read-only and informational. They are NOT
// duplicated into any generated node's systemPrompt — the runtime already
// auto-injects active world-info into every sub-agent. The system prompt
// instructs the AI to use these tools to understand the *shape* of
// constraints, not to copy lorebook text into prompts.
// ──────────────────────────────────────────────────────────────────────────
const { isLorebookReadTool, LOREBOOK_READ_TOOL_DEFS, runLorebookReadTool: runLorebookReadToolShared } = ITER_TOOLS.lorebookReads;
const { isLorebookWriteTool, LOREBOOK_WRITE_TOOL_DEFS, runLorebookWriteTool: runLorebookWriteToolShared } = ITER_TOOLS.lorebookWrites;

// `luker_orch_simulate` is classified as a read tool too (it runs a
// throwaway orchestration against the working profile and returns the
// stage outputs — the working profile itself is not mutated). The
// runtime executor for simulate lives in main.js's
// executeAiIterationToolCalls; the popup recognizes the name here so
// the call routes to the read-path persistence below (toolResults +
// pure-read auto-continue) instead of the silent-drop edit-tool path
// where lastSimulation gets written to a throwaway sandbox.
const SIMULATE_TOOL_NAME = 'luker_orch_simulate';

function isSimulateTool(name) {
    return String(name || '') === SIMULATE_TOOL_NAME;
}

// "Inline-executed" means the popup dispatches the call synchronously and
// persists the tool_result on the assistant message (so the next round's
// taskMessages replay carries it back to the model). Lorebook reads,
// lorebook writes, and simulate all share this path; sandbox-edit tools
// (luker_orch_set_*) do not — they become diff proposals the user
// reviews + applies via the popup, never reaching the model directly.
// Skill iter-studio tools also use the inline-executed
// path: 4 inventory tools just return server state, 4 working-profile
// tools (3 policy bindings + skill_replace_in_systemprompt) emit a
// sandbox-diff pending edit, and 8 authoring tools (7 spec + extract)
// emit a `pendingSkillEdit` blob parked on state.pendingSkillEdits.
// Custom-tool iter-studio tools (11 total: 7 reads + 4 writes that emit
// `pendingCustomToolEdit` blobs) also dispatch inline so writes can
// stage proposals on the bus and reads return verbatim without ever
// hitting the sandbox-diff path.
function isInlineExecutedTool(name) {
    return isLorebookReadTool(name)
        || isLorebookWriteTool(name)
        || isSimulateTool(name)
        || isSkillIterStudioTool(name)
        || isCustomToolIterStudioTool(name);
}

/**
 * Execute one lorebook read tool. Thin wrapper that threads the SillyTavern
 * context + avatar through the shared `iteration-library/tools/lorebook-reads.js`
 * implementation. Kept as a local helper so existing call sites that pass
 * `(call, avatar)` continue to work without restructuring.
 */
async function runLorebookReadTool(call, avatar = '') {
    return runLorebookReadToolShared(call, { context: __ctx, avatar });
}

/**
 * Execute one lorebook write tool. Mirrors runLorebookReadTool. Proposal
 * mode only — returns `{before, after, ...}` without touching disk; commit
 * via `applyLorebookProposal` after user approval.
 */
async function runLorebookWriteTool(call) {
    return runLorebookWriteToolShared(call, { context: __ctx });
}

const CONTROL_TOOL_NAMES = Object.freeze({
    resetToBlank: 'luker_orch_reset_live_to_blank',
    resetToGlobal: 'luker_orch_reset_live_to_global',
});
const CONTROL_TOOL_NAME_SET = new Set([
    CONTROL_TOOL_NAMES.resetToBlank,
    CONTROL_TOOL_NAMES.resetToGlobal,
]);

/**
 * Predicate the runner uses (via `isControlCall`) to route a tool call to
 * `onControlCall` instead of `onToolCall`. Keeps the shared runner
 * plugin-agnostic; the popup decides what counts as a control call.
 */
function isOrchControlCall(toolCall) {
    return CONTROL_TOOL_NAME_SET.has(String(toolCall?.name || ''));
}

/**
 * OpenAI-style function definitions for the popup-side control tools. The
 * orchestrator's `buildAiIterationToolSet` already returns the edit-tools
 * catalog for the active mode; we splice these in alongside, but route them
 * through `onControlCall` so they never reach the sandbox executor.
 * The multi-round auto-continue loop is program-driven by tool-call
 * presence (any tool call → next round, none → stop), so there is no
 * continue / finalize control tool.
 */
const CONTROL_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: CONTROL_TOOL_NAMES.resetToBlank,
            description: 'Replace the working profile with a minimal blank shell for the current mode, discarding the global-profile copy seeded in. Use ONLY when the user wants to author a brand-new orchestration for this character from scratch (not when adjusting the existing setup). The popup only injects this affordance when scope is character AND no character override exists yet — ignore it otherwise.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Optional rationale visible to the user.' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CONTROL_TOOL_NAMES.resetToGlobal,
            description: 'Replace the working profile with a fresh clone of the current GLOBAL profile for this mode, discarding the existing character-override copy seeded in. Use ONLY when the user wants to wipe their character override and restart from the current global setup. The popup only injects this affordance when scope is character AND a character override already exists — ignore it otherwise.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Optional rationale visible to the user.' },
                },
                additionalProperties: false,
            },
        },
    },
];

/**
 * Loose AbortError detector. The runner may throw a DOMException with name
 * AbortError, a plain Error with "aborted" in the message, or rethrow our
 * AbortController's signal. Treat any of those as a user-driven Stop so
 * handleSendMessage's catch block doesn't push an error bubble.
 */
function isAbortError(err, signal) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    const msg = String(err?.message || err);
    if (/abort(ed)?/i.test(msg)) return true;
    if (signal?.aborted) return true;
    return false;
}

/**
 * Per-mode popup titles. Resolved ONCE at mount and baked into the
 * popup shell HTML; the title is not re-rendered when the host's
 * executionMode changes externally. Closing + reopening the popup
 * picks up the new title. This is intentional — the popup's
 * session-bucket key is mode-scoped, so a mid-popup mode switch
 * already would not affect the running session anyway.
 */
const TITLES_BY_MODE = Object.freeze({
    spec: 'AI Iteration Studio — Spec',
    loop: 'AI Iteration Studio — Loop',
    agenda: 'AI Iteration Studio — Agenda',
    director: 'AI Iteration Studio — Director',
});

/**
 * Inject the popup stylesheet on first open. Subsequent opens are no-ops
 * because the link element is reused (id-keyed lookup). Loading is async
 * but the popup doesn't block on it — the first paint may be unstyled for
 * a tick before the browser applies the freshly-injected rules, which is
 * the same trade-off the other plugin-owned popups make.
 */
function ensureStylesheetInjected() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLESHEET_ID)) return;
    const link = document.createElement('link');
    link.id = STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.href = STYLESHEET_HREF;
    document.head.appendChild(link);
}

/**
 * Local HTML escape for building the static popup shell + per-render
 * content. Orchestrator main.js has its own escaper, but the popup needs
 * to be self-contained for SES reasons.
 */
function escapeHtmlLocal(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

// ──────────────────────────────────────────────────────────────────────────
// Live target preview — file-local helpers + 4-mode dispatcher.
//
// Module-scope so unit tests can `import { _testOnly_renderOrchPreviewPane }`
// without instantiating the popup. Pure functions: given `live` + pending
// edits + mode, return preview HTML. Snippets B + C from the implementation
// plan, duplicated rather than extracted to iteration-library per spec §B.
//
// Profile shapes (per source-of-truth, not the plan's best-guesses):
//   - SPEC:     {spec: {stages: [{id, mode, nodes: [{id, preset, type}]}],
//                       defaultTools}, presets: {<id>: {...}}}
//   - LOOP:     FLAT — {mode, apiPresetName, promptPresetName, system_prompt,
//                       tools, max_rounds, wall_clock_budget_ms, capsule_inject}
//   - AGENDA:   {planner, agents: {<id>: {...}} (map), finalAgentId, limits}
//   - DIRECTOR: {mode, director: {mainAgent, subAgents: [...] (array), ...}}
// ──────────────────────────────────────────────────────────────────────────

/**
 * Apply a single coarse `{ op: 'set', path: '', newValue }` edit by replacing
 * `live` outright with a deep clone of `newValue`. The shared `applyEdits`
 * engine is lodash-backed and `lodash.set(target, '', value)` is a no-op, so
 * sandbox-diff edits would otherwise silently skip — leaving both the manual
 * Apply button and composer-row auto-apply as UI-only with no commit. Pure
 * function; caller owns the resulting object.
 *
 * @param {*} _live   Current live value (unused; only the new value matters
 *                    when the engine emits a full-replacement edit).
 * @param {{op:string, path:string, newValue:*}} edit  The empty-path set edit.
 * @returns {*} A `structuredClone` of `edit.newValue`.
 */
function applyEmptyPathSet(_live, edit) {
    return structuredClone(edit.newValue);
}

function computeChangedPathSet(live, pendingEdits) {
    if (!Array.isArray(pendingEdits) || pendingEdits.length === 0) return new Set();
    // Orchestrator sandbox-diff emits `{ op: 'set', path: '', oldValue,
    // newValue }` per tool call (see normalizeToolCallToEditInline below).
    // The shared `applyEdits` engine is lodash-backed and treats path='' as
    // a no-op, so we'd see live === newLive and the diff would be empty.
    // Short-circuit: when any edit has `path === ''` with a `newValue`,
    // walk live vs the LAST such edit's newValue — multi-tool-call rounds
    // chain their newValues (edit N's newValue = original + all calls up to
    // N), so the cumulative diff lives in the last edit. Using `find`
    // (first match) would render only the first tool call's mutation and
    // hide the rest. Renderer-local bypass — the actual apply path is
    // untouched.
    const emptyPathEdit = pendingEdits.findLast(e => e?.op === 'set' && e?.path === '' && typeof e?.newValue !== 'undefined');
    if (emptyPathEdit) {
        const changed = new Set();
        walkDiff('', live, emptyPathEdit.newValue, changed);
        return changed;
    }
    let next;
    try {
        const cloned = structuredClone(live);
        const result = applyEdits(pendingEdits, cloned);
        next = result?.newLive ?? cloned;
    } catch {
        return new Set();
    }
    const changed = new Set();
    walkDiff('', live, next, changed);
    return changed;
}

function walkDiff(path, a, b, out) {
    if (a === b) return;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
        out.add(path);
        return;
    }
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
        const childPath = path ? `${path}.${k}` : k;
        walkDiff(childPath, a?.[k], b?.[k], out);
    }
}

function truncateForPreview(str, max = 200) {
    if (typeof str !== 'string') str = String(str ?? '');
    return str.length > max ? str.slice(0, max) + '…' : str;
}

/**
 * Return true if any element of `changed` (a Set of dotted paths) is a
 * descendant of (or exactly equal to) `prefix`. Used to bubble "this stage
 * was modified" up to the stage row without computing a per-field highlight
 * for every node.
 */
function isPrefixInChangedSet(changed, prefix) {
    if (!(changed instanceof Set) || changed.size === 0) return false;
    if (changed.has(prefix)) return true;
    const dotted = prefix + '.';
    for (const p of changed) {
        if (typeof p === 'string' && p.startsWith(dotted)) return true;
    }
    return false;
}

function rowClass(isChanged) {
    return isChanged
        ? 'luker-iter-workspace-preview-row pending-change'
        : 'luker-iter-workspace-preview-row';
}

/**
 * Render the right-pane HTML for the Orchestrator workspace preview. Pure
 * function; dispatches on `mode` to a per-mode sub-renderer. Wraps each
 * sub-renderer in try/catch so a malformed profile (e.g. half-applied edit
 * leaving the working profile in an inconsistent state) can't blank the
 * workspace.
 *
 * @param {object|null} live          Mode-dependent working profile, or null.
 * @param {Array}       pendingEdits  Edits from the latest LLM round.
 * @param {string}      mode          One of 'spec' | 'loop' | 'agenda' | 'director'.
 * @param {Function}    [tFn]         Optional i18n function (string → string).
 * @returns {string} HTML.
 */
function renderOrchPreviewPane(live, pendingEdits, mode, tFn) {
    const t = typeof tFn === 'function' ? tFn : (s) => String(s ?? '');
    if (!live) {
        return `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No profile loaded.'))}</div>`;
    }
    try {
        const changed = computeChangedPathSet(live, pendingEdits);
        if (mode === 'loop') return renderOrchLoopPreview(live, changed, t);
        if (mode === 'agenda') return renderOrchAgendaPreview(live, changed, t);
        if (mode === 'director') return renderOrchDirectorPreview(live, changed, t);
        return renderOrchSpecPreview(live, changed, t, pendingEdits);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[orch-iteration] preview renderer failed', err);
        return `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('Preview unavailable'))}</div>`;
    }
}

/**
 * SPEC mode renderer — surface stages, modes, nodes (with preset names),
 * then a Presets section that surfaces preset-level changes (旧-8). Reads
 * the real shape `{spec: {stages, defaultTools}, presets}`. The
 * `spec.mode === 'director'` carve-out handled by `sanitizeSpec` is
 * irrelevant here — the popup's outer dispatcher routes by `state.session.mode`
 * not by the profile shape.
 *
 * Without the Presets section, `presets.*` paths in the diff (e.g. a tool
 * call that bumped a preset's apiPresetName or systemPrompt) had no row to
 * highlight, so the preview pane was mute for changes that affected presets
 * but no stage was structurally re-laid-out. The Presets section uses
 * `isPrefixInChangedSet(changed, 'presets.<id>')` to light up the
 * specific preset rows whose subtree mutated.
 */
function renderOrchSpecPreview(profile, changed, t, pendingEdits) {
    const stages = Array.isArray(profile?.spec?.stages) ? profile.spec.stages : [];
    const presetMap = (profile?.presets && typeof profile.presets === 'object') ? profile.presets : {};
    const stageRows = stages.map((s, stageIdx) => {
        const nodes = Array.isArray(s?.nodes) ? s.nodes : [];
        const stagePath = `spec.stages.${stageIdx}`;
        const stageChanged = isPrefixInChangedSet(changed, stagePath);
        const nodeBlocks = nodes.map((n, nodeIdx) => {
            const nodePath = `${stagePath}.nodes.${nodeIdx}`;
            const nodeChanged = isPrefixInChangedSet(changed, nodePath);
            const presetKey = String(n?.preset || n?.id || '');
            const preset = presetMap[presetKey] || null;
            const presetLabel = preset
                ? (preset.apiPresetName || preset.promptPresetName || presetKey)
                : presetKey;
            const typeLabel = n?.type && n.type !== 'agent' ? `[${escapeHtmlLocal(n.type)}]` : '';
            return `<div class="luker-iter-workspace-preview-row-body${nodeChanged ? ' pending-change' : ''}" style="margin-left:12px;">
                <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(n?.id || '?')}</span>
                <span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(presetLabel)} ${typeLabel}</span>
            </div>`;
        }).join('');
        return `<div class="${rowClass(stageChanged)}">
            <div class="luker-iter-workspace-preview-row-head">
                <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(s?.id || '?')}</span>
                <span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(s?.mode || 'serial')}</span>
            </div>
            ${nodeBlocks}
        </div>`;
    }).join('');

    // Presets section — one row per preset, lit up when any `presets.<id>.*`
    // path is in the changed set. The summary line shows the api / prompt
    // preset names like the node label does, so the user can correlate
    // which presets the stage rows referenced.
    //
    // Removed presets (ORCH-19): pull the pre-edit preset names off the
    // pending edits' oldValue so a deletion shows a strikethrough "(deleted)"
    // row instead of vanishing silently. Without this, a remove_preset
    // tool call had no preview affordance at all — the user had no clue
    // anything happened until they applied + re-rendered.
    const removedPresetIds = (() => {
        if (!Array.isArray(pendingEdits) || pendingEdits.length === 0) return [];
        const out = [];
        for (const e of pendingEdits) {
            if (e?.op !== 'set' || e?.path !== '' || !e?.oldValue || !e?.newValue) continue;
            const oldPresets = e.oldValue?.presets && typeof e.oldValue.presets === 'object' ? e.oldValue.presets : {};
            const newPresets = e.newValue?.presets && typeof e.newValue.presets === 'object' ? e.newValue.presets : {};
            for (const id of Object.keys(oldPresets)) {
                if (!Object.hasOwn(newPresets, id) && !out.includes(id)) out.push(id);
            }
        }
        return out;
    })();
    const presetEntries = Object.entries(presetMap);
    const presetRows = presetEntries.map(([id, preset]) => {
        const presetPath = `presets.${id}`;
        const presetChanged = isPrefixInChangedSet(changed, presetPath);
        const apiName = String(preset?.apiPresetName || '');
        const promptName = String(preset?.promptPresetName || '');
        const subtitle = [promptName, apiName].filter(Boolean).join(' / ');
        return `<div class="${rowClass(presetChanged)}">
            <div class="luker-iter-workspace-preview-row-head">
                <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(id)}</span>
                <span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(subtitle)}</span>
            </div>
        </div>`;
    }).join('');
    const removedRows = removedPresetIds.map(id => `<div class="luker-iter-workspace-preview-row pending-change">
        <div class="luker-iter-workspace-preview-row-head">
            <span class="luker-iter-workspace-preview-row-label" style="text-decoration:line-through;">${escapeHtmlLocal(id)}</span>
            <span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(t('(deleted)'))}</span>
        </div>
    </div>`).join('');

    return `
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Pipeline'))}</div>
            ${stageRows || `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No stages'))}</div>`}
        </div>
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Presets'))}</div>
            ${presetRows || `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No presets'))}</div>`}
            ${removedRows}
        </div>
    `;
}

/**
 * LOOP mode renderer — surfaces the FLAT loop profile (preset names,
 * max_rounds, wall-clock budget). The plan's `{loop: {agent}}` fixture is
 * a best-guess; the real shape is flat (sanitizeLoopProfile in
 * persistence.js:363+).
 */
function renderOrchLoopPreview(profile, changed, t) {
    const apiPreset = String(profile?.apiPresetName ?? '');
    const promptPreset = String(profile?.promptPresetName ?? '');
    const maxRounds = Number(profile?.max_rounds ?? 0);
    const wallClockMs = Number(profile?.wall_clock_budget_ms ?? 0);
    const systemPrompt = truncateForPreview(String(profile?.system_prompt ?? ''), 200);

    const rows = [
        { label: t('Prompt preset'), value: promptPreset, path: 'promptPresetName' },
        { label: t('API preset'), value: apiPreset, path: 'apiPresetName' },
        { label: t('Max rounds'), value: String(maxRounds), path: 'max_rounds' },
        { label: t('Wall-clock budget (s)'), value: String(Math.round(wallClockMs / 1000)), path: 'wall_clock_budget_ms' },
    ].map(({ label, value, path }) => {
        const isChanged = changed.has(path);
        const displayValue = value || `<span class="muted">${escapeHtmlLocal(t('(unset)'))}</span>`;
        return `<div class="${rowClass(isChanged)}">
            <div class="luker-iter-workspace-preview-row-head">
                <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(label)}</span>
                <span class="luker-iter-workspace-preview-row-meta">${value ? escapeHtmlLocal(value) : displayValue}</span>
            </div>
        </div>`;
    }).join('');

    const systemPromptChanged = changed.has('system_prompt');
    const systemPromptHtml = systemPrompt
        ? `<div class="${rowClass(systemPromptChanged)}">
            <div class="luker-iter-workspace-preview-row-head">
                <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(t('System prompt'))}</span>
            </div>
            <div class="luker-iter-workspace-preview-row-body">${escapeHtmlLocal(systemPrompt)}</div>
        </div>`
        : '';

    // Tools section — surfaces nested `tools.<namespace>.<verb>` flags.
    // The flag tree is sparse (some namespaces are simple booleans like
    // `tools.finalize: true`, others are object trees), so we walk
    // shallowly to one level of nesting and check each leaf against
    // `changed` for the per-row highlight. `tools` itself is also
    // checked so a coarse delete/replace of the whole tree highlights
    // the section header.
    const toolsObj = profile?.tools && typeof profile.tools === 'object' ? profile.tools : null;
    const toolsSectionChanged = isPrefixInChangedSet(changed, 'tools');
    let toolsHtml = '';
    if (toolsObj) {
        const namespaceRows = Object.entries(toolsObj).map(([ns, value]) => {
            const nsPath = `tools.${ns}`;
            if (value && typeof value === 'object') {
                const verbs = Object.entries(value).map(([verb, on]) => {
                    const verbPath = `${nsPath}.${verb}`;
                    const verbChanged = changed.has(verbPath);
                    const label = `${ns}.${verb}`;
                    return `<div class="luker-iter-workspace-preview-row-body${verbChanged ? ' pending-change' : ''}" style="margin-left:12px;">
                        <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(label)}</span>
                        <span class="luker-iter-workspace-preview-row-meta">${on ? '✓' : '✗'}</span>
                    </div>`;
                }).join('');
                const nsChanged = isPrefixInChangedSet(changed, nsPath);
                return `<div class="${rowClass(nsChanged)}">
                    <div class="luker-iter-workspace-preview-row-head">
                        <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(ns)}</span>
                    </div>
                    ${verbs}
                </div>`;
            }
            const isChanged = changed.has(nsPath);
            return `<div class="${rowClass(isChanged)}">
                <div class="luker-iter-workspace-preview-row-head">
                    <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(ns)}</span>
                    <span class="luker-iter-workspace-preview-row-meta">${value ? '✓' : '✗'}</span>
                </div>
            </div>`;
        }).join('');
        toolsHtml = `
            <div class="luker-iter-workspace-preview-section">
                <div class="luker-iter-workspace-preview-section-title${toolsSectionChanged ? ' pending-change' : ''}">${escapeHtmlLocal(t('Tools'))}</div>
                ${namespaceRows}
            </div>
        `;
    }

    return `
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Loop agent'))}</div>
            ${rows}
            ${systemPromptHtml}
        </div>
        ${toolsHtml}
    `;
}

/**
 * AGENDA mode renderer — surfaces the planner block + each agent (map,
 * keyed by id; the plan's `[{id, presetName}]` array fixture is wrong).
 */
function renderOrchAgendaPreview(profile, changed, t) {
    const planner = profile?.planner && typeof profile.planner === 'object' ? profile.planner : {};
    const agents = profile?.agents && typeof profile.agents === 'object' ? profile.agents : {};
    const finalAgentId = String(profile?.finalAgentId ?? '');
    const limits = profile?.limits && typeof profile.limits === 'object' ? profile.limits : {};

    const plannerChanged = isPrefixInChangedSet(changed, 'planner');
    const plannerSubtitle = [planner.promptPresetName, planner.apiPresetName].filter(Boolean).join(' / ');
    const plannerBlock = `
        <div class="${rowClass(plannerChanged)}">
            <div class="luker-iter-workspace-preview-row-head">
                <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(t('Planner'))}</span>
                <span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(plannerSubtitle || '')}</span>
            </div>
        </div>
    `;

    const agentEntries = Object.entries(agents);
    const agentRows = agentEntries.map(([id, agent]) => {
        const agentPath = `agents.${id}`;
        const agentChanged = isPrefixInChangedSet(changed, agentPath);
        const subtitle = [agent?.promptPresetName, agent?.apiPresetName].filter(Boolean).join(' / ');
        const isFinal = id === finalAgentId ? ` [${escapeHtmlLocal(t('(final)'))}]` : '';
        return `<div class="${rowClass(agentChanged)}">
            <div class="luker-iter-workspace-preview-row-head">
                <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(id)}${isFinal}</span>
                <span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(subtitle || '')}</span>
            </div>
        </div>`;
    }).join('');

    const limitsChanged = isPrefixInChangedSet(changed, 'limits');
    const limitsBlock = `
        <div class="${rowClass(limitsChanged)}">
            <div class="luker-iter-workspace-preview-row-head">
                <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(t('Limits'))}</span>
                <span class="luker-iter-workspace-preview-row-meta">
                    ${escapeHtmlLocal(t('planner rounds'))}: ${escapeHtmlLocal(String(limits.plannerMaxRounds ?? ''))} ·
                    ${escapeHtmlLocal(t('concurrent agents'))}: ${escapeHtmlLocal(String(limits.maxConcurrentAgents ?? ''))} ·
                    ${escapeHtmlLocal(t('total runs'))}: ${escapeHtmlLocal(String(limits.maxTotalRuns ?? ''))}
                </span>
            </div>
        </div>
    `;

    return `
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Pipeline'))}</div>
            ${plannerBlock}
        </div>
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Agents'))}</div>
            ${agentRows || `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No agents'))}</div>`}
        </div>
        <div class="luker-iter-workspace-preview-section">
            ${limitsBlock}
        </div>
    `;
}

/**
 * DIRECTOR mode renderer — surfaces the main agent + each sub-agent.
 * Profile shape is flat (`{mode, mainAgent, subAgents, maxRounds, ...}`)
 * after the director-shape unification; sandbox-diff change paths emit
 * top-level keys (mainAgent / subAgents / maxRounds / ...) accordingly.
 */
function renderOrchDirectorPreview(profile, changed, t) {
    const director = profile && typeof profile === 'object' ? profile : {};
    const main = director.mainAgent && typeof director.mainAgent === 'object' ? director.mainAgent : {};
    const subs = Array.isArray(director.subAgents) ? director.subAgents : [];

    const mainChanged = isPrefixInChangedSet(changed, 'mainAgent');
    const mainSubtitle = [main.promptPresetName, main.apiPresetName].filter(Boolean).join(' / ');
    const mainBlock = `
        <div class="${rowClass(mainChanged)}">
            <div class="luker-iter-workspace-preview-row-head">
                <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(t('Main agent'))}</span>
                <span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(mainSubtitle || '')}</span>
            </div>
        </div>
    `;

    const subRows = subs.map((a, idx) => {
        const path = `subAgents.${idx}`;
        const isChanged = isPrefixInChangedSet(changed, path);
        const subtitle = [a?.promptPresetName, a?.apiPresetName, a?.description].filter(Boolean).join(' · ');
        return `<div class="${rowClass(isChanged)}">
            <div class="luker-iter-workspace-preview-row-head">
                <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(a?.id || '?')}</span>
                <span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(subtitle || '')}</span>
            </div>
        </div>`;
    }).join('');

    const limitsChanged = isPrefixInChangedSet(changed, 'maxRounds')
        || isPrefixInChangedSet(changed, 'maxConcurrentSubagents')
        || isPrefixInChangedSet(changed, 'maxTotalSubagentRuns');
    const limitsBlock = `
        <div class="${rowClass(limitsChanged)}">
            <div class="luker-iter-workspace-preview-row-head">
                <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(t('Limits'))}</span>
                <span class="luker-iter-workspace-preview-row-meta">
                    ${escapeHtmlLocal(t('rounds'))}: ${escapeHtmlLocal(String(director.maxRounds ?? ''))} ·
                    ${escapeHtmlLocal(t('concurrent subagents'))}: ${escapeHtmlLocal(String(director.maxConcurrentSubagents ?? ''))} ·
                    ${escapeHtmlLocal(t('total subagent runs'))}: ${escapeHtmlLocal(String(director.maxTotalSubagentRuns ?? ''))}
                </span>
            </div>
        </div>
    `;

    return `
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Pipeline'))}</div>
            ${mainBlock}
        </div>
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Sub-agents'))}</div>
            ${subRows || `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No sub-agents'))}</div>`}
        </div>
        <div class="luker-iter-workspace-preview-section">
            ${limitsBlock}
        </div>
    `;
}

export {
    renderOrchPreviewPane as _testOnly_renderOrchPreviewPane,
    applyEmptyPathSet as _testOnly_applyEmptyPathSet,
};

function makeSessionId() {
    return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createNewSession(mode) {
    const now = Date.now();
    return {
        id: makeSessionId(),
        title: '',
        messages: [],
        // Per-session surface preferences.
        surfaceState: {
            historyOpen: false,
            autoApply: false,
        },
        // Top-level mirror of pendingEdits so a popup close mid-turn (before
        // Apply) reloads with the same pending batch. The runtime state
        // (state.pendingEdits) is the live source; persistSession writes a
        // structured-clone of it onto state.session.pendingEdits before save.
        pendingEdits: [],
        mode,
        updatedAt: now,
        createdAt: now,
        summary: '',
        // Skip-persist marker for empty draft sessions. persistSession's
        // guard reads this and short-circuits when the session has no
        // messages + no pending edits — without it, mount-time popup
        // open + close (without sending anything) would write a phantom
        // row to the history list. Cleared in persistSession the first
        // time the session has meaningful content. startNewSession also
        // re-asserts this explicitly for parity, but doing it inside the
        // constructor is what makes the MOUNT-time session also benefit.
        _transient: true,
    };
}

/**
 * Build the popup root HTML. Built once on open; per-render mutations scope
 * to subordinate `[data-orch-it-*]` slots so we never re-mount the
 * textarea (which would lose focus + the in-progress draft).
 */
function buildPopupHtml({
    popupId,
    title,
    historyOpen,
    historyLabel,
    newSessionLabel,
    clearAllLabel,
    autoApply,
    sendLabel,
    composerPlaceholder,
    autoApplyLabel,
    chatTabLabel,
    previewTabLabel,
    chatBadgeAriaLabel,
    resizerAriaLabel,
}) {
    return `
<div id="${popupId}" class="orch_it_popup luker-iter-workspace" data-iter-layout="split" data-iter-active-tab="chat">
    <div class="orch_it_title">${escapeHtmlLocal(title)}</div>
    <details class="orch_it_history" data-orch-it-history${historyOpen ? ' open' : ''}>
        <summary>${escapeHtmlLocal(historyLabel)}</summary>
        <div class="orch_it_history_items" data-orch-it-history-items></div>
        <div class="orch_it_history_actions">
            <button class="menu_button menu_button_small" data-orch-it-action="new-session">${escapeHtmlLocal(newSessionLabel)}</button>
            <button class="menu_button menu_button_small" data-orch-it-action="clear-history">${escapeHtmlLocal(clearAllLabel)}</button>
        </div>
    </details>

    <div class="luker-iter-workspace-tabs" role="tablist">
        <button type="button" class="luker-iter-workspace-tab active" role="tab" aria-selected="true" data-iter-action="switch-tab" data-iter-tab="chat">
            <span class="luker-iter-workspace-tab-label">${escapeHtmlLocal(chatTabLabel)}</span>
            <span class="luker-iter-workspace-tab-badge" data-iter-chat-badge hidden aria-label="${escapeHtmlLocal(chatBadgeAriaLabel)}"></span>
        </button>
        <button type="button" class="luker-iter-workspace-tab" role="tab" aria-selected="false" data-iter-action="switch-tab" data-iter-tab="preview">
            <span class="luker-iter-workspace-tab-label">${escapeHtmlLocal(previewTabLabel)}</span>
        </button>
    </div>

    <div class="luker-iter-workspace-grid">
        <div class="luker-iter-workspace-chat" data-iter-pane="chat">
            <div class="orch_it_messages" data-orch-it-messages></div>
            <div class="orch_it_composer">
                <textarea class="text_pole" rows="2" data-orch-it-input data-iter-input placeholder="${escapeHtmlLocal(composerPlaceholder)}"></textarea>
                <div class="orch_it_composer_actions">
                    <label class="orch_it_composer_auto_apply">
                        <input type="checkbox" data-orch-it-action="toggle-auto-apply"${autoApply ? ' checked' : ''}>
                        <span>${escapeHtmlLocal(autoApplyLabel)}</span>
                    </label>
                    <div class="orch_it_composer_buttons">
                        <button class="menu_button" data-orch-it-action="send">${escapeHtmlLocal(sendLabel)}</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="luker-iter-workspace-resizer" data-iter-resizer aria-label="${escapeHtmlLocal(resizerAriaLabel)}"></div>
        <div class="luker-iter-workspace-preview" data-iter-pane="preview" data-iter-preview-pane></div>
    </div>
</div>`;
}

/**
 * Open the orchestrator AI iteration popup.
 *
 * Resolves when the user dismisses the dialog. Sessions are persisted eagerly
 * on every mutation so dismiss-without-save is irrelevant.
 *
 * @param {object} deps See module header for shape.
 */
export async function openOrchestratorIterationStudio(deps) {
    if (!deps || typeof deps !== 'object') {
        throw new TypeError('openOrchestratorIterationStudio: deps is required');
    }
    const {
        mode,
        context,
        settings,
        root,
        i18n,
        i18nFormat,
        getIterationDefaultScope,
        getCharacterDisplayNameByAvatar,
        hasCharacterOverrideForCurrentMode,
        syncCharacterEditorWithActiveAvatar,
        sanitizeLoopProfile,
        sanitizeAgendaWorkingProfile,
        sanitizeDirectorProfile,
        buildAiIterationToolSet,
        buildAiIterationSystemPrompt,
        buildAiIterationUserPrompt,
        buildAiIterationAutoContinuePrompt,
        executeAiIterationToolCalls,
        resolveOrchestrationRuntimeWorldInfo,
        applyAiIterationSessionToGlobal,
        applyAiIterationSessionToCharacter,
        ORCH_EXECUTION_MODES,
    } = deps;

    if (!mode) throw new TypeError('openOrchestratorIterationStudio: deps.mode is required');
    if (!ORCH_EXECUTION_MODES) throw new TypeError('openOrchestratorIterationStudio: deps.ORCH_EXECUTION_MODES is required');

    const t = typeof i18n === 'function' ? i18n : (s) => String(s ?? '');
    const tf = typeof i18nFormat === 'function' ? i18nFormat : ((s) => String(s ?? ''));

    const isLoop = mode === ORCH_EXECUTION_MODES.LOOP;
    const isAgenda = mode === ORCH_EXECUTION_MODES.AGENDA;
    const isDirector = mode === ORCH_EXECUTION_MODES.DIRECTOR;

    // Inject the popup stylesheet on first open. Idempotent.
    ensureStylesheetInjected();
    // Inject the shared iteration-library UI stylesheet (luker_lib_*
    // selectors that style the message / diff / apply / toolcall HTML
    // emitted by the components below). Idempotent.
    ITER_UI.ensureUiStylesheetInjected();

    // Read effective live profile by mode, respecting the iteration scope
    // (character override falls through to global). Routed through
    // preset-library's `getActivePreset` so we read the active preset of
    // the current (mode, scope) tuple — the underlying source-of-truth
    // since the preset-library migration. The result is re-sanitized via
    // `sanitizeForMode` to strip preset-library bookkeeping fields (e.g.
    // `name`) so state.live matches the shape downstream iter-studio code
    // expects.
    function loadLiveProfile() {
        try { syncCharacterEditorWithActiveAvatar?.(context); } catch { /* ignore */ }
        const baseScope = getIterationDefaultScope(context);
        const isCharScope = baseScope === 'character';
        const avatar = getCurrentAvatar(context);
        // `getActivePreset` returns `{ok:true, state}` envelope; `state` is
        // null when the (mode, scope) tuple has no active preset configured
        // (success, just nothing to read).
        const activeResult = isCharScope
            ? getActivePreset(settings, mode, { scope: 'character', context, avatar })
            : getActivePreset(settings, mode, { scope: 'global' });
        const active = activeResult.ok && activeResult.state ? activeResult.state : null;
        if (active) return sanitizeForMode(active);
        // Fall back to global active when the character scope returned
        // nothing (e.g. no avatar resolved yet). Keeps the popup usable
        // instead of opening on an empty profile. Surface this fallback
        // once via toastr so the user is not left guessing why iter-studio
        // is showing the global profile in a character-scoped session.
        const fallbackResult = getActivePreset(settings, mode, { scope: 'global' });
        const fallback = fallbackResult.ok && fallbackResult.state ? fallbackResult.state : null;
        if (isCharScope && typeof toastr !== 'undefined') {
            try {
                toastr.info(
                    `No character-scope ${mode} preset for this card — iter-studio opened on the global profile.`,
                    'iter-studio',
                    { timeOut: 4000 },
                );
            } catch { /* ignore */ }
        }
        return sanitizeForMode(fallback || {});
    }

    function sanitizeForMode(profile) {
        if (isLoop) return sanitizeLoopProfile(profile);
        if (isAgenda) return sanitizeAgendaWorkingProfile(profile);
        if (isDirector) return sanitizeDirectorProfile(profile);
        return profile;
    }

    // sessionScope: char_<avatar> when iteration scope is character AND an
    // avatar is selected; 'global' otherwise. Re-computed lazily inside the
    // session-store closure so switching characters mid-popup re-routes the
    // bucket without restarting.
    function computeSessionScope() {
        const baseScope = getIterationDefaultScope(context);
        if (baseScope !== 'character') return 'global';
        const avatar = String(context?.characters?.[context?.characterId]?.avatar || '').trim();
        return avatar ? `character_${avatar}` : 'global';
    }

    // ──────────────────────────────────────────────────────────────────
    // Session store — per-mode, per-scope bucket under
    // extension_settings.orchestrator.iterStudioV2[mode][scope].
    // ──────────────────────────────────────────────────────────────────
    const sessionStore = createOrchestratorIterationSessionStore({
        mode,
        getOrchestratorSettingsRoot: () => settings || {},
        persistSettings: () => {
            try {
                if (typeof globalThis !== 'undefined' && typeof globalThis.saveSettingsDebounced === 'function') {
                    globalThis.saveSettingsDebounced();
                }
            } catch { /* ignore */ }
        },
        // Non-debounced sibling used by the popup-close teardown flush.
        // Without this the host's settings debounce can sit in its timer
        // window when the user closes the popup and refreshes the page —
        // dropping the last in-popup turn (the iter-studio simulate
        // assistant bubble was the canonical repro).
        persistSettingsImmediate: async () => {
            try {
                const ctx = (typeof globalThis !== 'undefined' && typeof globalThis.SillyTavern?.getContext === 'function')
                    ? globalThis.SillyTavern.getContext()
                    : null;
                if (ctx && typeof ctx.saveSettings === 'function') {
                    await ctx.saveSettings();
                    return;
                }
                if (typeof globalThis !== 'undefined' && typeof globalThis.saveSettingsDebounced === 'function') {
                    globalThis.saveSettingsDebounced();
                }
            } catch { /* ignore */ }
        },
        computeScope: () => computeSessionScope(),
        ctx: __ctx,
    });
    await sessionStore.clearObsolete();

    try {
        await migrateOrchSessionsV2ToSidecar({
            settingsRoot: settings,
            ctx: __ctx,
            persistSettings: () => {
                try {
                    if (typeof globalThis !== 'undefined' && typeof globalThis.saveSettingsDebounced === 'function') {
                        globalThis.saveSettingsDebounced();
                    }
                } catch { /* ignore */ }
            },
        });
    } catch (err) {
        // Migration is best-effort — never block popup mount on a migration failure.
        // eslint-disable-next-line no-console
        console.warn('[orchestrator iter-studio] V2-to-sidecar migration threw, continuing with current bucket layout', err);
    }

    // Prime markdown deps so the first paint has formatted messages
    // rather than escaped fallback (`ensureMarkdownDeps` caches).
    await ITER_RENDER.ensureMarkdownDeps();

    // ──────────────────────────────────────────────────────────────────
    // Closure-local state. `live` is the working profile cloned from the
    // active editor. Pending writes (profile sandbox-diff, lorebook,
    // skill) are owned by the ProposalBus mounted below — no per-bucket
    // arrays on state any more.
    // ──────────────────────────────────────────────────────────────────
    const state = {
        mode,
        session: createNewSession(mode),
        live: null,
        isBusy: false,
        aborting: false,
        abortController: null,
    };

    function loadLive() {
        state.live = loadLiveProfile();
    }

    // ──────────────────────────────────────────────────────────────────
    // ProposalBus mount. Three kinds:
    //   - 'profile-edit'    — sandbox-diff working-profile replacement,
    //                         committed via commitLiveToActiveEditor
    //   - 'lorebook-write'  — lorebook update / str_replace proposals,
    //                         committed via applyCharacterEditorLorebook
    //                         Proposal (re-derives current state)
    //   - 'skill-author'    — skill authoring writes, committed via the
    //                         shared commitApprovedSkillProposal helper
    //                         (also re-derives current disk state)
    //
    // Bus owns persistence (state.session.proposalBus), drift detection
    // (per-kind fingerprint), click delegation, and auto-approve.
    // ──────────────────────────────────────────────────────────────────
    const bus = ITER_PROPOSAL_BUS.createProposalBus({
        mode: `orch-${mode}`,
        i18n: tf,
        onChange: () => {
            if (state.__suspendBusOnChange) return;
            scheduleBusRender();
        },
    });

    // Coalesce a burst of bus mutations into ONE render per animation
    // frame. Each propose / approve / reject / rollback fires onChange;
    // without coalescing, a single LLM auto-continue round fans out N
    // mutations -> N full popup re-renders (see trace
    // Trace-20260617T154806: 1,079 renders in 106s of one chat send).
    // The scheduler also defers a mid-render schedule() to the next
    // frame so mutations that arrive while persistSession/render are
    // awaiting still surface, instead of being silently dropped.
    const busRenderScheduler = createRenderScheduler({
        handler: async () => {
            try { await persistSession(); } catch { /* surface elsewhere */ }
            try { await render(); } catch { /* surface elsewhere */ }
            await drainBusOutcomes();
        },
        onError: (err) => {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}:${mode}] scheduleBusRender handler error`, err);
        },
    });
    function scheduleBusRender() {
        busRenderScheduler.schedule();
    }

    // Target handlers route disk reads + writes through the bus. Each
    // popup mount owns one profile mode (spec/loop/agenda/director); the
    // lorebook target dispatches per-book via target.name (and an optional
    // target._op for orch's per-entry proposal flow); skill-registry's
    // write delegates to commitApprovedSkillProposal via target._op.
    registerTarget('profile', {
        read: async () => {
            await loadLive();
            return structuredClone(state.live);
        },
        write: async (_target, next) => {
            state.live = structuredClone(next);
            const scope = getIterationDefaultScope(context);
            if (scope === 'character') await commitLiveToCharacter();
            else await commitLiveToGlobal();
        },
        describe: () => `profile:${mode}`,
    });
    // Namespaced lorebook target. CEA registers `'lorebook'` for its
    // own per-edit/whole-state writes; orch's lorebook flow always
    // commits via the CEA helper-api proposal envelope (`target._op`),
    // so we use a distinct type to avoid the target-registry singleton
    // collision (last-register wins) when both popups boot in the
    // same session.
    registerTarget('orch-lorebook', {
        read: async (target) => {
            const book = await context.loadWorldInfo(target?.name || '');
            return structuredClone(book || {});
        },
        write: async (target, next) => {
            if (target?._op) {
                // Orchestrator's per-entry proposal path: re-derive the
                // commit against current state via the CEA helper-api so
                // concurrent drift surfaces as a fresh validation error.
                return getCea().applyCharacterEditorLorebookProposal(context, target._op);
            }
            await context.saveWorldInfo(target?.name || '', next, true, { refreshEditor: true });
        },
        describe: (target) => `lorebook:${target?.name || ''}`,
    });
    registerTarget('skill-registry', {
        read: async (target) => {
            return { skill: target?.name || '', path: target?.path || '' };
        },
        write: async (target, _next) => {
            if (target?._op) {
                await commitApprovedSkillProposal(target._op);
            }
        },
        describe: (target) => String(target?.name || 'skill'),
    });
    // Orchestrator custom-tool authoring target. On commit, applies the
    // captured op against the LIVE working profile via the shared
    // committer (which re-reads current state so concurrent drift surfaces
    // as a fresh error rather than a stale clobber), flips the mode-
    // appropriate enable flag, and re-sanitizes customTools[]. After
    // commit the popup's normal Apply pipeline persists the mutated
    // profile to global / character scope on user-clicked Apply.
    registerTarget('orch-custom-tool', {
        read: async (target) => {
            const tools = Array.isArray(state.live?.customTools) ? state.live.customTools : [];
            return { name: target?.name || '', tool: tools.find(t => String(t?.name || '') === String(target?.name || '')) || null };
        },
        write: async (target, _next) => {
            if (!target?._op) return;
            const profile = state.live;
            const flagBucket = getCustomToolFlagBucket(profile, mode);
            commitApprovedCustomToolProposal(profile, flagBucket, target._op);
            resanitizeProfileCustomTools(profile);
            const scope = getIterationDefaultScope(context);
            if (scope === 'character') await commitLiveToCharacter();
            else await commitLiveToGlobal();
        },
        describe: (target) => `custom-tool:${target?.name || ''}`,
    });

    bus.registerKind('profile-edit', {
        ...profileEdit,
        renderDiffCard: (entry, _helpers) => {
            const before = entry?.meta?.before ?? null;
            const after = entry?.meta?.after ?? null;
            const edit = { op: 'set', path: '', oldValue: before, newValue: after };
            return ITER_UI.diff.renderDiffCard([edit], { i18n: tf, live: state.live });
        },
        label: () => t('Profile change'),
        icon: () => '✏',
        target: () => String(TITLES_BY_MODE[mode] || mode),
    });
    bus.registerKind('lorebook-write', {
        ...lorebookWrite,
        // Override the descriptor's default `'lorebook'` so the bus
        // accepts orch's namespaced target type. CEA still owns
        // `'lorebook'`; orch's flow uses `'orch-lorebook'` to avoid
        // the target-registry singleton collision.
        targetType: 'orch-lorebook',
        renderDiffCard: (entry, helpers) => {
            const adapted = { ...entry, op: entry?.meta?.op || null };
            return renderLorebookBody(adapted, helpers);
        },
        label: (entry) => {
            const adapted = { ...entry, op: entry?.meta?.op || null };
            return lorebookBodyLabel(adapted, { i18n: tf });
        },
        icon: (entry) => {
            const adapted = { ...entry, op: entry?.meta?.op || null };
            return lorebookBodyIcon(adapted);
        },
        target: (entry) => {
            const adapted = { ...entry, op: entry?.meta?.op || null };
            return lorebookBodyTarget(adapted);
        },
    });
    bus.registerKind('skill-author', {
        ...skillAuthor,
        renderDiffCard: (entry, helpers) => {
            const adapted = { ...entry, op: entry?.meta?.op || null };
            return renderSkillBody(adapted, helpers);
        },
        label: (entry) => {
            const adapted = { ...entry, op: entry?.meta?.op || null };
            return skillBodyLabel(adapted, { i18n: tf });
        },
        icon: (entry) => {
            const adapted = { ...entry, op: entry?.meta?.op || null };
            return skillBodyIcon(adapted);
        },
        target: (entry) => {
            const adapted = { ...entry, op: entry?.meta?.op || null };
            return skillBodyTarget(adapted, { i18n: tf });
        },
    });
    bus.registerKind('custom-tool-author', {
        ...customToolAuthor,
        renderDiffCard: (entry, _helpers) => {
            const adapted = { ...entry, op: entry?.meta?.op || null };
            return renderCustomToolBody(adapted, { i18n: tf });
        },
        label: (entry) => {
            const adapted = { ...entry, op: entry?.meta?.op || null };
            return customToolBodyLabel(adapted, { i18n: tf });
        },
        icon: (entry) => {
            const adapted = { ...entry, op: entry?.meta?.op || null };
            return customToolBodyIcon(adapted);
        },
        target: (entry) => {
            const adapted = { ...entry, op: entry?.meta?.op || null };
            return customToolBodyTarget(adapted);
        },
    });
    bus.setMessageResolver((messageId) => {
        const msgs = state.session?.messages || [];
        const m = msgs.find((x) => String(x?.id || '') === String(messageId));
        return m || { id: messageId, toolCalls: [] };
    });

    // Bus drain pump — re-fires the iteration loop after the user resolves
    // any batch of proposals. Replaces the legacy continueAfterReviewDecision.
    let drainScheduled = false;
    const __pendingDrainStash = [];
    async function drainBusOutcomes() {
        if (drainScheduled) return;
        const outcomes = bus.drainOutcomes();
        if (!outcomes.length) return;
        if (state.isBusy) {
            __pendingDrainStash.push(...outcomes);
            return;
        }
        const allOutcomes = __pendingDrainStash.length
            ? [...__pendingDrainStash.splice(0), ...outcomes]
            : outcomes;
        // Pure formatter — pins agent-facing wording (reason-grouped
        // section headers + hint-over-error preference) under unit
        // test at tests/orch-iteration/drain-outcomes-message.test.js.
        // Returns null when every outcome was filtered out so we keep
        // the original "nothing worth surfacing" early-return shape.
        const message = buildDrainOutcomesMessage(allOutcomes, { tf });
        if (message == null) return;
        drainScheduled = true;
        try {
            state.session.messages.push({
                id: makeMessageId(),
                role: 'user',
                content: message,
                at: Date.now(),
                auto: true,
            });
            state.isBusy = true;
            state.abortController = new AbortController();
            await persistSession();
            await render();
            try {
                let turn = await runIterationTurn();
                while (turn?.hadAnyToolCall && !bus.hasOutstanding()) {
                    await persistSession();
                    await render();
                    if (state.abortController?.signal?.aborted) break;
                    turn = await runIterationTurn({ autoContinueFromResult: turn.executionResult });
                }
            } catch (err) {
                if (!isAbortError(err, state.abortController?.signal)) {
                    // eslint-disable-next-line no-console
                    console.warn(`[${MODULE}:${mode}] drainBusOutcomes`, err);
                    state.session.messages.push({
                        id: makeMessageId(),
                        role: 'system',
                        content: tf('Error: ${0}', mdLiteral(err?.message || err)),
                        at: Date.now(),
                    });
                }
            } finally {
                state.isBusy = false;
                state.aborting = false;
                state.abortController = null;
                await persistSession();
                await render();
            }
        } finally {
            drainScheduled = false;
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Build a "session-shaped" object the orchestrator's mode-aware
    // helpers expect. The per-mode helpers detect mode via the
    // workingProfile shape + an explicit `mode` field. We carry the
    // popup's session metadata + the current live profile through.
    // ──────────────────────────────────────────────────────────────────
    function buildHelperSession(workingProfile) {
        const scope = typeof getIterationDefaultScope === 'function'
            ? getIterationDefaultScope(context)
            : 'global';
        const avatar = String(context?.characters?.[context?.characterId]?.avatar || '');
        const hasOverride = scope === 'character' && typeof hasCharacterOverrideForCurrentMode === 'function'
            ? Boolean(hasCharacterOverrideForCurrentMode(context, avatar, mode))
            : false;
        const characterDisplayName = scope === 'character' && typeof getCharacterDisplayNameByAvatar === 'function'
            ? String(getCharacterDisplayNameByAvatar(context, avatar) || '')
            : '';
        return {
            id: state.session.id,
            title: state.session.title,
            messages: state.session.messages,
            workingProfile: workingProfile != null ? workingProfile : state.live,
            mode,
            scope,
            hasOverride,
            characterDisplayName,
        };
    }

    // ──────────────────────────────────────────────────────────────────
    // Per-mode blank profile for the reset-to-blank control tool. Used
    // ONLY when scope is character + no override exists yet AND the AI
    // decides the user wants to author from scratch rather than adjust
    // the seeded global copy.
    // ──────────────────────────────────────────────────────────────────
    function createBlankProfileForMode() {
        if (mode === ORCH_EXECUTION_MODES.DIRECTOR) {
            return sanitizeDirectorProfile({});
        }
        if (mode === ORCH_EXECUTION_MODES.LOOP) {
            return sanitizeLoopProfile({});
        }
        if (mode === ORCH_EXECUTION_MODES.AGENDA) {
            return sanitizeAgendaWorkingProfile({});
        }
        return { spec: { stages: [], defaultTools: null }, presets: {} };
    }

    // ──────────────────────────────────────────────────────────────────
    // Per-mode global profile clone for the reset-to-global control tool.
    // Used ONLY when scope is character + a character override already
    // exists AND the AI decides the user wants to wipe that override and
    // restart from the current global setup. Mirrors `loadLiveProfile`
    // but forces `scope = 'global'` so the global active preset is read
    // regardless of the active iteration scope. Routed through
    // preset-library's `getActivePreset` (matches the post-migration
    // source-of-truth, same as loadLiveProfile).
    // ──────────────────────────────────────────────────────────────────
    function loadGlobalProfileForMode() {
        try { syncCharacterEditorWithActiveAvatar?.(context); } catch { /* ignore */ }
        const activeResult = getActivePreset(settings, mode, { scope: 'global' });
        const active = activeResult.ok && activeResult.state ? activeResult.state : null;
        return sanitizeForMode(active || {});
    }

    function buildLorebookFormatAuditHint(display) {
        return [
            '# Lorebook format audit',
            `Because this orchestration is character-scoped, also reconcile "${display}"'s bound lorebook with the output contract your orchestration imposes. Some cards ship entries that hard-constrain output (forcing a specific format, banning markdown, demanding plain prose, locking turn structure, requiring fixed section headers, etc.) — when those constraints contradict the format your nodes will produce, the model receives conflicting instructions at runtime and the output degrades.`,
            '',
            'Workflow:',
            '1. Call `world_book_list` to see which books the card binds. For each book, run both `lorebook_list` (compact uid+name+enabled index — useful for spotting format-related entries by name, and for noticing entries the keyword search would miss) and `lorebook_query` (keyword search over content). Useful query keywords (mix English and Chinese to match either authoring style): format, output, markdown, plain text, json, structure, 必须, 请直接, 不要, 仅, 只, 严格, 简短, 详细, 输出格式, 用…格式.',
            '2. For each candidate hit, call `lorebook_get` to read the full content and judge whether the constraint actually conflicts with what your orchestration produces. If it does not conflict, leave it alone — do not edit entries that already align with the new design.',
            '3. Classify each conflicting clause before deciding the repair. Two kinds of "format constraint" appear in lorebook entries and they need opposite treatment:',
            '   - **Process coercion** — directives that pin HOW the agent thinks or what shape its reasoning must take *during* the run, BEFORE it commits a final reply. Examples: "always use <thinking> tags before answering", "every response must begin with a CoT prefix", "follow steps 1-N in order before responding", "always run a 5W1H check first". These poison the agent loop — the orchestration runs multiple tool-call rounds, and a directive that fires every round forces narrative-shaped text where the agent needs tool calls, starving the planning channel. Strip the format. Then harvest the underlying intent (the topics, angles, persona habits, scene anchors the author cared about) and rewrite it as worldbuilding / persona / scene-anchor content the agent reads as *narrative input* — not as a new rule. Example: "她必须先用 <thinking> 标签分析对方意图再开口" → "她说话前总要先把对方话里的意图过一遍，捕捉其中的弦外之音 — 这是少女时期辩论队留下的习惯." Strip-without-rewrite is acceptable only when there is genuinely no salvageable intent (pure shape coercion such as "your reply must faithfully correspond to your thinking").',
            '   - **Final-output shape** — directives that describe the FORM of the final committed reply, not how the agent thinks on the way there. Examples: "all output must be markdown", "wrap the response in <content>", "always end with a closing summary block", "use bullet points throughout", "她说话用诗的格式". These are legitimate stylistic preferences and should be KEPT — but rewritten so the finalize semantics are explicit, so intermediate orchestration nodes (planner, tool-callers, reviewers) are not dragged into the same shape. The orchestration\'s last node is the one that commits the user-facing reply; that is where the form belongs. Example: "她说话用诗的格式" → "她最终回答用户时偏好以诗的形式表达，押上几个韵脚" (conditioned on the final commit, with persona-flavor wording so it reads as a habit rather than a hard rule). Or, when the constraint is purely cosmetic, scope it explicitly: "all output must be markdown" → "the orchestration\'s final reply to the user is formatted as markdown" so it does not constrain intermediate nodes.',
            '   When unsure whether a clause is process coercion or final-output shape, err toward preserving and ask the user. The decision test: does this require the agent to think or output in a specific shape BEFORE making its decision or calling a tool? Yes → process coercion. No (only describes the final reply\'s form) → final-output shape.',
            '4. Pick the repair tool by scope. Surgical clause-level edits (rewriting just the offending sentence while preserving the rest of the entry — worldbuilding facts, persona traits, scene anchors) use `lorebook_str_replace_in_entry`. Whole-entry disable via `lorebook_update_entry` with `{ "disable": true }` is reserved for entries that are pure format coercion with no salvageable content (e.g. an entry whose entire body is "all output must be in markdown"). Disabling a content-rich entry to mute one sentence loses information. Never delete entries.',
            '5. Approval flow — important: both write tools are PROPOSAL-mode, not direct writes. Each call you make captures a {before, after} envelope, returns it to you, and pushes a diff card into the popup for the user to review. The user approves or rejects per card; only approved cards commit to the on-disk world book when the user clicks Apply. The iter-studio PAUSES the auto-continue loop the moment any write proposal (profile edit, lorebook, skill) is staged — the next round will not fire until the user has fully resolved every pending card. You will then receive a synthetic user message describing which proposals committed, which were rejected, and which surfaced commit errors. Plan further work in your reasoning but do NOT stack additional unrelated write proposals in this same round expecting them to commit alongside this one — review is per-card, and the next round only fires after the full batch is settled. If the user rejects a proposal, the lorebook stayed unchanged — adjust strategy accordingly.',
            '6. Skip this audit entirely if the user explicitly said not to touch the lorebook, or if the orchestration imposes no specific output format.',
        ].join('\n');
    }

    // Global-scope counterpart of buildLorebookFormatAuditHint. The global
    // orchestration profile is loaded for every chat (no character override
    // present), so any world book the user has globally selected — or that
    // gets pulled in as chat-bound when authoring against a sample chat —
    // can ship the same kinds of process-coercion / final-output-shape
    // directives that derail orchestration. Same diagnosis + repair logic
    // as the character version; only the targeting language changes ("the
    // currently-active world books" instead of "this card's bound lorebook").
    function buildGlobalLorebookFormatAuditHint() {
        return [
            '# Lorebook format audit (global scope)',
            'World books selected globally (and any chat-bound book in the active chat) are loaded for every conversation that uses this global orchestration profile. If they contain entries that hard-constrain output (forcing a specific format, banning markdown, demanding plain prose, locking turn structure, requiring fixed section headers, etc.) the model will receive conflicting instructions at runtime and the output degrades. Reconcile those entries against the output contract your orchestration imposes.',
            '',
            'Workflow:',
            '1. Call `world_book_list` to see which books are visible right now — globally-selected entries are returned tagged `global`, plus any chat-bound books tagged `chat` (and a primary `character` / `character_aux` book if a card happens to be loaded, even though this is the global profile). For each book, run both `lorebook_list` (compact uid+name+enabled index — useful for spotting format-related entries by name, and for noticing entries the keyword search would miss) and `lorebook_query` (keyword search over content). Useful query keywords (mix English and Chinese to match either authoring style): format, output, markdown, plain text, json, structure, 必须, 请直接, 不要, 仅, 只, 严格, 简短, 详细, 输出格式, 用…格式.',
            '2. For each candidate hit, call `lorebook_get` to read the full content and judge whether the constraint actually conflicts with what your orchestration produces. If it does not conflict, leave it alone — do not edit entries that already align with the new design. Be especially conservative editing `global`-scoped books, since they affect every chat the user runs.',
            '3. Classify each conflicting clause before deciding the repair. Two kinds of "format constraint" appear in lorebook entries and they need opposite treatment:',
            '   - **Process coercion** — directives that pin HOW the agent thinks or what shape its reasoning must take *during* the run, BEFORE it commits a final reply. Examples: "always use <thinking> tags before answering", "every response must begin with a CoT prefix", "follow steps 1-N in order before responding", "always run a 5W1H check first". These poison the agent loop — the orchestration runs multiple tool-call rounds, and a directive that fires every round forces narrative-shaped text where the agent needs tool calls, starving the planning channel. Strip the format. Then harvest the underlying intent (the topics, angles, narrative habits the author cared about) and rewrite it as worldbuilding / persona / scene-anchor content the agent reads as *narrative input* — not as a new rule. Strip-without-rewrite is acceptable only when there is genuinely no salvageable intent (pure shape coercion such as "your reply must faithfully correspond to your thinking").',
            '   - **Final-output shape** — directives that describe the FORM of the final committed reply, not how the agent thinks on the way there. Examples: "all output must be markdown", "wrap the response in <content>", "always end with a closing summary block", "use bullet points throughout". These are legitimate stylistic preferences and should be KEPT — but rewritten so the finalize semantics are explicit, so intermediate orchestration nodes (planner, tool-callers, reviewers) are not dragged into the same shape. The orchestration\'s last node is the one that commits the user-facing reply; that is where the form belongs. Example: "all output must be markdown" → "the orchestration\'s final reply to the user is formatted as markdown" so it does not constrain intermediate nodes.',
            '   When unsure whether a clause is process coercion or final-output shape, err toward preserving and ask the user. The decision test: does this require the agent to think or output in a specific shape BEFORE making its decision or calling a tool? Yes → process coercion. No (only describes the final reply\'s form) → final-output shape.',
            '4. Pick the repair tool by scope. Surgical clause-level edits (rewriting just the offending sentence while preserving the rest of the entry) use `lorebook_str_replace_in_entry`. Whole-entry disable via `lorebook_update_entry` with `{ "disable": true }` is reserved for entries that are pure format coercion with no salvageable content. Disabling a content-rich entry to mute one sentence loses information. Never delete entries.',
            '5. Approval flow — important: both write tools are PROPOSAL-mode, not direct writes. Each call you make captures a {before, after} envelope, returns it to you, and pushes a diff card into the popup for the user to review. The user approves or rejects per card; only approved cards commit to the on-disk world book when the user clicks Apply. The iter-studio PAUSES the auto-continue loop the moment any write proposal (profile edit, lorebook, skill) is staged — the next round will not fire until the user has fully resolved every pending card. You will then receive a synthetic user message describing which proposals committed, which were rejected, and which surfaced commit errors. Plan further work in your reasoning but do NOT stack additional unrelated write proposals in this same round expecting them to commit alongside this one — review is per-card, and the next round only fires after the full batch is settled. If the user rejects a proposal, the lorebook stayed unchanged — adjust strategy accordingly.',
            '6. Skip this audit entirely if the user explicitly said not to touch any world book, or if the orchestration imposes no specific output format. Prefer narrow, well-justified edits over sweeping ones — global books are shared across every chat.',
        ].join('\n');
    }

    function buildNoContentDuplicationHint() {
        return [
            '# No content duplication',
            'Information that already lives elsewhere in the runtime is delivered at run time by Luker — never copy it into another prompt.',
            '- **Lorebook entries**: never paste an entry\'s body into an agent\'s systemPrompt. Reference the entry by book name + entry name (its comment or first key) instead. If you need to give the agent an explicit handle, point it at the entry name and instruct it to call `lorebook_get(entry_key=…)` or `lorebook_get(uid=…)` at run time. Never paste the body itself.',
            '- **Sibling / sub-agent prompts**: each agent\'s systemPrompt describes ONLY that agent\'s own responsibilities. Sub-agent task details belong in the sub-agent\'s own systemPrompt; the orchestrator dispatches each agent with its own prompt. Never copy a sibling agent\'s or sub-agent\'s prompt into another agent\'s prompt — that is dead weight that crowds the active agent\'s context and drifts when one prompt is later edited.',
            '- General rule: if you find yourself transcribing a body of text the runtime will provide (lorebook content, another agent\'s prompt, character description, preset content, etc.), STOP — replace the transcription with a one-line pointer naming the source. Verbatim duplication is always a smell.',
        ].join('\n');
    }

    function appendScopeHintIfNeeded(basePrompt, helperSession) {
        const noDup = buildNoContentDuplicationHint();
        if (helperSession?.scope !== 'character') {
            // Global scope: no character-scope hint to append, but the
            // lorebook tools ARE exposed in global scope (globally-selected
            // world books are active for every chat that uses this profile),
            // so the model needs the same audit guidance written against
            // those books rather than against a card's bound lorebook.
            return [basePrompt, '', buildGlobalLorebookFormatAuditHint(), '', noDup].join('\n');
        }
        const display = String(helperSession?.characterDisplayName || '').trim() || 'this character';
        const formatAuditHint = buildLorebookFormatAuditHint(display);
        if (!helperSession.hasOverride) {
            // 2-path hint: card has no override yet, the working profile
            // is a copy of the global setup, the AI picks between
            // "adjust" (default) and "author from scratch" (resetToBlank).
            return [
                basePrompt,
                '',
                '# Iteration scope',
                `You are iterating on the character override for "${display}". This card has NO character override yet.`,
                '',
                'Two paths exist; decide from the user\'s first message which applies:',
                '- Adjust the existing setup: the working profile starts as a copy of the GLOBAL profile. Make targeted edits as you normally would. This is the default path.',
                `- Author from scratch: call \`${CONTROL_TOOL_NAMES.resetToBlank}\` once to discard the global copy and start with a minimal blank shell. If you already called it earlier this session, the working profile is already blank — continue authoring from there without calling reset again.`,
                '',
                'Do not call the reset tool unless the user clearly wants a brand-new orchestration.',
                '',
                formatAuditHint,
                '',
                noDup,
            ].join('\n');
        }
        // 3-path hint: card already has an override, the working profile
        // is a copy of the OVERRIDE, the AI picks between "adjust"
        // (default), "author from scratch" (resetToBlank), or "match
        // global" (resetToGlobal).
        return [
            basePrompt,
            '',
            '# Iteration scope',
            `You are iterating on the character override for "${display}". This card ALREADY has a character override.`,
            '',
            'Three paths exist; default to the first unless the user clearly asks for one of the others:',
            '- Continue adjusting the current override: the working profile starts as a copy of the existing OVERRIDE. Make targeted edits as you normally would. This is the default path.',
            `- Author from scratch: call \`${CONTROL_TOOL_NAMES.resetToBlank}\` once to discard the existing override and start with a minimal blank shell. If you already called it earlier this session, the working profile is already blank — continue authoring from there without calling reset again.`,
            `- Match the global profile: call \`${CONTROL_TOOL_NAMES.resetToGlobal}\` once to discard the existing override and start with a fresh clone of the current global profile. If you already called it earlier this session, the working profile already matches global — continue adjusting from there without calling reset again.`,
            '',
            'Do not call either reset tool unless the user clearly asks for that fresh-start path.',
            '',
            formatAuditHint,
            '',
            noDup,
        ].join('\n');
    }

    // ──────────────────────────────────────────────────────────────────
    // Commit live → orchestrator settings. Apply chooses between these
    // via `getIterationDefaultScope(context)` — there's no separate
    // global vs character button anymore.
    // ──────────────────────────────────────────────────────────────────
    async function commitLiveToGlobal() {
        const fakeSession = buildHelperSession(sanitizeForMode(state.live));
        await applyAiIterationSessionToGlobal(context, settings, fakeSession, root);
    }

    async function commitLiveToCharacter() {
        if (typeof applyAiIterationSessionToCharacter !== 'function') return;
        const sanitized = sanitizeForMode(state.live);
        const fakeSession = buildHelperSession(sanitized);
        await applyAiIterationSessionToCharacter(context, settings, fakeSession, root);
    }

    // ──────────────────────────────────────────────────────────────────
    // Persistence. Session carries the latest surfaceState, messages, and
    // a derived title (first 50 chars of the first user message).
    // ──────────────────────────────────────────────────────────────────
    async function persistSession({ flush = false } = {}) {
        const hasMessages = Array.isArray(state.session.messages) && state.session.messages.length > 0;
        const hasPending = bus.hasOutstanding();
        if (state.session._transient && !hasMessages && !hasPending) {
            return;
        }
        if (state.session._transient) {
            delete state.session._transient;
        }
        state.session.updatedAt = Date.now();
        state.session.mode = mode;
        // Bus owns the staging queue; serialize() returns a v2 blob
        // (entries + outcomeQueue) we round-trip through the session
        // store. Drop legacy per-bucket fields if any sneak in from an
        // older session payload.
        state.session.proposalBus = bus.serialize();
        if (state.session.pendingEdits !== undefined) delete state.session.pendingEdits;
        if (state.session.pendingLorebookEdits !== undefined) delete state.session.pendingLorebookEdits;
        if (state.session.pendingSkillEdits !== undefined) delete state.session.pendingSkillEdits;
        if (!state.session.title) {
            const firstUser = state.session.messages.find(m => m.role === 'user' && !m.auto);
            if (firstUser) {
                state.session.title = String(firstUser.content || '').slice(0, 50);
            }
        }
        if (flush && typeof sessionStore.saveFlush === 'function') {
            await sessionStore.saveFlush(state.session);
        } else {
            await sessionStore.save(state.session);
        }
    }

    async function loadSession(id) {
        const loaded = await sessionStore.load(id);
        if (!loaded) return;
        const fallbackAt = Number(loaded.updatedAt) || Date.now();
        const loadedMessages = Array.isArray(loaded.messages) ? loaded.messages : [];
        state.session = {
            ...loaded,
            mode,
            surfaceState: {
                historyOpen: false,
                autoApply: false,
                ...(loaded.surfaceState || {}),
            },
            messages: loadedMessages.map(m => normalizeMessageShape(m, fallbackAt)),
        };
        // Hydrate the bus. Prefer the new proposalBus blob; otherwise
        // fall back to a one-shot migration of the legacy pendingEdits
        // array (per-profile-edit). Legacy pendingLorebookEdits /
        // pendingSkillEdits were never persisted in the orch popup,
        // matching the pre-migration behavior.
        state.__suspendBusOnChange = true;
        try {
            if (loaded.proposalBus && typeof loaded.proposalBus === 'object') {
                bus.hydrate(loaded.proposalBus);
            } else if (Array.isArray(loaded.pendingEdits) && loaded.pendingEdits.length > 0) {
                for (const edit of loaded.pendingEdits) {
                    if (edit?.op !== 'set' || edit?.path !== '') continue;
                    await bus.propose({
                        kind: 'profile-edit',
                        target: { type: 'profile' },
                        before: edit.oldValue ?? null,
                        after: edit.newValue ?? null,
                        sourceCallId: null,
                        meta: { before: edit.oldValue ?? null, after: edit.newValue ?? null },
                    });
                }
            } else {
                bus.hydrate({ version: 3, entries: [], outcomeQueue: [] });
            }
        } finally {
            state.__suspendBusOnChange = false;
        }
        bus.setAutoApprove(Boolean(state.session.surfaceState?.autoApply));
        delete state.session.pendingEdits;
        delete state.session.pendingLorebookEdits;
        delete state.session.pendingSkillEdits;
        // Re-read live so a parallel editor doesn't leave the popup with
        // stale state when the user reopens an older session.
        loadLive();
        await render();
    }

    async function startNewSession() {
        // Carry the prior session's autoApply preference forward — the user
        // sets this at the popup level (a per-session reset would be
        // surprising). Mirrors the MG-10 carry-forward pattern.
        const priorAutoApply = Boolean(state.session?.surfaceState?.autoApply);
        state.session = createNewSession(mode);
        state.session._transient = true;
        if (priorAutoApply) {
            state.session.surfaceState.autoApply = true;
        }
        state.__suspendBusOnChange = true;
        try {
            bus.hydrate({ version: 3, entries: [], outcomeQueue: [] });
        } finally {
            state.__suspendBusOnChange = false;
        }
        bus.setAutoApprove(Boolean(state.session.surfaceState?.autoApply));
        loadLive();
        // Don't save the blank session yet — persistSession's _transient
        // guard defers the write until the first user message.
        await render();
    }

    async function clearAllHistory() {
        // eslint-disable-next-line no-alert
        if (!confirm(t('Clear all session history?'))) return;
        const metas = await sessionStore.list();
        for (const meta of metas) {
            await sessionStore.delete(meta.id);
        }
        await startNewSession();
    }

    // ──────────────────────────────────────────────────────────────────
    // Pending-edit card. Delegates to `iteration-library/ui/diff` so the
    // visual diff language matches the other three iter-library popups
    // (CPA preset, MG schema, CEA char). The shared component handles
    // the coarse `{op:'set', path:''}` sandbox-diff edit that Orch emits
    // per turn — it splits the whole-object set into one virtual sub-card
    // per changed leaf (up to 20), then falls back to a single full-JSON
    // card for the rare structural rewrite case. Non-`set` ops render as
    // a compact op + path chip. Orchestrator profile shapes are deeply
    // nested objects, not strings, so the diff component's stringifyValue
    // helper JSON-stringifies them before running the inline LCS diff.
    //
    // String ops (str_replace / str_insert / str_delete) forward
    // `state.live` as `opts.live` only on the latest unapplied turn so
    // the renderer can resolve the field's pre-edit value and emit a
    // full-field before/after; older / already-applied turns fall back
    // to the focused find→replace card.
    //
    // Skill-policy edits (skill_bind_to_agent / skill_unbind_from_agent /
    // skill_set_mode_defaults) carry a `skillVisibilityChange` blob on
    // the edit envelope. We prepend an effective-set context strip so
    // the user sees the runtime semantics — e.g. `['+', foo]` is
    // "inherit mode default + foo", not "only foo" — which is otherwise
    // invisible in the raw `visible: ... → ['+', foo]` structural diff.
    // ──────────────────────────────────────────────────────────────────
    function renderPendingEditCard(edit) {
        // Bus's profile-edit card owns the actual LCS diff body — we no
        // longer render the diff here. The legacy `renderEditCard` path
        // still fires per-edit so skill policy-binding tool calls (which
        // attach a `skillVisibilityChange` blob describing the
        // "before / after effective visible skill set" for an agent or
        // mode) can surface that context strip above the bus's combined
        // diff card. Without this strip the user sees a sandbox-diff for
        // a structurally opaque enum (`'+'` = inherit, `'*'` = wildcard)
        // without learning what the change actually means.
        if (!edit?.skillVisibilityChange) return '';
        return renderSkillVisibilityContext(edit.skillVisibilityChange);
    }

    // ──────────────────────────────────────────────────────────────────
    // Skill-visibility context strip. Translates the structured
    // `skillVisibilityChange` blob attached by skills/iter-studio-tools
    // policy-binding handlers into a small "Effective visible skills"
    // header rendered above the raw structural diff card.
    //
    // The raw diff alone is opaque for skill policy edits because the
    // resolver's semantics (`'+'` = inherit mode + append, `'*'` =
    // wildcard, empty agent list = inherit mode) hide the actual impact
    // behind sentinel values. A bind that changes `visible: undefined →
    // ['+', 'foo']` for an agent whose mode default is `['*']` looks like
    // a tiny addition but is actually "agent now sees mode wildcard PLUS
    // foo" — the user benefits from seeing that summarized in words.
    //
    // Layout: a single block with two rows ("before" / "after"), each
    // showing the effective skill name set, with the inherit-from-mode
    // case spelled out as "(inherit mode = …)" rather than the literal
    // `+` chip. Kept intentionally text-y rather than chip-styled to
    // avoid pulling in new CSS — the structural diff card below carries
    // the heavy visual weight.
    // ──────────────────────────────────────────────────────────────────
    function renderSkillVisibilityContext(change) {
        if (!change || typeof change !== 'object') return '';
        const kind = String(change.kind || '');
        const list = String(change.list || 'visible');
        const listLabel = list === 'deny' ? t('deny') : t('visible');

        const formatSet = (modeSide, agentSide) => {
            // Mode-level row: simple expansion (wildcard → "all skills").
            if (kind === 'mode' || !agentSide) {
                const v = Array.isArray(modeSide?.[list]) ? modeSide[list] : [];
                if (v.includes('*')) return t('(all skills)');
                if (v.length === 0) return t('(none)');
                return v.map(escapeHtmlLocal).join(', ');
            }
            // Agent-level row. Three resolver shapes (skill-resolution.js):
            //   - agent field absent (null) OR empty list → inherit mode default
            //   - first element '+' → inherit mode default + remaining names
            //   - otherwise → REPLACE mode default with this exact list
            const modeV = Array.isArray(modeSide?.[list]) ? modeSide[list] : [];
            const agentV = agentSide && Array.isArray(agentSide[list]) ? agentSide[list] : null;
            const modeExpansion = modeV.includes('*') ? t('(all skills)')
                : (modeV.length === 0 ? t('(none)') : modeV.map(escapeHtmlLocal).join(', '));
            if (agentV === null || agentV.length === 0) {
                return tf('inherit mode = ${0}', modeExpansion);
            }
            if (agentV[0] === '+') {
                const extras = agentV.slice(1);
                if (extras.length === 0) return tf('inherit mode = ${0}', modeExpansion);
                return tf('inherit mode (${0}) + ${1}', modeExpansion, extras.map(escapeHtmlLocal).join(', '));
            }
            return tf('only ${0} (overrides mode)', agentV.map(escapeHtmlLocal).join(', '));
        };

        const beforeLabel = formatSet(change.mode?.before, change.agent?.before);
        const afterLabel = formatSet(change.mode?.after, change.agent?.after);
        const headerText = kind === 'agent'
            ? tf('Effective ${0} skills for agent "${1}"', listLabel, String(change.agentId || ''))
            : tf('Effective mode-level ${0} skills', listLabel);
        return `<div class="orch_it_skill_visibility_ctx">
            <div class="orch_it_skill_visibility_ctx_header">${escapeHtmlLocal(headerText)}</div>
            <div class="orch_it_skill_visibility_ctx_row">
                <span class="orch_it_skill_visibility_ctx_when">${escapeHtmlLocal(t('Before'))}:</span>
                <span class="orch_it_skill_visibility_ctx_set">${beforeLabel}</span>
            </div>
            <div class="orch_it_skill_visibility_ctx_row">
                <span class="orch_it_skill_visibility_ctx_when">${escapeHtmlLocal(t('After'))}:</span>
                <span class="orch_it_skill_visibility_ctx_set">${afterLabel}</span>
            </div>
        </div>`;
    }

    // ──────────────────────────────────────────────────────────────────
    // Chat-message rendering. Orchestrator delegates to
    // `iteration-library/ui/message.renderMessageCard` so the
    // four iter-library popups (CPA, MG schema, Orch, CEA char) share
    // one visual language for tool-call chips, per-round edit cards,
    // applied/rolled-back stamps, and the Regenerate / Rollback row.
    //
    // Orch preserves only the outer `<div class="orch_it_msg ...">`
    // wrapper around the shared component, because studio.css's flex-row
    // alignment / accent colors / max-widths key on `.orch_it_msg_user`
    // / `_assistant` / `_system`. The inner `<div class="luker_lib_message ...">`
    // emitted by the shared component carries the rest of the structure
    // (markdown body, read-only-round hint when all calls are read-type,
    // tool chips, edit cards via renderPendingEditCard, applied/rolled-back
    // stamp, Regenerate button). Click delegation accepts msgId from either
    // `data-orch-it-msg-id` (outer) or `data-luker-lib-msg-id` (inner).
    // ──────────────────────────────────────────────────────────────────
    /**
     * Resolve the apply scope label for the current context. Reused by both
     * the pending block button and the per-message "✓ Applied to ..." chip
     * so they stay in sync.
     */
    function getApplyScopeLabel() {
        const scope = getIterationDefaultScope(context);
        if (scope === 'character') {
            const avatar = String(context?.characters?.[context?.characterId]?.avatar || '').trim();
            const display = typeof getCharacterDisplayNameByAvatar === 'function'
                ? (getCharacterDisplayNameByAvatar(context, avatar) || '')
                : '';
            return display || avatar || t('current character');
        }
        return t('global');
    }

    /**
     * Resolve the apply scope label that should be persisted on the
     * applied message. Distinct from the live UI label because the
     * persisted value should survive the user switching characters
     * later — we record `appliedTarget = 'character' | 'global'` so the
     * Rollback button knows what scope to revert. For display, we
     * resolve `appliedTarget` back to a human label at render time.
     */
    function resolveAppliedTargetLabel(appliedTarget) {
        if (appliedTarget === 'character') return t('character');
        if (appliedTarget === 'global') return t('global');
        return String(appliedTarget || '');
    }


    function renderMessageCard(message, idx, allMessages) {
        if (!message) return '';
        const role = String(message.role || 'user');
        const roleCls = role === 'user'
            ? 'orch_it_msg_user'
            : role === 'assistant'
                ? 'orch_it_msg_assistant'
                : 'orch_it_msg_system';
        const autoCls = message.auto ? ' orch_it_msg_auto' : '';

        // Last-assistant predicate: true only when this assistant turn has
        // no later assistant in the visible message list. Trailing user /
        // system / auto-continue turns are skipped so the actual final
        // assistant reply (the one whose prompt is the live tail) hides
        // its Regenerate button — re-sending from the same composer text
        // is semantically equivalent.
        let isLast = false;
        if (role === 'assistant' && !message.auto) {
            isLast = true;
            for (let j = (allMessages?.length || 0) - 1; j > idx; j--) {
                if (allMessages[j]?.role === 'assistant' && !allMessages[j]?.auto) { isLast = false; break; }
            }
        }

        // The shared component renders the applied-target line as
        // "✓ Applied to ${0} at ${1}" when `message.appliedTarget` is
        // truthy. Orch persists `appliedTarget = 'character' | 'global'`,
        // which is the right enum for the rollback flow but not a
        // user-facing string in zh-CN/zh-TW — we resolve it through
        // `resolveAppliedTargetLabel` here so the shared component shows
        // the localized label without leaking the enum.
        const displayMessage = message.appliedTarget
            ? { ...message, appliedTarget: resolveAppliedTargetLabel(message.appliedTarget) }
            : message;

        const innerHtml = ITER_UI.message.renderMessageCard(displayMessage, {
            toolDisplay: ORCH_TOOL_DISPLAY,
            // Renders ONLY the skill-policy visibility context strip when
            // the edit carries one — the bus's profile-edit card below
            // renders the actual LCS diff body. Without this strip the
            // user wouldn't see what a skill_bind_to_agent / unbind /
            // set_mode_defaults call actually changes (the raw structural
            // diff over `'+'` / `'*'` enums is unreadable on its own).
            renderEditCard: renderPendingEditCard,
            renderApplyControls: (m) => {
                // Bus renders per-card chrome (Approve / Reject / Conflict /
                // Rollback) for every proposal tied to this message AND the
                // turn-actions row that batches them. The legacy
                // renderApplyControls / "Apply to <scope>" button has been
                // retired — apply IS approve, fired per-card by the bus's
                // click delegator.
                const cards = bus.renderCardsForMessage(m) || '';
                const turn = bus.renderTurnActions(m) || '';
                if (!cards && !turn) return '';
                return cards + turn;
            },
            isLast,
            i18n: tf,
            renderMarkdown: ITER_RENDER.renderMessageMarkdown,
            actionAttribute: 'data-orch-it-action',
        });

        // The shared component returns '' for auto user messages (the
        // auto-continue synthetic carrier) and for empty assistant
        // turns. Skip the outer flex-row wrapper in that case so the
        // chat doesn't render a padded empty card with accent color.
        if (!innerHtml) return '';

        // Preserve Orch's outer flex-row container so the popup's
        // alignment / accent-color / max-width rules in studio.css still
        // apply.
        return `<div class="orch_it_msg ${roleCls}${autoCls}" data-orch-it-msg-id="${escapeHtmlLocal(message.id || '')}">${innerHtml}</div>`;
    }

    function renderHistoryItem(meta) {
        const id = String(meta?.id || '');
        const title = String(meta?.title || meta?.id || '');
        const active = id === state.session.id ? ' orch_it_history_item_active' : '';
        return `<div class="orch_it_history_item${active}" data-orch-it-action="load-session" data-orch-it-id="${escapeHtmlLocal(id)}">
            <span class="orch_it_history_title">${escapeHtmlLocal(title || t('(untitled)'))}</span>
            <button class="orch_it_history_delete" data-orch-it-action="delete-session" data-orch-it-id="${escapeHtmlLocal(id)}" title="${escapeHtmlLocal(t('Delete this session'))}">×</button>
        </div>`;
    }

    // ──────────────────────────────────────────────────────────────────
    // Full re-render. Cheap enough to call after every state mutation
    // (the static popup shell + textarea stay mounted, so user input
    // and focus aren't disturbed).
    // ──────────────────────────────────────────────────────────────────
    let $root = null;
    async function render() {
        if (!$root) return;

        // History details: sync open state without firing toggle handler.
        const $history = $root.find('[data-orch-it-history]');
        if ($history.length) {
            const wantOpen = Boolean(state.session.surfaceState?.historyOpen);
            if ($history.prop('open') !== wantOpen) {
                $history.prop('open', wantOpen);
            }
        }

        // Auto-apply checkbox: sync to persisted preference. render() is the
        // single source of truth so a session switch (different auto-apply
        // pref) updates the checkbox without separate plumbing.
        const $autoApply = $root.find('[data-orch-it-action="toggle-auto-apply"]');
        if ($autoApply.length) {
            const wantChecked = Boolean(state.session.surfaceState?.autoApply);
            if ($autoApply.prop('checked') !== wantChecked) {
                $autoApply.prop('checked', wantChecked);
            }
        }

        // History list
        const metas = await sessionStore.list();
        const historyHtml = metas.map(renderHistoryItem).join('')
            || `<div class="orch_it_history_empty">${escapeHtmlLocal(t('No saved sessions'))}</div>`;
        $root.find('[data-orch-it-history-items]').html(historyHtml);

        // Messages — pass index + full array so renderMessageCard can decide
        // whether to render Regenerate (only on non-last assistant turns).
        // Pre-compute latest-unapplied id so inline Apply/Reject row only
        // attaches to the most recent unapplied assistant turn.
        // Filter auto-generated continuation prompts ("AUTO CONTINUE…")
        // out of the rendered chat — they stay in state.session.messages
        // for buildTaskMessages to feed the LLM, but the user shouldn't
        // see them as chat noise.
        const allMsgs = (state.session.messages || []).filter(m => !(m?.role === 'user' && m?.auto));
        // Latest-unapplied = the most recent assistant turn that still
        // owns at least one pending or conflict ProposalBus entry. Used
        // to identify the assistant message whose live tail is current
        // so renderDiffCard can resolve str-ops against state.live.
        let latestUnappliedAssistantId = '';
        if (bus.hasOutstanding()) {
            const callIdsToTurn = new Map();
            for (const m of allMsgs) {
                if (m?.role !== 'assistant' || m?.auto) continue;
                if (m.appliedAt || m.rolledBackAt) continue;
                const calls = Array.isArray(m?.toolCalls) ? m.toolCalls : [];
                for (const tc of calls) {
                    const id = String(tc?.id || '');
                    if (id) callIdsToTurn.set(id, String(m.id || ''));
                }
            }
            const busEntries = bus._testOnly_entries();
            for (let i = busEntries.length - 1; i >= 0; i--) {
                const e = busEntries[i];
                if (e.status !== 'pending' && e.status !== 'conflict') continue;
                const owningTurn = callIdsToTurn.get(String(e.sourceCallId || ''));
                if (owningTurn) {
                    latestUnappliedAssistantId = owningTurn;
                    break;
                }
            }
        }
        state.__latestUnappliedAssistantId = latestUnappliedAssistantId;
        const messagesHtml = allMsgs.map((m, i) => renderMessageCard(m, i, allMsgs)).join('');
        const $msgs = $root.find('[data-orch-it-messages]');
        // Loading bubble: append (don't overwrite) so the just-finished
        // user turn stays visible while the LLM call is in flight.
        const loadingHtml = state.isBusy
            ? `<div class="orch_it_msg orch_it_msg_assistant orch_it_msg_loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtmlLocal(t('AI is thinking...'))}</div>`
            : '';
        $msgs.html(messagesHtml + loadingHtml);
        // Auto-scroll so newly-appended messages are visible.
        try {
            const node = $msgs[0];
            if (node && typeof node.scrollTop === 'number') {
                node.scrollTop = node.scrollHeight;
            }
        } catch { /* DOM not attached (test) */ }

        // Pending edits — single Apply button per spec §3.4. The label
        // resolves to the active iteration scope (character name when a card
        // is selected, "global" otherwise). One handler ('apply-batch')
        // decides commit target via getIterationDefaultScope() so the button
        // can't commit to the wrong scope after a parallel character switch.
        // Delegates to the shared `iteration-library/ui/apply` component
        // for the row HTML so the four iter-library popups stay
        // visually synchronized; the component emits
        // `${actionAttribute}="apply-batch"` / `discard-batch` and the
        // handlers below match those values. `pendingMessage` is a
        // Pending edits + Apply / Reject affordances render inline on the
        // assistant message that produced them via renderApplyControls hook
        // in renderMessageCard. The legacy bottom region has been retired.

        // Composer: Send label flips to Stop while busy.
        const $sendBtn = $root.find('[data-orch-it-action="send"]');
        $sendBtn.text(state.isBusy ? t('Stop') : t('Send'));
        const $textarea = $root.find('[data-orch-it-input]');
        // Disable Stop while the abort is in-flight so a second click
        // can't queue up before the catch+finally clears state.
        $sendBtn.prop('disabled', Boolean(state.aborting));
        $textarea.prop('disabled', false);

        // Live target preview pane (right column on desktop, Preview tab on
        // mobile). Pure render against state.live + pendingEdits — the
        // renderer wraps each per-mode sub-renderer in try/catch so a
        // malformed pending edit shape can't blank the workspace.
        try {
            const $previewPane = $root.find('[data-iter-preview-pane]');
            if ($previewPane.length) {
                const pendingEditsForPreview = [];
                for (const entry of bus._testOnly_entries()) {
                    if (entry.status !== 'pending' && entry.status !== 'conflict') continue;
                    if (entry.kind !== 'profile-edit') continue;
                    const before = entry?.meta?.before ?? null;
                    const after = entry?.meta?.after;
                    if (typeof after === 'undefined') continue;
                    pendingEditsForPreview.push({ op: 'set', path: '', oldValue: before, newValue: after });
                }
                const previewHtml = renderOrchPreviewPane(
                    state.live,
                    pendingEditsForPreview,
                    state.session.mode || mode,
                    t,
                );
                $previewPane.html(previewHtml);
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}:${mode}] preview render failed`, err);
            $root.find('[data-iter-preview-pane]').html(
                `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('Preview unavailable'))}</div>`,
            );
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Runner integration. The runner returns tool calls in the shape
    // `{ name, args, raw }`. Our inline sandbox-diff normalizer takes
    // them in that shape directly (orchestrator's executor expects the
    // same), so no OpenAI-shape wrapping is needed here.
    // ──────────────────────────────────────────────────────────────────

    /**
     * Sandbox-diff normalize — ported from iteration-adapter.js L244-L298.
     *
     * Clones the live profile, runs the mode-aware orchestrator executor
     * against the sandbox, emits ONE bulk `set('', newProfile)` edit if
     * anything changed. Returns `[]` for no-op tool calls, `null` if the
     * executor throws (caller skips silently and lets the AI retry).
     *
     * `beforeOverride` lets the caller thread the previous tool call's
     * sandbox in as this call's baseline. Without it, every tool call in
     * a multi-call round would snapshot the SAME unchanged `state.live`
     * and emit `{set '', oldValue: original, newValue: original+one_mutation}`
     * — N independent root-replace edits that clobber each other on
     * apply (last-write-wins, and lodash.set('') turns the >1 case into
     * a no-op so NONE survive). Threading the chain makes edit N's
     * oldValue = edit N-1's newValue, so the cumulative state lives in
     * the last edit's newValue and the apply loop reproduces it.
     */
    async function normalizeToolCallToEditInline(call, beforeOverride = null) {
        const before = beforeOverride ?? state.live;
        if (before === undefined || before === null) {
            return { kind: 'noop' };
        }
        const sandbox = structuredClone(before);
        const fakeSession = buildHelperSession(sandbox);
        let executorResult = null;
        try {
            executorResult = await executeAiIterationToolCalls(null, fakeSession, [call], null);
        } catch (error) {
            console.warn(`[${MODULE}:${mode}] sandbox executor failed`, error);
            return { kind: 'throw', error };
        }
        // Loop / spec executors reassign `session.workingProfile = next`
        // (not in-place mutation), so the original `sandbox` reference is
        // left untouched and only `fakeSession.workingProfile` carries the
        // post-tool-call state. Director / agenda mutate the object in
        // place, so `sandbox === fakeSession.workingProfile` for those
        // modes — either way, the authoritative post-call value lives on
        // `fakeSession.workingProfile`. Read it back to cover both shapes.
        const after = fakeSession.workingProfile != null
            ? fakeSession.workingProfile
            : sandbox;
        const outcome = interpretSandboxOutcome({ before, after, executorResult });
        if (outcome.kind === 'edits') {
            return {
                kind: 'edits',
                edits: [{
                    op: 'set',
                    path: '',
                    oldValue: before,
                    newValue: after,
                }],
            };
        }
        return outcome;
    }

    /**
     * Build the conversation history sent to the runner. Replays prior
     * user/assistant turns so the model has context. The orchestrator's
     * `buildAiIterationUserPrompt` is used to format the latest user
     * turn (mirrors what the per-mode adapter used to do).
     */
    function buildTaskMessages(systemPrompt, lastUserText, lastUserOpts) {
        const messages = [{ role: 'system', content: systemPrompt }];
        const history = (state.session.messages || []).filter(m => {
            const role = String(m?.role || '').toLowerCase();
            return role === 'user' || role === 'assistant';
        });
        let lastUserIdx = -1;
        for (let i = history.length - 1; i >= 0; i--) {
            if (String(history[i].role).toLowerCase() === 'user') {
                lastUserIdx = i;
                break;
            }
        }
        history.forEach((m, idx) => {
            const role = String(m.role).toLowerCase();
            const isLastUser = idx === lastUserIdx && role === 'user';
            const content = isLastUser
                ? buildAiIterationUserPrompt(
                    settings,
                    buildHelperSession(state.live),
                    String(lastUserText ?? m.content ?? ''),
                    lastUserOpts || {},
                )
                : String(m.content || '');

            // Replay assistant message's tool calls that produced a
            // persisted tool result — read tools (lorebook + simulate)
            // AND rejected reset control calls (their fail tool_result
            // is how the next round's model learns the rejection
            // reason). Edit tool calls are intentionally NOT replayed:
            // they're sandbox-diff proposals the user reviews + applies
            // via the popup, not part of the OpenAI-protocol round-trip
            // the model expects to see.
            const readResults = Array.isArray(m?.toolResults) ? m.toolResults : [];
            const resultIds = new Set(readResults.map(r => String(r?.tool_call_id || '')).filter(Boolean));
            const readCalls = Array.isArray(m?.toolCalls)
                ? m.toolCalls.filter(tc => isInlineExecutedTool(tc?.name) || (tc?.id && resultIds.has(String(tc.id))))
                : [];
            if (role === 'assistant' && readCalls.length > 0 && readResults.length > 0) {
                const toolCallsForHistory = readCalls.map((tc) => ({
                    id: String(tc?.id || ''),
                    type: 'function',
                    function: {
                        name: String(tc?.name || ''),
                        arguments: JSON.stringify(tc?.args || {}),
                    },
                }));
                messages.push({
                    role: 'assistant',
                    content,
                    tool_calls: toolCallsForHistory,
                });
                const resultById = new Map();
                for (const r of readResults) {
                    if (r && r.tool_call_id != null) resultById.set(String(r.tool_call_id), r);
                }
                for (const tc of readCalls) {
                    const r = resultById.get(String(tc?.id || ''));
                    if (!r) continue;
                    let serialized = '';
                    try {
                        serialized = typeof r.content === 'string'
                            ? r.content
                            : JSON.stringify(r.content ?? '');
                    } catch {
                        serialized = '';
                    }
                    messages.push({
                        role: 'tool',
                        tool_call_id: String(tc?.id || ''),
                        content: serialized,
                    });
                }
                return;
            }

            messages.push({ role, content });
        });
        return messages;
    }

    /**
     * Build the catalog the runner advertises to the LLM. The mode-aware
     * `buildAiIterationToolSet` returns the per-mode edit tools; we splice
     * the two popup-side control tools (continue / finalize) alongside.
     * The runner's `isControlCall` predicate (passed below) routes them to
     * onControlCall instead of onToolCall so they never reach the sandbox
     * executor.
     */
    function buildToolCatalog() {
        const helperSession = buildHelperSession(state.live);
        const editTools = buildAiIterationToolSet(helperSession) || [];
        // Dedupe by tool name: the upstream per-mode edit-tool builder may
        // also emit continue/finalize entries (legacy from when control
        // routing lived in main.js). Popup-side CONTROL_TOOL_DEFS is the
        // single source of truth; drop the upstream copies so the provider
        // doesn't reject the request with "Tool names must be unique."
        // The popup explicitly hides both continue and finalize legacy tools
        // — the multi-round loop is program-driven by tool-call presence,
        // so neither AI-driven control tool participates in the catalog.
        const controlNames = new Set(
            CONTROL_TOOL_DEFS.map((t) => t?.function?.name).filter(Boolean),
        );
        const droppedNames = new Set([
            'luker_orch_continue_iteration',
            'luker_orch_finalize_iteration',
        ]);
        const editToolsDeduped = editTools.filter((t) => {
            const name = t?.function?.name;
            if (!name) return true;
            if (controlNames.has(name)) return false;
            if (droppedNames.has(name)) return false;
            return true;
        });
        // Lorebook read + write tools work in BOTH scopes:
        //   - character scope: the audit reconciles the card's bound books
        //     (character / character_aux / chat / global) against the
        //     orchestration's output contract.
        //   - global scope: there is no card to inherit books from, but
        //     globally-selected world books are still active for every chat
        //     and can carry format coercion that conflicts with the global
        //     orchestration. The underlying helper-tool dispatcher
        //     (`createCharacterEditorWorldBookListToolApi`,
        //     `createCharacterEditorLorebookToolApi`,
        //     `createCharacterEditorLorebookWriteToolApi`) loads books by
        //     `book_name` and lists globally-selected entries with no
        //     avatar dependency, so both surfaces work without an avatar.
        const lorebookReadTools = LOREBOOK_READ_TOOL_DEFS;
        const lorebookWriteTools = LOREBOOK_WRITE_TOOL_DEFS;
        // Reset tools only make sense in character scope (the scope hint
        // explicitly tells the AI about them only when scope==='character').
        // Filter them out of the catalog in global scope so the LLM can't
        // emit a call that the onControlCall guard would then have to
        // reject.
        const controlTools = helperSession?.scope === 'character'
            ? CONTROL_TOOL_DEFS
            : CONTROL_TOOL_DEFS.filter((t) => {
                const name = t?.function?.name;
                return name !== CONTROL_TOOL_NAMES.resetToBlank
                    && name !== CONTROL_TOOL_NAMES.resetToGlobal;
            });
        // Skill-management tools (17 total: 4 inventory + 7
        // authoring + 3 policy + 3 migration) are always advertised — they're
        // scope-agnostic (server-side scopes are passed in args) and the
        // iter-studio AI uses them to inspect / author / migrate skills
        // as part of orchestrator design.
        return [...editToolsDeduped, ...lorebookReadTools, ...lorebookWriteTools, ...controlTools, ...SKILL_ITER_STUDIO_TOOL_DEFS];
    }

    async function runIterationTurn({ autoContinueFromResult = null } = {}) {
        // Reuse the caller-owned AbortController when present so a Stop
        // click during handleSendMessage / continueAfterReviewDecision's
        // pre-await (persistSession + render) is honored. Fall back to a
        // fresh one for callers that don't pre-seed.
        const ac = state.abortController || new AbortController();
        state.abortController = ac;

        loadLive();   // re-read so each turn sees external edits

        const helperSession = buildHelperSession(state.live);
        const scopeHintedPrompt = appendScopeHintIfNeeded(
            buildAiIterationSystemPrompt(settings, helperSession),
            helperSession,
        );
        // Append the skills discipline + visible-catalog
        // block. The augment helper is a no-op when the working profile
        // has no long systemPrompts AND no visible skills, so the prompt
        // stays clean for sessions that aren't doing skill work.
        const skillRuntimeContext = buildSkillRuntimeContext(context, null);
        const systemPrompt = await augmentIterStudioPromptWithSkills(
            scopeHintedPrompt,
            state.live,
            skillRuntimeContext,
        );

        // For auto-continue turns, the user-facing "latest user text" is
        // replaced with the synthesized auto-continue prompt; the rest of
        // the history is replayed verbatim.
        let lastUserText;
        let lastUserOpts = {};
        if (autoContinueFromResult) {
            lastUserText = buildAiIterationAutoContinuePrompt(autoContinueFromResult);
            lastUserOpts = { auto: true };
            // Push a synthetic user message into the visible history so the
            // model has context AND the user can see the auto-continue turn.
            // Marked `auto:true` so Regenerate skips them when walking back
            // to the human user turn.
            state.session.messages.push({
                id: makeMessageId(),
                role: 'user',
                content: lastUserText,
                at: Date.now(),
                auto: true,
            });
        }

        const taskMessages = buildTaskMessages(systemPrompt, lastUserText, lastUserOpts);

        const tools = buildToolCatalog();
        // Iter studio is the orchestration *designer*, not a runtime RP
        // agent — auto-injecting active world-info entries (the runtime
        // path) would only feed the model context it should not duplicate
        // into the profile it's editing. Sibling iter popups (CPA / MG
        // schema / CEA editor) all pass `runtimeWorldInfo: null` for the
        // same reason. The AI reaches lorebook content through the
        // dedicated read tools (world_book_list / lorebook_list / _query /
        // _get) when shaping a node that actually needs them.
        const runtimeWorldInfo = null;

        const apiPresetName = String(settings?.requestApiPresetName || '').trim();
        const llmPresetName = String(settings?.requestLlmPresetName || '').trim();

        const runnerSettings = {
            toolCallRetryMax: settings?.toolCallRetryMax,
            rpmLimit: settings?.rpmLimit,
        };

        // Per-round callback bookkeeping. The runner fires onAssistantText
        // Per-round callback bookkeeping. The runner fires onAssistantText
        // once (after validation, before return) and onToolCall once per
        // non-control call in array order. Control tools (reset_to_blank /
        // reset_to_global) route to onControlCall via the isControlCall
        // predicate, so they never pollute the edit-tool list. The outer
        // loop continues whenever ANY tool call landed — program-driven
        // by tool-call presence, not by an AI-emitted continue flag.
        let firstAssistantText = '';
        const collectedToolCalls = [];
        let hadAnyToolCall = false;
        // Reset rejections: each entry holds the original control call +
        // a localized reason. The popup pushes one system message per
        // rejection into chat AND emits a `{role:'tool', tool_call_id,
        // content: {error}}` message so the next round's LLM sees the
        // reason instead of silently no-opping (ORCH-5).
        const rejectedResets = [];

        const result = await ITER_RUNNER.requestToolCallsWithRetry(
            context,
            runnerSettings,
            {
                taskMessages,
                runtimeWorldInfo,
                apiPresetName,
                llmPresetName,
                tools,
                abortSignal: ac.signal,
                includeAssistantText: true,
                allowNoToolCalls: true,
                isControlCall: isOrchControlCall,
                onAssistantText: (text) => {
                    firstAssistantText = String(text || '');
                },
                onToolCall: (call) => {
                    collectedToolCalls.push(call);
                    hadAnyToolCall = true;
                },
                onControlCall: (call) => {
                    const name = String(call?.name || '');
                    hadAnyToolCall = true;
                    if (name === CONTROL_TOOL_NAMES.resetToBlank) {
                        // Only accept the reset when scope is character + no
                        // override exists yet — otherwise the AI shouldn't have
                        // called it and the system prompt explicitly says so.
                        // Rejected calls push a system message into chat AND
                        // emit a tool_result error so the next round's LLM
                        // sees the rejection reason instead of silently
                        // no-opping (ORCH-5).
                        const helper = buildHelperSession(state.live);
                        if (helper.scope === 'character' && !helper.hasOverride) {
                            state.live = createBlankProfileForMode();
                            // Reset invalidates all in-flight proposals
                            // (profile, lorebook, skill) — they were
                            // composed against the pre-reset design.
                            state.__suspendBusOnChange = true;
                            try {
                                for (const entry of bus._testOnly_entries()) {
                                    if (entry.status === 'pending' || entry.status === 'conflict') bus.reject(entry.id);
                                }
                            } finally {
                                state.__suspendBusOnChange = false;
                            }
                            state.session.messages.push({
                                id: makeMessageId(),
                                role: 'system',
                                content: t('Working profile reset to a blank shell — building this card\'s orchestration from scratch.'),
                                at: Date.now(),
                            });
                        } else {
                            const reason = helper.scope !== 'character'
                                ? t('Reset rejected: reset_to_blank only applies when iterating a character override.')
                                : t('Reset rejected: this card already has an override. Use reset_to_global instead, or continue adjusting in place.');
                            rejectedResets.push({ call, reason });
                        }
                    } else if (name === CONTROL_TOOL_NAMES.resetToGlobal) {
                        // Only accept the reset when scope is character + an
                        // override DOES exist — otherwise the AI shouldn't have
                        // called it and the system prompt explicitly says so.
                        // Rejected calls push a system + tool_result error
                        // (ORCH-5).
                        const helper = buildHelperSession(state.live);
                        if (helper.scope === 'character' && helper.hasOverride) {
                            state.live = loadGlobalProfileForMode();
                            state.__suspendBusOnChange = true;
                            try {
                                for (const entry of bus._testOnly_entries()) {
                                    if (entry.status === 'pending' || entry.status === 'conflict') bus.reject(entry.id);
                                }
                            } finally {
                                state.__suspendBusOnChange = false;
                            }
                            state.session.messages.push({
                                id: makeMessageId(),
                                role: 'system',
                                content: t('Working profile reset to match the current global profile — adjust from there.'),
                                at: Date.now(),
                            });
                        } else {
                            const reason = helper.scope !== 'character'
                                ? t('Reset rejected: reset_to_global only applies when iterating a character override.')
                                : t('Reset rejected: this card has no character override yet. Use reset_to_blank instead, or continue adjusting the seeded global copy in place.');
                            rejectedResets.push({ call, reason });
                        }
                    }
                },
            },
        );

        // Prefer `collectedToolCalls` — populated by `onToolCall`, which the
        // runner only fires for non-control calls. When the per-event
        // callbacks didn't land (e.g. an older runner version), fall back to
        // `result.toolCalls`, but filter out control calls explicitly so
        // they never leak into the persisted `assistantMsg.toolCalls`.
        const nonControlCalls = collectedToolCalls.length > 0
            ? collectedToolCalls
            : (Array.isArray(result?.toolCalls)
                ? result.toolCalls.filter((c) => !isOrchControlCall(c))
                : []);
        const assistantText = firstAssistantText.trim();

        // Split non-control calls by read-vs-edit. Read tools execute
        // synchronously here and their results are persisted on the
        // assistant message + replayed into the next round's taskMessages
        // (see buildTaskMessages). Edit tools continue down the
        // sandbox-diff path that the orch popup has always used.
        // `luker_orch_simulate` is read-type (it runs a throwaway
        // orchestration without mutating the profile); its result is
        // routed to the read-path persistence so the user sees the chip
        // with a result block instead of silently dropping.
        const readToolCalls = nonControlCalls.filter((c) => isInlineExecutedTool(c?.name));
        const editToolCalls = nonControlCalls.filter((c) => !isInlineExecutedTool(c?.name));

        // Execute read tools synchronously. Each call gets a stable id so
        // the persisted tool_result can be matched back to it during chat
        // rendering AND during the next round's taskMessages replay.
        //
        // Two backends:
        //   - Lorebook reads dispatch through `runLorebookReadTool` (the
        //     legacy `luker_card_*` helper-tool runner, scoped to the
        //     active avatar).
        //   - `luker_orch_simulate` dispatches through the orchestrator's
        //     own `executeAiIterationToolCalls` against a sandbox profile
        //     so the simulate runtime executes (and its `simulation`
        //     payload lands in toolResults) without mutating state.live.
        //     If the runtime executor throws (AbortError / HTTP / runtime)
        //     or produces no matching result, the chip surfaces a
        //     `{ok:false, reason, hint}` envelope so the user and the
        //     next round's role:'tool' replay see the real failure
        //     instead of a fake "simulation complete" placeholder.
        // Lorebook tools are plugin-agnostic; the avatar scopes
        // `world_book_list` to a card's bindings. In global scope, the
        // avatar is an empty string and `world_book_list` falls back to
        // listing chat-bound and globally-active books only.
        const avatarForReads = String(context?.characters?.[context?.characterId]?.avatar || '').trim();
        const persistedToolResults = [];
        // skill_bind_to_agent / skill_unbind_from_agent /
        // skill_set_mode_defaults / skill_replace_in_systemprompt mutate the
        // working profile via runSkillIterStudioTool, which returns a coarse
        // `{op:'set', path:'', oldValue, newValue}` pending edit alongside
        // the tool result. We accumulate those here and inject them into the
        // edit-tool sandbox-diff loop's chainedBefore (so any orchestrator
        // edit-tool calls in the SAME round see the skill-mutated profile as
        // their baseline). Empty when no policy-binding tools fire.
        const skillToolEdits = [];
        let skillToolChainedLive = null;
        for (const call of readToolCalls) {
            const callId = String(call?.id || `read_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
            let resultPayload;
            let statusLabel = 'ok';
            try {
                if (isSimulateTool(call?.name)) {
                    // Run simulate through the orchestrator's executor against
                    // a sandbox clone so a malformed simulate call can't
                    // poison state.live. The executor stamps tool_call_id on
                    // each pushed tool result; we adopt the callId pre-call
                    // so the match is deterministic.
                    const sandbox = state.live != null ? structuredClone(state.live) : state.live;
                    const fakeSession = buildHelperSession(sandbox);
                    const execCall = {
                        id: callId,
                        name: call?.name,
                        args: call?.args && typeof call.args === 'object' ? call.args : {},
                    };
                    let execOk = false;
                    try {
                        const execResult = await executeAiIterationToolCalls(null, fakeSession, [execCall], ac.signal);
                        const results = Array.isArray(execResult?.toolResults) ? execResult.toolResults : [];
                        const match = results.find(r => String(r?.tool_call_id || '') === callId) || results[0];
                        if (match && match.content !== undefined) {
                            // toolResults' content is serialized JSON
                            // string per orchestrator's serializeToolResultContent.
                            // Parse so the message renderer's chip-summary
                            // hook can pull simulation.summary directly.
                            let parsed = match.content;
                            try {
                                if (typeof parsed === 'string') parsed = JSON.parse(parsed);
                            } catch { /* leave as-is on parse failure */ }
                            resultPayload = parsed;
                            statusLabel = (parsed && parsed.ok === false) ? 'fail' : 'ok';
                            execOk = true;
                        }
                    } catch (err) {
                        // Don't pretend success — surface the failure to
                        // the agent. The historical "simulation complete"
                        // placeholder silently absorbed every executor
                        // throw (AbortError, network failure, runtime
                        // bug, …) and faked an ok result, which is an
                        // active regression of the iter-studio
                        // noop→error contract (see
                        // `iter_studio_noop_error_contract`). Map the
                        // error to a reason from the state-error enum
                        // and emit an envelope-shaped failure payload so
                        // the chip renders with an actionable hint and
                        // the next round's role:'tool' replay carries
                        // the real cause.
                        // eslint-disable-next-line no-console
                        console.warn(`[${MODULE}:${mode}] simulate executor failed`, err);
                        const reason = err?.name === 'AbortError'
                            ? 'TRANSPORT_ERROR'
                            : (typeof err?.status === 'number' && err.status >= 400)
                                ? 'HTTP_ERROR'
                                : 'TRANSPORT_ERROR';
                        resultPayload = {
                            ok: false,
                            reason,
                            hint: tf('Simulate executor threw: ${0}', String(err?.message || 'unknown').slice(0, 80)),
                        };
                        statusLabel = 'fail';
                        // Mark as handled so the genuine-no-output
                        // fallback below doesn't overwrite the failure.
                        execOk = true;
                    }
                    if (!execOk) {
                        // Genuine no-output case: executor returned
                        // without throwing AND without producing any
                        // matching toolResult. Extremely rare, but
                        // surface as a transport-level failure rather
                        // than the historical fake-success placeholder.
                        resultPayload = {
                            ok: false,
                            reason: 'TRANSPORT_ERROR',
                            hint: tf('Simulate executor produced no result'),
                        };
                        statusLabel = 'fail';
                    }
                } else if (isSkillIterStudioTool(call?.name)) {
                    // Dispatch the skill iter-studio tool.
                    // Three result shapes:
                    //   - pendingEdit: policy-binding / systemPrompt-splice
                    //     tools mutate a clone of the working profile and
                    //     return a coarse sandbox-diff edit.
                    //   - pendingSkillEdit: 7 authoring tools (+
                    //     skill_extract_from_text) emit a per-file proposal
                    //     envelope; parked on state.pendingSkillEdits for
                    //     user approval, committed at Apply time via
                    //     commitApprovedSkillProposal.
                    //   - plain result: 4 inventory tools return server
                    //     state verbatim.
                    //
                    // The mutationCtx's getWorkingProfile returns the
                    // chained skill-side working profile so sequential
                    // skill mutations in the same round compose.
                    const out = await runSkillIterStudioTool(
                        { name: call?.name, args: call?.args },
                        { getWorkingProfile: () => skillToolChainedLive || state.live },
                    );
                    if (out?.ok) {
                        if (out.pendingEdit) {
                            skillToolEdits.push(out.pendingEdit);
                            // Advance the skill-side chain so the next
                            // policy-binding tool in this round sees the
                            // prior tool's mutations as its baseline.
                            skillToolChainedLive = out.pendingEdit.newValue;
                        }
                        if (out.pendingSkillEdit) {
                            // Skill authoring proposal → ProposalBus. We
                            // pass before === after so the inverse patch
                            // is empty (no rollback). The skill-registry
                            // target's write dispatches to
                            // commitApprovedSkillProposal via target._op.
                            const pendingSkillEdit = out.pendingSkillEdit;
                            const stableShape = {
                                skillName: pendingSkillEdit.skillName || '',
                                scope: pendingSkillEdit.scope || null,
                                path: pendingSkillEdit.path || '',
                            };
                            await bus.propose({
                                kind: 'skill-author',
                                target: {
                                    type: 'skill-registry',
                                    name: stableShape.skillName,
                                    path: stableShape.path,
                                    _op: pendingSkillEdit.op,
                                },
                                before: stableShape,
                                after: stableShape,
                                sourceCallId: callId,
                                meta: {
                                    op: pendingSkillEdit.op,
                                    skillName: pendingSkillEdit.skillName,
                                    scope: pendingSkillEdit.scope,
                                    path: pendingSkillEdit.path,
                                    before: pendingSkillEdit.before,
                                    after: pendingSkillEdit.after,
                                    extras: pendingSkillEdit.extras || null,
                                },
                            });
                        }
                        resultPayload = out.result;
                    } else {
                        resultPayload = { error: String(out?.error || 'unknown error') };
                        statusLabel = 'fail';
                    }
                } else if (isCustomToolIterStudioTool(call?.name)) {
                    // Custom-tool iter-studio dispatch. 7 reads return verbatim
                    // (list / get / dry_run / ctx_list_keys / ctx_describe /
                    // docs_list / docs_read); 4 writes (set / patch_body /
                    // patch_schema / remove) emit `pendingCustomToolEdit`
                    // proposals parked on the bus. Reads are dispatched
                    // through the same `executeAiIterationToolCalls` the
                    // edit-tool path uses below, but against a sandbox
                    // session so a buggy dry_run cannot poison state.live.
                    // The bus.propose mirrors skill-author: target._op
                    // carries the captured op; on user-approved commit the
                    // orch-custom-tool target handler replays through the
                    // shared committer so concurrent drift surfaces as an
                    // error rather than a stale clobber.
                    const sandbox = state.live != null ? structuredClone(state.live) : state.live;
                    const fakeSession = buildHelperSession(sandbox);
                    const execCall = {
                        id: callId,
                        name: call?.name,
                        args: call?.args && typeof call.args === 'object' ? call.args : {},
                    };
                    try {
                        const execResult = await executeAiIterationToolCalls(null, fakeSession, [execCall], ac.signal);
                        const results = Array.isArray(execResult?.toolResults) ? execResult.toolResults : [];
                        const match = results.find(r => String(r?.tool_call_id || '') === callId) || results[0];
                        let parsed = match?.content;
                        try { if (typeof parsed === 'string') parsed = JSON.parse(parsed); } catch { /* leave as-is */ }
                        resultPayload = parsed != null ? parsed : { ok: false, error: 'custom-tool iter-studio executor returned no result' };
                        statusLabel = (resultPayload && resultPayload.ok === false) ? 'fail' : 'ok';
                        // Harvest pending blobs the executor staged and
                        // park each on the bus.
                        const pendingBlobs = Array.isArray(execResult?.pendingCustomToolEdits) ? execResult.pendingCustomToolEdits : [];
                        for (const entry of pendingBlobs) {
                            const blob = entry?.blob;
                            if (!blob || typeof blob !== 'object') continue;
                            const stableShape = {
                                name: String(blob.name || ''),
                                kind: String(blob.kind || ''),
                            };
                            await bus.propose({
                                kind: 'custom-tool-author',
                                target: {
                                    type: 'orch-custom-tool',
                                    name: stableShape.name,
                                    _op: blob.op,
                                },
                                before: stableShape,
                                after: stableShape,
                                sourceCallId: callId,
                                meta: {
                                    op: blob.op,
                                    kind: blob.kind,
                                    name: blob.name,
                                    before: blob.before,
                                    after: blob.after,
                                },
                            });
                        }
                    } catch (err) {
                        // eslint-disable-next-line no-console
                        console.warn(`[${MODULE}:${mode}] custom-tool iter-studio dispatch failed`, err);
                        resultPayload = { ok: false, error: String(err?.message || err) };
                        statusLabel = 'fail';
                    }
                } else if (isLorebookWriteTool(call?.name)) {
                    const out = await runLorebookWriteTool({ id: callId, name: call?.name, args: call?.args });
                    if (out?.ok && out.result && typeof out.result === 'object' && out.result.before && out.result.after) {
                        // Proposal mode: the write tool's helper-api invoke
                        // returned a {before, after, kind} envelope and did
                        // NOT touch disk. Stage it as a ProposalBus
                        // lorebook-write entry — the bus's commit path
                        // re-derives the after-image against current state
                        // (concurrent drift surfaces as a fresh validation
                        // error rather than clobbering with a stale
                        // after-image).
                        const op = {
                            kind: out.result.kind,
                            args: (call?.args && typeof call.args === 'object') ? call.args : {},
                        };
                        const bookName = out.result.book_name;
                        // Use the entry's before/after (provided by CEA's
                        // helper-api proposal envelope) as the bus's diff
                        // shape — the lorebook target's write delegates
                        // to CEA's commit helper via target._op so concurrent
                        // drift surfaces as a fresh validation error rather
                        // than clobbering with a stale after-image.
                        const entryBefore = out.result.before || {};
                        const entryAfter = out.result.after || {};
                        const { id: pendingId } = await bus.propose({
                            kind: 'lorebook-write',
                            target: {
                                type: 'orch-lorebook',
                                name: bookName,
                                uid: out.result.uid,
                                _op: op,
                            },
                            before: entryBefore,
                            after: entryAfter,
                            sourceCallId: callId,
                            meta: {
                                op,
                                bookName,
                                uid: out.result.uid,
                                before: entryBefore,
                                after: entryAfter,
                            },
                        });
                        const summary = out.result.kind === 'update'
                            ? { updated_fields: Array.isArray(out.result.updated_fields) ? out.result.updated_fields : [] }
                            : { replaced_chars: out.result.replaced_chars, new_chars: out.result.new_chars };
                        resultPayload = {
                            ok: true,
                            proposed: true,
                            pending_id: pendingId,
                            book_name: out.result.book_name,
                            uid: out.result.uid,
                            kind: out.result.kind,
                            ...summary,
                            message: 'Proposed for user approval. The edit is NOT live yet — the user reviews this diff card and approves or rejects it; nothing reaches disk until the user clicks Approve. The iter-studio PAUSES the auto-continue loop the moment any write proposal (profile edit, lorebook, skill) is staged: the next round will not fire until the user has fully resolved every pending card. You will then receive a synthetic user message describing exactly which proposals committed, which were rejected, and which surfaced commit errors. Continue planning subsequent work in your reasoning, but do not stack additional unrelated write proposals in this same round expecting them to commit alongside this one — the user reviews each card independently and the loop only resumes after the batch is settled.',
                        };
                    } else if (out?.ok) {
                        // Defensive: helper api returned ok without the
                        // expected proposal shape. Surface as-is but log a
                        // warning so a future refactor breaking the
                        // {before, after} envelope contract is visible
                        // instead of silently bypassing the approval flow.
                        // eslint-disable-next-line no-console
                        console.warn(`[${MODULE}:${mode}] lorebook write tool returned ok without {before, after} envelope — proposal skipped`, out);
                        resultPayload = out.result;
                    } else {
                        resultPayload = { error: String(out?.error || 'unknown error') };
                        statusLabel = 'fail';
                    }
                } else {
                    const out = await runLorebookReadTool({ id: callId, name: call?.name, args: call?.args }, avatarForReads);
                    if (out?.ok) {
                        resultPayload = out.result;
                    } else {
                        resultPayload = { error: String(out?.error || 'unknown error') };
                        statusLabel = 'fail';
                    }
                }
            } catch (err) {
                resultPayload = { error: String(err?.message || err || 'unknown error') };
                statusLabel = 'fail';
            }
            persistedToolResults.push({
                tool_call_id: callId,
                content: resultPayload,
                status: statusLabel,
            });
            // Backfill id on the source call so persistedToolCalls below uses
            // the same id (otherwise renderMessageCard's tool_call_id ↔ chip
            // lookup would miss).
            call.id = callId;
        }

        // Normalize edit-tools → edits via sandbox-diff. Multiple edit
        // calls in the same turn chain their oldValue → newValue: each
        // call's sandbox baseline is the PREVIOUS call's newValue (not a
        // fresh snapshot of state.live). Without chaining, multiple
        // path:'' set edits would clobber each other — and applyEdits's
        // lodash.set('') is a no-op for the multi-edit fallback, so all
        // N would get dropped and the apply would commit the pre-AI
        // state. With chaining the cumulative result lives in the last
        // edit's newValue, which the apply loop at applyPendingEdits
        // reproduces by walking through every empty-path edit.
        //
        // Failures and no-op outcomes push a `role: 'tool'`-shaped result
        // onto the assistant message's toolResults so buildTaskMessages
        // re-emits them as tool replies in the next round. Previous
        // versions pushed a `role: 'system'` chat message on error,
        // which buildTaskMessages filters out — the model never learned
        // that its tool call failed and would re-emit the same broken
        // call.
        const edits = [];
        const editToolResults = [];
        // Seed chainedBefore with the LAST skill-tool edit's newValue when
        // present, so any orchestrator edit-tool calls in this same round
        // see the skill-mutated profile as their baseline. Without this
        // seeding the first edit-tool call would snapshot the pre-skill
        // state.live and clobber skill-tool mutations on apply.
        let chainedBefore = skillToolChainedLive;
        for (const call of editToolCalls) {
            const name = String(call?.name || '');
            const callId = String(call?.id || `edit_${editToolResults.length}_${Date.now().toString(36)}`);
            call.id = callId;
            try {
                const outcome = await normalizeToolCallToEditInline(call, chainedBefore);
                // The decision/mapping pair is unit-tested in
                // tests/orch-iteration/sandbox-result.test.js — keep this
                // call site a thin compose so the tested helpers stay
                // load-bearing. Failure / throw outcomes used to be
                // collapsed onto a hardcoded "likely already matches"
                // noop, which silenced the executor's real error
                // (anchor not_found / multiple_matches / invalid_args)
                // and made the AI think a broken patch had succeeded.
                const reply = buildEditCallReply({ outcome, callId });
                if (reply.edits.length > 0) {
                    edits.push(...reply.edits);
                }
                if (reply.toolResult) {
                    editToolResults.push(reply.toolResult);
                }
                if (reply.chainAdvanceTo !== undefined) {
                    // Advance the chain so the next tool sees the prior
                    // tool's mutations. Failure / noop replies leave the
                    // chain at `chainedBefore` (chainAdvanceTo undefined).
                    chainedBefore = reply.chainAdvanceTo;
                }
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}:${mode}] normalizeToolCallToEditInline failed for ${name}`, err);
                editToolResults.push({
                    tool_call_id: callId,
                    content: { error: String(err?.message || err || 'normalize failed') },
                    status: 'fail',
                });
            }
        }

        // Reset-rejection handling (ORCH-5). Reset control calls that were
        // rejected by the scope/hasOverride guard get a visible system
        // message AND a fail-status tool result so the next round's
        // taskMessages replay surfaces the rejection in OpenAI-protocol
        // shape — the model can then either back off or try the other
        // path, rather than retrying the same rejected call forever.
        // These calls are appended to the assistant message's toolCalls
        // so renderMessageCard renders the chip + result block.
        const rejectedResetCalls = [];
        for (const { call, reason } of rejectedResets) {
            const callId = String(call?.id || `reset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
            // `reason` is a localized prose sentence built from `t(...)`
            // above — visible to BOTH the user (system bubble, markdown-
            // rendered) and the model (via persistedToolResults below,
            // raw text). Keep translations free of markdown sigils
            // (`_`, `*`, backticks) so the bubble doesn't reinterpret
            // them; wrapping in inline code here would turn the whole
            // rationale into etymological-mode code font for the user.
            state.session.messages.push({
                id: makeMessageId(),
                role: 'system',
                content: reason,
                at: Date.now(),
            });
            persistedToolResults.push({
                tool_call_id: callId,
                content: { error: reason },
                status: 'fail',
            });
            rejectedResetCalls.push({
                id: callId,
                name: String(call?.name || ''),
                args: call?.args && typeof call.args === 'object' ? call.args : {},
            });
        }

        // Stage the assistant message with the full per-round audit trail.
        // The toolCalls + edits + appliedAt fields drive renderMessageCard's
        // collapsible details block, Apply marker, and Rollback button. When
        // the model emitted tool calls without text the chips themselves
        // already display each call's friendly label + args, so we leave
        // `content` empty rather than synthesising a redundant one-liner.
        const content = assistantText;
        const assistantMsg = {
            id: makeMessageId(),
            role: 'assistant',
            content: content || '',
            at: Date.now(),
        };
        const allCallsForPersist = [...readToolCalls, ...editToolCalls];
        if (allCallsForPersist.length > 0 || rejectedResetCalls.length > 0) {
            const fromMain = allCallsForPersist.map(tc => ({
                id: String(tc?.id || ''),
                name: String(tc?.name || ''),
                args: tc?.args ?? {},
            }));
            assistantMsg.toolCalls = [...fromMain, ...rejectedResetCalls];
        }
        if (persistedToolResults.length > 0 || editToolResults.length > 0) {
            assistantMsg.toolResults = [...persistedToolResults, ...editToolResults];
        }
        // Merge skill-tool sandbox-diff edits with orchestrator edit-tool
        // edits. Skill edits come FIRST because their chainedBefore was
        // state.live; orchestrator edit-tool calls used skillToolChainedLive
        // as their baseline, so concatenation preserves the cumulative
        // chain (each path:'' edit's newValue = original + all mutations
        // up to that point).
        const combinedEdits = [...skillToolEdits, ...edits];
        if (combinedEdits.length > 0) {
            // The bus `profile-edit` kind below renders the actual diff
            // body from `entry.meta.before/after` — we never need to
            // persist the full v2 `{op:'set', path:'', oldValue, newValue}`
            // payload on the message. The ONLY consumer of `m.edits` is
            // `renderPendingEditCard`, which reads `skillVisibilityChange`
            // off skill policy-binding edits to surface a human-readable
            // context strip above the bus card (resolving the opaque
            // `'+'` / `'*'` enums into the actual effective visible-skill
            // set). Persist just that slim sidecar — dropping the v2
            // oldValue/newValue carriers keeps `m.edits` v3-clean.
            const slim = combinedEdits
                .filter((e) => e && e.skillVisibilityChange)
                .map((e) => ({ skillVisibilityChange: e.skillVisibilityChange }));
            if (slim.length > 0) {
                assistantMsg.edits = slim;
            }
        }
        state.session.messages.push(assistantMsg);

        // Stage the chained-live profile edit as a single ProposalBus
        // proposal. The orch sandbox-diff coalesces 1-or-N empty-path-set
        // edits per turn into a final cumulative newValue; the bus card
        // represents that one cumulative change.
        if (combinedEdits.length > 0) {
            const lastEdit = combinedEdits[combinedEdits.length - 1];
            const firstCallId = (editToolCalls.find((c) => c?.id)?.id) || assistantMsg.id;
            bus.setAutoApprove(Boolean(state.session.surfaceState?.autoApply));
            // Chain across earlier pending proposals: the bus's
            // getCurrentPendingState walks any same-target pending entries
            // so the patch we record here lines up with the approve-in-
            // order replay (no stale-snapshot conflicts).
            const proposalBefore = await bus.getCurrentPendingState('profile-edit', { type: 'profile' });
            await bus.propose({
                kind: 'profile-edit',
                target: { type: 'profile' },
                before: proposalBefore,
                after: lastEdit.newValue,
                sourceCallId: firstCallId,
                meta: { before: proposalBefore, after: lastEdit.newValue },
            });
        }

        // Mobile workspace: if the user was on the Preview tab, bump the
        // chat-tab badge so they know new assistant content arrived without
        // forcing a tab switch.
        bumpChatBadge();

        // Build a synthetic execution result the auto-continue prompt
        // builder can consume. We pass a minimal shape — the orchestrator's
        // builder tolerates missing fields. `finalized` is true only when
        // the model emitted no tool calls at all (pure-prose response =
        // loop exit). Pure-read rounds with no edits still mark
        // `hadAnyToolCall` true via the onToolCall callback, so they
        // naturally trigger another round without a special branch.
        const syntheticExecutionResult = {
            actions: [],
            simulations: [],
            toolResults: [],
            finalized: !hadAnyToolCall,
            changed: combinedEdits.length > 0,
            hasPending: combinedEdits.length > 0,
        };

        return {
            hadAnyToolCall,
            executionResult: syntheticExecutionResult,
        };
    }


    // ──────────────────────────────────────────────────────────────────
    // Per-message actions.
    //
    // regenerateFromMessage(msgId): truncate the chat back to the user
    // turn that prompted this assistant message, drop staged pendingEdits
    // (they belonged to the discarded turn), refill the textarea with the
    // original prompt, and re-fire the send pipeline.
    //
    // rollbackBatch(msgId): inverse-apply each edit in the message's
    // batch against state.live (right-to-left, so dependent ops unwind in
    // creation order), commit the result, mark the message rolledBackAt.
    // Bails on the first edit whose op lacks an inverse — partial
    // rollback would leave the profile in an inconsistent state.
    // ──────────────────────────────────────────────────────────────────
    async function regenerateFromMessage(messageId) {
        if (state.isBusy) return;
        const messages = state.session.messages || [];
        const idx = messages.findIndex(m => m && m.id === messageId);
        if (idx < 0) return;
        // Walk back to the user message that prompted this assistant turn.
        // Skip auto-continue synthetic users (`m.auto === true`) so the
        // resend refills the textarea with the human's original text.
        let userIdx = -1;
        for (let i = idx - 1; i >= 0; i--) {
            const m = messages[i];
            if (m && m.role === 'user' && !m.auto) { userIdx = i; break; }
        }
        if (userIdx < 0) return;
        const userText = String(messages[userIdx].content || '');
        // Truncate before the user message; the resend will push it again.
        state.session.messages = messages.slice(0, userIdx);
        // Reject bus proposals tied to discarded assistant turns — their
        // sourceCallId points at tool calls that are about to vanish
        // from the message stream.
        const survivingCallIds = new Set();
        for (const m of state.session.messages) {
            if (Array.isArray(m?.toolCalls)) {
                for (const tc of m.toolCalls) if (tc?.id) survivingCallIds.add(String(tc.id));
            }
        }
        state.__suspendBusOnChange = true;
        try {
            for (const entry of bus._testOnly_entries()) {
                const cid = String(entry.sourceCallId || '');
                if (entry.status === 'pending' && cid && !survivingCallIds.has(cid)) {
                    bus.reject(entry.id);
                }
            }
        } finally {
            state.__suspendBusOnChange = false;
        }
        await persistSession();
        await render();
        const $textarea = $root.find('[data-orch-it-input]');
        $textarea.val(userText);
        await handleSendMessage();
    }

    // rollbackBatch is now bus-driven via turn-actions on the assistant
    // card; bus.rollbackAllInTurn(message) handles it.


    // ──────────────────────────────────────────────────────────────────
    // Send-message handler. Q6: user message is pushed AND rendered
    // BEFORE the await so the user sees their own input before the LLM
    // wait spinner starts. Errors surface as system messages.
    //
    // Multi-round auto-continue is program-driven by tool-call presence:
    // whenever a round emits any tool call (edit or control), the loop
    // fires another round (after rendering the previous round so the
    // user sees progressive output). The ONLY exits are:
    //   1. The model responded with plain text and no tool calls.
    //   2. The user clicked Stop (abortController fires; isAbortError
    //      catches the resulting error in the catch block).
    //   3. The model staged ANY write proposal the user hasn't fully
    //      committed yet — profile edit, lorebook proposal, OR skill
    //      proposal. The bucket has to be empty (committed + rejected
    //      flushed by Apply, nothing left pending) before the loop
    //      resumes. See hasOutstandingWriteProposals.
    // There is NO hard round cap — runaway loops are the user's problem
    // and a single Stop click ends them.
    // ──────────────────────────────────────────────────────────────────
    async function handleSendMessage() {
        if (state.isBusy) {
            // Stop request: abort the in-flight runner call. Mark
            // `aborting` and re-render immediately so the button visibly
            // reflects the click even when the network takes time to
            // actually drop the request. The original call's finally
            // clears both flags once the abort lands.
            if (!state.aborting) {
                state.aborting = true;
                try { state.abortController?.abort(); } catch { /* ignore */ }
                render().catch(() => { /* ignore — best-effort UI nudge */ });
            }
            return;
        }
        const $textarea = $root.find('[data-orch-it-input]');
        const text = String($textarea.val() || '').trim();
        if (!text) return;
        $textarea.val('');
        state.session.messages.push({
            id: makeMessageId(),
            role: 'user',
            content: text,
            at: Date.now(),
        });
        state.isBusy = true;
        // Seed the AbortController before the pre-flight awaits so a
        // Stop click during persistSession / render isn't dropped onto
        // a null controller. runIterationTurn reuses this instance.
        state.abortController = new AbortController();
        await persistSession();
        await render();   // Q6: user message visible before LLM wait
        try {
            let turn = await runIterationTurn();
            while (turn?.hadAnyToolCall
                && !bus.hasOutstanding()) {
                await persistSession();
                await render();   // progressive: prior round visible before next
                if (state.abortController?.signal?.aborted) break;
                turn = await runIterationTurn({ autoContinueFromResult: turn.executionResult });
            }
        } catch (err) {
            // Stop button → don't push an error bubble; user knows they cancelled.
            if (!isAbortError(err, state.abortController?.signal)) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}:${mode}]`, err);
                state.session.messages.push({
                    id: makeMessageId(),
                    role: 'system',
                    content: tf('Error: ${0}', mdLiteral(err?.message || err)),
                    at: Date.now(),
                });
            }
        } finally {
            state.isBusy = false;
            state.aborting = false;
            state.abortController = null;
            await persistSession();
            await render();
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Mount popup + bind events. The popup is DISPLAY-type (no built-in
    // OK / Cancel) and `wider` so the chat surface has breathing room.
    //
    // Event delegation lives on `$root` so re-renders that swap inner
    // HTML don't drop handlers.
    // ──────────────────────────────────────────────────────────────────
    loadLive();

    const popupId = `orch_it_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const titleText = TITLES_BY_MODE[mode] || 'AI Iteration Studio';
    const popupHtml = buildPopupHtml({
        popupId,
        title: t(titleText),
        historyOpen: Boolean(state.session.surfaceState?.historyOpen),
        historyLabel: t('History'),
        newSessionLabel: t('New session'),
        clearAllLabel: t('Clear all'),
        autoApply: Boolean(state.session.surfaceState?.autoApply),
        sendLabel: t('Send'),
        composerPlaceholder: t('Describe what to change in the profile...'),
        autoApplyLabel: t('Auto-apply edits'),
        chatTabLabel: t('Chat'),
        previewTabLabel: t('Preview'),
        chatBadgeAriaLabel: t('New messages while you were on Preview'),
        resizerAriaLabel: t('Resize columns'),
    });
    const popup = new Popup(popupHtml, POPUP_TYPE.DISPLAY, '', {
        wider: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: false,
    });
    const popupPromise = popup.show();
    $root = jQuery(`#${popupId}`);

    // Wire the iteration-library zoom overlay so the profile-diff
    // Expand button + splitter + Esc-key affordances work scoped to
    // this popup.
    const zoomOverlayUnbind = ITER_ZOOM_OVERLAY.attachZoomOverlay($root[0], {
        namespace: `.orchItDiff_${popupId}`,
        i18n: t,
    });

    // When the bus detects that the underlying target has drifted in a
    // way it can no longer chain off, lock the composer and surface a
    // banner. Unbind runs in the teardown `finally` block below.
    const unbindChainBroken = ITER_UI.message.bindChainBrokenBanner($root[0], bus, {
        translate: (s) => t(s),
    });

    // No mount-time persist — the session is _transient until the user
    // sends their first message. persistSession()'s _transient guard
    // defers the write so opening + closing the popup without sending
    // anything does not accumulate empty session rows in the history.

    // ── Delegated events ──────────────────────────────────────────────
    $root.on('click.orchIt', '[data-orch-it-action="send"]', async (e) => {
        e.preventDefault();
        await handleSendMessage();
    });

    // Q5: Plain Enter → newline (textarea default).
    //     Ctrl/Cmd-Enter → send.
    $root.on('keydown.orchIt', '[data-orch-it-input]', async (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            await handleSendMessage();
        }
    });

    // Q3: history details collapse state persists per-session.
    $root.on('toggle.orchIt', '[data-orch-it-history]', async (e) => {
        const open = Boolean(e.currentTarget?.open);
        state.session.surfaceState = { ...(state.session.surfaceState || {}), historyOpen: open };
        await persistSession();
    });

    // Auto-apply preference: persist per-session AND mirror into bus.
    $root.on('change.orchIt', '[data-orch-it-action="toggle-auto-apply"]', async (e) => {
        const checked = Boolean(e.currentTarget?.checked);
        state.session.surfaceState = { ...(state.session.surfaceState || {}), autoApply: checked };
        bus.setAutoApprove(checked);
        await persistSession();
        // If we just enabled it and proposals are already pending, fire
        // approve on each so the queue drains immediately (matches the
        // during-turn behavior of the bus's auto-approve scheduler).
        if (checked) {
            try {
                for (const entry of bus._testOnly_entries()) {
                    if (entry.status === 'pending') await bus.approve(entry.id);
                }
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}:${mode}] auto-apply on toggle failed`, err);
            }
        }
    });

    // ProposalBus click delegation. Approve / reject / reset / rollback
    // per-card AND approve-all / reject-all / rollback-turn turn-actions
    // are all consumed here. Any click whose target carries
    // `data-proposal-action` is handled by the bus; unmatched clicks fall
    // through to the rest of the popup's handlers (session switch,
    // workspace tabs, regenerate, etc.).
    $root.on('click.orchIt', async (e) => {
        await bus.handleClick(e);
    });

    // Session-switch handlers — abort in-flight LLM + reset busy flag before
    // the swap so a stale response can't land in the newly-loaded session.
    $root.on('click.orchIt', '[data-orch-it-action="new-session"]', async (e) => {
        e.preventDefault();
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.aborting = false;
        state.abortController = null;
        await startNewSession();
    });
    // Q9: clear-history lives inside the <details>; same delegation root.
    $root.on('click.orchIt', '[data-orch-it-action="clear-history"]', async (e) => {
        e.preventDefault();
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.aborting = false;
        state.abortController = null;
        await clearAllHistory();
    });
    $root.on('click.orchIt', '[data-orch-it-action="load-session"]', async (e) => {
        // The delete button is a child of the load row — stop the row's
        // click from firing when the user is removing an item.
        const target = e.target;
        if (target && target.matches?.('[data-orch-it-action="delete-session"]')) return;
        const id = String(e.currentTarget?.dataset?.orchItId || '');
        if (id && id !== state.session.id) {
            try { state.abortController?.abort(); } catch { /* ignore */ }
            state.isBusy = false;
            state.aborting = false;
            state.abortController = null;
            await loadSession(id);
        }
    });
    $root.on('click.orchIt', '[data-orch-it-action="delete-session"]', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = String(e.currentTarget?.dataset?.orchItId || '');
        if (!id) return;
        // Deleting the active session also tears down any in-flight LLM
        // call so the response can't land in the recreated next session.
        if (id === state.session?.id) {
            try { state.abortController?.abort(); } catch { /* ignore */ }
            state.isBusy = false;
            state.aborting = false;
            state.abortController = null;
        }
        await sessionStore.delete(id);
        if (state.session.id === id) {
            await startNewSession();
        } else {
            await render();
        }
    });

    // Per-message Regenerate / Rollback. Both buttons are rendered by
    // `iteration-library/ui/message.renderMessageCard`, which emits them
    // with `data-orch-it-action="regenerate"` / `="rollback-batch"` (via
    // the actionAttribute opt) and `data-luker-lib-msg-id="..."`. The
    // msgId resolver accepts both attribute names so the outer Orch
    // wrapper's `data-orch-it-msg-id` (preserved on the parent
    // `.orch_it_msg`) keeps working if a future override taps that path.
    function resolveMsgId(target) {
        if (!target) return '';
        // dataset is camelCase: orchItMsgId / lukerLibMsgId
        return String(target.dataset?.orchItMsgId || target.dataset?.lukerLibMsgId || '');
    }
    $root.on('click.orchIt', '[data-orch-it-action="regenerate"]', async (e) => {
        e.preventDefault();
        const msgId = resolveMsgId(e.currentTarget);
        if (!msgId) return;
        await regenerateFromMessage(msgId);
    });
    // Per-batch rollback is now bus-driven: turn-actions row rendered by
    // bus.renderTurnActions emits `data-proposal-action="rollback-turn"`
    // which the bus click delegator above consumes.

    // ── Workspace events ──────────────────────────────────────────────
    // Mobile tab switcher — only relevant when the < 900px media query
    // collapses the grid; on desktop both panes are mounted simultaneously
    // and the tab bar is hidden via CSS.
    $root.on('click.orchIt', '[data-iter-action="switch-tab"]', (e) => {
        const tab = e.currentTarget?.dataset?.iterTab;
        if (!tab) return;
        e.preventDefault();
        setActiveTab(tab);
    });

    function setActiveTab(tab) {
        const root = $root?.[0];
        if (!root) return;
        root.dataset.iterActiveTab = tab;
        root.querySelectorAll('[data-iter-action="switch-tab"]').forEach(btn => {
            const isActive = btn.dataset.iterTab === tab;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
        });
        if (tab === 'chat') {
            const badge = root.querySelector('[data-iter-chat-badge]');
            if (badge) {
                badge.hidden = true;
                badge.textContent = '';
            }
        }
    }

    function bumpChatBadge() {
        const root = $root?.[0];
        if (!root || root.dataset?.iterActiveTab !== 'preview') return;
        const badge = root.querySelector('[data-iter-chat-badge]');
        if (!badge) return;
        const next = (Number(badge.textContent) || 0) + 1;
        badge.textContent = String(next);
        badge.hidden = false;
    }

    // External character-switch listener — when the user navigates to a
    // different character (or switches chats) in the main app while a
    // turn is in flight, abort the request so a stale response can't
    // land in the popup's now-mismatched context. We do NOT reload
    // state here: the iteration scope is closure-captured at mount and
    // the user can dismiss + reopen to pick up the new scope. This is
    // a safety net for the abort, not a hot-reload feature.
    let unsubscribeChatChanged = null;
    try {
        if (typeof context?.eventSource?.on === 'function'
            && typeof context?.eventSource?.removeListener === 'function'
            && context?.eventTypes?.CHAT_CHANGED) {
            const handler = () => {
                try {
                    if (state.abortController?.signal && !state.abortController.signal.aborted) {
                        state.abortController.abort();
                    }
                } catch { /* ignore */ }
            };
            context.eventSource.on(context.eventTypes.CHAT_CHANGED, handler);
            unsubscribeChatChanged = () => {
                try { context.eventSource.removeListener(context.eventTypes.CHAT_CHANGED, handler); } catch { /* ignore */ }
            };
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[${MODULE}:${mode}] CHAT_CHANGED listener attach failed`, err);
    }

    // Bind the column resizer. Returns a no-op when grid/splitter are
    // missing (e.g. during teardown), so the unbind call below is safe
    // regardless of mount state.
    //
    // Both the bind and the initial render are inside the try block so a
    // throw at either step still hits the finally cleanup (no leaked
    // resizer / pending abortController / unpersisted session).
    let unbindResizer = () => {};
    try {
        unbindResizer = bindIterWorkspaceResizer($root[0]);
        await render();
        // Block until the user dismisses the popup. The single try/finally
        // ensures every teardown step (resizer unbind, zoom-overlay unbind,
        // in-flight abort, final persist) runs even if rendering throws or
        // the popup is force-closed; ordering puts persistSession LAST so
        // the abort flag is cleared before disk write. The teardown
        // persist passes `{flush:true}` so the host's settings debounce
        // is bypassed — otherwise a close-then-refresh inside the
        // debounce window drops the last in-popup turn (canonical repro:
        // simulate finishes, user closes popup + refreshes within ~1s,
        // assistant bubble was in memory but never hit disk).
        await popupPromise;
    } finally {
        try { unbindResizer(); } catch { /* ignore */ }
        try { zoomOverlayUnbind?.(); } catch { /* ignore */ }
        try { unbindChainBroken?.(); } catch { /* ignore */ }
        try { unsubscribeChatChanged?.(); } catch { /* ignore */ }
        try { state.abortController?.abort(); } catch { /* ignore */ }
        // Stop accepting new bus-driven renders before final persist —
        // a propose() that lands during teardown would otherwise request
        // a frame that fires after popup DOM has detached.
        try { busRenderScheduler.dispose(); } catch { /* ignore */ }
        state.isBusy = false;
        state.aborting = false;
        state.abortController = null;
        // Final teardown flush. saveFlush throws on hard failure (the
        // session-store wraps the LOG_WRITE_FAILED reason into the Error
        // message). Detect that prefix and prompt the user before
        // silently dropping the unsaved turn — historical silent catch
        // was the canonical lost-write repro for
        // known_bug_debounced_save_on_unload at this site (close +
        // refresh inside the settings debounce window). The popup DOM
        // is already detached by the time we get here so the prompt is
        // an acknowledgement, not a true "abort close" — but the
        // console.warn gives the user a chance to copy the unsaved
        // content out of devtools before navigating away.
        try {
            await persistSession({ flush: true });
        } catch (err) {
            const message = err instanceof Error ? String(err.message || '') : String(err ?? '');
            if (message.includes('LOG_WRITE_FAILED')) {
                // eslint-disable-next-line no-alert
                const proceed = (typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function')
                    ? globalThis.confirm(t('Save failed — close anyway and lose this turn?'))
                    : true;
                const verdict = proceed ? 'user acknowledged loss' : 'user chose to keep unsaved turn';
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}:${mode}] teardown flush failed (LOG_WRITE_FAILED): ${verdict}`, err);
            } else {
                // Non-LOG_WRITE_FAILED throw — preserve historical
                // silent behavior so an unrelated bug can't hard-block
                // popup close, but at least record it.
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}:${mode}] teardown flush threw`, err);
            }
        }
    }
}
