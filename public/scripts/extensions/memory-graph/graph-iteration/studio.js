// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Memory Graph — AI graph-revision popup (plugin-owned).
 *
 * Single-column chat surface that wires `iteration-library/*` helpers
 * directly: per-chat session storage (`session-store.js`, chat-state
 * namespace), the tool-calling runner, markdown rendering, and the shared
 * ProposalBus for reviewable write proposals.
 *
 * Read-first: no up-front graph dump. The model calls the read tools
 * (graph reads + shared world-book reads) on demand, then proposes writes;
 * every write batch is staged as one review card and only approval touches
 * the live graph.
 *
 * Layout:
 *
 *   ┌────────────────────────────────────────────┐
 *   │ <details> History … New, Clear </details>  │
 *   │ <div> message list (chat)         </div>   │
 *   │ <div> pending edits (when staged) </div>   │
 *   │ <div> composer textarea + Send    </div>   │
 *   └────────────────────────────────────────────┘
 *
 * The popup is mounted via `new Popup(..., POPUP_TYPE.DISPLAY)` so it has no
 * built-in OK / Cancel buttons; the user dismisses it via the dialog's close
 * button (top-right ✕). Sessions auto-persist on every mutation, so closing
 * mid-conversation is safe.
 *
 * Entry point:
 *   `openGraphIterationStudio(deps)`
 *
 * Deps shape:
 *   - context                          SillyTavern context
 *   - settings                         MG settings reference (extension_settings.memory_graph)
 *   - ensureStoreSyncedWithChat(ctx)   returns the runtime store synced with disk
 *   - commitGraphUiMutation(ctx, chatKey, { beforeStore, afterStore, replaceGraph, seq })
 *                                       shared UI-mutation commit path
 *   - getChatKey(ctx)                  stable per-chat key
 *   - getEffectiveSettings(ctx, settings)
 *   - getEffectiveNodeTypeSchema(ctx, settings)
 *   - syncGraphVectorsAfterMutation(ctx, chatKey, store)
 *   - readChatRange(ctx, from, to)
 *   - searchGraphSimilarNodes(ctx, query, opts)
 *   - i18n, i18nFormat
 */

const __ctx = Luker.getContext();
const Popup = __ctx.Popup;
const POPUP_TYPE = __ctx.POPUP_TYPE;
const POPUP_RESULT = __ctx.POPUP_RESULT;
import {
    bindIterWorkspaceResizer,
    createRenderScheduler,
    render as ITER_RENDER,
    runner as ITER_RUNNER,
    tools as ITER_TOOLS,
    zoomOverlay as ITER_ZOOM_OVERLAY,
    ui as ITER_UI,
    proposalBus as ITER_PROPOSAL_BUS,
} from '../../../iteration-library/index.js';
import { registerTarget } from '../../../iteration-library/storage/target-registry.js';
import { applyOps } from '../../../iteration-library/storage/patch-codec.js';
import { mdLiteral } from '../../../iteration-library/markdown-escape.js';
import { isReplayableIterationMessage } from '../../../iteration-library/iter-message-filter.js';
import {
    buildEditToolResultPayload,
    buildPayloadForOutcome,
} from '../../../iteration-library/edit-tool-result-envelope.js';
import {
    GRAPH_TOOL_DEFS,
    isGraphReadTool,
    isGraphWriteTool,
    executeGraphReadTool,
    executeGraphWriteTool,
} from './tools.js';
import { MG_GRAPH_TOOL_DISPLAY } from './tool-display.js';
import { buildGraphIterSystemPrompt } from './system-prompt.js';
import {
    createMgGraphSessionStore,
    makeMessageId,
    normalizeMessageShape,
    restorePendingChain,
} from './session-store.js';
import {
    canonicalFromStore,
    applyCanonicalToStore,
    docsEqual,
    docsTouchNodes,
} from './canonical.js';
import {
    buildGraphDiffSummary,
    renderMgGraphDiffCard,
    renderMgGraphDiffSummary,
} from './diff-cards.js';
import { renderMgGraphPreviewPane } from './preview.js';
import { getMemoryGraphWriteApi } from '../write-api.js';

const MODULE = 'mg-graph-iteration';
const STYLESHEET_ID = 'mg_graph_it_studio_stylesheet';
const ITERATION_KIND = 'mg-graph-store';
const TARGET_TYPE = 'memory-graph';
const STYLESHEET_HREF = '/scripts/extensions/memory-graph/graph-iteration/studio.css';
const PROPOSAL_BUS_STYLESHEET_ID = 'mg_graph_it_proposal_bus_stylesheet';
const PROPOSAL_BUS_STYLESHEET_HREF = '/scripts/iteration-library/proposal-bus/proposal-bus.css';

/**
 * Inject the popup stylesheet on first open. Idempotent (id-keyed lookup).
 */
function ensureStylesheetInjected() {
    if (typeof document === 'undefined') return;
    if (!document.getElementById(STYLESHEET_ID)) {
        const link = document.createElement('link');
        link.id = STYLESHEET_ID;
        link.rel = 'stylesheet';
        link.href = STYLESHEET_HREF;
        document.head.appendChild(link);
    }
    if (!document.getElementById(PROPOSAL_BUS_STYLESHEET_ID)) {
        const link = document.createElement('link');
        link.id = PROPOSAL_BUS_STYLESHEET_ID;
        link.rel = 'stylesheet';
        link.href = PROPOSAL_BUS_STYLESHEET_HREF;
        document.head.appendChild(link);
    }
}

