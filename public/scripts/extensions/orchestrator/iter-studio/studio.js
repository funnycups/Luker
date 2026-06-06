// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Orchestrator — AI iteration popup (plugin-owned).
 *
 * Stage 5 replacement for the iter-studio shell-driven adapter
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
 *   - getEditorByScope, getAgendaEditorByScope, getLoopEditorByScope, getDirectorEditorByScope
 *   - syncCharacterEditorWithActiveAvatar(ctx)
 *   - cloneWorkingProfileFromEditor, cloneAgendaWorkingProfileFromEditor, cloneDirectorWorkingProfileFromEditor
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

const __ctx = SillyTavern.getContext();
const Popup = __ctx.Popup;
const POPUP_TYPE = __ctx.POPUP_TYPE;
import {
    applyEdits,
    bindIterWorkspaceResizer,
    inverseEdit,
    render as ITER_RENDER,
    runner as ITER_RUNNER,
    tools as ITER_TOOLS,
    ui as ITER_UI,
    zoomOverlay as ITER_ZOOM_OVERLAY,
} from '../../../iteration-library/index.js';
import {
    createOrchestratorIterationSessionStore,
    makeMessageId,
    normalizeMessageShape,
} from './session-store.js';
import { ORCH_TOOL_DISPLAY } from './tool-display.js';
import {
    buildCharacterEditorHelperApis,
    runCharacterEditorHelperToolCall,
    applyCharacterEditorLorebookProposal,
} from '../../character-editor-assistant/main.js';
// Plan 2 Unit 7: iter-studio skill management catalog. Spliced into the
// tool catalog alongside CONTROL_TOOL_DEFS + lorebook reads/writes, routed
// through the inline-executed path. 14 tools only touch server state and
// return their result to the AI; the 3 policy-binding tools emit a
// sandbox-diff pending edit the user reviews + applies via the normal flow.
import {
    SKILL_ITER_STUDIO_TOOL_DEFS,
    isSkillIterStudioTool,
    runSkillIterStudioTool,
} from '../skill-iter-studio-tools.js';
import { augmentIterStudioPromptWithSkills } from '../skill-iter-studio-prompt.js';
import { buildSkillRuntimeContext } from '../skill-resolution.js';

const MODULE = 'orch-iteration';
const STYLESHEET_ID = 'orch_it_studio_stylesheet';
const STYLESHEET_HREF = '/scripts/extensions/orchestrator/iter-studio/studio.css';

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
// iter) via `iteration-library/tools/lorebook-reads.js`. The legacy
// dispatcher (`runCharacterEditorHelperToolCall`) is injected per-call
// so the shared module stays plugin-agnostic.
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
// Skill iter-studio tools (Plan 2 Unit 7) also use the inline-executed
// path: 12 server-side tools just return results, and the 3 policy-binding
// tools synthesize their own sandbox-diff edit so they slot into the
// existing pendingEdits flow without a separate review affordance.
function isInlineExecutedTool(name) {
    return isLorebookReadTool(name)
        || isLorebookWriteTool(name)
        || isSimulateTool(name)
        || isSkillIterStudioTool(name);
}

/**
 * Execute one lorebook read tool. Thin wrapper that injects the CEA
 * dispatcher into the shared `iteration-library/tools/lorebook-reads.js`
 * implementation. Kept as a local helper so existing call sites that pass
 * `(call, helperApis)` continue to work without restructuring.
 */
async function runLorebookReadTool(call, helperApis = []) {
    return runLorebookReadToolShared(call, {
        dispatch: runCharacterEditorHelperToolCall,
        helperApis,
    });
}

/**
 * Execute one lorebook write tool. Mirrors runLorebookReadTool: injects
 * the same CEA dispatcher into the shared
 * `iteration-library/tools/lorebook-writes.js` implementation. The
 * dispatcher routes the legacy `luker_card_update_lorebook_entry` /
 * `luker_card_str_replace_in_lorebook_entry` wire names to the helper
 * apis registered in buildCharacterEditorHelperApis.
 */
