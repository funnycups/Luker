/**
 * IterationStudio — turn runner.
 *
 * One LLM round-trip per call. Builds prompts via the adapter, ships the
 * request through orchestrator/tool-calling.js (still the canonical home of
 * the retry / RPM / timeout plumbing; we may relocate it later), processes
 * the response into either a pending-approval message or an auto-applied
 * tool execution.
 *
 * Control tools (continue / finalize) are owned by the shell — adapters do
 * NOT need to declare or dispatch them. The shell extracts them from the
 * call list, sets the corresponding execution-result flags, and forwards
 * only editable calls into adapter.executeEditableToolCall.
 */

import {
    buildExecutionToolCalls,
    buildPersistentToolCallsFromRawCalls,
    buildPendingToolResults,
    buildPersistentToolHistoryMessages,
    buildToolCallSummary,
    createPersistentToolTurnMessage,
    makeAiIterationMessageId,
    requestToolCallsWithRetry,
    serializeToolResultContent,
} from '../extensions/orchestrator/tool-calling.js';
import { buildProfileDelta } from './delta.js';
import { trimSessionMessages } from './session.js';
import { i18n, i18nFormat } from './i18n.js';

const DEFAULT_CONTROL_TOOL_NAMES = Object.freeze({
    continue: 'iter_continue',
    finalize: 'iter_finalize',
});

export function getControlToolNames(adapter) {
    const override = (adapter && adapter.controlToolNames) || {};
    return {
        continue: String(override.continue || DEFAULT_CONTROL_TOOL_NAMES.continue),
        finalize: String(override.finalize || DEFAULT_CONTROL_TOOL_NAMES.finalize),
    };
}

export function buildControlToolDefs(adapter) {
    const { continue: continueName, finalize: finalizeName } = getControlToolNames(adapter);
    return [
        {
            type: 'function',
            function: {
                name: continueName,
                description: i18n('Signal that another iteration is needed after the current tools complete. Use when more changes are pending.'),
                parameters: {
                    type: 'object',
                    properties: {
                        reason: { type: 'string', description: 'Brief reason for continuing.' },
                    },
                    required: [],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: finalizeName,
                description: i18n('Signal that the iteration is complete and no further changes are needed.'),
                parameters: {
                    type: 'object',
                    properties: {
                        summary: { type: 'string', description: 'Brief summary of what was finalized.' },
                    },
                    required: [],
                    additionalProperties: false,
                },
            },
        },
    ];
}

function stripThoughtTags(value) {
    const text = String(value ?? '');
    if (!text) return '';
    const withoutBlocks = text.replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/gi, '');
    const withoutTags = withoutBlocks.replace(/<\/?thought\b[^>]*>/gi, '');
    return withoutTags.replace(/\n{3,}/g, '\n\n').trim();
}

function splitCallsByControl(adapter, allCalls) {
    const { continue: continueName, finalize: finalizeName } = getControlToolNames(adapter);
    const controlSet = new Set([continueName, finalizeName]);
    const editableCalls = [];
    const controlCalls = [];
    for (const call of Array.isArray(allCalls) ? allCalls : []) {
        const name = String(call?.name || '').trim();
        if (controlSet.has(name)) {
            controlCalls.push(call);
        } else {
            editableCalls.push(call);
        }
    }
    return { allCalls: Array.isArray(allCalls) ? allCalls : [], editableCalls, controlCalls };
}

function buildFriendlySummary(executionResult) {
    const actions = Array.isArray(executionResult?.actions) ? executionResult.actions : [];
    if (actions.length === 0 && !executionResult?.finalizeSummary) {
        return i18n('AI iteration updated.');
    }
    const lines = actions.length > 0
        ? [i18nFormat('Executed ${0} operation(s).', actions.length), ...actions]
        : [];
    if (executionResult?.finalizeSummary) {
        lines.push(i18nFormat('Summary: ${0}', executionResult.finalizeSummary));
    }
    return lines.join('\n');
}

export function buildAutoContinuePrompt(adapter, executionResult) {
    if (typeof adapter.buildAutoContinuePrompt === 'function') {
        return adapter.buildAutoContinuePrompt(executionResult);
    }
    const { continue: continueName, finalize: finalizeName } = getControlToolNames(adapter);
    return [
        'AUTO CONTINUE',
        'Previous tool execution is complete. Review the result and continue iteration.',
        '',
        buildFriendlySummary(executionResult),
        '',
        `If all requested work is complete, call ${finalizeName}.`,
        `Otherwise, emit the next focused tool calls (you may include ${continueName} when more rounds are still needed).`,
    ].join('\n');
}

/**
 * Execute the editable + control calls in order, mutating session.workingProfile.
 * Returns a uniform ExecutionResult.
 */
