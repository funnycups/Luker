/**
 * IterationStudio — turn runner (IDE-style).
 *
 * Responsible for:
 *   - Tool catalog assembly (adapter + shell control tools)
 *   - LLM call (delegated to existing tool-calling helpers)
 *   - Tool classification (editable vs control)
 *   - Editable dispatch via adapter.normalizeToolCallToEdit → lib.applyEdits → adapter.commit
 *   - Pending-approval sandbox projection
 *   - Rollback via lib.inverseEdit
 *
 * Does NOT carry a workingProfile. adapter.live() is authority.
 */

import { applyEdits, inverseEdit } from '../lib/edits/index.js';
import { showConflictResolution } from '../lib/edits/conflict-ui.js';
import { i18n } from './i18n.js';
import { trimSessionMessages } from './session.js';
import {
    buildExecutionToolCalls,
    buildPendingToolResults,
    buildPersistentToolCallsFromRawCalls,
    buildPersistentToolHistoryMessages,
    createPersistentToolTurnMessage,
    makeAiIterationMessageId,
    requestToolCallsWithRetry,
} from '../extensions/orchestrator/tool-calling.js';

const SHELL_CONTROL_DEFAULTS = { continue: 'iter_continue', finalize: 'iter_finalize' };

function stripThoughtTags(value) {
    const text = String(value ?? '');
    if (!text) return '';
    const withoutBlocks = text.replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/gi, '');
    const withoutTags = withoutBlocks.replace(/<\/?thought\b[^>]*>/gi, '');
    return withoutTags.replace(/\n{3,}/g, '\n\n').trim();
}

export function getControlToolNames(adapter) {
    const override = adapter?.controlToolNames || {};
    return {
        continue: String(override.continue || SHELL_CONTROL_DEFAULTS.continue),
        finalize: String(override.finalize || SHELL_CONTROL_DEFAULTS.finalize),
    };
}

