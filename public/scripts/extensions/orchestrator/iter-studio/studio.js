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
    render as ITER_RENDER,
    runner as ITER_RUNNER,
    textDiff as ITER_TEXT_DIFF,
    zoomOverlay as ITER_ZOOM_OVERLAY,
} from '../../../iteration-library/index.js';
import { createOrchestratorIterationSessionStore } from './session-store.js';

const MODULE = 'orch-iteration';
const STYLESHEET_ID = 'orch_it_studio_stylesheet';
const STYLESHEET_HREF = '/scripts/extensions/orchestrator/iter-studio/studio.css';

const CONTROL_TOOL_NAMES = Object.freeze({
    continue: 'luker_orch_continue_iteration',
    finalize: 'luker_orch_finalize_iteration',
});
const CONTROL_TOOL_NAME_SET = new Set([CONTROL_TOOL_NAMES.continue, CONTROL_TOOL_NAMES.finalize]);

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
 * SPEC mode renderer — surface stages, modes, nodes (with preset names).
 * Reads the real shape `{spec: {stages, defaultTools}, presets}`. The
 * `spec.mode === 'director'` carve-out handled by `sanitizeSpec` is
 * irrelevant here — the popup's outer dispatcher routes by `state.session.mode`
 * not by the profile shape.
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
    return `
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(t('Pipeline'))}</div>
            ${stageRows || `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No stages'))}</div>`}
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
        surfaceState: { historyOpen: false, autoApply: false },
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
    // active editor. `pendingEdits` always contains 0 or 1 entries since
    // the sandbox-diff emits one coarse `set('', newProfile)` per turn.
    // ──────────────────────────────────────────────────────────────────
    const state = {
        mode,
        session: createNewSession(mode),
        live: null,
        pendingEdits: [],
        isBusy: false,
        abortController: null,
        isFinalized: false,
        finalizeSummary: '',
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
        return {
            id: state.session.id,
            title: state.session.title,
            messages: state.session.messages,
            workingProfile: workingProfile != null ? workingProfile : state.live,
            mode,
        };
    }

    // ──────────────────────────────────────────────────────────────────
    // Commit live → orchestrator settings via the existing global apply
    // helper. Per-character apply is a separate button (see action
    // handler below).
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
        if (!state.session.title) {
            const firstUser = state.session.messages.find(m => m.role === 'user');
            if (firstUser) {
                state.session.title = String(firstUser.content || '').slice(0, 50);
            }
        }
        await sessionStore.save(state.session);
    }

    async function loadSession(id) {
        const loaded = await sessionStore.load(id);
        if (!loaded) return;
        state.session = {
            ...loaded,
            mode,
            surfaceState: { historyOpen: false, autoApply: false, ...(loaded.surfaceState || {}) },
        };
        state.pendingEdits = [];
        state.isFinalized = false;
        state.finalizeSummary = '';
        await render();
    }

    async function startNewSession() {
        state.session = createNewSession(mode);
        state.pendingEdits = [];
        state.isFinalized = false;
        state.finalizeSummary = '';
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
    // into one `set('', oldProfile, newProfile)` edit. Rather than dump
    // the full JSON we surface a side-by-side LCS diff using the
    // iteration-library renderer — the user sees the byte delta in the
    // header and can drill into the line-level diff via the embedded
    // `<details>`.
    function renderPendingEditCard(edit) {
        if (edit?.op === 'set' && edit.path === '' && edit.oldValue && edit.newValue) {
            const beforeJson = JSON.stringify(edit.oldValue, null, 2);
            const afterJson = JSON.stringify(edit.newValue, null, 2);
            const beforeBytes = JSON.stringify(edit.oldValue).length;
            const afterBytes = JSON.stringify(edit.newValue).length;
            const bytesDelta = afterBytes - beforeBytes;
            const sign = bytesDelta >= 0 ? '+' : '';
            const libDiffHtml = ITER_TEXT_DIFF.renderInlineTextDiffHtml(beforeJson, afterJson, {
                fileLabel: 'working profile',
                i18n: t,
                forceOpen: true,
            });
            return `<div class="orch_it_pending_card">
                <span class="op">${escapeHtmlLocal(t('Profile updated'))}</span>
                <span class="diff_delta">(${sign}${bytesDelta} bytes)</span>
                ${libDiffHtml}
            </div>`;
        }
        return `<div class="orch_it_pending_card">
            <span class="op">${escapeHtmlLocal(String(edit?.op || t('(unknown op)')))}</span>
        </div>`;
    }

    // ──────────────────────────────────────────────────────────────────
    // Chat-message rendering. Q2 + Q7:
    //   - assistant messages route through the library's markdown renderer
    //     (sanitized via DOMPurify, so embedding via `innerHTML` is XSS-safe).
    //   - user / assistant / system messages get distinct CSS classes.
    // ──────────────────────────────────────────────────────────────────
    function renderMessage(message) {
        const role = String(message?.role || 'user');
        const content = message?.content || '';
        let bodyHtml;
        if (role === 'assistant') {
            bodyHtml = ITER_RENDER.renderMessageMarkdown(content);
        } else {
            bodyHtml = escapeHtmlLocal(String(content)).replace(/\n/g, '<br>');
        }
        const roleCls = role === 'user'
            ? 'orch_it_msg_user'
            : role === 'assistant'
                ? 'orch_it_msg_assistant'
                : 'orch_it_msg_system';
        return `<div class="orch_it_msg ${roleCls}">${bodyHtml}</div>`;
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

        // Auto-apply checkbox: sync to persisted preference.
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

        // Messages
        const messagesHtml = (state.session.messages || []).map(renderMessage).join('');
        const $msgs = $root.find('[data-orch-it-messages]');
        $msgs.html(messagesHtml);
        // Auto-scroll so newly-appended messages are visible.
        try {
            const node = $msgs[0];
            if (node && typeof node.scrollTop === 'number') {
                node.scrollTop = node.scrollHeight;
            }
        } catch { /* DOM not attached (test) */ }

        // Finalized banner
        const $fin = $root.find('[data-orch-it-finalized]');
        if (state.isFinalized) {
            const summary = state.finalizeSummary
                ? escapeHtmlLocal(state.finalizeSummary)
                : escapeHtmlLocal(t('Session finalized'));
            $fin.html(`
                <span class="orch_it_finalized_label">${escapeHtmlLocal(t('Session finalized'))}</span>
                <span class="orch_it_finalized_summary">${summary}</span>
            `).show().attr('hidden', null);
        } else {
            $fin.html('').hide().attr('hidden', '');
        }

        // Pending edits
        const $pending = $root.find('[data-orch-it-pending]');
        if (state.pendingEdits.length > 0) {
            const cardsHtml = state.pendingEdits.map(renderPendingEditCard).join('');
            const hasAvatar = Boolean(
                String(context?.characters?.[context?.characterId]?.avatar || '').trim(),
            );
            const charBtnAttrs = hasAvatar ? '' : ' disabled title="' + escapeHtmlLocal(t('No active character')) + '"';
            $pending.html(`
                <div class="orch_it_pending_title">${escapeHtmlLocal(t('Pending changes'))}</div>
                <div class="orch_it_pending_list">${cardsHtml}</div>
                <div class="orch_it_pending_actions">
                    <button class="menu_button" data-orch-it-action="apply-global">${escapeHtmlLocal(t('Apply to global'))}</button>
                    <button class="menu_button" data-orch-it-action="apply-character"${charBtnAttrs}>${escapeHtmlLocal(t('Apply to character'))}</button>
                    <button class="menu_button" data-orch-it-action="discard-edits">${escapeHtmlLocal(t('Discard'))}</button>
                </div>
            `).show().attr('hidden', null);
        } else {
            $pending.html('').hide().attr('hidden', '');
        }

        // Composer: disable when finalized or busy; Send label flips to Stop.
        const $sendBtn = $root.find('[data-orch-it-action="send"]');
        $sendBtn.text(state.isBusy ? t('Stop') : t('Send'));
        const $textarea = $root.find('[data-orch-it-input]');
        if (state.isFinalized) {
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
     * Strip control tools from the catalog so the LLM sees one canonical
     * set of definitions. The mode-aware `buildAiIterationToolSet`
     * includes continue/finalize tools as part of every catalog; the
     * popup handles them explicitly (see runIterationTurn) but doesn't
     * need them present in the catalog the runner ships to the model.
     *
     * NB: keeping the control tools IN the catalog is harmless (the
     * filter step that follows handles them either way) but stripping
     * them prevents the model from seeing duplicate definitions if a
     * future executor refactor injects them from another source.
     */
    function buildToolCatalog() {
        const helperSession = buildHelperSession(state.live);
        const all = buildAiIterationToolSet(helperSession) || [];
        return all;
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
        const systemPrompt = buildAiIterationSystemPrompt(settings, helperSession);

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
            state.session.messages.push({
                role: 'user',
                content: lastUserText,
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
            },
        );

        const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
        const assistantText = String(result?.assistantText || '').trim();

        // Partition tool calls: control tools drive popup flow; edit tools
        // go through sandbox-diff normalize.
        let wantsAutoContinue = false;
        const editToolCalls = [];
        for (const call of toolCalls) {
            const name = String(call?.name || '');
            if (name === CONTROL_TOOL_NAMES.continue) {
                wantsAutoContinue = true;
            } else if (name === CONTROL_TOOL_NAMES.finalize) {
                state.isFinalized = true;
                state.finalizeSummary = String(call?.args?.summary || '').trim();
            } else {
                editToolCalls.push(call);
            }
        }

        // Normalize edit-tools → edits via sandbox-diff. Multiple edit
        // calls in the same turn stack as separate edits, but Apply
        // collapses them via applyEdits's sequential application.
        const edits = [];
        for (const call of editToolCalls) {
            const normalized = await normalizeToolCallToEditInline(call);
            if (Array.isArray(normalized)) {
                edits.push(...normalized);
            }
            // null (executor failure) → skip silently.
        }
        state.pendingEdits = edits;

        // Push assistant message (visible). If the model returned text,
        // use it; if not but produced tool calls, synthesize a brief
        // stand-in so the chat doesn't have empty bubbles.
        if (assistantText) {
            state.session.messages.push({ role: 'assistant', content: assistantText });
        } else if (toolCalls.length > 0) {
            const names = toolCalls.map(c => String(c?.name || '')).filter(Boolean).join(', ');
            state.session.messages.push({
                role: 'assistant',
                content: t('Suggested actions: ') + names,
            });
        }

        // Mobile workspace: if the user was on the Preview tab, bump the
        // chat-tab badge so they know new assistant content arrived without
        // forcing a tab switch.
        bumpChatBadge();

        // Mode-aware auto-apply: when checked AND new edits arrived AND
        // we are not finalized, apply immediately. (Order: apply BEFORE
        // evaluating auto-continue so the next turn sees the new live.)
        const autoApply = Boolean(state.session.surfaceState?.autoApply);
        if (autoApply && state.pendingEdits.length > 0 && !state.isFinalized) {
            try {
                await applyPendingEdits({ skipRender: true });
            } catch (err) {
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
            finalized: state.isFinalized,
            finalizeSummary: state.finalizeSummary,
            continueRequested: wantsAutoContinue,
            changed: edits.length > 0,
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
    // re-read so a parallel editor doesn't blow away their work.
    // ──────────────────────────────────────────────────────────────────
    async function applyPendingEdits({ skipRender = false, target = 'global' } = {}) {
        if (state.pendingEdits.length === 0) return;
        loadLive();
        // Sandbox-diff emits a single coarse {op:'set', path:'', newValue:<whole profile>}.
        // lodash.set with empty path is a no-op, so route empty-path edits
        // around the engine via applyEmptyPathSet — otherwise auto-apply and
        // the manual Apply button both silently skip the commit. Mirrors the
        // same fix shipped for memory-graph in 3fc75b35.
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
        state.pendingEdits = [];
        try {
            if (target === 'character') {
                await commitLiveToCharacter();
            } else {
                await commitLiveToGlobal();
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}:${mode}] commit failed`, err);
            state.session.messages.push({
                role: 'system',
                content: t('Failed to apply changes: ') + String(err?.message || err),
            });
        }
        await persistSession();
        if (!skipRender) await render();
    }

    async function discardPendingEdits() {
        state.pendingEdits = [];
        await render();
    }

    // ──────────────────────────────────────────────────────────────────
    // Send-message handler. Q6: user message is pushed AND rendered
    // BEFORE the await so the user sees their own input before the LLM
    // wait spinner starts. Errors surface as system messages.
    //
    // Auto-continue loop: when the model emits a `continue` control tool
    // AND no edits are pending (so we don't preempt the user's apply
    // decision), the popup schedules another turn with the synthesized
    // auto-continue prompt. Loop bounded by `maxAutoContinueRounds` to
    // prevent runaway costs.
    // ──────────────────────────────────────────────────────────────────
    const MAX_AUTO_CONTINUE_ROUNDS = 6;

    async function handleSendMessage() {
        if (state.isBusy) {
            try { state.abortController?.abort(); } catch { /* ignore */ }
            return;
        }
        if (state.isFinalized) return;
        const $textarea = $root.find('[data-orch-it-input]');
        const text = String($textarea.val() || '').trim();
        if (!text) return;
        $textarea.val('');
        state.session.messages.push({ role: 'user', content: text });
        state.isBusy = true;
        await persistSession();
        await render();   // Q6: user message visible before LLM wait
        try {
            let turn = await runIterationTurn();
            let rounds = 0;
            while (turn.wantsAutoContinue
                && state.pendingEdits.length === 0
                && !state.isFinalized
                && rounds < MAX_AUTO_CONTINUE_ROUNDS) {
                rounds++;
                await persistSession();
                await render();
                turn = await runIterationTurn({ autoContinueFromResult: turn.executionResult });
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}:${mode}]`, err);
            state.session.messages.push({
                role: 'system',
                content: t('Error: ') + String(err?.message || err),
            });
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
        if (checked && state.pendingEdits.length > 0 && !state.isFinalized) {
            await applyPendingEdits();
        }
    });

    $root.on('click.orchIt', '[data-orch-it-action="apply-global"]', async (e) => {
        e.preventDefault();
        await applyPendingEdits({ target: 'global' });
    });
    $root.on('click.orchIt', '[data-orch-it-action="apply-character"]', async (e) => {
        e.preventDefault();
        if (e.currentTarget?.disabled) return;
        await applyPendingEdits({ target: 'character' });
    });
    $root.on('click.orchIt', '[data-orch-it-action="discard-edits"]', async (e) => {
        e.preventDefault();
        await discardPendingEdits();
    });
    $root.on('click.orchIt', '[data-orch-it-action="new-session"]', async (e) => {
        e.preventDefault();
        await startNewSession();
    });
    // Q9: clear-history lives inside the <details>; same delegation root.
    $root.on('click.orchIt', '[data-orch-it-action="clear-history"]', async (e) => {
        e.preventDefault();
        await clearAllHistory();
    });
    $root.on('click.orchIt', '[data-orch-it-action="load-session"]', async (e) => {
        // The delete button is a child of the load row — stop the row's
        // click from firing when the user is removing an item.
        const target = e.target;
        if (target && target.matches?.('[data-orch-it-action="delete-session"]')) return;
        const id = String(e.currentTarget?.dataset?.orchItId || '');
        if (id && id !== state.session.id) {
            await loadSession(id);
        }
    });
    $root.on('click.orchIt', '[data-orch-it-action="delete-session"]', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = String(e.currentTarget?.dataset?.orchItId || '');
        if (!id) return;
        await sessionStore.delete(id);
        if (state.session.id === id) {
            await startNewSession();
        } else {
            await render();
        }
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
    const unbindResizer = bindIterWorkspaceResizer($root[0]);

    await render();

    // Block until the user dismisses the popup. Persist one final time so
    // any in-flight composer / surfaceState changes survive close.
    try {
        await popupPromise;
    } finally {
        try { unbindResizer(); } catch { /* ignore */ }
    }
    try { state.abortController?.abort(); } catch { /* ignore */ }
    try { zoomOverlayUnbind?.(); } catch { /* ignore */ }
    await persistSession();

    // Silence unused-import lint for tf in environments where i18nFormat
    // isn't surfaced through any rendered string yet. (Kept threaded
    // through deps so callers can swap in localized formats later.)
    void tf;
}
