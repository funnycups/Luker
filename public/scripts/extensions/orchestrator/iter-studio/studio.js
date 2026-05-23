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
 * Control tools (`luker_orch_continue_iteration` /
 * `luker_orch_finalize_iteration`) are filtered out of `toolCalls` BEFORE
 * sandbox-diff normalize. They drive popup flow only:
 *   - continue → if no pending edits, schedule another runIterationTurn
 *   - finalize → render a banner, disable composer
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
 *   - MODULE_NAME
 */

import { Popup, POPUP_TYPE } from '../../../popup.js';
import {
    applyEdits,
    bindIterWorkspaceResizer,
    inverseEdit,
    render as ITER_RENDER,
    runner as ITER_RUNNER,
    textDiff as ITER_TEXT_DIFF,
    zoomOverlay as ITER_ZOOM_OVERLAY,
} from '../../../iteration-library/index.js';
import {
    createOrchestratorIterationSessionStore,
    makeMessageId,
    normalizeMessageShape,
} from './session-store.js';

const MODULE = 'orch-iteration';
const STYLESHEET_ID = 'orch_it_studio_stylesheet';
const STYLESHEET_HREF = '/scripts/extensions/orchestrator/iter-studio/studio.css';

const CONTROL_TOOL_NAMES = Object.freeze({
    continue: 'luker_orch_continue_iteration',
    finalize: 'luker_orch_finalize_iteration',
    resetToBlank: 'luker_orch_reset_live_to_blank',
});
const CONTROL_TOOL_NAME_SET = new Set([
    CONTROL_TOOL_NAMES.continue,
    CONTROL_TOOL_NAMES.finalize,
    CONTROL_TOOL_NAMES.resetToBlank,
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
 * OpenAI-style function definitions for the two control tools that drive
 * the multi-round auto-continue loop. The orchestrator's
 * `buildAiIterationToolSet` already returns the edit-tools catalog for the
 * active mode; we splice these in alongside, but route them through
 * `onControlCall` so they never reach the sandbox executor.
 */
const CONTROL_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: CONTROL_TOOL_NAMES.continue,
            description: 'Request one automatic follow-up round after the current tools have run. Use only when more iteration is genuinely needed; otherwise call luker_orch_finalize_iteration.',
            parameters: {
                type: 'object',
                properties: {
                    note: { type: 'string', description: 'Optional rationale visible to the user.' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CONTROL_TOOL_NAMES.finalize,
            description: 'Finalize this iteration turn with a concise summary. The popup stops auto-continuing after this call.',
            parameters: {
                type: 'object',
                properties: {
                    summary: { type: 'string', description: 'Short user-facing summary of what changed.' },
                },
                additionalProperties: false,
            },
        },
    },
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
    // Short-circuit: if any edit has `path === ''` with a `newValue`, walk
    // live vs that value directly. Renderer-local bypass — the actual apply
    // path is untouched (the orchestrator's coarse `set('',profile)` shape
    // would also exhibit MG's empty-path no-op bug, but that's out of scope
    // for the workspace-upgrade and the user has working manual Apply +
    // auto-apply via the per-mode global/character apply helpers anyway).
    const emptyPathEdit = pendingEdits.find(e => e?.op === 'set' && e?.path === '' && typeof e?.newValue !== 'undefined');
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
        return renderOrchSpecPreview(live, changed, t);
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
function renderOrchSpecPreview(profile, changed, t) {
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

    return `
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Pipeline'))}</div>
            ${stageRows || `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No stages'))}</div>`}
        </div>
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Presets'))}</div>
            ${presetRows || `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No presets'))}</div>`}
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

    return `
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Loop agent'))}</div>
            ${rows}
            ${systemPromptHtml}
        </div>
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
 * Real shape nests under `director` (sanitizeDirectorProfile in
 * director-defaults.js:1008); the plan's flat `{main, subAgents}` fixture
 * is a best-guess.
 */
function renderOrchDirectorPreview(profile, changed, t) {
    const director = profile?.director && typeof profile.director === 'object' ? profile.director : {};
    const main = director.mainAgent && typeof director.mainAgent === 'object' ? director.mainAgent : {};
    const subs = Array.isArray(director.subAgents) ? director.subAgents : [];

    const mainChanged = isPrefixInChangedSet(changed, 'director.mainAgent');
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
        const path = `director.subAgents.${idx}`;
        const isChanged = isPrefixInChangedSet(changed, path);
        const subtitle = [a?.promptPresetName, a?.apiPresetName, a?.description].filter(Boolean).join(' · ');
        return `<div class="${rowClass(isChanged)}">
            <div class="luker-iter-workspace-preview-row-head">
                <span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(a?.id || '?')}</span>
                <span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(subtitle || '')}</span>
            </div>
        </div>`;
    }).join('');

    const limitsChanged = isPrefixInChangedSet(changed, 'director.maxRounds')
        || isPrefixInChangedSet(changed, 'director.maxConcurrentSubagents')
        || isPrefixInChangedSet(changed, 'director.maxTotalSubagentRuns');
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
        // Per-session surface preferences + finalize state. isFinalized +
        // finalizeSummary now ride on surfaceState (single source of truth)
        // so popup close / reload preserves them — previously they were
        // closure-local (state.isFinalized) and a popup reopen would lose
        // them on the same session.
        surfaceState: {
            historyOpen: false,
            autoApply: false,
            isFinalized: false,
            finalizeSummary: '',
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
            <div class="orch_it_finalized" data-orch-it-finalized hidden></div>
            <div class="orch_it_pending" data-orch-it-pending hidden></div>
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
    //
    // isFinalized + finalizeSummary live on state.session.surfaceState
    // (not on `state` itself) so they persist across popup close / reopen.
    // ──────────────────────────────────────────────────────────────────
    const state = {
        mode,
        session: createNewSession(mode),
        live: null,
        pendingEdits: [],
        isBusy: false,
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

    function appendScopeHintIfNeeded(basePrompt, helperSession) {
        if (helperSession?.scope !== 'character' || helperSession?.hasOverride) {
            return basePrompt;
        }
        const display = String(helperSession?.characterDisplayName || '').trim() || 'this character';
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
        const fakeSession = buildHelperSession(sanitizeForMode(state.live));
        await applyAiIterationSessionToCharacter(context, settings, fakeSession, root);
    }

    // ──────────────────────────────────────────────────────────────────
    // Persistence. Session carries the latest surfaceState, messages, and
    // a derived title (first 50 chars of the first user message).
    // ──────────────────────────────────────────────────────────────────
    async function persistSession() {
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
                isFinalized: false,
                finalizeSummary: '',
                ...(loaded.surfaceState || {}),
            },
            messages: loadedMessages.map(m => normalizeMessageShape(m, fallbackAt)),
            pendingEdits: Array.isArray(loaded.pendingEdits) ? loaded.pendingEdits.slice() : [],
        };
        state.pendingEdits = state.session.pendingEdits.slice();
        // Re-read live so a parallel editor doesn't leave the popup with
        // stale state when the user reopens an older session.
        loadLive();
        await render();
    }

    async function startNewSession() {
        state.session = createNewSession(mode);
        state.pendingEdits = [];
        loadLive();
        await sessionStore.save(state.session);
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
    // JSON-diff pending-edit card — Q8.
    //
    // Sandbox-diff emits a single `set('', newProfile)` per turn; the card
    // shows the byte delta + collapsible JSON before/after (truncated for
    // large profiles).
    // ──────────────────────────────────────────────────────────────────
    // Bulk-set edits on the working profile collapse the entire delta
    // into one `set('', oldProfile, newProfile)` edit. We split that
    // upfront into one virtual `set(<leafPath>, oldLeaf, newLeaf)` card
    // per changed leaf so the user sees per-field diffs instead of one
    // giant JSON blob. When >20 leaves changed (rare — usually means a
    // structural rewrite the user asked for), fall back to the original
    // whole-object render to avoid card flood.
    function getByPath(obj, path) {
        if (!path) return obj;
        let cur = obj;
        for (const seg of String(path).split('.')) {
            if (cur == null) return undefined;
            cur = cur[seg];
        }
        return cur;
    }

    function renderSetEditCard(path, oldValue, newValue) {
        const isWholeObject = path === '';
        const beforeText = typeof oldValue === 'string' ? oldValue : JSON.stringify(oldValue, null, 2);
        const afterText = typeof newValue === 'string' ? newValue : JSON.stringify(newValue, null, 2);
        const beforeBytes = beforeText.length;
        const afterBytes = afterText.length;
        const bytesDelta = afterBytes - beforeBytes;
        const sign = bytesDelta >= 0 ? '+' : '';
        const fileLabel = isWholeObject ? 'working profile' : path;
        const libDiffHtml = ITER_TEXT_DIFF.renderInlineTextDiffHtml(beforeText, afterText, {
            fileLabel,
            i18n: t,
            forceOpen: true,
        });
        const headerLabel = isWholeObject ? t('Profile updated') : tf('Field updated: ${0}', path);
        return `<div class="orch_it_pending_card">
            <span class="op">${escapeHtmlLocal(headerLabel)}</span>
            <span class="diff_delta">(${sign}${bytesDelta} bytes)</span>
            ${libDiffHtml}
        </div>`;
    }

    function renderPendingEditCard(edit) {
        if (edit?.op === 'set' && edit.path === ''
            && edit.oldValue && edit.newValue
            && typeof edit.oldValue === 'object' && typeof edit.newValue === 'object') {
            const changed = new Set();
            walkDiff('', edit.oldValue, edit.newValue, changed);
            if (changed.size > 0 && changed.size <= 20) {
                return [...changed].map((leafPath) => renderSetEditCard(
                    leafPath,
                    getByPath(edit.oldValue, leafPath),
                    getByPath(edit.newValue, leafPath),
                )).join('');
            }
            return renderSetEditCard('', edit.oldValue, edit.newValue);
        }
        if (edit?.op === 'set' && edit.oldValue !== undefined && edit.newValue !== undefined) {
            return renderSetEditCard(String(edit.path || ''), edit.oldValue, edit.newValue);
        }
        return `<div class="orch_it_pending_card">
            <span class="op">${escapeHtmlLocal(String(edit?.op || t('(unknown op)')))}</span>
        </div>`;
    }

    function formatTime(ts) {
        try {
            const d = new Date(Number(ts) || Date.now());
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        } catch { return ''; }
    }

    function renderToolCallChip(tc) {
        const name = String(tc?.name || '');
        let argsText;
        try { argsText = JSON.stringify(tc?.args ?? {}, null, 2); } catch { argsText = String(tc?.args ?? ''); }
        return `
            <div class="orch_it_msg_toolcall">
                <div class="orch_it_msg_toolcall_name">${escapeHtmlLocal(name || t('(tool)'))}</div>
                <pre class="orch_it_msg_toolcall_args">${escapeHtmlLocal(argsText)}</pre>
            </div>`;
    }

    function renderEditChip(edit) {
        // Reuse the pending-card renderer so the per-message audit trail
        // and the active pending block look visually identical — the user
        // doesn't have to learn two diff visual languages.
        return renderPendingEditCard(edit);
    }

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
        const content = String(message.content || '');
        let bodyHtml;
        if (role === 'assistant') {
            // sanitized by DOMPurify inside renderMessageMarkdown
            bodyHtml = ITER_RENDER.renderMessageMarkdown(content);
        } else {
            bodyHtml = escapeHtmlLocal(content).replace(/\n/g, '<br>');
        }
        const roleCls = role === 'user'
            ? 'orch_it_msg_user'
            : role === 'assistant'
                ? 'orch_it_msg_assistant'
                : 'orch_it_msg_system';
        const autoCls = message.auto ? ' orch_it_msg_auto' : '';

        const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
        const edits = Array.isArray(message.edits) ? message.edits : [];
        const hasTrail = toolCalls.length > 0 || edits.length > 0;
        const applied = Boolean(message.appliedAt) && !message.rolledBackAt;
        const rolledBack = Boolean(message.rolledBackAt);
        const detailsOpen = hasTrail && !applied && !rolledBack;

        let trailHtml = '';
        if (hasTrail) {
            const headerLabel = tf('Tools and edits this round (${0})', String(toolCalls.length + edits.length));
            const targetLabel = resolveAppliedTargetLabel(message.appliedTarget);
            const statusHtml = rolledBack
                ? `<span class="orch_it_msg_rolled_back">${escapeHtmlLocal(tf('Rolled back at ${0}', formatTime(message.rolledBackAt)))}</span>`
                : (applied
                    ? `
                        <span class="orch_it_msg_applied">${escapeHtmlLocal(tf('✓ Applied to ${0} at ${1}', targetLabel, formatTime(message.appliedAt)))}</span>
                        <button class="menu_button menu_button_small" data-orch-it-custom-action="rollback-batch" data-orch-it-msg-id="${escapeHtmlLocal(message.id || '')}">
                            ${escapeHtmlLocal(t('Rollback'))}
                        </button>
                    `
                    : '');

            const toolsHtml = toolCalls.map(renderToolCallChip).join('');
            const editsHtml = edits.map(renderEditChip).join('');

            trailHtml = `
                <details class="orch_it_msg_trail" ${detailsOpen ? 'open' : ''}>
                    <summary>${escapeHtmlLocal(headerLabel)}</summary>
                    <div class="orch_it_msg_trail_body">
                        ${toolsHtml}
                        ${editsHtml}
                    </div>
                    ${statusHtml ? `<div class="orch_it_msg_trail_status">${statusHtml}</div>` : ''}
                </details>
            `;
        }

        // Regenerate is per-assistant-message, only when it's not the
        // current tail (otherwise just hit Send again to re-run from the
        // same prompt). We also skip auto-continue synthetic assistants;
        // their prompt was synthesized so regen would just truncate to
        // the prior human turn anyway — semantically identical to
        // regenerating that prior turn.
        const isLastAssistant = (() => {
            if (role !== 'assistant') return false;
            for (let j = (allMessages?.length || 0) - 1; j > idx; j--) {
                if (allMessages[j]?.role === 'assistant') return false;
            }
            return true;
        })();
        const showRegenerate = role === 'assistant' && !isLastAssistant && !message.auto;
        const actionsHtml = showRegenerate
            ? `
                <div class="orch_it_msg_actions">
                    <button class="menu_button menu_button_small" data-orch-it-custom-action="regenerate" data-orch-it-msg-id="${escapeHtmlLocal(message.id || '')}">
                        ${escapeHtmlLocal(t('Regenerate'))}
                    </button>
                </div>`
            : '';

        return `<div class="orch_it_msg ${roleCls}${autoCls}" data-orch-it-msg-id="${escapeHtmlLocal(message.id || '')}">
            ${bodyHtml}
            ${trailHtml}
            ${actionsHtml}
        </div>`;
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
        const allMsgs = state.session.messages || [];
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

        // Finalized banner — sourced from surfaceState (persists across reload).
        const isFinalized = Boolean(state.session.surfaceState?.isFinalized);
        const finalizeSummary = String(state.session.surfaceState?.finalizeSummary || '');
        const $fin = $root.find('[data-orch-it-finalized]');
        if (isFinalized) {
            const summary = finalizeSummary
                ? escapeHtmlLocal(finalizeSummary)
                : escapeHtmlLocal(t('Session finalized'));
            $fin.html(`
                <span class="orch_it_finalized_label">${escapeHtmlLocal(t('Session finalized'))}</span>
                <span class="orch_it_finalized_summary">${summary}</span>
            `).show().attr('hidden', null);
        } else {
            $fin.html('').hide().attr('hidden', '');
        }

        // Pending edits — single Apply button per spec §3.4. The label
        // resolves to the active iteration scope (character name when a card
        // is selected, "global" otherwise). One handler ('apply') decides
        // commit target via getIterationDefaultScope() so the button can't
        // commit to the wrong scope after a parallel character switch.
        const $pending = $root.find('[data-orch-it-pending]');
        if (state.pendingEdits.length > 0) {
            const cardsHtml = state.pendingEdits.map(renderPendingEditCard).join('');
            const applyLabel = tf('Apply to ${0}', getApplyScopeLabel());
            $pending.html(`
                <div class="orch_it_pending_title">${escapeHtmlLocal(t('Pending changes'))}</div>
                <div class="orch_it_pending_list">${cardsHtml}</div>
                <div class="orch_it_pending_actions">
                    <button class="menu_button luker-iter-pending-apply" data-orch-it-action="apply">${escapeHtmlLocal(applyLabel)}</button>
                    <button class="menu_button menu_button_small" data-orch-it-action="discard-edits">${escapeHtmlLocal(t('Discard'))}</button>
                </div>
            `).show().attr('hidden', null);
        } else {
            $pending.html('').hide().attr('hidden', '');
        }

        // Composer: disable when finalized; Send label flips to Stop while busy.
        const $sendBtn = $root.find('[data-orch-it-action="send"]');
        $sendBtn.text(state.isBusy ? t('Stop') : t('Send'));
        const $textarea = $root.find('[data-orch-it-input]');
        if (isFinalized) {
            $sendBtn.prop('disabled', true);
            $textarea.prop('disabled', true);
        } else {
            $sendBtn.prop('disabled', false);
            $textarea.prop('disabled', false);
        }

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
     */
    async function normalizeToolCallToEditInline(call) {
        const before = state.live;
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
        return [...editTools, ...CONTROL_TOOL_DEFS];
    }

    async function resolveRuntimeWorldInfo(signal) {
        if (typeof resolveOrchestrationRuntimeWorldInfo !== 'function') return null;
        try {
            return await resolveOrchestrationRuntimeWorldInfo(context, settings, {
                worldInfoMessages: Array.isArray(state.session.messages) ? state.session.messages : [],
                runtimeWorldInfo: null,
                forceWorldInfoResimulate: false,
                worldInfoType: 'quiet',
                abortSignal: signal,
            });
        } catch (err) {
            console.warn(`[${MODULE}:${mode}] resolveOrchestrationRuntimeWorldInfo failed`, err);
            return null;
        }
    }

    async function runIterationTurn({ autoContinueFromResult = null } = {}) {
        const ac = new AbortController();
        state.abortController = ac;

        loadLive();   // re-read so each turn sees external edits

        const helperSession = buildHelperSession(state.live);
        const systemPrompt = appendScopeHintIfNeeded(
            buildAiIterationSystemPrompt(settings, helperSession),
            helperSession,
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
        const runtimeWorldInfo = await resolveRuntimeWorldInfo(ac.signal);

        const apiPresetName = String(settings?.aiSuggestApiPresetName || '').trim();
        const llmPresetName = String(settings?.aiSuggestPresetName || '').trim();

        const runnerSettings = {
            useStreamingTransport: Boolean(settings?.useStreamingTransport),
            toolCallRetryMax: settings?.toolCallRetryMax,
            rpmLimit: settings?.rpmLimit,
        };

        // Per-round callback bookkeeping. The runner fires onAssistantText
        // once (after validation, before return) and onToolCall once per
        // non-control call in array order. Control tools (continue /
        // finalize) route to onControlCall via the isControlCall predicate,
        // so they never pollute the edit-tool list.
        let firstAssistantText = '';
        const collectedToolCalls = [];
        let wantsAutoContinue = false;
        let sawFinalize = false;
        let finalizeSummary = '';
        let continueNote = '';

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
                },
                onControlCall: (call) => {
                    const name = String(call?.name || '');
                    if (name === CONTROL_TOOL_NAMES.continue) {
                        // Finalize is sticky: if the model emits both controls
                        // in one turn (continue, finalize OR finalize, continue)
                        // the iteration ends. Order of call arrival should not
                        // change the outcome.
                        if (!sawFinalize) {
                            wantsAutoContinue = true;
                            continueNote = String(call?.args?.note || '');
                        }
                    } else if (name === CONTROL_TOOL_NAMES.finalize) {
                        sawFinalize = true;
                        wantsAutoContinue = false;
                        finalizeSummary = String(call?.args?.summary || '');
                    } else if (name === CONTROL_TOOL_NAMES.resetToBlank) {
                        // Only accept the reset when scope is character + no
                        // override exists yet — otherwise the AI shouldn't have
                        // called it and the system prompt explicitly says so.
                        // Ignoring silently avoids clobbering an existing
                        // override the user is actively editing.
                        const helper = buildHelperSession(state.live);
                        if (helper.scope === 'character' && !helper.hasOverride) {
                            state.live = createBlankProfileForMode();
                            state.pendingEdits = [];
                            state.session.messages.push({
                                id: makeMessageId(),
                                role: 'system',
                                content: t('Working profile reset to a blank shell — building this card\'s orchestration from scratch.'),
                                at: Date.now(),
                            });
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
        const editToolCalls = collectedToolCalls.length > 0
            ? collectedToolCalls
            : (Array.isArray(result?.toolCalls)
                ? result.toolCalls.filter((c) => !isOrchControlCall(c))
                : []);
        const assistantText = firstAssistantText.trim();

        // Normalize edit-tools → edits via sandbox-diff. Multiple edit
        // calls in the same turn stack as separate edits, but Apply
        // collapses them via applyEdits's sequential application.
        const edits = [];
        for (const call of editToolCalls) {
            try {
                const normalized = await normalizeToolCallToEditInline(call);
                if (Array.isArray(normalized)) {
                    edits.push(...normalized);
                }
                // null (executor failure) → skip silently; the AI can retry.
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}:${mode}] normalizeToolCallToEditInline failed for ${String(call?.name || '')}`, err);
                state.session.messages.push({
                    id: makeMessageId(),
                    role: 'system',
                    content: tf('Edit error: ${0}', String(err?.message || err)),
                    at: Date.now(),
                });
            }
        }

        // Persist finalize state on surfaceState (single source of truth) so
        // popup close / reload retains it. `sawFinalize` is set in the
        // onControlCall callback above for the finalize branch — true even
        // when finalizeSummary is an empty string.
        if (sawFinalize) {
            state.session.surfaceState = state.session.surfaceState || {};
            state.session.surfaceState.isFinalized = true;
            state.session.surfaceState.finalizeSummary = finalizeSummary;
        }

        // Stage the assistant message with the full per-round audit trail.
        // Falls back to a synthesized summary when the model emitted tool
        // calls without text so the chat doesn't have empty bubbles. The
        // toolCalls + edits + appliedAt fields drive renderMessageCard's
        // collapsible details block, Apply marker, and Rollback button.
        let content = assistantText;
        if (!content && editToolCalls.length > 0) {
            const names = editToolCalls
                .map(c => String(c?.name || ''))
                .filter(Boolean)
                .join(', ');
            content = tf('Suggested actions: ${0}', names);
        }
        if (!content && (wantsAutoContinue || finalizeSummary)) {
            content = finalizeSummary || t('Continuing...');
        }
        const assistantMsg = {
            id: makeMessageId(),
            role: 'assistant',
            content: content || '',
            at: Date.now(),
        };
        if (editToolCalls.length > 0) {
            assistantMsg.toolCalls = editToolCalls.map(tc => ({
                id: String(tc?.id || ''),
                name: String(tc?.name || ''),
                args: tc?.args ?? {},
            }));
        }
        if (edits.length > 0) {
            assistantMsg.edits = edits.slice();
        }
        state.session.messages.push(assistantMsg);

        // Replace pendingEdits with this round's batch. We don't append:
        // staging is per-round so the user can Apply or Discard cleanly
        // before the next AI request fires.
        state.pendingEdits = edits;

        // Mobile workspace: if the user was on the Preview tab, bump the
        // chat-tab badge so they know new assistant content arrived without
        // forcing a tab switch.
        bumpChatBadge();

        // Composer-row auto-apply: if enabled AND this turn produced edits,
        // AND we are not finalized, apply immediately. Errors are caught
        // locally so the runner's outer finally still resets isBusy +
        // persists the session.
        const autoApplyOn = Boolean(state.session.surfaceState?.autoApply);
        if (autoApplyOn && state.pendingEdits.length > 0 && !state.session.surfaceState?.isFinalized) {
            try {
                await applyPendingEdits({ skipRender: true });
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}:${mode}] auto-apply failed`, err);
            }
        }

        // Build a synthetic execution result the auto-continue prompt
        // builder can consume. We pass a minimal shape (`finalized`,
        // `continueRequested`, summary if any) — the orchestrator's
        // builder tolerates missing fields.
        const syntheticExecutionResult = {
            actions: [],
            simulations: [],
            toolResults: [],
            finalized: Boolean(state.session.surfaceState?.isFinalized),
            finalizeSummary: String(state.session.surfaceState?.finalizeSummary || ''),
            continueRequested: wantsAutoContinue,
            continueNote,
            changed: edits.length > 0,
            hasPending: edits.length > 0,
        };

        return {
            wantsAutoContinue,
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
    async function applyPendingEdits({ skipRender = false } = {}) {
        if (!Array.isArray(state.pendingEdits) || state.pendingEdits.length === 0) return;
        if (!state.live) await loadLive();
        const liveSnapshot = state.live;
        // Sandbox-diff emits a single coarse {op:'set', path:'', newValue:<whole profile>}.
        // lodash.set with empty path is a no-op, so route empty-path edits
        // around the engine via applyEmptyPathSet — otherwise auto-apply and
        // the manual Apply button both silently skip the commit.
        const onlyEdit = state.pendingEdits.length === 1 ? state.pendingEdits[0] : null;
        const emptyPathEdit = onlyEdit && onlyEdit.op === 'set' && onlyEdit.path === '' && typeof onlyEdit.newValue !== 'undefined'
            ? onlyEdit
            : null;
        if (emptyPathEdit) {
            state.live = applyEmptyPathSet(state.live, emptyPathEdit);
        } else {
            const result = applyEdits(state.pendingEdits, state.live);
            state.live = result?.newLive ?? state.live;
        }

        const scope = getIterationDefaultScope(context);
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
            return;
        }

        try { toastr.success(tf('Applied to ${0}', getApplyScopeLabel())); } catch { /* ignore */ }

        // Mark the most recent unapplied assistant message that owns these
        // edits. We scan back from the end because the just-rendered turn
        // is the typical target; rare cases (user clicks Apply on a stale
        // session reopened with persisted pendingEdits) still hit a sane
        // candidate as long as one exists.
        const messages = state.session.messages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role === 'assistant' && Array.isArray(m.edits) && m.edits.length > 0 && !m.appliedAt) {
                m.appliedAt = Date.now();
                m.appliedTarget = scope;
                break;
            }
        }

        state.pendingEdits = [];
        await persistSession();
        if (!skipRender) await render();
    }

    async function discardPendingEdits() {
        state.pendingEdits = [];
        await persistSession();
        await render();
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
        // Drop finalize state too — a regenerate is a "rewind" so the
        // surface state should match the pre-finalize point.
        if (state.session.surfaceState) {
            state.session.surfaceState.isFinalized = false;
            state.session.surfaceState.finalizeSummary = '';
        }
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
    // Multi-round auto-continue: when the AI emits
    // `luker_orch_continue_iteration`, runIterationTurn returns
    // `wantsAutoContinue: true` and the loop fires another round (after
    // rendering the previous round so the user sees progressive output).
    // The ONLY exits are:
    //   1. The model called `luker_orch_finalize_iteration` (no continue).
    //   2. The model did neither (e.g. produced edits + stopped).
    //   3. The user clicked Stop (abortController fires; isAbortError
    //      catches the resulting error in the catch block).
    //   4. The model is staging edits and the user hasn't applied them yet
    //      (pendingEdits non-empty halts the auto-continue so the user gets
    //      to apply before the next round mutates `live`).
    // There is NO hard round cap — runaway loops are the user's problem
    // and a single Stop click ends them.
    // ──────────────────────────────────────────────────────────────────
    async function handleSendMessage() {
        if (state.isBusy) {
            // Stop request: abort the in-flight runner call.
            try { state.abortController?.abort(); } catch { /* ignore */ }
            return;
        }
        if (state.session.surfaceState?.isFinalized) return;
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
        await persistSession();
        await render();   // Q6: user message visible before LLM wait
        try {
            let turn = await runIterationTurn();
            while (turn?.wantsAutoContinue
                && state.pendingEdits.length === 0
                && !state.session.surfaceState?.isFinalized) {
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

    // Initial persist so the session shows up in the history list right
    // away (the user might dismiss without sending a message and still
    // want the empty session as a checkpoint).
    await sessionStore.save(state.session);

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
        if (checked && state.pendingEdits.length > 0 && !state.session.surfaceState?.isFinalized) {
            try {
                await applyPendingEdits();
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}:${mode}] auto-apply on toggle failed`, err);
            }
        }
    });

    $root.on('click.orchIt', '[data-orch-it-action="apply"]', async (e) => {
        e.preventDefault();
        await applyPendingEdits();
    });
    $root.on('click.orchIt', '[data-orch-it-action="discard-edits"]', async (e) => {
        e.preventDefault();
        await discardPendingEdits();
    });

    // Session-switch handlers — abort in-flight LLM + reset busy flag before
    // the swap so a stale response can't land in the newly-loaded session.
    $root.on('click.orchIt', '[data-orch-it-action="new-session"]', async (e) => {
        e.preventDefault();
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.abortController = null;
        await startNewSession();
    });
    // Q9: clear-history lives inside the <details>; same delegation root.
    $root.on('click.orchIt', '[data-orch-it-action="clear-history"]', async (e) => {
        e.preventDefault();
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
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
            state.abortController = null;
        }
        await sessionStore.delete(id);
        if (state.session.id === id) {
            await startNewSession();
        } else {
            await render();
        }
    });

    // Per-message custom actions (Regenerate / Rollback). Use
    // `data-orch-it-custom-action` rather than `data-orch-it-action` so the
    // legacy delegation selectors above can't accidentally fire on these —
    // matches the iter-studio shell gotcha pattern.
    $root.on('click.orchIt', '[data-orch-it-custom-action="regenerate"]', async (e) => {
        e.preventDefault();
        const msgId = String(e.currentTarget?.dataset?.orchItMsgId || '');
        if (!msgId) return;
        await regenerateFromMessage(msgId);
    });
    $root.on('click.orchIt', '[data-orch-it-custom-action="rollback-batch"]', async (e) => {
        e.preventDefault();
        const msgId = String(e.currentTarget?.dataset?.orchItMsgId || '');
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
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.abortController = null;
        try { await persistSession(); } catch { /* ignore */ }
    }
}