export function buildControlToolDefs(adapter) {
    const { continue: continueName, finalize: finalizeName } = getControlToolNames(adapter);
    return [
        {
            type: 'function',
            function: {
                name: continueName,
                description: 'Signal that more iteration is needed; shell will continue the loop.',
                parameters: {
                    type: 'object',
                    properties: { reason: { type: 'string' } },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: finalizeName,
                description: 'Signal that all requested work is complete.',
                parameters: {
                    type: 'object',
                    properties: { summary: { type: 'string' } },
                    additionalProperties: false,
                },
            },
        },
    ];
}

export function classifyToolCalls(adapter, calls) {
    const { continue: continueName, finalize: finalizeName } = getControlToolNames(adapter);
    const controlCalls = [];
    const editableCalls = [];
    for (const call of Array.isArray(calls) ? calls : []) {
        const name = String(call?.name || '').trim();
        if (!name) continue;
        if (name === continueName || name === finalizeName) {
            controlCalls.push(call);
            continue;
        }
        const verdict = typeof adapter?.classifyToolCall === 'function'
            ? adapter.classifyToolCall(call)
            : 'editable';
        if (verdict === 'control') controlCalls.push(call);
        else editableCalls.push(call);
    }
    return { controlCalls, editableCalls };
}

// Per-turn dispatcher: walks tool calls in order, routes control vs
// editable, accumulates editable Edits into one batch, and commits via
// the adapter. On conflict surfaces the 3-pane UI; on commit failure
// attempts a best-effort inverse rollback.
export async function executeToolCalls(adapter, session, allCalls, abortSignal) {
    const { continue: continueName, finalize: finalizeName } = getControlToolNames(adapter);
    const result = {
        actions: [],
        toolResults: [],
        finalized: false,
        finalizeSummary: '',
        continueRequested: false,
        changed: false,
        appliedEdits: [],
    };

    const calls = Array.isArray(allCalls) ? allCalls : [];
    const editsToApply = [];        // accumulated for one batch commit per turn
    const liveBefore = await adapter.live();
    let currentLive = liveBefore;

    for (const call of calls) {
        const name = String(call?.name || '').trim();
        if (!name) continue;

        // Shell control tools
        if (name === continueName) {
            result.continueRequested = true;
            result.toolResults.push({
                tool_call_id: String(call?.id || ''),
                content: JSON.stringify({ ok: true, continueRequested: true, note: String(call?.args?.reason || '') }),
            });
            continue;
        }
        if (name === finalizeName) {
            result.finalized = true;
            const summary = String(call?.args?.summary || '').trim();
            if (summary) result.finalizeSummary = summary;
            result.toolResults.push({
                tool_call_id: String(call?.id || ''),
                content: JSON.stringify({ ok: true, finalized: true, summary }),
            });
            continue;
        }

        // Adapter classification
        const cls = typeof adapter.classifyToolCall === 'function' ? adapter.classifyToolCall(call) : 'editable';
        if (cls === 'control') {
            try {
                const ctrl = await adapter.executeControlToolCall(call, { session, live: currentLive }, abortSignal);
                result.toolResults.push({
                    tool_call_id: String(call?.id || ''),
                    content: typeof ctrl?.content === 'string' ? ctrl.content : JSON.stringify(ctrl ?? { ok: true }),
                });
                if (ctrl?.action) result.actions.push(String(ctrl.action));
                if (ctrl?.continueRequested) result.continueRequested = true;
                if (ctrl?.finalized) {
                    result.finalized = true;
                    if (ctrl.finalizeSummary) result.finalizeSummary = String(ctrl.finalizeSummary);
                }
            } catch (error) {
                result.toolResults.push({
                    tool_call_id: String(call?.id || ''),
                    content: JSON.stringify({ ok: false, error: String(error?.message || error) }),
                });
            }
            continue;
        }

        // Editable tool: normalize to Edit[]. The contract allows the
        // adapter to return a Promise (e.g. orchestrator's sandbox-diff
        // strategy awaits its own async executor), so we await here.
        let edits;
        try {
            edits = await adapter.normalizeToolCallToEdit(call, { session, live: currentLive });
        } catch (error) {
            result.toolResults.push({
                tool_call_id: String(call?.id || ''),
                content: JSON.stringify({ ok: false, error: String(error?.message || error) }),
            });
            continue;
        }
        if (edits === null) {
            result.toolResults.push({
                tool_call_id: String(call?.id || ''),
                content: JSON.stringify({ ok: true, note: 'edit_rejected_malformed' }),
            });
            continue;
        }
        if (!Array.isArray(edits) || edits.length === 0) {
            result.toolResults.push({
                tool_call_id: String(call?.id || ''),
                content: JSON.stringify({ ok: true, note: 'no_op' }),
            });
            continue;
        }
        editsToApply.push(...edits);
        result.toolResults.push({
            tool_call_id: String(call?.id || ''),
            content: JSON.stringify({ ok: true, staged: edits.length }),
        });
        const adapterAction = typeof adapter.describeTool === 'function'
            ? adapter.describeTool(name)
            : name;
        result.actions.push(adapterAction);
    }

    if (editsToApply.length === 0) {
        return result;
    }

    // One batch apply per turn. The engine returns { newLive, clean,
    // conflicts, alreadyDone }; on conflicts we surface the 3-pane UI
    // and re-apply with the user's resolutions (apply-mine / manual)
    // merged into the previously-clean set.
    let applyResult = applyEdits(editsToApply, currentLive);
    if (applyResult.conflicts.length > 0) {
        const resolutions = await showConflictResolution(applyResult.conflicts);
        if (!resolutions) {
            // User cancelled the conflict popup. Treat as a no-op apply.
            return result;
        }
        const resolvedEdits = [...applyResult.clean];
        for (const resolution of resolutions) {
            if (resolution.decision === 'apply-mine') {
                resolvedEdits.push(resolution.edit);
            } else if (resolution.decision === 'manual') {
                if (resolution.edit.op === 'set') {
                    resolvedEdits.push({ ...resolution.edit, newValue: resolution.newValue });
                } else {
                    resolvedEdits.push(resolution.edit);
                }
            }
            // 'keep-theirs' → skip.
        }
        applyResult = applyEdits(resolvedEdits, currentLive);
    }
    currentLive = applyResult.newLive;
    result.appliedEdits = Array.isArray(applyResult.clean) ? applyResult.clean : [];

    // Commit; on failure roll back via inverse (best-effort).
    try {
        await adapter.commit(currentLive);
    } catch (error) {
        const inverses = result.appliedEdits.map(e => inverseEdit(e)).reverse();
        try {
            const rb = applyEdits(inverses, currentLive);
            await adapter.commit(rb.newLive);
        } catch (_rollbackError) { /* ignore — best effort */ }
        result.appliedEdits = [];
        throw error;
    }

    result.changed = result.appliedEdits.length > 0;
    return result;
}

async function callLlm(adapter, context, settings, session, { systemPrompt, userPrompt, tools, abortSignal }) {
    const presetOptions = typeof adapter.getRequestPresetOptions === 'function'
        ? adapter.getRequestPresetOptions(settings) || {}
        : {};
    const apiPresetName = String(presetOptions.apiPresetName || '').trim();
    const llmPresetName = String(presetOptions.llmPresetName || '').trim();
    const runtimeWorldInfo = typeof adapter.resolveRuntimeWorldInfo === 'function'
        ? (await adapter.resolveRuntimeWorldInfo(session, abortSignal)) || null
        : null;
    const allowedNames = new Set(tools.map(t => String(t?.function?.name || '').trim()).filter(Boolean));
    const taskMessages = [
        { role: 'system', content: systemPrompt },
        ...buildPersistentToolHistoryMessages(session.messages),
        { role: 'user', content: userPrompt },
    ];
    return await requestToolCallsWithRetry(context, settings, {
        taskMessages,
        runtimeWorldInfo,
        apiPresetName,
        llmPresetName,
        tools,
        allowedNames,
        abortSignal,
        includeAssistantText: true,
        allowNoToolCalls: true,
    });
}

export async function runIterationTurn(adapter, context, settings, session, userText, abortSignal = null, opts = {}) {
    const { auto = false, appendUserMessage = true, autoApply = false, reference = null } = opts;
    const text = String(userText || '').trim();
    if (!text) return { ok: false, message: 'empty_input' };

    if (appendUserMessage) {
        session.messages.push({
            id: makeAiIterationMessageId('iter_user'),
            role: 'user', content: text, auto: Boolean(auto), at: Date.now(),
        });
        trimSessionMessages(session);
    }

    const editableTools = adapter.buildToolCatalog(session) || [];
    const tools = [...editableTools, ...buildControlToolDefs(adapter)];
    const systemPrompt = adapter.buildSystemPrompt(session);
    const userPrompt = adapter.buildUserPrompt(session, text, {
        reference,
        sourceScope: String(session?.sourceScope || ''),
        sourceName: String(session?.sourceName || ''),
    });

    const detailed = await callLlm(adapter, context, settings, session, { systemPrompt, userPrompt, tools, abortSignal });
    const executionToolCalls = buildExecutionToolCalls(Array.isArray(detailed?.toolCalls) ? detailed.toolCalls : []);
    const assistantText = stripThoughtTags(detailed?.assistantText || '');

    if (executionToolCalls.length === 0) {
        if (assistantText) {
            session.messages.push({
                id: makeAiIterationMessageId('iter_msg'),
                role: 'assistant', content: assistantText, auto: Boolean(auto), at: Date.now(),
            });
            trimSessionMessages(session);
            session.pendingApproval = null;
            session.updatedAt = Date.now();
            return { ok: true, pending: false, textOnly: true };
        }
        throw new Error(i18n('Function output is invalid.'));
    }

    const { editableCalls } = classifyToolCalls(adapter, executionToolCalls);
    const persistentToolCalls = buildPersistentToolCallsFromRawCalls(executionToolCalls);

    if (editableCalls.length > 0 && !autoApply) {
        const pendingSummary = i18n('AI suggested changes are waiting for approval.');
        const persistentToolResults = buildPendingToolResults(persistentToolCalls, pendingSummary);
        const messageId = makeAiIterationMessageId(`${adapter.id}_msg`);
        const message = createPersistentToolTurnMessage({
            messageId,
            assistantText: assistantText || pendingSummary,
            toolCalls: persistentToolCalls,
            toolResults: persistentToolResults,
            toolSummary: pendingSummary,
            toolState: 'pending',
            auto: Boolean(auto),
            at: Date.now(),
            extra: {
                pendingToolCalls: editableCalls.map(c => ({ ...c })),
                executionToolCalls: executionToolCalls.map(c => ({ ...c })),
            },
        });
        session.messages.push(message);
        await stagePendingApproval(adapter, session, {
            messageId, assistantText: assistantText || pendingSummary, calls: executionToolCalls,
        });
        trimSessionMessages(session);
        session.updatedAt = Date.now();
        return { ok: true, pending: true };
    }

    // Auto-apply path (or only control tools)
    const execResult = await executeToolCalls(adapter, session, executionToolCalls, abortSignal);
    const messageId = makeAiIterationMessageId(`${adapter.id}_msg`);
    session.messages.push(createPersistentToolTurnMessage({
        messageId,
        assistantText: assistantText || (execResult.actions[0] || ''),
        toolCalls: persistentToolCalls,
        toolResults: execResult.toolResults,
        toolSummary: execResult.actions.join('; '),
        toolState: 'completed',
        auto: Boolean(auto),
        at: Date.now(),
        extra: {
            executionToolCalls: executionToolCalls.map(c => ({ ...c })),
            appliedEdits: execResult.appliedEdits,
        },
    }));
    trimSessionMessages(session);
    session.pendingApproval = null;
    session.updatedAt = Date.now();
    return { ok: true, pending: false, autoApplied: true, executionResult: execResult };
}

export function buildAutoContinuePrompt(adapter, executionResult) {
    if (typeof adapter?.buildAutoContinuePrompt === 'function') {
        return adapter.buildAutoContinuePrompt(executionResult);
    }
    const { continue: continueName, finalize: finalizeName } = getControlToolNames(adapter);
    return [
        'AUTO CONTINUE',
        'Previous tool execution is complete. Review the result and continue iteration.',
        '',
        ...(executionResult?.actions || []).map(a => `- ${a}`),
        '',
        `If all requested work is complete, call ${finalizeName}.`,
        `Otherwise emit the next focused tool calls (you may include ${continueName} when more rounds are still needed).`,
    ].join('\n');
}

/**
 * Roll back the session to the state immediately before `messageId`.
 *
 * Walks `session.messages[N..latest]` in reverse, maps each message's
 * `appliedEdits` (also in reverse) through `inverseEdit`, then applies
 * the accumulated inverses as ONE batch via `lib.applyEdits` (two-phase
 * if conflicts surface), commits the resulting live, and marks every
 * message in the range with `rolledBack: true`.
 */
export async function rollbackToMessage(adapter, session, messageId) {
    if (!session || !Array.isArray(session.messages) || !messageId) {
        return { ok: false, error: 'invalid_args' };
    }
    const startIdx = session.messages.findIndex(m => String(m?.id || '') === String(messageId));
    if (startIdx < 0) {
        return { ok: false, error: 'message_not_found' };
    }
    const range = session.messages.slice(startIdx);
    const inverses = [];
    for (let i = range.length - 1; i >= 0; i -= 1) {
        const msg = range[i];
        const edits = Array.isArray(msg?.appliedEdits) ? msg.appliedEdits : [];
        for (let j = edits.length - 1; j >= 0; j -= 1) {
            inverses.push(inverseEdit(edits[j]));
        }
    }
    if (inverses.length === 0) {
        range.forEach(m => { m.rolledBack = true; });
        session.updatedAt = Date.now();
        return { ok: true, applied: 0 };
    }
    const live = await adapter.live();

    // Two-phase apply: detect conflicts → resolve via 3-pane UI → re-apply.
    let applyResult = applyEdits(inverses, live);
    if (applyResult.conflicts.length > 0) {
        const resolutions = await showConflictResolution(applyResult.conflicts);
        if (!resolutions) {
            return { ok: false, error: 'cancelled' };
        }
        const resolvedEdits = [...applyResult.clean];
        for (const resolution of resolutions) {
            if (resolution.decision === 'apply-mine') {
                resolvedEdits.push(resolution.edit);
            } else if (resolution.decision === 'manual') {
                if (resolution.edit.op === 'set') {
                    resolvedEdits.push({ ...resolution.edit, newValue: resolution.newValue });
                } else {
                    resolvedEdits.push(resolution.edit);
                }
            }
            // 'keep-theirs' → drop the edit.
        }
        applyResult = applyEdits(resolvedEdits, live);
    }

    await adapter.commit(applyResult.newLive);
    range.forEach(m => { m.rolledBack = true; });
    session.updatedAt = Date.now();
    return { ok: true, applied: applyResult.clean?.length || 0 };
}

export async function stagePendingApproval(adapter, session, { messageId, assistantText, calls }) {
    const liveSnapshot = await adapter.live();
    const editsToProject = [];
    for (const call of Array.isArray(calls) ? calls : []) {
        const cls = typeof adapter.classifyToolCall === 'function' ? adapter.classifyToolCall(call) : 'editable';
        if (cls !== 'editable') continue;
        let edits;
        try {
            edits = await adapter.normalizeToolCallToEdit(call, { session, live: liveSnapshot });
        } catch { continue; }
        if (Array.isArray(edits)) editsToProject.push(...edits);
    }
    let projectedLive = liveSnapshot;
    if (editsToProject.length > 0) {
        try {
            const projection = applyEdits(editsToProject, liveSnapshot);
            // If conflicts arise in sandbox projection, fall through with the
            // partially-applied clean result. The user will see real conflicts
            // when they click Approve (handled by executeToolCalls).
            projectedLive = projection.newLive;
        } catch (_error) {
            projectedLive = liveSnapshot;
        }
    }
    session.pendingApproval = {
        messageId: String(messageId || ''),
        assistantText: String(assistantText || ''),
        toolCalls: Array.isArray(calls) ? calls.slice() : [],
        executionToolCalls: Array.isArray(calls) ? calls.slice() : [],
        proposedEdits: editsToProject,
        createdAt: Date.now(),
    };
    return { projectedLive, proposedEdits: editsToProject };
}

export async function applyPendingApproval(adapter, session) {
    const pending = session?.pendingApproval;
    if (!pending) return { ok: false, error: 'no_pending' };
    const message = (session.messages || []).find(m => String(m?.id || '') === String(pending.messageId));
    if (!message) return { ok: false, error: 'message_missing' };

    const calls = Array.isArray(pending.executionToolCalls) ? pending.executionToolCalls : [];
    const result = await executeToolCalls(adapter, session, calls, null);
    message.appliedEdits = result.appliedEdits;
    message.toolState = result.changed ? 'completed' : (message.toolState || 'completed');
    message.tool_results = result.toolResults;
    session.pendingApproval = null;
    session.updatedAt = Date.now();
    return { ok: true, result };
}

export function rejectPendingApproval(session) {
    const pending = session?.pendingApproval;
    if (!pending) return { ok: false };
    const message = (session.messages || []).find(m => String(m?.id || '') === String(pending.messageId));
    if (message) {
        message.toolState = 'rejected';
    }
    session.pendingApproval = null;
    session.updatedAt = Date.now();
    return { ok: true };
}