export async function executeToolCalls(adapter, context, session, allCalls, abortSignal) {
    const { continue: continueName, finalize: finalizeName } = getControlToolNames(adapter);
    const result = {
        actions: [],
        simulations: [],
        toolResults: [],
        finalized: false,
        finalizeSummary: '',
        continueRequested: false,
        changed: false,
    };
    for (const call of Array.isArray(allCalls) ? allCalls : []) {
        const name = String(call?.name || '').trim();
        if (!name) continue;
        if (name === continueName) {
            result.continueRequested = true;
            result.toolResults.push({
                tool_call_id: String(call?.id || ''),
                content: serializeToolResultContent({ ok: true, continueRequested: true, note: String(call?.args?.reason || '') }),
            });
            continue;
        }
        if (name === finalizeName) {
            result.finalized = true;
            const summary = String(call?.args?.summary || '').trim();
            if (summary) {
                result.finalizeSummary = summary;
            }
            result.toolResults.push({
                tool_call_id: String(call?.id || ''),
                content: serializeToolResultContent({ ok: true, finalized: true, summary }),
            });
            continue;
        }
        try {
            const dispatch = await adapter.executeEditableToolCall(context, session, call, abortSignal);
            const content = dispatch?.content ?? serializeToolResultContent({ ok: true });
            result.toolResults.push({
                tool_call_id: String(call?.id || ''),
                content: typeof content === 'string' ? content : serializeToolResultContent(content),
            });
            if (dispatch?.action) result.actions.push(String(dispatch.action));
            if (dispatch?.changed) {
                result.changed = true;
                session.revision = Math.max(1, Math.floor(Number(session.revision) || 1)) + 1;
                session.updatedAt = Date.now();
            }
        } catch (error) {
            result.toolResults.push({
                tool_call_id: String(call?.id || ''),
                content: serializeToolResultContent({ ok: false, error: String(error?.message || error) }),
            });
        }
    }
    return result;
}