function escapeHtmlLocal(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function makeSessionId() {
    return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isAbortError(err, signal) {
    if (signal?.aborted) return true;
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    const msg = String(err.message || err);
    return /aborted|Aborted/.test(msg);
}

function serializeGraphToolError(err) {
    if (err && typeof err === 'object' && err.envelope && typeof err.envelope === 'object') {
        return err.envelope;
    }
    return { error: String(err?.message || err || 'tool failed') };
}

// Shared world-book read tools (iteration-library). The graph studio keeps
// them for alias / worldview disambiguation when editing facts; they are
// read-only reference material, never copied into graph fields.
const { isLorebookReadTool, LOREBOOK_READ_TOOL_DEFS, runLorebookReadTool: runLorebookReadToolShared } = ITER_TOOLS.lorebookReads;

async function runLorebookReadTool(call, avatar = '') {
    return runLorebookReadToolShared(call, { context: __ctx, avatar });
}

export { createNewSession as _testOnly_createNewSession };

function createNewSession() {
    const now = Date.now();
    return {
        id: makeSessionId(),
        title: '',
        messages: [],
        surfaceState: { historyOpen: false, autoApply: false },
        updatedAt: now,
        createdAt: now,
        summary: '',
        // Skip-persist marker for empty draft sessions. persistSession's
        // guard reads this and short-circuits when the session has no
        // messages + no pending proposals — without it, mount-time popup
        // open + close (without sending anything) would write a phantom
        // row to the history list. Cleared in persistSession the first
        // time the session has meaningful content.
        _transient: true,
    };
}

/**
 * Build the popup root HTML. Built once on open; per-render mutations scope
 * to subordinate `[data-mg-graph-it-*]` slots so we never re-mount the
 * textarea (which would lose focus + the in-progress draft).
 */
function buildPopupHtml({
    popupId,
    title,
    historyOpen,
    historyLabel,
    newSessionLabel,
    clearAllLabel,
    sendLabel,
    composerPlaceholder,
    autoApply,
    autoApplyLabel,
    chatTabLabel,
    previewTabLabel,
    chatBadgeAriaLabel,
    resizerAriaLabel,
}) {
    return `
<div id="${popupId}" class="mg_graph_it_popup luker-iter-workspace" data-iter-layout="split" data-iter-active-tab="chat">
    <div class="mg_graph_it_title">${escapeHtmlLocal(title)}</div>
    <details class="mg_graph_it_history" data-mg-graph-it-history${historyOpen ? ' open' : ''}>
        <summary>${escapeHtmlLocal(historyLabel)}</summary>
        <div class="mg_graph_it_history_items" data-mg-graph-it-history-items></div>
        <div class="mg_graph_it_history_actions">
            <button class="menu_button menu_button_small" data-mg-graph-it-action="new-session">${escapeHtmlLocal(newSessionLabel)}</button>
            <button class="menu_button menu_button_small" data-mg-graph-it-action="clear-history">${escapeHtmlLocal(clearAllLabel)}</button>
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
            <div class="mg_graph_it_messages" data-mg-graph-it-messages></div>
            <div class="mg_graph_it_composer">
                <textarea class="text_pole" rows="2" data-mg-graph-it-input data-iter-input placeholder="${escapeHtmlLocal(composerPlaceholder)}"></textarea>
                <div class="mg_graph_it_composer_actions">
                    <label class="mg_graph_it_composer_auto_apply">
                        <input type="checkbox" data-mg-graph-it-action="toggle-auto-apply"${autoApply ? ' checked' : ''}>
                        <span>${escapeHtmlLocal(autoApplyLabel)}</span>
                    </label>
                    <div class="mg_graph_it_composer_buttons">
                        <button class="menu_button" data-mg-graph-it-action="send">${escapeHtmlLocal(sendLabel)}</button>
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
 * Open the Memory Graph schema AI iteration popup.
 *
 * Resolves when the user dismisses the dialog. Sessions are persisted eagerly
 * on every mutation so dismiss-without-save is irrelevant.
 *
 * @param {object} deps See module header for shape.
 */
export async function openGraphIterationStudio(deps) {
    if (!deps || typeof deps !== 'object') {
        throw new TypeError('openGraphIterationStudio: deps is required');
    }
    const {
        context,
        settings,
        ensureStoreSyncedWithChat,
        commitGraphUiMutation,
        getChatKey,
        getEffectiveSettings,
        getEffectiveNodeTypeSchema,
        syncGraphVectorsAfterMutation,
        readChatRange,
        searchGraphSimilarNodes,
        i18n,
        i18nFormat,
    } = deps;

    for (const [key, value] of Object.entries({
        ensureStoreSyncedWithChat,
        commitGraphUiMutation,
        getChatKey,
        getEffectiveSettings,
        getEffectiveNodeTypeSchema,
        syncGraphVectorsAfterMutation,
        readChatRange,
        searchGraphSimilarNodes,
    })) {
        if (typeof value !== 'function') {
            throw new TypeError(`openGraphIterationStudio: deps.${key} must be a function`);
        }
    }

    const t = typeof i18n === 'function' ? i18n : (s) => String(s ?? '');
    const tf = typeof i18nFormat === 'function'
        ? i18nFormat
        : (s, ...vals) => String(s ?? '').replace(/\$\{(\d+)\}/g, (_m, n) => String(vals[Number(n)] ?? ''));

    ensureStylesheetInjected();
    ITER_UI.ensureUiStylesheetInjected();
    await ITER_RENDER.ensureMarkdownDeps();

    // The graph is strictly per-chat; freeze the chat key at open time so a
    // mid-session character swap cannot silently retarget writes.
    const chatKey = String(getChatKey(context) || '').trim();
    if (!chatKey || chatKey === 'invalid_target') {
        try { toastr.warning(t('Open a chat first.')); } catch { /* toastr optional in tests */ }
        return;
    }
    const targetRef = () => ({ type: TARGET_TYPE, name: chatKey });
    const chatStateTarget = (() => {
        try { return context.resolveChatStateTarget?.() || null; } catch { return null; }
    })();

    const sessionStore = createMgGraphSessionStore({ context, getTarget: () => chatStateTarget });
    const effectiveSettings = () => getEffectiveSettings(context, settings) || settings || {};

    const state = {
        session: createNewSession(),
        liveDoc: null,
        stagedDoc: null,
        working: null,
        writeApi: null,
        isBusy: false,
        aborting: false,
        abortController: null,
    };

    const bus = ITER_PROPOSAL_BUS.createProposalBus({
        mode: 'mg-graph',
        i18n: tf,
        onChange: () => {
            if (state.__suspendBusOnChange) return;
            scheduleBusRender();
        },
    });
    registerTarget(TARGET_TYPE, {
        read: async () => {
            const liveStore = await ensureStoreSyncedWithChat(context);
            return canonicalFromStore(liveStore);
        },
        write: async (_target, nextDoc) => {
            // Approve re-applies the forward patch against the fresh live
            // store, so `nextDoc` is the merged result, not our proposal-time
            // snapshot. Rebuild the runtime store, commit through the shared
            // UI-mutation path (same floor anchor as manual edits), then sync
            // vectors only when the node set/text actually changed.
            const liveStore = await ensureStoreSyncedWithChat(context);
            const beforeDoc = canonicalFromStore(liveStore);
            const nextStore = applyCanonicalToStore(nextDoc, liveStore);
            const inner = await commitGraphUiMutation(context, chatKey, {
                beforeStore: liveStore,
                afterStore: nextStore,
                replaceGraph: false,
                seq: null,
            });
            if (inner && inner.skipped) {
                const err = new Error(String(inner.hint || inner.reason || 'commit skipped'));
                err.reason = inner.reason || 'VALIDATION_COMMIT';
                err.hint = inner.hint || '';
                throw err;
            }
            if (docsTouchNodes(beforeDoc, canonicalFromStore(nextStore))) {
                try {
                    await syncGraphVectorsAfterMutation(context, chatKey, nextStore);
                } catch (err) {
                    console.warn(`[${MODULE}] vector sync after approval failed`, err);
                }
            }
        },
        describe: () => `graph ${chatKey}`,
    });
    bus.registerKind(ITERATION_KIND, {
        kind: ITERATION_KIND,
        targetType: TARGET_TYPE,
        renderDiffCard: (entry) => {
            const after = entry?._pendingAfter;
            if (!after) {
                return renderMgGraphDiffSummary(entry?.meta?.summary, { t });
            }
            let before = null;
            if (after && Array.isArray(entry.inverse)) {
                try {
                    before = applyOps(after, entry.inverse, { targetType: TARGET_TYPE, targetName: chatKey });
                } catch { before = null; }
            }
            return renderMgGraphDiffCard(before, after, { t });
        },
        label: () => t('Graph change'),
        icon: () => '🕸️',
        target: () => String(chatKey || ''),
    });
    bus.setMessageResolver((messageId) => {
        const msgs = state.session?.messages || [];
        return msgs.find(m => m && m.id === messageId) || null;
    });

    // Coalesce a burst of bus mutations into ONE render per animation
    // frame. Each propose / approve / reject / rollback fires onChange;
    // without coalescing, a single LLM auto-continue round produces N
    // mutations -> N full popup re-renders. The scheduler defers mid-
    // render schedule() calls to the next frame so mutations arriving
    // while persistSession/render are awaiting still surface.
    const busRenderScheduler = createRenderScheduler({
        handler: async () => {
            await persistSessionQuiet('bus render');
            try {
                await render();
            } catch { /* render errors surface elsewhere */ }
            await drainBusOutcomes();
        },
        onError: (err) => {
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] scheduleBusRender handler error`, err);
        },
    });
    function scheduleBusRender() {
        busRenderScheduler.schedule();
    }

    // ──────────────────────────────────────────────────────────────────
    // Bus outcome → AI feedback bridge. Bus enqueues an outcome on every
    // status transition (commit / reject / conflict / rollback). When a
    // batch of outcomes lands AND the popup isn't currently mid-turn, we
    // synthesize one user message describing the user's decisions and
    // re-fire the iteration loop so the AI sees how its prior proposals
    // resolved.
    //
    // Mirrors the legacy `continueAfterReviewDecision` + auto-apply
    // feedback paths; the bus is now the single trigger.
    // ──────────────────────────────────────────────────────────────────
    let drainScheduled = false;

    // Turn-scope gate helper. See orchestrator/iter-studio/studio.js
    // hasPendingInSameAssistantTurnAs for the full rationale.
    function hasPendingInSameAssistantTurnAs(outcomes) {
        const outcomeCallIds = new Set();
        for (const o of outcomes || []) {
            const cid = String(o?.sourceCallId || '');
            if (cid) outcomeCallIds.add(cid);
        }
        if (outcomeCallIds.size === 0) return false;
        const callIdToMsg = new Map();
        const msgs = state.session?.messages || [];
        for (const m of msgs) {
            if (!m || m.role !== 'assistant') continue;
            const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
            for (const tc of calls) {
                const id = String(tc?.id || '');
                if (id) callIdToMsg.set(id, String(m.id || ''));
            }
        }
        const owningMsgs = new Set();
        for (const cid of outcomeCallIds) {
            const mid = callIdToMsg.get(cid);
            if (mid) owningMsgs.add(mid);
        }
        if (owningMsgs.size === 0) return false;
        for (const p of bus.listPending()) {
            const mid = callIdToMsg.get(p.sourceCallId);
            if (mid && owningMsgs.has(mid)) return true;
        }
        return false;
    }

    // Build the assistant-message index used by the drain-outcome
    // tool_result updater. Returns two maps:
    //   - callIdToMsg: tool_call_id → owning assistant message id
    //   - msgById:     assistant message id → the message object
    // Walk state.session.messages once so applyOutcomesToToolResults can
    // reuse both maps; they stay valid until the next mutation of the
    // messages array. Mirror of orchestrator/iter-studio/studio.js's
    // helper of the same name.
    function buildAssistantMessageIndex() {
        const callIdToMsg = new Map();
        const msgById = new Map();
        const msgs = state.session?.messages || [];
        for (const m of msgs) {
            if (!m || m.role !== 'assistant') continue;
            const mid = String(m.id || '');
            if (mid) msgById.set(mid, m);
            const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
            for (const tc of calls) {
                const id = String(tc?.id || '');
                if (id) callIdToMsg.set(id, mid);
            }
        }
        return { callIdToMsg, msgById };
    }

    // Apply a batch of bus outcomes to persisted assistant-message
    // tool_results. For each outcome, find the owning assistant message
    // (via sourceCallId → callIdToMsg) and swap the pending tool_result
    // envelope at matching tool_call_id to the resolved payload.
    //
    // Multi-edit cascade: MG schema iter-studio coalesces N chained
    // edit-tool calls per turn into ONE bus entry keyed to the first
    // callId (see runIterationTurn's `bus.propose` site — one
    // graph-proposal per turn regardless of how many write tool calls
    // landed). When an `mg-graph-store` outcome fires, cascade its
    // resolved status to every other still-`pending` edit tool_result in
    // the same assistant message so the batch shares fate in the LLM's
    // protocol view. Read-tool results (status:'ok' with concrete
    // payloads) are never clobbered because the cascade only touches
    // envelopes whose current content.status === 'proposal_pending'.
    function applyOutcomesToToolResults(outcomes) {
        if (!Array.isArray(outcomes) || outcomes.length === 0) return;
        const { callIdToMsg, msgById } = buildAssistantMessageIndex();
        const turnOutcomeByMsg = new Map();
        for (const outcome of outcomes) {
            const sourceCallId = String(outcome?.sourceCallId || '');
            if (!sourceCallId) continue;
            const mid = callIdToMsg.get(sourceCallId);
            if (!mid) continue;
            const msg = msgById.get(mid);
            if (!msg) continue;
            const results = Array.isArray(msg.toolResults) ? msg.toolResults : null;
            if (!results) continue;
            const idx = results.findIndex((r) => String(r?.tool_call_id || '') === sourceCallId);
            if (idx < 0) continue;
            const payload = buildPayloadForOutcome(outcome);
            const nextStatus = outcome?.status === 'committed' ? 'ok' : 'fail';
            results[idx] = {
                tool_call_id: sourceCallId,
                content: payload,
                status: nextStatus,
            };
            if (outcome?.kind === ITERATION_KIND) {
                turnOutcomeByMsg.set(mid, outcome);
            }
        }
        for (const [mid, outcome] of turnOutcomeByMsg) {
            const msg = msgById.get(mid);
            if (!msg) continue;
            const results = Array.isArray(msg.toolResults) ? msg.toolResults : null;
            if (!results) continue;
            const payload = buildPayloadForOutcome(outcome);
            const nextStatus = outcome?.status === 'committed' ? 'ok' : 'fail';
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                const content = r?.content;
                const isPending = content
                    && typeof content === 'object'
                    && content.status === 'proposal_pending';
                if (!isPending) continue;
                results[i] = {
                    tool_call_id: String(r?.tool_call_id || ''),
                    content: payload,
                    status: nextStatus,
                };
            }
        }
    }

    async function drainBusOutcomes() {
        if (drainScheduled) return;
        const outcomes = bus.drainOutcomes();
        if (!outcomes.length) return;
        if (state.isBusy) {
            // Re-queue: outcomes drained but isBusy was true. Push them
            // back via the bus, so the next idle drain picks them up.
            // The bus exposes no public re-queue; we keep a stash here
            // and replay on the next call.
            __pendingDrainStash.push(...outcomes);
            return;
        }
        // Batch gate: same-turn siblings still pending → hold. See
        // orchestrator/iter-studio/studio.js drainBusOutcomes for the
        // full rationale.
        if (hasPendingInSameAssistantTurnAs(outcomes)) {
            __pendingDrainStash.push(...outcomes);
            return;
        }
        const allOutcomes = __pendingDrainStash.length
            ? [...__pendingDrainStash.splice(0), ...outcomes]
            : outcomes;
        // Update the per-tool_call_id tool_result envelopes in place so
        // the next round's role:'tool' replay carries the user's
        // decision. Every edit tool_call has a persisted `pending`
        // tool_result from emission time (see runIterationTurn's edit
        // loop) that we swap to committed / rejected / conflict /
        // rolled_back per the outcome.
        //
        // Multi-edit-per-turn cascade: MG collapses N chained write calls
        // per turn into ONE bus `mg-graph-store` entry keyed to the first
        // callId. The outcome fires once and covers the whole batch, so
        // cascade the same status to every other still-pending tool_result
        // in the same assistant message. Only graph-proposal outcomes
        // cascade; 1:1 kinds match by sourceCallId alone.
        applyOutcomesToToolResults(allOutcomes);
        const hadUpdate = allOutcomes.length > 0;
        if (!hadUpdate) return;
        drainScheduled = true;
        try {
            state.isBusy = true;
            state.abortController = new AbortController();
            await persistSessionQuiet('bus outcome drain');
            await render();
            try {
                let turn = await runIterationTurn();
                while (turn?.hadAnyToolCall && !bus.hasOutstanding()) {
                    await persistSessionQuiet('bus outcome drain');
                    await render();
                    if (state.abortController?.signal?.aborted) break;
                    turn = await runIterationTurn();
                }
            } catch (err) {
                if (!isAbortError(err, state.abortController?.signal)) {
                    // eslint-disable-next-line no-console
                    console.warn(`[${MODULE}] drainBusOutcomes`, err);
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
                await persistSessionQuiet('bus outcome drain');
                await render();
            }
        } finally {
            drainScheduled = false;
        }
    }
    const __pendingDrainStash = [];

    async function loadStaged() {
        const liveStore = await ensureStoreSyncedWithChat(context);
        state.liveDoc = canonicalFromStore(liveStore);
        const pendingDoc = await bus.getCurrentPendingState(ITERATION_KIND, targetRef());
        state.stagedDoc = pendingDoc || state.liveDoc;
        state.working = applyCanonicalToStore(state.stagedDoc, liveStore);
        state.writeApi = getMemoryGraphWriteApi(state.working, context, {
            onCommit: null,
            settings: effectiveSettings(),
            // Approvals commit at the covered watermark, so sandbox edits must
            // not bump `seqTo` to a not-yet-covered in-flight turn (that would
            // make the commit floor unresolvable and park as a conflict), and
            // a corrective edit must not claim a timeline move the user never
            // asked for (manual-edit parity).
            useInFlightAnchor: false,
            preserveSeqOnEdit: true,
        });
    }

    // ──────────────────────────────────────────────────────────────────
    // Persistence. Session carries the latest surfaceState, messages, and
    // a derived title (first 50 chars of the first user message).
    // ──────────────────────────────────────────────────────────────────
    async function persistSession() {
        const hasMessages = Array.isArray(state.session.messages) && state.session.messages.length > 0;
        const hasPending = bus.hasOutstanding();
        if (state.session._transient && !hasMessages && !hasPending) {
            return;
        }
        if (state.session._transient) {
            delete state.session._transient;
        }
        state.session.updatedAt = Date.now();
        state.session.proposalBus = bus.serialize();
        // `serialize()` strips the runtime-only `_pendingAfter`; snapshot the
        // reconstructed tail after-state so a reload can rebuild the chain
        // with `restorePendingChain` before hydrating the bus.
        state.session.pendingTailAfter = hasPending
            ? await bus.getCurrentPendingState(ITERATION_KIND, targetRef())
            : null;
        if (state.session.pendingEdits !== undefined) {
            delete state.session.pendingEdits;
        }
        if (!state.session.title) {
            const firstUser = state.session.messages.find(m => m.role === 'user');
            if (firstUser) {
                state.session.title = String(firstUser.content || '').slice(0, 50);
            }
        }
        await sessionStore.save(state.session);
    }

    // The store throws when the chat-state write envelope is not ok. Every
    // background persist (render scheduler, turn loops, teardown, toggle
    // handlers) must warn + continue instead of surfacing an unhandled
    // rejection from an event handler. User-initiated delete / clear actions
    // catch their own errors so they can toast.
    async function persistSessionQuiet(tag) {
        try {
            await persistSession();
            return true;
        } catch (err) {
            console.warn(`[${MODULE}] session persist failed (${tag})`, err);
            return false;
        }
    }

    async function loadSession(id) {
        const loaded = await sessionStore.load(id);
        if (!loaded) return;
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.aborting = false;
        state.abortController = null;

        const fallbackAt = Number(loaded.updatedAt) || Date.now();
        const surface = loaded.surfaceState || {};
        state.session = {
            ...loaded,
            surfaceState: {
                historyOpen: !!surface.historyOpen,
                autoApply: !!surface.autoApply,
            },
            messages: Array.isArray(loaded.messages)
                ? loaded.messages.map(m => normalizeMessageShape(m, fallbackAt))
                : [],
        };
        state.__suspendBusOnChange = true;
        try {
            const serialized = (loaded.proposalBus && typeof loaded.proposalBus === 'object')
                ? loaded.proposalBus
                : { version: 3, entries: [], outcomeQueue: [] };
            const restored = restorePendingChain(serialized.entries, loaded.pendingTailAfter);
            if (!restored.ok) {
                console.warn(`[${MODULE}] pending chain restore failed: ${restored.error}`);
                try {
                    toastr.warning(
                        t('Pending graph proposals could not be verified after reload and were marked as conflicts. Review them before approving.'),
                        t('Graph proposals need attention'),
                        { timeOut: 10000 },
                    );
                } catch { /* toastr optional */ }
            }
            bus.hydrate({ ...serialized, entries: restored.entries });
        } finally {
            state.__suspendBusOnChange = false;
        }
        delete state.session.pendingEdits;
        bus.setAutoApprove(Boolean(state.session.surfaceState?.autoApply));
        await loadStaged();
        await render();
    }

    async function startNewSession() {
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.aborting = false;
        state.abortController = null;
        const priorAutoApply = Boolean(state.session?.surfaceState?.autoApply);
        state.session = createNewSession();
        state.session._transient = true;
        if (priorAutoApply) {
            state.session.surfaceState = { ...(state.session.surfaceState || {}), autoApply: true };
        }
        state.__suspendBusOnChange = true;
        try {
            bus.hydrate({ version: 3, entries: [], outcomeQueue: [] });
        } finally {
            state.__suspendBusOnChange = false;
        }
        bus.setAutoApprove(Boolean(state.session.surfaceState?.autoApply));
        await loadStaged();
        await render();
    }

    async function clearAllHistory() {
        // eslint-disable-next-line no-alert
        if (!confirm(t('Clear all session history?'))) return;
        try { state.abortController?.abort(); } catch { /* ignore */ }
        state.isBusy = false;
        state.aborting = false;
        state.abortController = null;
        const metas = await sessionStore.list();
        let failed = 0;
        for (const meta of metas) {
            try {
                await sessionStore.delete(meta.id);
            } catch (err) {
                failed += 1;
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] clear history: deleting ${meta.id} failed`, err);
            }
        }
        if (failed > 0) {
            try {
                toastr.warning(
                    t('Some sessions could not be deleted — they are still in the saved history.'),
                    t('Delete failed'),
                    { timeOut: 8000 },
                );
            } catch { /* toastr optional in tests */ }
        }
        await startNewSession();
    }

    // ──────────────────────────────────────────────────────────────────
    // Chat-message rendering. MG delegates to
    // `iteration-library/ui/message.renderMessageCard` so the four
    // iter-library popups (CPA, MG schema, Orch, CEA char) share one
    // visual language for tool-call chips, per-round edit cards, applied/
    // rolled-back stamps, and the Regenerate / Rollback row.
    //
    // MG preserves only the outer `<div class="mg_graph_it_msg ...">`
    // wrapper around the shared component, because studio.css's flex-row
    // alignment / accent colors / max-widths key on
    // `.mg_graph_it_msg_user` / `_assistant` / `_system`. The inner
    // `<div class="luker_lib_message ...">` carries the rest of the
    // structure (markdown body, read-only-round hint when all calls are
    // read-type, tool chips, edit cards via renderPendingEditCard,
    // applied/rolled-back stamp, Regenerate button). Click delegation
    // accepts msgId from either `data-mg-graph-it-msg-id` (outer) or
    // `data-luker-lib-msg-id` (inner).
    // ──────────────────────────────────────────────────────────────────
    function renderMessageCard(message, idx, allMessages) {
        if (!message) return '';
        const role = String(message.role || 'user');
        const roleCls = role === 'user'
            ? 'mg_graph_it_msg_user'
            : role === 'assistant'
                ? 'mg_graph_it_msg_assistant'
                : 'mg_graph_it_msg_system';
        const autoCls = message.auto ? ' mg_graph_it_msg_auto' : '';

        const innerHtml = ITER_UI.message.renderMessageCard(message, {
            toolDisplay: MG_GRAPH_TOOL_DISPLAY,
            // Bus's graph-diff card owns the diff body — no legacy
            // edit-card render here.
            renderEditCard: () => '',
            renderApplyControls: (m) => {
                // Bus owns per-card chrome + turn-actions. Render the
                // per-card stack first (Approve / Reject / Conflict ribbon
                // / Rollback for each proposal tied to this assistant
                // message), then a turn-actions row that batches them.
                const cards = bus.renderCardsForMessage(m) || '';
                const turn = bus.renderTurnActions(m) || '';
                if (!cards && !turn) return '';
                return cards + turn;
            },
            i18n: tf,
            renderMarkdown: ITER_RENDER.renderMessageMarkdown,
            actionAttribute: 'data-mg-graph-it-action',
        });

        // Preserve MG's outer flex-row container so the popup's alignment
        // / accent-color / max-width rules in studio.css still apply.
        return `<div class="mg_graph_it_msg ${roleCls}${autoCls}" data-mg-graph-it-msg-id="${escapeHtmlLocal(message.id || '')}">${innerHtml}</div>`;
    }

    function renderHistoryItem(meta) {
        const id = String(meta?.id || '');
        const title = String(meta?.title || meta?.id || '');
        const active = id === state.session.id ? ' mg_graph_it_history_item_active' : '';
        return `<div class="mg_graph_it_history_item${active}" data-mg-graph-it-action="load-session" data-mg-graph-it-id="${escapeHtmlLocal(id)}">
            <span class="mg_graph_it_history_title">${escapeHtmlLocal(title || t('(untitled)'))}</span>
            <button class="mg_graph_it_history_delete" data-mg-graph-it-action="delete-session" data-mg-graph-it-id="${escapeHtmlLocal(id)}" title="${escapeHtmlLocal(t('Delete this session'))}">×</button>
        </div>`;
    }

    // ──────────────────────────────────────────────────────────────────
    // Full re-render. Cheap enough to call after every state mutation
    // (the static popup shell + textarea stay mounted, so user input
    // and focus aren't disturbed by re-rendering messages / pending).
    // ──────────────────────────────────────────────────────────────────
    let $root = null;
    async function render() {
        if (!$root) return;
        // History details: sync open state without firing toggle handler.
        const $history = $root.find('[data-mg-graph-it-history]');
        if ($history.length) {
            const wantOpen = Boolean(state.session.surfaceState?.historyOpen);
            if ($history.prop('open') !== wantOpen) {
                $history.prop('open', wantOpen);
            }
        }
        const metas = await sessionStore.list();
        const historyHtml = metas.map(renderHistoryItem).join('')
            || `<div class="mg_graph_it_history_empty">${escapeHtmlLocal(t('No saved sessions'))}</div>`;
        $root.find('[data-mg-graph-it-history-items]').html(historyHtml);

        // Messages — pass index + full array so renderMessageCard can decide
        // whether to render Regenerate (only on non-last assistant turns).
        // Pre-compute latest-unapplied id so inline Apply/Reject row only
        // attaches to the most recent unapplied assistant turn.
        // Filter auto-generated continuation prompts ("AUTO CONTINUE…")
        // out of the rendered chat — they stay in state.session.messages
        // for buildTaskMessages to feed the LLM, but the user shouldn't
        // see them as chat noise.
        const allMsgs = (state.session.messages || []).filter(m => !(m?.role === 'user' && m?.auto));
        // Bus.hasOutstanding is the source of truth for "this round is
        // staged and awaiting review". When the bus is empty no message
        // should carry an Apply/Reject row — even though `m.edits` is
        // still retained on the assistant message for diff history /
        // rollback. Short-circuit before scanning so the inline controls
        // disappear the moment the batch is resolved.
        let latestUnappliedAssistantId = '';
        if (bus.hasOutstanding()) {
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
        const $msgs = $root.find('[data-mg-graph-it-messages]');
        // Loading bubble: append (don't overwrite) so the just-finished
        // user turn stays visible while the LLM call is in flight.
        const loadingHtml = state.isBusy
            ? `<div class="mg_graph_it_msg mg_graph_it_msg_assistant mg_graph_it_msg_loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtmlLocal(t('AI is thinking...'))}</div>`
            : '';
        $msgs.html(messagesHtml + loadingHtml);
        // Auto-scroll to bottom so newly-appended messages are visible.
        try {
            const node = $msgs[0];
            if (node && typeof node.scrollTop === 'number') {
                node.scrollTop = node.scrollHeight;
            }
        } catch { /* DOM not attached (test) */ }

        // Pending edits — delegates the Apply / Discard row to the shared
        // `iteration-library/ui/apply` component so it stays in visual
        // sync with the other iter-library popups (M1.7). The shared
        // component emits `${actionAttribute}="apply-batch"` and
        // `discard-batch` buttons; MG's click delegation matches those
        // values too (see handler block below). `pendingMessage` is a
        // virtual carrier — the popup's pending block is owned by the
        // Pending edits + Apply / Reject affordances now render inline on
        // the assistant message that produced them via the renderApplyControls
        // hook in renderMessageCard. The legacy bottom region has been
        // retired so Apply stays visible alongside the diff cards it
        // refers to.

        // Send / Stop button label
        const $sendBtn = $root.find('[data-mg-graph-it-action="send"]');
        $sendBtn.text(state.isBusy ? t('Stop') : t('Send'));
        // Disable Stop while the abort is in-flight so a second click
        // can't queue up before the catch+finally clears state.
        $sendBtn.prop('disabled', Boolean(state.aborting));

        // Sync auto-apply checkbox state — render() is the single source of
        // truth, so a session switch (different auto-apply pref) updates the
        // checkbox without separate plumbing.
        const $autoApply = $root.find('[data-mg-graph-it-action="toggle-auto-apply"]');
        if ($autoApply.length) {
            const want = !!state.session.surfaceState?.autoApply;
            if ($autoApply.prop('checked') !== want) {
                $autoApply.prop('checked', want);
            }
        }

        // Refresh the staged view (live + pending proposals) and repaint the
        // outline. Skipped while busy — runIterationTurn manages staged state
        // itself and render() runs mid-turn.
        try {
            if (!state.isBusy) {
                await loadStaged();
            }
            const previewHtml = renderMgGraphPreviewPane(state.stagedDoc, state.liveDoc, { t });
            $root.find('[data-iter-preview-pane]').html(previewHtml);
        } catch (err) {
            console.warn(`[${MODULE}] preview render failed`, err);
            $root.find('[data-iter-preview-pane]').html(`<div class="mg_graph_it_preview_empty">${escapeHtmlLocal(t('Preview unavailable'))}</div>`);
        }
    }

    /**
     * Build the conversation history sent to the runner. Replays prior
     * user/assistant turns so the model has context. Under the read-first
     * refactor the last-user message is passed VERBATIM (no injected
     * `[Current working schema]` / `[Global baseline schema]` outline) —
     * the iterating AI reads live state on demand via
     * `mg_schema_read_fields`.
     *
     * `snapshot` is kept in the signature for call-site compatibility
     * (some existing callers threaded the per-turn snapshot in for the
     * old outline injection) but is no longer consulted.
     *
     * Legacy pre-refactor sessions carry `{role:'user', auto:true}`
     * AUTO CONTINUE fillers and drain-summary `[User reviewed …]`
     * messages between assistant tool-call rounds; all of them are
     * dropped by `isReplayableIterationMessage` so a resumed
     * pre-refactor session doesn't replay dead filler to the LLM.
     * Post-refactor iter-studio never emits auto:true user messages;
     * edit outcomes flow through in-place role:'tool' result updates.
     *
     * Assistant messages that carry `toolCalls` + matching `toolResults`
     * (read-tool rounds) get the OpenAI tool-protocol replay shape:
     * `assistant {content, tool_calls}` followed by one `tool` message
     * per tool_call_id. Without this replay, "act on what you just read"
     * prompts couldn't see prior read results across user-driven turns.
     */
    // eslint-disable-next-line no-unused-vars
    function buildTaskMessages(systemPrompt, _snapshot) {
        const messages = [{ role: 'system', content: systemPrompt }];
        const history = (state.session.messages || []).filter(isReplayableIterationMessage);
        history.forEach((m) => {
            const role = String(m.role).toLowerCase();
            const content = String(m.content || '');

            // Replay assistant message's tool calls with their matching
            // persisted tool_results. Every tool_call MUST have a
            // corresponding role:'tool' message or the provider 400s
            // ("tool_use ids must have matching tool_result").
            //
            // Read tools carry their real result (executed synchronously
            // at emission time). Edit tools carry a `proposal_pending`
            // envelope at emission time that `drainBusOutcomes` updates
            // in place to committed / rejected / conflict / rolled_back
            // once the user acts.
            //
            // Legacy sessions (pre tool_call/tool_result round-trip) may
            // have persisted edit tool_calls WITHOUT a matching
            // toolResults entry (the old code stripped edit calls from
            // history entirely). Synthesize a `committed` payload inline
            // for those — best-effort, since the edit is on disk when
            // the user is resuming the session it was committed at some
            // point.
            const persistedResults = Array.isArray(m?.toolResults) ? m.toolResults : [];
            const persistedCalls = Array.isArray(m?.toolCalls) ? m.toolCalls : [];
            if (role === 'assistant' && persistedCalls.length > 0) {
                const toolCallsForHistory = persistedCalls.map((tc) => ({
                    id: String(tc?.id || ''),
                    type: 'function',
                    function: {
                        name: String(tc?.name || ''),
                        arguments: JSON.stringify(tc?.args || {}),
                    },
                }));
                const persistedReasoning = typeof m?.reasoning === 'string' ? m.reasoning : '';
                const persistedReasoningBlocks = Array.isArray(m?.reasoningBlocks) && m.reasoningBlocks.length > 0
                    ? m.reasoningBlocks
                    : null;
                const persistedReasoningDetails = Array.isArray(m?.reasoningDetails) && m.reasoningDetails.length > 0
                    ? m.reasoningDetails
                    : null;
                messages.push({
                    role: 'assistant',
                    content,
                    ...(persistedReasoning ? { reasoning: persistedReasoning } : {}),
                    ...(persistedReasoningBlocks ? { reasoning_blocks: persistedReasoningBlocks } : {}),
                    ...(persistedReasoningDetails ? { reasoning_details: persistedReasoningDetails } : {}),
                    tool_calls: toolCallsForHistory,
                });
                const resultById = new Map();
                for (const r of persistedResults) {
                    if (r && r.tool_call_id != null) resultById.set(String(r.tool_call_id), r);
                }
                for (const tc of persistedCalls) {
                    const callId = String(tc?.id || '');
                    const r = resultById.get(callId);
                    let serialized;
                    if (r) {
                        try {
                            serialized = typeof r.content === 'string'
                                ? r.content
                                : JSON.stringify(r.content ?? '');
                        } catch {
                            serialized = '';
                        }
                    } else {
                        // Legacy fill: assume committed. See
                        // edit-tool-result-envelope.js for the parallel
                        // emission-time shape.
                        serialized = JSON.stringify(buildEditToolResultPayload('committed'));
                    }
                    messages.push({
                        role: 'tool',
                        tool_call_id: callId,
                        content: serialized,
                    });
                }
                return;
            }

            messages.push({ role, content });
        });
        return messages;
    }

    async function runIterationTurn() {
        const ac = state.abortController || new AbortController();
        state.abortController = ac;

        await loadStaged();

        const systemPrompt = buildGraphIterSystemPrompt(effectiveSettings());
        const taskMessages = buildTaskMessages(systemPrompt);

        const apiPresetName = String(settings?.requestApiPresetName || '').trim();
        const llmPresetName = String(settings?.requestLlmPresetName || '').trim();
        const runnerSettings = {
            toolCallRetryMax: settings?.toolCallRetryMax,
            rpmLimit: settings?.rpmLimit,
        };

        let firstAssistantText = '';
        const collectedToolCalls = [];
        let hadAnyToolCall = false;

        const result = await ITER_RUNNER.requestToolCallsWithRetry(
            context,
            runnerSettings,
            {
                taskMessages,
                runtimeWorldInfo: null,
                apiPresetName,
                llmPresetName,
                tools: [...GRAPH_TOOL_DEFS, ...LOREBOOK_READ_TOOL_DEFS],
                abortSignal: ac.signal,
                includeAssistantText: true,
                allowNoToolCalls: true,
                isControlCall: () => false,
                onAssistantText: (text) => { firstAssistantText = String(text || ''); },
                onToolCall: (call) => {
                    collectedToolCalls.push(call);
                    hadAnyToolCall = true;
                },
                onControlCall: () => { hadAnyToolCall = true; },
            },
        );

        const calls = collectedToolCalls.length > 0
            ? collectedToolCalls
            : (Array.isArray(result?.toolCalls) ? result.toolCalls : []);
        const readToolCalls = calls.filter((c) => isGraphReadTool(c?.name) || isLorebookReadTool(c?.name));
        const writeToolCalls = calls.filter((c) => isGraphWriteTool(c?.name));
        const unknownToolCalls = calls.filter((c) => !isGraphReadTool(c?.name) && !isGraphWriteTool(c?.name) && !isLorebookReadTool(c?.name));
        const assistantText = firstAssistantText.trim();

        const toolDeps = {
            getEffectiveNodeTypeSchema,
            readChatRange: (from, to) => readChatRange(context, from, to),
            searchSimilarNodes: (query, opts) => searchGraphSimilarNodes(context, query, opts),
        };
        const resolvedSettings = effectiveSettings();

        const readResults = [];
        for (const call of readToolCalls) {
            const callId = String(call?.id || `read_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
            call.id = callId;
            try {
                if (isLorebookReadTool(call?.name)) {
                    const avatar = String(context?.characters?.[context?.characterId]?.avatar || '').trim();
                    const out = await runLorebookReadTool({ id: callId, name: call?.name, args: call?.args }, avatar);
                    if (out?.ok) {
                        readResults.push({ tool_call_id: callId, content: out.result, status: 'ok' });
                    } else {
                        readResults.push({
                            tool_call_id: callId,
                            content: { error: String(out?.error || 'unknown error') },
                            status: 'fail',
                        });
                    }
                    continue;
                }
                const payload = await executeGraphReadTool(
                    { name: call?.name, args: call?.args },
                    { working: state.working, deps: toolDeps, context, settings: resolvedSettings },
                );
                readResults.push({ tool_call_id: callId, content: payload, status: 'ok' });
            } catch (err) {
                readResults.push({
                    tool_call_id: callId,
                    content: serializeGraphToolError(err),
                    status: 'fail',
                });
            }
        }

        const writeResults = [];
        const writeOutcomes = [];
        for (const call of writeToolCalls) {
            const callId = String(call?.id || `write_${writeResults.length}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
            call.id = callId;
            try {
                const payload = await executeGraphWriteTool(
                    { name: call?.name, args: call?.args },
                    {
                        working: state.working,
                        writeApi: state.writeApi,
                        deps: toolDeps,
                        context,
                        settings: resolvedSettings,
                    },
                );
                writeOutcomes.push({ callId, changed: payload?.changed !== false, failed: false });
                writeResults.push({ tool_call_id: callId, content: payload, status: 'ok' });
            } catch (err) {
                writeOutcomes.push({ callId, changed: false, failed: true });
                writeResults.push({
                    tool_call_id: callId,
                    content: serializeGraphToolError(err),
                    status: 'fail',
                });
            }
        }
        for (const call of unknownToolCalls) {
            const callId = String(call?.id || `unknown_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
            call.id = callId;
            writeResults.push({
                tool_call_id: callId,
                content: { error: `unknown_tool: "${String(call?.name || '')}" is not part of the graph tool catalog.` },
                status: 'fail',
            });
        }

        // One proposal per turn, keyed off the FIRST mutating call. The
        // staged before-state is whatever the previous round left behind, so
        // consecutive proposals chain through `bus.getCurrentPendingState`.
        const previousStagedDoc = state.stagedDoc;
        const afterDoc = canonicalFromStore(state.working);
        const hasChanges = !docsEqual(previousStagedDoc, afterDoc);
        const pendingCallIds = [];
        if (hasChanges) {
            for (const outcome of writeOutcomes) {
                if (outcome.failed || !outcome.changed) continue;
                pendingCallIds.push(outcome.callId);
            }
            // Every successful mutating call maps onto the single turn-level
            // proposal; swap its emission envelope to `proposal_pending` so
            // every tool_call keeps a matching tool_result for the next
            // round's protocol replay.
            const pendingPayload = buildEditToolResultPayload('pending');
            for (const res of writeResults) {
                if (pendingCallIds.includes(res.tool_call_id)) {
                    res.content = pendingPayload;
                    res.status = 'pending';
                }
            }
        } else if (writeOutcomes.length > 0) {
            // Calls ran but the staged view is unchanged — answer with an
            // explicit noop envelope instead of a stale success payload.
            const noopPayload = {
                ok: true,
                changed: false,
                note: 'No net change against the staged graph; an earlier round may already have applied this. Re-read before retrying.',
            };
            for (const res of writeResults) {
                if (res.status === 'fail') continue;
                res.content = noopPayload;
            }
        }

        const assistantMsg = {
            id: makeMessageId(),
            role: 'assistant',
            content: assistantText || '',
            at: Date.now(),
        };
        const persistedReasoning = String(result?.reasoning || '');
        const persistedReasoningBlocks = Array.isArray(result?.reasoningBlocks) && result.reasoningBlocks.length > 0
            ? result.reasoningBlocks
            : null;
        const persistedReasoningDetails = Array.isArray(result?.reasoningDetails) && result.reasoningDetails.length > 0
            ? result.reasoningDetails
            : null;
        if (persistedReasoning) assistantMsg.reasoning = persistedReasoning;
        if (persistedReasoningBlocks) assistantMsg.reasoningBlocks = persistedReasoningBlocks;
        if (persistedReasoningDetails) assistantMsg.reasoningDetails = persistedReasoningDetails;
        const allCalls = [...readToolCalls, ...writeToolCalls, ...unknownToolCalls];
        if (allCalls.length > 0) {
            assistantMsg.toolCalls = allCalls.map((tc) => ({
                id: String(tc?.id || ''),
                name: String(tc?.name || ''),
                args: tc?.args ?? {},
            }));
        }
        if (readResults.length + writeResults.length > 0) {
            assistantMsg.toolResults = [...readResults, ...writeResults];
        }
        // No `assistantMsg.edits` — the bus proposal card is the single
        // source of truth for pending review UI.
        state.session.messages.push(assistantMsg);

        if (hasChanges) {
            state.stagedDoc = afterDoc;
            bus.setAutoApprove(Boolean(state.session.surfaceState?.autoApply));
            const firstCallId = pendingCallIds[0] || writeToolCalls.find((c) => c?.id)?.id || assistantMsg.id;
            await bus.propose({
                kind: ITERATION_KIND,
                target: targetRef(),
                before: previousStagedDoc,
                after: afterDoc,
                sourceCallId: firstCallId,
                meta: { summary: buildGraphDiffSummary(previousStagedDoc, afterDoc) },
            });
        }

        bumpChatBadge();

        return {
            hadAnyToolCall,
            executionResult: {
                finalized: !hadAnyToolCall,
                changed: hasChanges,
                hasPending: hasChanges,
            },
        };
    }

    // ──────────────────────────────────────────────────────────────────
    // Per-message actions.
    //
    // regenerateFromMessage(msgId): truncate the chat back to the user
    // turn that prompted this assistant message, drop staged proposals
    // tied to the discarded turn, refill the textarea with the
    // original prompt, and re-fire the send pipeline.
    //
    // rollbackBatch(msgId): inverse-apply each edit in the message's
    // batch against state.live (right-to-left, so dependent ops unwind in
    // creation order), commit the result, mark the message rolledBackAt.
    // Bails on the first edit whose op lacks an inverse — partial rollback
    // would leave the schema in an inconsistent state.
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

        // Roll back disk commits the discarded assistant turns made. Abort
        // on any failure: a half-rolled-back schema would mislead the next
        // regenerate. See orchestrator/iter-studio/studio.js for the full
        // rationale — both popups share `bus.rollbackAllInMessages`.
        const discardedRange = messages.slice(userIdx);
        if (bus.countCommittedInMessages(discardedRange) > 0) {
            const rollbackOutcome = await bus.rollbackAllInMessages(discardedRange);
            if (!rollbackOutcome.ok) {
                const failedTarget = rollbackOutcome.failedAt?.target;
                const targetLabel = failedTarget?.name
                    ? `${failedTarget.type}:${failedTarget.name}`
                    : (failedTarget?.type || 'unknown');
                const reason = String(rollbackOutcome.failedAt?.error?.message
                    || rollbackOutcome.failedAt?.status
                    || 'unknown');
                const msg = tf('Regenerate aborted — could not roll back commit on ${0}: ${1}',
                    targetLabel, reason);
                try { toastr.error(msg, t('Regenerate aborted'), { timeOut: 8000 }); } catch { /* ignore */ }
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] regenerate rollback failed`, rollbackOutcome.failedAt);
                return;
            }
        }

        // Truncate before the user message; the resend will push it again.
        state.session.messages = messages.slice(0, userIdx);
        // Discard any bus proposals tied to discarded assistant turns —
        // their sourceCallId points at tool calls that are about to be
        // removed from the message stream. Rejecting them is the cleanest
        // way to drop them without losing the historical record.
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
        await persistSessionQuiet('regenerate');
        await render();
        const $textarea = $root.find('[data-mg-graph-it-input]');
        $textarea.val(userText);
        await handleSendMessage();
    }

    // editUserMessage(messageId): edit a prior user message + auto-regenerate.
    // See orchestrator/iter-studio/studio.js for the rationale; all four
    // popups share the prompt() → rollback → truncate → handleSendMessage
    // flow.
    async function editUserMessage(messageId) {
        if (state.isBusy) return;
        const messages = state.session.messages || [];
        const targetIdx = messages.findIndex(m => m && m.id === messageId && m.role === 'user' && !m.auto);
        if (targetIdx < 0) return;
        const original = String(messages[targetIdx].content || '');
        // eslint-disable-next-line no-alert
        const next = window.prompt(t('Edit message — saving will regenerate from this turn:'), original);
        if (next === null) return;
        const trimmed = String(next).trim();
        if (!trimmed) return;

        const discardedRange = messages.slice(targetIdx);
        if (bus.countCommittedInMessages(discardedRange) > 0) {
            const rollbackOutcome = await bus.rollbackAllInMessages(discardedRange);
            if (!rollbackOutcome.ok) {
                const failedTarget = rollbackOutcome.failedAt?.target;
                const targetLabel = failedTarget?.name
                    ? `${failedTarget.type}:${failedTarget.name}`
                    : (failedTarget?.type || 'unknown');
                const reason = String(rollbackOutcome.failedAt?.error?.message
                    || rollbackOutcome.failedAt?.status
                    || 'unknown');
                const msg = tf('Regenerate aborted — could not roll back commit on ${0}: ${1}',
                    targetLabel, reason);
                try { toastr.error(msg, t('Regenerate aborted'), { timeOut: 8000 }); } catch { /* ignore */ }
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] edit-user-message rollback failed`, rollbackOutcome.failedAt);
                return;
            }
        }
        state.session.messages = messages.slice(0, targetIdx);
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
        await persistSessionQuiet('edit message');
        await render();
        const $textarea = $root.find('[data-mg-graph-it-input]');
        $textarea.val(trimmed);
        await handleSendMessage();
    }

    // rollbackBatch is now bus-driven: turn-actions card under the assistant
    // message renders "Rollback this turn" when at least one of its
    // proposals is in `committed` status, dispatched through bus.handleClick.

    // ──────────────────────────────────────────────────────────────────
    // Send-message handler. Q6: user message is pushed AND rendered
    // BEFORE the await so the user sees their own input before the LLM
    // wait spinner starts. Errors surface as system messages.
    //
    // Multi-round auto-continue is program-driven by tool-call presence:
    // whenever a round emits any tool call (edit OR control), the loop
    // fires another round (after rendering the previous round so the user
    // sees progressive output). The ONLY exits are:
    //   1. The model responded with plain text and no tool calls.
    //   2. The user clicked Stop (abortController fires; isAbortError
    //      catches the resulting error in the catch block).
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
        const $textarea = $root.find('[data-mg-graph-it-input]');
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
        await persistSessionQuiet('send');
        await render();   // Q6: user message visible before LLM wait
        try {
            let turn = await runIterationTurn();
            while (turn?.hadAnyToolCall && !bus.hasOutstanding()) {
                await persistSessionQuiet('send');
                await render();   // progressive: prior round visible before next
                if (state.abortController?.signal?.aborted) break;
                turn = await runIterationTurn({ autoContinueFromResult: turn.executionResult });
            }
        } catch (err) {
            // Stop button → don't push an error bubble; user knows they cancelled.
            if (!isAbortError(err, state.abortController?.signal)) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}]`, err);
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
            await persistSessionQuiet('send');
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
    await loadStaged();

    const popupId = `mg_graph_it_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const popupHtml = buildPopupHtml({
        popupId,
        title: t('Memory Graph Studio'),
        historyOpen: Boolean(state.session.surfaceState?.historyOpen),
        historyLabel: t('History'),
        newSessionLabel: t('New session'),
        clearAllLabel: t('Clear all'),
        sendLabel: t('Send'),
        composerPlaceholder: t('Describe what to change in the graph...'),
        autoApply: Boolean(state.session.surfaceState?.autoApply),
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

    // Graph sessions are bound to one chat. A chat switch while the popup is
    // open would let later approvals land on the wrong target — abort
    // in-flight work and close the popup; the user reopens it on the new chat.
    const chatChangedEvent = context?.eventTypes?.CHAT_CHANGED;
    const handleChatChanged = () => {
        try { state.abortController?.abort(); } catch { /* ignore */ }
        try { popup.complete(POPUP_RESULT.CANCELLED); } catch { /* ignore */ }
    };
    if (chatChangedEvent && context?.eventSource?.on) {
        context.eventSource.on(chatChangedEvent, handleChatChanged);
    }

    // Wire the iteration-library zoom overlay so per-entry JSON diff
    // Expand button + splitter + Esc-key affordances work scoped to
    // this popup.
    const zoomOverlayUnbind = ITER_ZOOM_OVERLAY.attachZoomOverlay($root[0], {
        namespace: `.mgGraphItDiff_${popupId}`,
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
    $root.on('click.mgGraphIt', '[data-mg-graph-it-action="send"]', async (e) => {
        e.preventDefault();
        await handleSendMessage();
    });

    // Q5: Plain Enter → newline (textarea default).
    //     Ctrl/Cmd-Enter → send.
    $root.on('keydown.mgGraphIt', '[data-mg-graph-it-input]', async (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            await handleSendMessage();
        }
    });

    // Q3: history details collapse state persists per-session.
    $root.on('toggle.mgGraphIt', '[data-mg-graph-it-history]', async (e) => {
        const open = Boolean(e.currentTarget?.open);
        state.session.surfaceState = { ...(state.session.surfaceState || {}), historyOpen: open };
        await persistSessionQuiet('history toggle');
    });

    // Proposal-bus click delegation. The bus owns approve / reject / reset
    // / rollback per-card AND approve-all / reject-all / rollback-turn
    // turn-actions; any click whose target carries `data-proposal-action`
    // is consumed here. Returns false for unmatched clicks so the rest of
    // the popup's handlers (workspace tabs, regenerate, etc.) still fire.
    $root.on('click.mgGraphIt', async (e) => {
        await bus.handleClick(e);
    });
    $root.on('click.mgGraphIt', '[data-mg-graph-it-action="new-session"]', async (e) => {
        e.preventDefault();
        await startNewSession();
    });
    // Q9: clear-history lives inside the <details>; same delegation root.
    $root.on('click.mgGraphIt', '[data-mg-graph-it-action="clear-history"]', async (e) => {
        e.preventDefault();
        await clearAllHistory();
    });
    $root.on('click.mgGraphIt', '[data-mg-graph-it-action="load-session"]', async (e) => {
        // The delete button is a child of the load row — stop the row's
        // click from firing when the user is removing an item.
        const target = e.target;
        if (target && target.matches?.('[data-mg-graph-it-action="delete-session"]')) return;
        const id = String(e.currentTarget?.dataset?.mgGraphItId || '');
        if (id && id !== state.session.id) {
            await loadSession(id);
        }
    });
    $root.on('click.mgGraphIt', '[data-mg-graph-it-action="delete-session"]', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = String(e.currentTarget?.dataset?.mgGraphItId || '');
        if (!id) return;
        // Deleting the active session also tears down any in-flight LLM call
        // so the response can't land in the recreated next session.
        if (id === state.session?.id) {
            try { state.abortController?.abort(); } catch { /* ignore */ }
            state.isBusy = false;
            state.aborting = false;
            state.abortController = null;
        }
        let deleted = false;
        try {
            await sessionStore.delete(id);
            deleted = true;
        } catch (err) {
            // Keep the item in the history list and tell the user instead of
            // letting the rejection break the handler.
            // eslint-disable-next-line no-console
            console.warn(`[${MODULE}] delete session ${id} failed`, err);
            try {
                toastr.warning(
                    t('Session delete failed — it is still in the saved history.'),
                    t('Delete failed'),
                    { timeOut: 8000 },
                );
            } catch { /* toastr optional in tests */ }
        }
        if (deleted && state.session.id === id) {
            await startNewSession();
        } else {
            await render();
        }
    });

    // Per-message Regenerate / Rollback. Both buttons are rendered by
    // `iteration-library/ui/message.renderMessageCard`, which emits them
    // with `data-mg-graph-it-action="regenerate"` / `="rollback-batch"`
    // (via the actionAttribute opt) and `data-luker-lib-msg-id="..."`.
    // The msgId resolver accepts both attribute names so a future
    // MG-only override that still tags `data-mg-graph-it-msg-id`
    // keeps working.
    function resolveMsgId(target) {
        if (!target) return '';
        // dataset is camelCase: mgGraphItMsgId / lukerLibMsgId
        return String(target.dataset?.mgGraphItMsgId || target.dataset?.lukerLibMsgId || '');
    }
    $root.on('click.mgGraphIt', '[data-mg-graph-it-action="regenerate"]', async (e) => {
        e.preventDefault();
        const msgId = resolveMsgId(e.currentTarget);
        if (!msgId) return;
        await regenerateFromMessage(msgId);
    });
    $root.on('click.mgGraphIt', '[data-mg-graph-it-action="edit-user-message"]', async (e) => {
        e.preventDefault();
        if (state.isBusy) return;
        const msgId = resolveMsgId(e.currentTarget);
        if (!msgId) return;
        await editUserMessage(msgId);
    });
    // Per-batch rollback is now bus-driven: the turn-actions row rendered
    // by bus.renderTurnActions emits `data-proposal-action="rollback-turn"`
    // which the bus click delegator above consumes.

    // ── Workspace events ──────────────────────────────────────────────
    // Mobile tab switcher — only relevant when the < 900px media query
    // collapses the grid; on desktop both panes are mounted simultaneously
    // and the tab bar is hidden via CSS.
    $root.on('click.mgGraphIt', '[data-iter-action="switch-tab"]', (e) => {
        const tab = e.currentTarget?.dataset?.iterTab;
        if (!tab) return;
        e.preventDefault();
        setActiveTab(tab);
    });

    // Composer-row auto-apply toggle. Persists per-session via surfaceState
    // and mirrors into bus.setAutoApprove. Toggling ON when proposals are
    // already pending kicks each one through bus.approve immediately,
    // matching the orchestrator's existing behavior.
    $root.on('change.mgGraphIt', '[data-mg-graph-it-action="toggle-auto-apply"]', async (e) => {
        const checked = Boolean(e.currentTarget?.checked);
        state.session.surfaceState = {
            ...(state.session.surfaceState || {}),
            autoApply: checked,
        };
        bus.setAutoApprove(checked);
        await persistSessionQuiet('auto-apply toggle');
        if (checked) {
            try {
                for (const entry of bus._testOnly_entries()) {
                    if (entry.status === 'pending') await bus.approve(entry.id);
                }
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[${MODULE}] auto-apply on toggle failed`, err);
            }
        }
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
        try { unbindChainBroken?.(); } catch { /* ignore */ }
        if (chatChangedEvent) {
            try { context?.eventSource?.removeListener?.(chatChangedEvent, handleChatChanged); } catch { /* ignore */ }
        }
        try { state.abortController?.abort(); } catch { /* ignore */ }
        // Stop accepting new bus-driven renders before final persist — a
        // propose() landing during teardown would otherwise queue a frame
        // that fires after the popup DOM detached.
        try { busRenderScheduler.dispose(); } catch { /* ignore */ }
        state.isBusy = false;
        state.aborting = false;
        state.abortController = null;
        await persistSessionQuiet('teardown');
    }
}

// Re-export the small surface from peer modules so importers don't need to
// chase three import paths to find the popup, its tools, and its system-
// prompt builder. Used by tests + by main.js's lazy import.
export { MG_GRAPH_TOOL_DISPLAY } from './tool-display.js';