async function runLorebookWriteTool(call, helperApis = []) {
    return runLorebookWriteToolShared(call, {
        dispatch: runCharacterEditorHelperToolCall,
        helperApis,
    });
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
            <div class="orch_it_lbk_summary" data-orch-it-lbk-summary></div>
            <div class="orch_it_composer">
                <textarea class="text_pole" rows="2" data-orch-it-input placeholder="${escapeHtmlLocal(composerPlaceholder)}"></textarea>
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
        getEditorByScope,
        getAgendaEditorByScope,
        getLoopEditorByScope,
        getDirectorEditorByScope,
        syncCharacterEditorWithActiveAvatar,
        cloneWorkingProfileFromEditor,
        cloneAgendaWorkingProfileFromEditor,
        cloneDirectorWorkingProfileFromEditor,
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
    // (character override falls through to global).
    function loadLiveProfile() {
        try { syncCharacterEditorWithActiveAvatar?.(context); } catch { /* ignore */ }
        const scope = getIterationDefaultScope(context);
        if (isLoop) return sanitizeLoopProfile(getLoopEditorByScope(scope));
        if (isAgenda) return cloneAgendaWorkingProfileFromEditor(getAgendaEditorByScope(scope));
        if (isDirector) return cloneDirectorWorkingProfileFromEditor(getDirectorEditorByScope(scope));
        return cloneWorkingProfileFromEditor(getEditorByScope(scope));
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
        computeScope: () => computeSessionScope(),
    });
    await sessionStore.clearObsolete();

    // Prime markdown deps so the first paint has formatted messages
    // rather than escaped fallback (`ensureMarkdownDeps` caches).
    await ITER_RENDER.ensureMarkdownDeps();

    // ──────────────────────────────────────────────────────────────────
    // Closure-local state. `live` is the working profile cloned from the
    // active editor. `pendingEdits` mirrors state.session.pendingEdits so
    // popup close mid-batch reloads the same staged edits; it usually
    // holds 0 or 1 entries since the sandbox-diff emits one coarse
    // `set('', newProfile)` per turn but multi-tool turns can stack.
    // ──────────────────────────────────────────────────────────────────
    const state = {
        mode,
        session: createNewSession(mode),
        live: null,
        pendingEdits: [],
        // Pending lorebook edits captured from lorebook_update_entry /
        // lorebook_str_replace_in_entry tool calls. Each: { id, kind,
        // bookName, uid, before, after, status: 'pending'|'approved'|'rejected',
        // sourceCallId, createdAt }. Reset on session load and on Apply.
        // Approved entries commit at Apply time via
        // applyCharacterEditorLorebookCommit; rejected entries are discarded.
        pendingLorebookEdits: [],
        isBusy: false,
        aborting: false,
        abortController: null,
    };

    function loadLive() {
        state.live = loadLiveProfile();
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
    // but forces `scope = 'global'` so the global editor source is read
    // regardless of the active iteration scope.
    // ──────────────────────────────────────────────────────────────────
    function loadGlobalProfileForMode() {
        try { syncCharacterEditorWithActiveAvatar?.(context); } catch { /* ignore */ }
        if (isLoop) return sanitizeLoopProfile(getLoopEditorByScope('global'));
        if (isAgenda) return cloneAgendaWorkingProfileFromEditor(getAgendaEditorByScope('global'));
        if (isDirector) return cloneDirectorWorkingProfileFromEditor(getDirectorEditorByScope('global'));
        return cloneWorkingProfileFromEditor(getEditorByScope('global'));
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
            '5. Approval flow — important: both write tools are PROPOSAL-mode, not direct writes. Each call you make captures a {before, after} envelope, returns it to you, and pushes a diff card into the popup for the user to review. The user approves or rejects per card; only approved cards commit to the on-disk world book when the user clicks Apply. You will receive a tool result with `"proposed": true` and a message saying "Proposed for user approval" — treat that as the success contract. Continue designing the orchestration on the assumption your proposals will land if accepted, but do NOT block on disk-level confirmation. If the user rejects a proposal, your next round will see the rejection (the lorebook stayed unchanged) — adjust strategy accordingly.',
            '6. Skip this audit entirely if the user explicitly said not to touch the lorebook, or if the orchestration imposes no specific output format.',
        ].join('\n');
    }

    function appendScopeHintIfNeeded(basePrompt, helperSession) {
        if (helperSession?.scope !== 'character') return basePrompt;
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
    async function persistSession() {
        const hasMessages = Array.isArray(state.session.messages) && state.session.messages.length > 0;
        const hasPending = Array.isArray(state.pendingEdits) && state.pendingEdits.length > 0;
        if (state.session._transient && !hasMessages && !hasPending) {
            return;
        }
        if (state.session._transient) {
            delete state.session._transient;
        }
        state.session.updatedAt = Date.now();
        state.session.mode = mode;
        // Mirror runtime pendingEdits onto the persisted session so a popup
        // close mid-batch reloads with the same staged edits. Structured-
        // clone so a subsequent in-place mutation can't poison the saved
        // copy via the same reference.
        try {
            state.session.pendingEdits = Array.isArray(state.pendingEdits)
                ? structuredClone(state.pendingEdits)
                : [];
        } catch {
            state.session.pendingEdits = Array.isArray(state.pendingEdits) ? state.pendingEdits.slice() : [];
        }
        if (!state.session.title) {
            const firstUser = state.session.messages.find(m => m.role === 'user' && !m.auto);
            if (firstUser) {
                state.session.title = String(firstUser.content || '').slice(0, 50);
            }
        }
        await sessionStore.save(state.session);
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
            pendingEdits: Array.isArray(loaded.pendingEdits) ? loaded.pendingEdits.slice() : [],
        };
        state.pendingEdits = state.session.pendingEdits.slice();
        // Pending lorebook edits are deliberately session-local (never
        // persisted): they are proposals against on-disk world books, and
        // those books may have been edited in a parallel session since the
        // proposal was captured. Forcing the user to re-propose after a
        // session swap avoids applying a stale after-image against drifted
        // entry state.
        state.pendingLorebookEdits = [];
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
        state.pendingEdits = [];
        // Lorebook proposals are session-local — a new session starts with
        // an empty review queue. Without this reset, stale cards from the
        // prior session linger in the summary row (and remain committable
        // through the "commit lorebook only" button even though their
        // sourceCallId no longer matches any rendered message).
        state.pendingLorebookEdits = [];
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
    // ──────────────────────────────────────────────────────────────────
    function renderPendingEditCard(edit) {
        return ITER_UI.diff.renderDiffCard([edit], { i18n: tf });
    }

    // ──────────────────────────────────────────────────────────────────
    // Chat-message rendering. Orchestrator delegates to
    // `iteration-library/ui/message.renderMessageCard` (M1.4) so the
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

    // ──────────────────────────────────────────────────────────────────
    // Pending lorebook edits — approval cards.
    // Lorebook write tools (lorebook_update_entry / _str_replace_in_entry)
    // do NOT commit on call; the inline-executed dispatcher captures each
    // {before, after} envelope into state.pendingLorebookEdits and renders
    // it inline below the assistant message that proposed it. The user
    // approves/rejects per card; only approved cards commit at Apply time
    // via applyCharacterEditorLorebookCommit. This mirrors the orch
    // profile sandbox-diff flow but targets external (on-disk) world-info
    // state — the diff card shows full before/after so the user can judge
    // the impact before authorizing the disk write.
    // ──────────────────────────────────────────────────────────────────
    function truncateForLorebookDiff(value, max = 480) {
        const s = String(value ?? '');
        if (s.length <= max) return s;
        return s.slice(0, max) + '…';
    }

    function renderLorebookUpdateDiffBody(before, after) {
        const beforeObj = (before && typeof before === 'object') ? before : {};
        const afterObj = (after && typeof after === 'object') ? after : {};
        const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
        const changed = [];
        for (const k of keys) {
            if (k === 'uid') continue;
            if (JSON.stringify(beforeObj[k]) !== JSON.stringify(afterObj[k])) {
                changed.push(k);
            }
        }
        if (changed.length === 0) {
            return `<div class="orch_it_lbk_nochange">${escapeHtmlLocal(t('No field changes'))}</div>`;
        }
        return changed.map((k) => {
            const b = beforeObj[k];
            const a = afterObj[k];
            // Content gets stacked before/after panels (long-form); other
            // fields render inline before → after.
            if (k === 'content') {
                return `<div class="orch_it_lbk_field orch_it_lbk_field_long">
                    <div class="orch_it_lbk_field_name">${escapeHtmlLocal(k)}</div>
                    <div class="orch_it_lbk_block orch_it_lbk_block_before">${escapeHtmlLocal(truncateForLorebookDiff(b))}</div>
                    <div class="orch_it_lbk_block orch_it_lbk_block_after">${escapeHtmlLocal(truncateForLorebookDiff(a))}</div>
                </div>`;
            }
            const bRepr = typeof b === 'undefined' ? '(unset)' : JSON.stringify(b);
            const aRepr = typeof a === 'undefined' ? '(unset)' : JSON.stringify(a);
            return `<div class="orch_it_lbk_field">
                <span class="orch_it_lbk_field_name">${escapeHtmlLocal(k)}</span>
                <span class="orch_it_lbk_inline_before">${escapeHtmlLocal(bRepr)}</span>
                <span class="orch_it_lbk_inline_arrow">→</span>
                <span class="orch_it_lbk_inline_after">${escapeHtmlLocal(aRepr)}</span>
            </div>`;
        }).join('');
    }

    function renderLorebookStrReplaceDiffBody(before, after) {
        const beforeContent = String(before?.content ?? '');
        const afterContent = String(after?.content ?? '');
        return `<div class="orch_it_lbk_field orch_it_lbk_field_long">
            <div class="orch_it_lbk_field_name">content</div>
            <div class="orch_it_lbk_block orch_it_lbk_block_before">${escapeHtmlLocal(truncateForLorebookDiff(beforeContent))}</div>
            <div class="orch_it_lbk_block orch_it_lbk_block_after">${escapeHtmlLocal(truncateForLorebookDiff(afterContent))}</div>
        </div>`;
    }

    function renderLorebookPendingCard(edit) {
        const status = String(edit?.status || 'pending');
        const kind = String(edit?.kind || '');
        const icon = kind === 'update' ? '✏️' : '🩹';
        const kindLabel = kind === 'update'
            ? t('Update lorebook entry')
            : t('Patch lorebook entry text');
        const statusLabel = status === 'approved'
            ? `<span class="orch_it_lbk_status approved">✓ ${escapeHtmlLocal(t('Approved'))}</span>`
            : status === 'rejected'
                ? `<span class="orch_it_lbk_status rejected">✗ ${escapeHtmlLocal(t('Rejected'))}</span>`
                : `<span class="orch_it_lbk_status pending">${escapeHtmlLocal(t('Pending approval'))}</span>`;

        const body = kind === 'update'
            ? renderLorebookUpdateDiffBody(edit.before, edit.after)
            : renderLorebookStrReplaceDiffBody(edit.before, edit.after);

        const idAttr = escapeHtmlLocal(String(edit?.id || ''));
        const controls = (status === 'approved' || status === 'rejected')
            ? `<button class="menu_button orch_it_lbk_btn" data-orch-it-action="reset-lorebook-decision" data-orch-it-pending-id="${idAttr}">${escapeHtmlLocal(t('Undo decision'))}</button>`
            : `<button class="menu_button orch_it_lbk_btn orch_it_lbk_btn_approve" data-orch-it-action="approve-lorebook" data-orch-it-pending-id="${idAttr}">${escapeHtmlLocal(t('Approve'))}</button>
               <button class="menu_button orch_it_lbk_btn orch_it_lbk_btn_reject" data-orch-it-action="reject-lorebook" data-orch-it-pending-id="${idAttr}">${escapeHtmlLocal(t('Reject'))}</button>`;

        const target = `${escapeHtmlLocal(String(edit?.bookName || ''))} #${escapeHtmlLocal(String(edit?.uid ?? ''))}`;
        return `<div class="orch_it_lbk_card orch_it_lbk_card_${escapeHtmlLocal(status)}" data-orch-it-pending-id="${idAttr}">
            <div class="orch_it_lbk_header">
                <span class="orch_it_lbk_icon">${icon}</span>
                <span class="orch_it_lbk_label">${escapeHtmlLocal(kindLabel)}</span>
                <span class="orch_it_lbk_target">${target}</span>
                ${statusLabel}
            </div>
            <div class="orch_it_lbk_body">${body}</div>
            <div class="orch_it_lbk_controls">${controls}</div>
        </div>`;
    }

    function renderLorebookPendingForMessage(message) {
        if (!message || message.role !== 'assistant') return '';
        const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
        if (toolCalls.length === 0) return '';
        const callIds = new Set(toolCalls.map(tc => String(tc?.id || '')).filter(Boolean));
        const pending = Array.isArray(state.pendingLorebookEdits) ? state.pendingLorebookEdits : [];
        const matched = pending.filter(p => callIds.has(String(p?.sourceCallId || '')));
        if (matched.length === 0) return '';
        return `<div class="orch_it_lbk_list">${matched.map(renderLorebookPendingCard).join('')}</div>`;
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
            renderEditCard: renderPendingEditCard,
            renderApplyControls: (m) => {
                const isLatestUnapplied = String(m?.id || '') === state.__latestUnappliedAssistantId;
                const passthroughEdits = isLatestUnapplied ? m.edits : [];
                const applyLabel = getIterationDefaultScope(context) === 'character'
                    ? tf('Apply to ${0} override', getApplyScopeLabel())
                    : tf('Apply to ${0}', getApplyScopeLabel());
                return ITER_UI.apply.renderApplyControls(
                    { ...m, edits: passthroughEdits },
                    {
                        i18n: tf,
                        applyLabel,
                        actionAttribute: 'data-orch-it-action',
                    },
                );
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
        // apply. The shared component emits its own `<div
        // class="luker_lib_message">` inner wrapper; click delegation
        // resolves msgId from both attributes (see handler block below).
        const lorebookHtml = renderLorebookPendingForMessage(message);
        return `<div class="orch_it_msg ${roleCls}${autoCls}" data-orch-it-msg-id="${escapeHtmlLocal(message.id || '')}">${innerHtml}${lorebookHtml}</div>`;
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
        // `state.pendingEdits` is the source of truth for "this round is
        // staged and awaiting review". When it's empty (Discard cleared
        // it, or Apply landed with zero clean edits), no message should
        // carry an Apply/Reject row — even though `m.edits` is still
        // retained on the assistant message for diff history / rollback.
        // Short-circuit before scanning so the inline controls disappear
        // the moment the batch is resolved.
        let latestUnappliedAssistantId = '';
        if (Array.isArray(state.pendingEdits) && state.pendingEdits.length > 0) {
            for (let i = allMsgs.length - 1; i >= 0; i--) {
                const m = allMsgs[i];
                if (m && m.role === 'assistant' && !m.auto
                    && Array.isArray(m.edits) && m.edits.length > 0
                    && !m.appliedAt && !m.rolledBackAt) {
                    latestUnappliedAssistantId = String(m.id || '');
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

        // Lorebook summary row — sits between the chat scroll area and the
        // composer. Shows the pending counts and exposes a "Commit lorebook"
        // button when there are approved entries but no orch profile edits
        // waiting (the regular per-message Apply button covers the
        // common case where both are in flight together).
        try {
            const $summary = $root.find('[data-orch-it-lbk-summary]');
            if ($summary.length) {
                const allPending = Array.isArray(state.pendingLorebookEdits) ? state.pendingLorebookEdits : [];
                const pendCount = allPending.filter(p => p?.status === 'pending').length;
                const apprCount = allPending.filter(p => p?.status === 'approved').length;
                const rejCount = allPending.filter(p => p?.status === 'rejected').length;
                const orchPending = Array.isArray(state.pendingEdits) && state.pendingEdits.length > 0;
                if (allPending.length === 0) {
                    $summary.empty();
                } else {
                    const parts = [];
                    if (pendCount > 0) parts.push(tf('${0} pending', String(pendCount)));
                    if (apprCount > 0) parts.push(tf('${0} approved', String(apprCount)));
                    if (rejCount > 0) parts.push(tf('${0} rejected', String(rejCount)));
                    const summaryLabel = `${t('Lorebook proposals')}: ${parts.join(', ')}`;
                    // Surface the lorebook-only flush button when there's
                    // something to act on AND no orch profile commit is
                    // already covering it. Label adapts: "commit" when
                    // there are approved entries to write, "clear" when
                    // the only pending decisions are rejected ones.
                    const decisionCount = apprCount + rejCount;
                    const showBtn = decisionCount > 0 && !orchPending;
                    let btnHtml = '';
                    if (showBtn) {
                        const btnLabel = apprCount > 0
                            ? tf('Commit ${0} lorebook decision(s)', String(decisionCount))
                            : tf('Clear ${0} rejected', String(rejCount));
                        btnHtml = `<button class="menu_button orch_it_lbk_commit_btn" data-orch-it-action="commit-lorebook-only">${escapeHtmlLocal(btnLabel)}</button>`;
                    }
                    $summary.html(`<span class="orch_it_lbk_summary_text">${escapeHtmlLocal(summaryLabel)}</span>${btnHtml}`);
                }
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}:${mode}] lorebook summary render failed`, err);
        }

        // Pending edits — single Apply button per spec §3.4. The label
        // resolves to the active iteration scope (character name when a card
        // is selected, "global" otherwise). One handler ('apply-batch')
        // decides commit target via getIterationDefaultScope() so the button
        // can't commit to the wrong scope after a parallel character switch.
        // Delegates to the shared `iteration-library/ui/apply` component
        // (M1.7) for the row HTML so the four iter-library popups stay
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
                const previewHtml = renderOrchPreviewPane(
                    state.live,
                    state.pendingEdits || [],
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
        if (before === undefined || before === null) return [];
        const sandbox = structuredClone(before);
        const fakeSession = buildHelperSession(sandbox);
        try {
            await executeAiIterationToolCalls(null, fakeSession, [call], null);
        } catch (error) {
            console.warn(`[${MODULE}:${mode}] sandbox executor failed`, error);
            return null;
        }
        try {
            if (JSON.stringify(sandbox) === JSON.stringify(before)) {
                return [];
            }
        } catch {
            // Fall through and emit the edit regardless.
        }
        return [{
            op: 'set',
            path: '',
            oldValue: before,
            newValue: sandbox,
        }];
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
        // Splice in the lorebook read tools when the popup is scoped to a
        // character — the legacy helper-tool dispatcher is per-character,
        // so without an avatar there is nothing to bind these tools to.
        const lorebookReadTools = helperSession?.scope === 'character'
            && String(context?.characters?.[context?.characterId]?.avatar || '').trim()
            ? LOREBOOK_READ_TOOL_DEFS
            : [];
        // Write tools share the same gate. They land in the inline-executed
        // path (same as reads + simulate), so an avatar is required.
        const lorebookWriteTools = helperSession?.scope === 'character'
            && String(context?.characters?.[context?.characterId]?.avatar || '').trim()
            ? LOREBOOK_WRITE_TOOL_DEFS
            : [];
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
        // Plan 2 Unit 7: skill-management tools (17 total: 4 inventory + 7
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
        // Plan 2 Unit 7: append the skills discipline + visible-catalog
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
            useStreamingTransport: Boolean(settings?.useStreamingTransport),
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
                            state.pendingEdits = [];
                            // Pending lorebook edits were proposed against
                            // the old design's output contract; resetting
                            // the working profile invalidates that contract.
                            state.pendingLorebookEdits = [];
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
                            state.pendingEdits = [];
                            // See resetToBlank above — lorebook proposals
                            // belonged to the old design and are invalid now.
                            state.pendingLorebookEdits = [];
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
        //     If the runtime executor throws or `executeAiIterationToolCalls`
        //     is unavailable, fall back to a `{simulated: true, message}`
        //     placeholder so the user still sees a chip with a result
        //     block — better than the previous silent drop.
        const helperSessionForReads = buildHelperSession(state.live);
        const avatarForReads = String(context?.characters?.[context?.characterId]?.avatar || '').trim();
        const helperApisForReads = (helperSessionForReads?.scope === 'character' && avatarForReads)
            ? buildCharacterEditorHelperApis(context, { avatar: avatarForReads })
            : [];
        const persistedToolResults = [];
        // Plan 2 Unit 7: skill_bind_to_agent / skill_unbind_from_agent /
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
                        // Fall through to placeholder so the chip still
                        // renders with a result block.
                        // eslint-disable-next-line no-console
                        console.warn(`[${MODULE}:${mode}] simulate executor failed`, err);
                    }
                    if (!execOk) {
                        resultPayload = { simulated: true, message: 'simulation complete' };
                        statusLabel = 'ok';
                    }
                } else if (isSkillIterStudioTool(call?.name)) {
                    // Plan 2 Unit 7: dispatch the skill iter-studio tool.
                    // Policy-binding tools mutate a clone of the working
                    // profile and return a coarse sandbox-diff edit; the
                    // 12 server-side tools return their result verbatim.
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
                        resultPayload = out.result;
                    } else {
                        resultPayload = { error: String(out?.error || 'unknown error') };
                        statusLabel = 'fail';
                    }
                } else if (isLorebookWriteTool(call?.name)) {
                    const out = await runLorebookWriteTool({ id: callId, name: call?.name, args: call?.args }, helperApisForReads);
                    if (out?.ok && out.result && typeof out.result === 'object' && out.result.before && out.result.after) {
                        // Proposal mode: the write tool's helper-api invoke
                        // returned a {before, after, kind} envelope and did
                        // NOT touch disk. Capture it as a pending lorebook
                        // edit and hand the model a slim ack — full
                        // before/after blobs would pad context for no gain,
                        // since the user reviews the diff in the UI, not
                        // the model.
                        const pendingId = `lbk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
                        if (!Array.isArray(state.pendingLorebookEdits)) state.pendingLorebookEdits = [];
                        state.pendingLorebookEdits.push({
                            id: pendingId,
                            kind: out.result.kind,
                            bookName: out.result.book_name,
                            uid: out.result.uid,
                            before: out.result.before,
                            after: out.result.after,
                            // Carry the original tool args so the Apply
                            // path can re-derive the after-image against
                            // the entry's CURRENT state. This lets multiple
                            // approved proposals targeting the same
                            // book#uid chain correctly (each commit reads
                            // the prior commit's mutation) and surfaces
                            // concurrent drift as a fresh validation error.
                            op: {
                                kind: out.result.kind,
                                args: (call?.args && typeof call.args === 'object') ? call.args : {},
                            },
                            status: 'pending',
                            sourceCallId: callId,
                            createdAt: Date.now(),
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
                            message: 'Proposed for user approval. The edit is NOT live yet — the user will review the diff card in the popup and approve or reject it before it is committed at Apply time.',
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
                    const out = await runLorebookReadTool({ id: callId, name: call?.name, args: call?.args }, helperApisForReads);
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
                const normalized = await normalizeToolCallToEditInline(call, chainedBefore);
                if (Array.isArray(normalized) && normalized.length > 0) {
                    edits.push(...normalized);
                    // Advance the chain so the next tool sees the prior
                    // tool's mutations. No-op normalizations return `[]`
                    // and surface a tool reply below.
                    chainedBefore = normalized[normalized.length - 1].newValue;
                } else {
                    editToolResults.push({
                        tool_call_id: callId,
                        content: { status: 'noop', message: 'No edits produced. The target profile state likely already matches what you requested; an earlier round may have already applied this change. Re-read the live profile before retrying — do not re-issue the same call. If you genuinely intended a different result, verify args (path / mode / value).' },
                        status: 'fail',
                    });
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
        // Falls back to a synthesized summary when the model emitted tool
        // calls without text so the chat doesn't have empty bubbles. The
        // toolCalls + edits + appliedAt fields drive renderMessageCard's
        // collapsible details block, Apply marker, and Rollback button.
        let content = assistantText;
        if (!content && (editToolCalls.length > 0 || readToolCalls.length > 0)) {
            const names = [...readToolCalls, ...editToolCalls]
                .map(c => String(c?.name || ''))
                .filter(Boolean)
                .join(', ');
            content = tf('Suggested actions: ${0}', names);
        }
        if (!content && hadAnyToolCall) {
            content = t('Continuing...');
        }
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
            assistantMsg.edits = combinedEdits.slice();
        }
        state.session.messages.push(assistantMsg);

        // Replace pendingEdits with this round's batch. We don't append:
        // staging is per-round so the user can Apply or Discard cleanly
        // before the next AI request fires.
        state.pendingEdits = combinedEdits;

        // Mobile workspace: if the user was on the Preview tab, bump the
        // chat-tab badge so they know new assistant content arrived without
        // forcing a tab switch.
        bumpChatBadge();

        // Composer-row auto-apply: if enabled AND this turn produced edits,
        // AND we are not finalized, apply immediately. When auto-apply runs
        // we still push a synthetic apply-outcome user message so the next
        // round's buildTaskMessages can replay it and the model sees which
        // edits actually took effect — same truthful signal review-mode
        // gets via continueAfterReviewDecision.
        const autoApplyOn = Boolean(state.session.surfaceState?.autoApply);
        if (autoApplyOn && state.pendingEdits.length > 0) {
            const autoCount = state.pendingEdits.length;
            try {
                const outcome = await applyPendingEdits({ skipRender: true });
                if (outcome) {
                    const text = buildApplyOutcomeUserText({
                        count: autoCount,
                        applied: outcome.applied,
                        conflicts: outcome.conflicts,
                        alreadyDone: outcome.alreadyDone,
                        cleanEdits: outcome.cleanEdits,
                        target: getApplyScopeLabel(),
                        autoApply: true,
                        lorebook: outcome.lorebook,
                    });
                    state.session.messages.push({
                        id: makeMessageId(),
                        role: 'user',
                        content: text,
                        at: Date.now(),
                        auto: true,
                    });
                }
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}:${mode}] auto-apply failed`, err);
            }
        }

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
    // Apply pending edits. `applyEdits(edits, live)` returns
    // `{ newLive, clean, conflicts, alreadyDone }`. Per sub-spec §6 / §9
    // we do NOT surface a conflict UI: just commit `newLive` and silently
    // drop any conflicting / already-done edits. The pre-call live is
    // re-read so a parallel editor (e.g. user swapped characters) doesn't
    // blow away their work.
    //
    // `state.live` is snapshotted before applyEdits/applyEmptyPathSet so
    // a commit failure restores the pre-apply value — otherwise the
    // preview would lie about what's on disk until the next loadLive()
    // reload. `state.pendingEdits` is cleared only after commit resolves
    // so a failed save leaves the staged batch for the user to retry.
    //
    // Scope is derived from `getIterationDefaultScope(context)` so the
    // single Apply button can't commit to the wrong target after a parallel
    // character switch — character scope when an avatar is selected, global
    // otherwise. On success we toast the user and mark the most recent
    // unapplied assistant message so renderMessageCard can show the
    // Applied label and a Rollback button.
    // ──────────────────────────────────────────────────────────────────
    /**
     * Commit approved pending lorebook proposals to disk. Walks the
     * approved entries in order and calls
     * applyCharacterEditorLorebookCommit for each — successful commits are
     * dropped from state.pendingLorebookEdits; rejected entries are also
     * dropped (decision is final); pending (undecided) entries are
     * preserved so the user can come back to them. On per-entry failure,
     * the walk halts and the remaining un-committed approved entries stay
     * in the list so the user can investigate and retry.
     *
     * Called from applyPendingEdits AFTER the orch profile commit phase
     * succeeds (so a half-applied profile never coexists with newly
     * committed lorebook entries), and also from the "Commit lorebook
     * only" button when there are no orch profile edits in flight.
     */
    async function commitApprovedLorebookEdits() {
        const all = Array.isArray(state.pendingLorebookEdits) ? state.pendingLorebookEdits : [];
        // Snapshot all groups BEFORE mutation so the verdict can report
        // exactly what the user saw in the panel at click time.
        const approved = all.filter(p => p?.status === 'approved');
        const rejected = all.filter(p => p?.status === 'rejected');
        const stillPending = all.filter(p => p?.status === 'pending');
        const snap = (e) => ({ bookName: e.bookName, uid: e.uid, kind: e.kind });
        const decisionsToDrop = (p) => p?.status === 'rejected';
        if (approved.length === 0) {
            // No commits to attempt, but still flush rejected decisions so
            // the panel doesn't grow stale across multiple Apply clicks.
            const kept = all.filter(p => !decisionsToDrop(p));
            const droppedRejected = all.length - kept.length;
            state.pendingLorebookEdits = kept;
            return {
                committed: 0,
                failed: 0,
                failedAt: null,
                droppedRejected,
                verdict: {
                    committed: [],
                    rejected_dropped: rejected.map(snap),
                    still_approved: [],
                    still_pending: stillPending.map(snap),
                    failed: null,
                },
            };
        }
        const committedIds = new Set();
        let failedAt = null;
        let failedError = null;
        for (const entry of approved) {
            try {
                // Re-derive the after-image against the entry's CURRENT
                // on-disk state via applyCharacterEditorLorebookProposal —
                // not the snapshot `entry.after` captured at proposal time.
                // This makes multi-proposal chains for the same book#uid
                // commit correctly (proposal B's mutation lands on top of
                // proposal A's already-committed state) and surfaces
                // parallel-session drift as a fresh validation error.
                await applyCharacterEditorLorebookProposal(context, {
                    kind: entry.op?.kind ?? entry.kind,
                    args: entry.op?.args ?? {},
                });
                committedIds.add(entry.id);
            } catch (err) {
                failedAt = entry;
                failedError = err;
                break;
            }
        }
        state.pendingLorebookEdits = all.filter(p => {
            if (committedIds.has(p?.id)) return false;
            if (decisionsToDrop(p)) return false;
            return true;
        });
        if (failedAt) {
            const errText = String(failedError?.message || failedError || 'unknown error');
            try {
                toastr.error(tf('Lorebook commit failed at ${0} #${1}: ${2}',
                    String(failedAt.bookName || ''), String(failedAt.uid ?? ''), errText));
            } catch { /* toastr may be unavailable in tests */ }
            state.session.messages.push({
                id: makeMessageId(),
                role: 'system',
                content: tf('Lorebook commit halted: ${0} #${1} failed (${2}). Remaining approved entries left in the pending list for retry.',
                    String(failedAt.bookName || ''), String(failedAt.uid ?? ''), errText),
                at: Date.now(),
            });
        } else if (committedIds.size > 0) {
            try {
                toastr.success(tf('Committed ${0} lorebook edit(s)', String(committedIds.size)));
            } catch { /* ignore */ }
        }
        const committedSnaps = approved.filter(a => committedIds.has(a.id)).map(snap);
        const stillApprovedSnaps = approved.filter(a => !committedIds.has(a.id)).map(snap);
        return {
            committed: committedIds.size,
            failed: failedAt ? 1 : 0,
            failedAt,
            verdict: {
                committed: committedSnaps,
                rejected_dropped: rejected.map(snap),
                still_approved: stillApprovedSnaps,
                still_pending: stillPending.map(snap),
                failed: failedAt
                    ? {
                        bookName: failedAt.bookName,
                        uid: failedAt.uid,
                        kind: failedAt.kind,
                        error: String(failedError?.message || failedError || 'unknown error'),
                    }
                    : null,
            },
        };
    }

    async function applyPendingEdits({ skipRender = false } = {}) {
        const hasOrchPending = Array.isArray(state.pendingEdits) && state.pendingEdits.length > 0;
        const hasApprovedLorebook = Array.isArray(state.pendingLorebookEdits)
            && state.pendingLorebookEdits.some(p => p?.status === 'approved');
        const hasRejectedLorebook = Array.isArray(state.pendingLorebookEdits)
            && state.pendingLorebookEdits.some(p => p?.status === 'rejected');
        if (!hasOrchPending && !hasApprovedLorebook && !hasRejectedLorebook) {
            return { proposed: 0, applied: 0, conflicts: [], alreadyDone: [] };
        }
        if (!hasOrchPending) {
            // Lorebook-only path: handles both approved commits and the
            // rejected-flush cleanup (which the user can trigger
            // independently when there are no committable proposals but
            // their declined decisions are still cluttering the summary
            // row). commitApprovedLorebookEdits drops rejected entries
            // unconditionally; that path is reachable whether or not any
            // approved entries exist.
            const lorebookResult = await commitApprovedLorebookEdits();
            await persistSession();
            if (!skipRender) await render();
            return { proposed: 0, applied: 0, conflicts: [], alreadyDone: [], lorebook: lorebookResult };
        }
        if (!state.live) await loadLive();
        const liveSnapshot = state.live;
        const editsBatch = state.pendingEdits.slice();
        // Sandbox-diff emits coarse `{op:'set', path:'', newValue:<whole profile>}`
        // edits — one per AI tool call, chained so each edit's newValue
        // = previous edit's newValue + this tool's mutation. lodash.set
        // with empty path is a no-op, so the multi-edit case CANNOT
        // route through applyEdits (it would silently drop every edit
        // and the commit would persist the pre-AI state, which is
        // exactly the "saved global config to character" bug). Mirror
        // rollback's loop: when every edit is an empty-path set, walk
        // them in order with applyEmptyPathSet. After the chain fix in
        // normalize, the LAST edit's newValue holds the cumulative
        // state, so the loop's final iteration produces the correct
        // result regardless of how many tool calls landed this round.
        //
        // Track per-edit outcomes so the apply truth (clean vs conflict
        // vs already-done) can travel back to the AI through the
        // synthetic feedback message.
        const allEmptyPath = editsBatch.length > 0
            && editsBatch.every(e => e?.op === 'set' && e?.path === '' && typeof e?.newValue !== 'undefined');
        let cleanEdits = [];
        let conflicts = [];
        let alreadyDone = [];
        if (allEmptyPath) {
            for (const edit of editsBatch) {
                state.live = applyEmptyPathSet(state.live, edit);
                cleanEdits.push(edit);
            }
        } else {
            const result = applyEdits(editsBatch, state.live);
            state.live = result?.newLive ?? state.live;
            cleanEdits = Array.isArray(result?.clean) ? result.clean : [];
            conflicts = Array.isArray(result?.conflicts) ? result.conflicts : [];
            alreadyDone = Array.isArray(result?.alreadyDone) ? result.alreadyDone : [];
        }
        const appliedCount = cleanEdits.length;

        const scope = getIterationDefaultScope(context);
        if (appliedCount > 0) {
            try {
                if (scope === 'character') {
                    await commitLiveToCharacter();
                } else {
                    await commitLiveToGlobal();
                }
            } catch (err) {
                state.live = liveSnapshot;
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}:${mode}] commit failed`, err);
                try { toastr.error(tf('Apply failed: ${0}', String(err?.message || err))); } catch { /* toastr may be unavailable in tests */ }
                state.session.messages.push({
                    id: makeMessageId(),
                    role: 'system',
                    content: tf('Failed to save profile: ${0}', String(err?.message || err)),
                    at: Date.now(),
                });
                await persistSession();
                if (!skipRender) await render();
                return { proposed: editsBatch.length, applied: 0, conflicts, alreadyDone, commitFailed: true };
            }
        } else {
            // Nothing landed → live stayed identical to liveSnapshot, no
            // commit needed. Restore explicitly in case any partial mutation
            // slipped through the (unreachable today) non-empty-path branch.
            state.live = liveSnapshot;
        }

        try {
            if (appliedCount === editsBatch.length) {
                toastr.success(tf('Applied ${0} edit(s) to ${1}', String(appliedCount), getApplyScopeLabel()));
            } else if (appliedCount > 0) {
                toastr.warning(tf('Applied ${0} of ${1} edit(s) to ${2}; ${3} skipped',
                    String(appliedCount), String(editsBatch.length), getApplyScopeLabel(),
                    String(conflicts.length + alreadyDone.length)));
            } else {
                toastr.warning(tf('No edits applied to ${0}: all ${1} were skipped (conflicts or already in desired state)',
                    getApplyScopeLabel(), String(editsBatch.length)));
            }
        } catch { /* ignore */ }

        // Mark the most recent unapplied assistant message that owns these
        // edits. Only stamp appliedAt when at least one edit actually
        // landed — a zero-clean batch should not render the IDE-style "✓
        // Applied" check.
        if (appliedCount > 0) {
            const messages = state.session.messages || [];
            for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i];
                if (m.role === 'assistant' && Array.isArray(m.edits) && m.edits.length > 0 && !m.appliedAt) {
                    m.appliedAt = Date.now();
                    m.appliedTarget = scope;
                    m.appliedCount = appliedCount;
                    m.appliedProposed = editsBatch.length;
                    break;
                }
            }
        }

        state.pendingEdits = [];
        // Lorebook commit phase: only runs once the orch profile commit
        // succeeded. Approved entries write to disk via CardApp; rejected
        // entries are dropped; pending (undecided) entries survive into
        // the next Apply so the user can return to them.
        const lorebookResult = await commitApprovedLorebookEdits();
        await persistSession();
        if (!skipRender) await render();
        return { proposed: editsBatch.length, applied: appliedCount, conflicts, alreadyDone, cleanEdits, lorebook: lorebookResult };
    }

    async function discardPendingEdits() {
        state.pendingEdits = [];
        await persistSession();
        await render();
    }

    /**
     * Fire the next AI round after the user reviewed a paused batch
     * (clicked Apply or Discard). `handleSendMessage`'s loop exits the
     * moment the round produces pendingEdits, so without this resumer
     * the AI never sees the outcome — even though its prior round was
     * clearly "propose edits, then continue based on review". Pushes a
     * synthetic user message describing the decision and re-enters the
     * loop, mirroring the IDE pattern (approve → tool result lands →
     * agent continues; reject → agent reconsiders).
     */
    /**
     * Build the synthetic user-message text the next round sees after a
     * batch is applied (review-mode click or auto-apply). The model reads
     * this verbatim — keep the per-edit "skipped because X" detail intact
     * so the LLM can correct its next round.
     */
    function buildApplyOutcomeUserText({ count, applied, conflicts, alreadyDone, cleanEdits, target = 'profile', autoApply = false, lorebook = null }) {
        const conflictArr = Array.isArray(conflicts) ? conflicts : [];
        const alreadyArr = Array.isArray(alreadyDone) ? alreadyDone : [];
        const cleanArr = Array.isArray(cleanEdits) ? cleanEdits : [];
        const appliedNum = Number.isInteger(applied) ? applied : count;
        const skipped = conflictArr.length + alreadyArr.length;
        const prefix = autoApply ? 'Auto-apply ran' : 'User reviewed this round';
        const lines = [];
        if (skipped === 0) {
            lines.push(`[${prefix}: all ${count} pending edit(s) took effect on the ${target}.`);
        } else {
            lines.push(`[${prefix}: ${appliedNum}/${count} edits took effect on the ${target}, ${skipped} skipped.`);
            if (conflictArr.length > 0) {
                lines.push('Skipped (conflicts):');
                for (const c of conflictArr) {
                    const edit = c?.edit || {};
                    const op = String(edit.op || '?');
                    const path = String(edit.path || '<root>');
                    const reason = String(c?.reason || 'unknown');
                    lines.push(`  - ${op}(${path}): ${reason}`);
                }
            }
            if (alreadyArr.length > 0) {
                lines.push('Already in desired state (no-op):');
                for (const e of alreadyArr) {
                    const op = String(e?.op || '?');
                    const path = String(e?.path || '<root>');
                    lines.push(`  - ${op}(${path})`);
                }
            }
            lines.push('Revise your approach for any skipped edit that was essential (re-read current state, fix the path / value).');
        }
        // List the edits that actually moved state this round so the AI
        // doesn't re-issue toggles it already made in an earlier auto-
        // apply round.
        if (cleanArr.length > 0 && appliedNum > 0) {
            lines.push('Applied paths (state that moved this round):');
            for (const e of cleanArr) {
                const op = String(e?.op || '?');
                const path = String(e?.path || '<root>');
                const note = (op === 'set' && path === '')
                    ? ' — whole profile replaced by a sandbox-diff tool; many fields may have shifted'
                    : '';
                lines.push(`  - ${op}(${path || '<root>'})${note}`);
            }
        }
        // Lorebook decisions — load-bearing for the system-prompt promise
        // that "your next round will see the rejection". The verdict lists
        // every group separately so the AI can stop re-proposing entries
        // the user already declined, and pick up the still-pending ones.
        if (lorebook && lorebook.verdict) {
            const v = lorebook.verdict;
            const fmtEntry = (e) => `    - ${String(e.bookName || '')} #${String(e.uid ?? '')} (${String(e.kind || '?')})`;
            const hasAny = (v.committed?.length || 0) + (v.rejected_dropped?.length || 0)
                + (v.still_approved?.length || 0) + (v.still_pending?.length || 0)
                + (v.failed ? 1 : 0);
            if (hasAny > 0) {
                lines.push('Lorebook decisions from this Apply:');
                if (Array.isArray(v.committed) && v.committed.length > 0) {
                    lines.push('  Committed (now live on disk):');
                    for (const e of v.committed) lines.push(fmtEntry(e));
                }
                if (Array.isArray(v.rejected_dropped) && v.rejected_dropped.length > 0) {
                    lines.push('  Rejected by user (dropped, never written to disk; do NOT re-propose without addressing the reason the user might have rejected — they likely have a reason):');
                    for (const e of v.rejected_dropped) lines.push(fmtEntry(e));
                }
                if (Array.isArray(v.still_approved) && v.still_approved.length > 0) {
                    lines.push('  Still approved but not yet committed (a commit failure halted the walk; the user can retry):');
                    for (const e of v.still_approved) lines.push(fmtEntry(e));
                }
                if (Array.isArray(v.still_pending) && v.still_pending.length > 0) {
                    lines.push('  Still pending user decision (not yet approved or rejected):');
                    for (const e of v.still_pending) lines.push(fmtEntry(e));
                }
                if (v.failed) {
                    lines.push(`  Commit failed at ${String(v.failed.bookName || '')} #${String(v.failed.uid ?? '')} (${String(v.failed.kind || '?')}): ${String(v.failed.error || 'unknown')}`);
                }
            }
        }
        lines.push('Continue with the next step if more changes are needed; respond with plain text and no tool calls when done.]');
        return lines.join('\n');
    }

    async function continueAfterReviewDecision({ action, count, applied, conflicts, alreadyDone, cleanEdits, lorebook = null }) {
        if (state.isBusy) return;
        const userText = action === 'apply'
            ? buildApplyOutcomeUserText({ count, applied, conflicts, alreadyDone, cleanEdits, target: getApplyScopeLabel(), lorebook })
            : `[User reviewed and discarded ${count} pending edit(s). Reconsider your approach — propose different edits or respond with plain text and no tool calls when finished.]`;

        state.session.messages.push({
            id: makeMessageId(),
            role: 'user',
            content: userText,
            at: Date.now(),
            auto: true,
        });

        state.isBusy = true;
        // Mirror handleSendMessage: seed the AbortController before the
        // pre-flight awaits so a Stop click during persist+render is
        // honored instead of dropped onto a null controller.
        state.abortController = new AbortController();
        await persistSession();
        await render();
        try {
            let turn = await runIterationTurn();
            while (turn?.hadAnyToolCall && state.pendingEdits.length === 0) {
                await persistSession();
                await render();
                if (state.abortController?.signal?.aborted) break;
                turn = await runIterationTurn({ autoContinueFromResult: turn.executionResult });
            }
        } catch (err) {
            if (!isAbortError(err, state.abortController?.signal)) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] continueAfterReviewDecision`, err);
                state.session.messages.push({
                    id: makeMessageId(),
                    role: 'system',
                    content: tf('Error: ${0}', String(err?.message || err)),
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
        state.pendingEdits = [];
        await persistSession();
        await render();
        const $textarea = $root.find('[data-orch-it-input]');
        $textarea.val(userText);
        await handleSendMessage();
    }

    async function rollbackBatch(messageId) {
        if (state.isBusy) return;
        const msg = (state.session.messages || []).find(m => m && m.id === messageId);
        if (!msg) return;
        if (!msg.appliedAt || msg.rolledBackAt) return;
        if (!Array.isArray(msg.edits) || msg.edits.length === 0) return;
        // eslint-disable-next-line no-alert
        if (!confirm(t('Roll back this batch? The changes will be reversed in the target.'))) return;

        loadLive();
        let working = state.live;
        // Build inverses up-front so an unsupported op fails BEFORE we
        // partial-apply anything. Right-to-left inversion handles dependent
        // edits (e.g. set then list_insert) cleanly.
        const inverses = [];
        for (const edit of msg.edits.slice().reverse()) {
            try {
                inverses.push(inverseEdit(edit));
            } catch (err) {
                console.warn(`[${MODULE}:${mode}] inverseEdit failed`, edit, err);
                try { toastr.error(tf('Cannot rollback edit type: ${0}', String(edit?.op || 'unknown'))); } catch { /* ignore */ }
                return;
            }
        }
        try {
            // Orch sandbox-diff uses empty-path set edits; inverse is the same
            // shape with oldValue/newValue swapped. Route the same way Apply
            // does so the engine's lodash.set("") no-op doesn't strand us.
            const allEmptyPath = inverses.length > 0
                && inverses.every(e => e?.op === 'set' && e?.path === '' && typeof e?.newValue !== 'undefined');
            if (allEmptyPath) {
                for (const inv of inverses) {
                    working = applyEmptyPathSet(working, inv);
                }
            } else {
                const result = applyEdits(inverses, working);
                working = result?.newLive ?? working;
            }
        } catch (err) {
            console.warn(`[${MODULE}:${mode}] applyEdits(inverses) failed`, err);
            try { toastr.error(tf('Apply failed: ${0}', String(err?.message || err))); } catch { /* ignore */ }
            return;
        }
        state.live = working;
        // Route the commit through the same scope chooser as Apply.
        const scope = msg.appliedTarget === 'character' || msg.appliedTarget === 'global'
            ? msg.appliedTarget
            : getIterationDefaultScope(context);
        try {
            if (scope === 'character') {
                await commitLiveToCharacter();
            } else {
                await commitLiveToGlobal();
            }
        } catch (err) {
            console.warn(`[${MODULE}:${mode}] commit(rollback) failed`, err);
            try { toastr.error(tf('Apply failed: ${0}', String(err?.message || err))); } catch { /* ignore */ }
            return;
        }
        msg.rolledBackAt = Date.now();
        await persistSession();
        try { toastr.success(t('Rolled back')); } catch { /* ignore */ }
        await render();
    }

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
    //   3. The model is staging edits and the user hasn't applied them yet
    //      (pendingEdits non-empty halts the auto-continue so the user gets
    //      to apply before the next round mutates `live`).
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
                && state.pendingEdits.length === 0) {
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
                    content: tf('Error: ${0}', String(err?.message || err)),
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

    // Auto-apply preference: persist per-session.
    $root.on('change.orchIt', '[data-orch-it-action="toggle-auto-apply"]', async (e) => {
        const checked = Boolean(e.currentTarget?.checked);
        state.session.surfaceState = { ...(state.session.surfaceState || {}), autoApply: checked };
        await persistSession();
        // If we just enabled it and we already have pending edits, apply
        // them immediately (consistent with the during-turn behavior).
        if (checked && state.pendingEdits.length > 0) {
            try {
                await applyPendingEdits();
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}:${mode}] auto-apply on toggle failed`, err);
            }
        }
    });

    // Apply / Discard the staged batch. Selectors use `apply-batch` /
    // `discard-batch` because the row is rendered by
    // `iteration-library/ui/apply.renderApplyControls`, which emits those
    // values via the `actionAttribute: 'data-orch-it-action'` opt — the
    // same convention M1.4's `renderMessageCard` uses for per-message
    // rollback/regenerate buttons (handlers further down).

    // Per-proposal approve/reject/undo for pending lorebook edits. These
    // only flip the local status flag on state.pendingLorebookEdits; actual
    // disk writes happen at apply-batch time (orch profile commits first,
    // then approved lorebook proposals via applyCharacterEditorLorebookCommit).
    $root.on('click.orchIt', '[data-orch-it-action="approve-lorebook"]', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = String($(e.currentTarget).attr('data-orch-it-pending-id') || '');
        const entry = (state.pendingLorebookEdits || []).find(p => p?.id === id);
        if (!entry) return;
        entry.status = 'approved';
        await render();
    });

    $root.on('click.orchIt', '[data-orch-it-action="reject-lorebook"]', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = String($(e.currentTarget).attr('data-orch-it-pending-id') || '');
        const entry = (state.pendingLorebookEdits || []).find(p => p?.id === id);
        if (!entry) return;
        entry.status = 'rejected';
        await render();
    });

    $root.on('click.orchIt', '[data-orch-it-action="reset-lorebook-decision"]', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = String($(e.currentTarget).attr('data-orch-it-pending-id') || '');
        const entry = (state.pendingLorebookEdits || []).find(p => p?.id === id);
        if (!entry) return;
        entry.status = 'pending';
        await render();
    });

    // Commit approved lorebook proposals when there's no orch profile
    // commit in flight. Goes through applyPendingEdits' lorebook-only path,
    // which short-circuits the orch-profile commit machinery.
    $root.on('click.orchIt', '[data-orch-it-action="commit-lorebook-only"]', async (e) => {
        e.preventDefault(); e.stopPropagation();
        await applyPendingEdits();
    });

    $root.on('click.orchIt', '[data-orch-it-action="apply-batch"]', async (e) => {
        e.preventDefault();
        const pendingCount = Array.isArray(state.pendingEdits) ? state.pendingEdits.length : 0;
        const outcome = await applyPendingEdits();
        // After the user reviewed + applied a paused batch, fire the next
        // AI round with a synthetic "user approved" message. The handle-
        // SendMessage loop only paused because pendingEdits gated human
        // review; the AI was mid-iteration and expects a result. Pass the
        // real outcome (applied / conflicts / alreadyDone) so the AI sees
        // truthful detail instead of just a proposed-count claim.
        if (pendingCount > 0
            && (!Array.isArray(state.pendingEdits) || state.pendingEdits.length === 0)
            && !state.isBusy) {
            await continueAfterReviewDecision({
                action: 'apply',
                count: pendingCount,
                applied: outcome?.applied,
                conflicts: outcome?.conflicts,
                alreadyDone: outcome?.alreadyDone,
                cleanEdits: outcome?.cleanEdits,
                lorebook: outcome?.lorebook,
            });
        }
    });
    $root.on('click.orchIt', '[data-orch-it-action="discard-batch"]', async (e) => {
        e.preventDefault();
        const pendingCount = Array.isArray(state.pendingEdits) ? state.pendingEdits.length : 0;
        await discardPendingEdits();
        // Mirror the apply-batch resume — discard is the AI's signal to
        // reconsider, not to stop entirely. User can still hit Stop or
        // close the popup if they're truly done.
        if (pendingCount > 0
            && (!Array.isArray(state.pendingEdits) || state.pendingEdits.length === 0)
            && !state.isBusy) {
            await continueAfterReviewDecision({ action: 'discard', count: pendingCount });
        }
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
    $root.on('click.orchIt', '[data-orch-it-action="rollback-batch"]', async (e) => {
        e.preventDefault();
        const msgId = resolveMsgId(e.currentTarget);
        if (!msgId) return;
        await rollbackBatch(msgId);
    });

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
        // the abort flag is cleared before disk write.
        await popupPromise;
    } finally {
        try { unbindResizer(); } catch { /* ignore */ }
        try { zoomOverlayUnbind?.(); } catch { /* ignore */ }
        try { unsubscribeChatChanged?.(); } catch { /* ignore */ }
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.aborting = false;
        state.abortController = null;
        try { await persistSession(); } catch { /* ignore */ }
    }
}