async function callLlm(adapter, context, settings, session, { systemPrompt, userPrompt, tools, abortSignal }) {
    const presetOptions = typeof adapter.getRequestPresetOptions === 'function'
        ? adapter.getRequestPresetOptions(settings) || {}
        : {};
    const apiPresetName = String(presetOptions.apiPresetName || '').trim();
    const llmPresetName = String(presetOptions.llmPresetName || '').trim();
    const runtimeWorldInfo = typeof adapter.resolveRuntimeWorldInfo === 'function'
        ? (await adapter.resolveRuntimeWorldInfo(context, settings, session, abortSignal)) || null
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

/**
 * Run one iteration turn. Returns one of:
 *   - {ok: false, message: 'empty_input'}     when userText is blank
 *   - {ok: true, pending: false, textOnly: true}    LLM emitted only text
 *   - {ok: true, pending: true}               LLM proposed editable tools, awaiting approval
 *   - {ok: true, pending: false, autoApplied: true, executionResult}    auto-applied (only control tools were emitted, or no editable tools)
 */
export async function runIterationTurn(adapter, context, settings, session, userText, abortSignal = null, { auto = false, appendUserMessage = true, autoApply = false } = {}) {
    const text = String(userText || '').trim();
    if (!text) {
        return { ok: false, message: 'empty_input' };
    }
    if (appendUserMessage) {
        session.messages.push({ role: 'user', content: text, auto: Boolean(auto), at: Date.now() });
        trimSessionMessages(session);
    }

    const editableTools = adapter.buildEditableToolSet(session) || [];
    const tools = [...editableTools, ...buildControlToolDefs(adapter)];
    const baseline = adapter.getGlobalBaselineProfile?.(settings, session) || null;
    const beforeProfile = adapter.cloneWorkingProfile(session.workingProfile);

    const systemPrompt = adapter.buildSystemPrompt(settings, session);
    const userPrompt = adapter.buildUserPrompt(settings, session, text, {
        globalProfile: baseline,
        sourceScope: String(session?.sourceScope || ''),
        sourceName: String(session?.sourceName || ''),
    });

    const detailed = await callLlm(adapter, context, settings, session, { systemPrompt, userPrompt, tools, abortSignal });
    const executionToolCalls = buildExecutionToolCalls(Array.isArray(detailed?.toolCalls) ? detailed.toolCalls : []);
    const assistantText = stripThoughtTags(detailed?.assistantText || '');

    if (executionToolCalls.length === 0) {
        if (assistantText) {
            session.messages.push({
                role: 'assistant',
                content: assistantText,
                auto: Boolean(auto),
                at: Date.now(),
            });
            trimSessionMessages(session);
            session.pendingApproval = null;
            session.updatedAt = Date.now();
            return { ok: true, pending: false, textOnly: true };
        }
        throw new Error(i18n('Function output is invalid.'));
    }

    const split = splitCallsByControl(adapter, executionToolCalls);
    const persistentToolCalls = buildPersistentToolCallsFromRawCalls(split.allCalls);
    const visibleAssistantText = assistantText || buildToolCallSummary(persistentToolCalls);

    if (split.editableCalls.length > 0 && !autoApply) {
        const pendingSummary = i18n('AI suggested changes are waiting for approval.');
        const persistentToolResults = buildPendingToolResults(persistentToolCalls, pendingSummary);

        // Project the diff: sandbox-execute editable calls on a cloned
        // session so the user sees what would change BEFORE clicking
        // Approve. adapter.executeEditableToolCall must be side-effect-
        // free w.r.t. anything outside session.workingProfile / .lastSimulation
        // for this to be safe (it is for orchestrator + memory-graph).
        let pendingDelta = null;
        let pendingReverseDelta = null;
        let pendingBeforeSnapshot = beforeProfile;
        try {
            const sandboxSession = {
                ...session,
                workingProfile: adapter.cloneWorkingProfile(session.workingProfile),
                baseWorkingProfile: adapter.cloneWorkingProfile(session.baseWorkingProfile || session.workingProfile),
                lastSimulation: session.lastSimulation ? structuredClone(session.lastSimulation) : null,
                pendingApproval: null,
                messages: Array.isArray(session.messages) ? session.messages.slice() : [],
            };
            for (const editableCall of split.editableCalls) {
                await adapter.executeEditableToolCall(context, sandboxSession, editableCall, abortSignal);
            }
            const projected = buildProfileDelta(adapter, beforeProfile, sandboxSession.workingProfile);
            pendingBeforeSnapshot = projected.beforeProfile;
            pendingDelta = projected.delta;
            pendingReverseDelta = projected.reverseDelta;
        } catch (error) {
            console.warn(`[iteration-studio:${adapter.id}] Failed to project pending diff`, error);
        }

        const assistantMessage = createPersistentToolTurnMessage({
            messageId: makeAiIterationMessageId(`${adapter.id}_msg`),
            assistantText: visibleAssistantText,
            toolCalls: persistentToolCalls,
            toolResults: persistentToolResults,
            toolSummary: pendingSummary,
            toolState: 'pending',
            auto: Boolean(auto),
            at: Date.now(),
            extra: {
                pendingToolCalls: structuredClone(split.editableCalls),
                executionToolCalls: structuredClone(split.allCalls),
                profileSnapshotBefore: pendingBeforeSnapshot,
                profileDelta: pendingDelta,
                reverseProfileDelta: pendingReverseDelta,
            },
        });
        session.messages.push(assistantMessage);
        trimSessionMessages(session);
        session.pendingApproval = {
            messageId: assistantMessage.id,
            assistantText: visibleAssistantText,
            toolCalls: split.editableCalls,
            executionToolCalls: split.allCalls,
            createdAt: Date.now(),
        };
        session.updatedAt = Date.now();
        return { ok: true, pending: true };
    }

    // No editable calls — only control flow (continue/finalize). Auto-apply.
    const executionResult = await executeToolCalls(adapter, context, session, split.allCalls, abortSignal);
    const completedDiff = buildProfileDelta(adapter, beforeProfile, session.workingProfile);
    session.messages.push(createPersistentToolTurnMessage({
        messageId: makeAiIterationMessageId(`${adapter.id}_msg`),
        assistantText: visibleAssistantText,
        toolCalls: persistentToolCalls,
        toolResults: Array.isArray(executionResult?.toolResults) ? executionResult.toolResults : [],
        toolSummary: buildFriendlySummary(executionResult),
        toolState: 'completed',
        auto: Boolean(auto),
        at: Date.now(),
        extra: {
            profileSnapshotBefore: completedDiff.beforeProfile,
            profileDelta: completedDiff.delta,
            reverseProfileDelta: completedDiff.reverseDelta,
            profileSnapshotAfter: adapter.cloneWorkingProfile(session.workingProfile),
            lastSimulationAfter: session?.lastSimulation ? structuredClone(session.lastSimulation) : null,
        },
    }));
    trimSessionMessages(session);
    session.pendingApproval = null;
    session.updatedAt = Date.now();
    return { ok: true, pending: false, autoApplied: true, executionResult };
}

/**
 * Apply an approved set of editable calls. Used when the user clicks
 * Approve on a pending message. Mutates session.workingProfile via
 * adapter.executeEditableToolCall and returns the uniform ExecutionResult.
 */
export async function applyApprovedToolCalls(adapter, context, session, executionToolCalls, abortSignal) {
    return await executeToolCalls(adapter, context, session, executionToolCalls, abortSignal);
}

export { buildFriendlySummary };
