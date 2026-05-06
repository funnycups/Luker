/**
 * Agenda execution-mode runtime for the orchestrator.
 *
 * The "agenda" mode runs a planner that owns a TODO board and dispatches
 * one or more text agents per round. The planner can `add` / `set_status`
 * / `drop` todos via tool-call ops, and either `dispatches` agents on
 * each round or signals `finalize` to stop. After the planner loop ends,
 * a single configurable `finalAgentId` produces the orchestration
 * guidance text that becomes the capsule body.
 *
 * Module layout, top-down:
 *
 *   - State helpers:
 *     `AGENDA_TODO_STATUSES`, `normalizeAgendaTodoStatus`,
 *     `createAgendaRunId`, `createAgendaTodo`, `upsertAgendaTodo`,
 *     `selectAgendaRuns`, `applyAgendaPlannerOps`,
 *     `normalizeAgendaDispatches`.
 *   - Prompt-building helpers (all return markdown strings the
 *     planner / agents see in their user prompt):
 *     `buildAgendaRecentChatText`, `buildAgendaLastUserText`,
 *     `buildAgendaSelectedRunOutputsText`, `buildAgendaDistillerOutputText`,
 *     `buildAgendaSharedContextText`, `buildAgendaTodosText`,
 *     `buildAgendaRunsText`.
 *   - Trace bridge: `syncAgendaTrace` mirrors the agenda state into the
 *     runtime trace payload so the trace popup can render planner rounds,
 *     todos, and per-run outputs.
 *   - Tool-call drivers:
 *     `runAgendaPlannerStep` issues the planner tool call,
 *     `runAgendaTextAgent` issues an agent (or finalize) tool call.
 *   - Entry point: `runAgendaOrchestration` drives the planner loop up to
 *     `plannerMaxRounds`, dispatches agents in parallel honoring
 *     `maxConcurrentAgents` / `maxTotalRuns`, then runs the final agent
 *     and returns the same `{ stageOutputs, previousNodeOutputs,
 *     runtimeTrace, reviewRerunCount, agendaState }` envelope as
 *     spec mode.
 *
 * Limits read at runtime:
 *   - `plannerMaxRounds` — clamped against `getAgendaPlannerMaxRounds`
 *     and the per-profile limit.
 *   - `maxConcurrentAgents` — caps `dispatches.length` per round.
 *   - `maxTotalRuns` — caps total agent runs across all rounds.
 */

import { extension_settings } from '../../extensions.js';
import { isAbortSignalLike, throwIfAborted } from './abort-utils.js';
import { extractLastUserMessage, getRecentMessages } from './anchors.js';
import {
    AGENDA_PLANNER_TOOL,
    AGENDA_RESULT_TOOL,
    DEFAULT_AGENDA_PLANNER_PROMPT,
    DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT,
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_NODE_TYPE_WORKER,
} from './defaults.js';
import {
    resolveOrchestrationAgentApiPresetName,
    resolveOrchestrationAgentPromptPresetName,
    resolveOrchestrationRuntimeWorldInfo,
} from './agent-resolution.js';
import {
    buildAgendaAvailableAgentsText,
    getAgendaMaxConcurrentAgents,
    getAgendaMaxTotalRuns,
    getAgendaPlannerMaxRounds,
} from './agenda-profile.js';
import {
    createAgendaPlannerDraft,
    sanitizeIdentifierToken,
} from './editable-spec.js';
import { toReadableYamlText } from './output-formatting.js';
import { buildAutoInjectedNodePromptPrelude } from './review-feedback.js';
import {
    beginOrchestrationRuntimeNodeAttempt,
    buildOrchestrationRuntimeSlotKey,
    createOrchestrationRuntimeTrace,
    finishOrchestrationRuntimeNodeAttempt,
} from './runtime-trace.js';
import { getPreviousOrchestrationCapsuleText } from './snapshot-cache.js';
import {
    getNodeIterationMaxRounds,
    getReviewRerunMaxRounds,
} from './spec-schema.js';
import {
    normalizeTemplateForRuntime,
    renderTemplate,
} from './template-vars.js';
import { requestToolCallWithRetry } from './tool-calling.js';
import { buildRuntimeWorldInfoFromPayload } from './world-info.js';

const MODULE_NAME = 'orchestrator';

export const AGENDA_TODO_STATUSES = Object.freeze(['todo', 'doing', 'done', 'blocked', 'dropped']);

export function normalizeAgendaTodoStatus(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return AGENDA_TODO_STATUSES.includes(normalized) ? normalized : 'todo';
}

export function createAgendaRunId() {
    return `agenda_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createAgendaTodo({ id = '', goal = '', status = 'todo' } = {}) {
    const todoId = sanitizeIdentifierToken(id, '');
    const goalText = String(goal || '').trim();
    if (!todoId || !goalText) {
        return null;
    }
    return {
        id: todoId,
        goal: goalText,
        status: normalizeAgendaTodoStatus(status),
    };
}

export function buildAgendaRecentChatText(messages, settings = extension_settings[MODULE_NAME]) {
    return getRecentMessages(messages, settings?.maxRecentMessages)
        .map(message => `${message?.is_user ? 'User' : (message?.name || 'Assistant')}: ${String(message?.mes || '')}`)
        .join('\n');
}

export function buildAgendaLastUserText(messages) {
    const { message: lastUser } = extractLastUserMessage(messages);
    return String(lastUser?.mes || '');
}

export function selectAgendaRuns(runs = [], selectedRunIds = null) {
    const selected = selectedRunIds instanceof Set ? selectedRunIds : null;
    return (Array.isArray(runs) ? runs : []).filter((run) => {
        if (!selected) {
            return true;
        }
        return selected.has(String(run?.runId || ''));
    });
}

export function buildAgendaSelectedRunOutputsText(runs = [], selectedRunIds = null) {
    const source = selectAgendaRuns(runs, selectedRunIds);
    if (source.length === 0) {
        return '(none)';
    }
    return source.map((run) => [
        `[${String(run?.runId || '')}] ${String(run?.agent || '')} / ${String(run?.todoId || '')}`,
        String(run?.outputText || ''),
    ].join('\n')).join('\n\n');
}

export function buildAgendaDistillerOutputText(runs = [], selectedRunIds = null) {
    const selectedSource = selectAgendaRuns(runs, selectedRunIds);
    const selectedDistiller = selectedSource.filter(run => String(run?.agent || '') === 'distiller' && String(run?.outputText || '').trim());
    if (selectedDistiller.length > 0) {
        return String(selectedDistiller[selectedDistiller.length - 1]?.outputText || '');
    }
    const allDistiller = (Array.isArray(runs) ? runs : []).filter(run => String(run?.agent || '') === 'distiller' && String(run?.outputText || '').trim());
    return allDistiller.length > 0 ? String(allDistiller[allDistiller.length - 1]?.outputText || '') : '(none)';
}

export function upsertAgendaTodo(state, nextTodo) {
    if (!state || !Array.isArray(state.todos) || !nextTodo) {
        return;
    }
    const index = state.todos.findIndex(todo => String(todo?.id || '') === String(nextTodo.id || ''));
    if (index >= 0) {
        state.todos[index] = {
            ...state.todos[index],
            ...nextTodo,
            status: normalizeAgendaTodoStatus(nextTodo.status || state.todos[index]?.status),
        };
        return;
    }
    state.todos.push({
        id: String(nextTodo.id || ''),
        goal: String(nextTodo.goal || ''),
        status: normalizeAgendaTodoStatus(nextTodo.status),
    });
}

export function buildAgendaSharedContextText(context, payload, messages) {
    const settings = extension_settings[MODULE_NAME];
    const recent = buildAgendaRecentChatText(messages, settings);
    const lastUserText = buildAgendaLastUserText(messages);
    return [
        '## shared_context',
        '### recent_chat',
        '```text',
        recent || '(empty)',
        '```',
        '### current_user_message',
        '```text',
        lastUserText,
        '```',
        '### runtime_limits',
        '```yaml',
        toReadableYamlText({
            planner_max_rounds: getAgendaPlannerMaxRounds(settings),
            max_concurrent_agents: getAgendaMaxConcurrentAgents(settings),
            max_total_runs: getAgendaMaxTotalRuns(settings),
            node_iteration_max_rounds: getNodeIterationMaxRounds(settings),
            review_rerun_max_rounds: getReviewRerunMaxRounds(settings),
            agent_timeout_seconds: Math.max(0, Math.floor(Number(settings?.agentTimeoutSeconds) || 0)),
        }, '{}'),
        '```',
    ].join('\n');
}

export function buildAgendaTodosText(todos = []) {
    return [
        '## todo_board',
        '```yaml',
        toReadableYamlText(
            (Array.isArray(todos) ? todos : []).map(todo => ({
                id: String(todo?.id || ''),
                goal: String(todo?.goal || ''),
                status: normalizeAgendaTodoStatus(todo?.status),
            })),
            '[]',
        ),
        '```',
    ].join('\n');
}

export function buildAgendaRunsText(runs = [], selectedRunIds = null) {
    const source = selectAgendaRuns(runs, selectedRunIds);
    if (source.length === 0) {
        return [
            '## prior_runs',
            '```text',
            '(none)',
            '```',
        ].join('\n');
    }
    return [
        '## prior_runs',
        ...source.map((run) => [
            `### ${String(run?.runId || '')}`,
            '```yaml',
            toReadableYamlText({
                todo_id: String(run?.todoId || ''),
                agent: String(run?.agent || ''),
                task_brief: String(run?.taskBrief || ''),
                input_run_ids: Array.isArray(run?.inputRunIds) ? run.inputRunIds.map(item => String(item || '')) : [],
            }, '{}'),
            '```',
            '```text',
            String(run?.outputText || ''),
            '```',
        ].join('\n')),
    ].join('\n\n');
}

export function syncAgendaTrace(trace, state) {
    if (!trace || typeof trace !== 'object' || !state || typeof state !== 'object') {
        return;
    }
    trace.mode = ORCH_EXECUTION_MODE_AGENDA;
    trace.agenda = {
        plannerRounds: Math.max(0, Math.floor(Number(state.plannerRounds) || 0)),
        todos: Array.isArray(state.todos) ? structuredClone(state.todos) : [],
        runs: Array.isArray(state.runs) ? structuredClone(state.runs) : [],
        finalGuidance: String(state.finalGuidance || ''),
    };
}

export function applyAgendaPlannerOps(state, plannerStep = {}) {
    if (!state || typeof state !== 'object') {
        return;
    }
    for (const rawOp of Array.isArray(plannerStep?.todo_ops) ? plannerStep.todo_ops : []) {
        const op = String(rawOp?.op || '').trim().toLowerCase();
        const todoId = sanitizeIdentifierToken(rawOp?.todo_id, '');
        if (!todoId) {
            continue;
        }
        if (op === 'add') {
            const nextTodo = createAgendaTodo({
                id: todoId,
                goal: String(rawOp?.goal || ''),
                status: rawOp?.status || 'todo',
            });
            if (nextTodo) {
                upsertAgendaTodo(state, nextTodo);
            }
            continue;
        }
        const index = state.todos.findIndex(todo => String(todo?.id || '') === todoId);
        if (index < 0) {
            continue;
        }
        if (op === 'set_status') {
            state.todos[index].status = normalizeAgendaTodoStatus(rawOp?.status);
        } else if (op === 'drop') {
            state.todos[index].status = 'dropped';
        }
    }
}

export function normalizeAgendaDispatches(state, plannerStep = {}, profile = {}, settings = extension_settings[MODULE_NAME]) {
    const dispatches = [];
    const agents = profile?.agents && typeof profile.agents === 'object' ? profile.agents : {};
    const knownRunIds = new Set((Array.isArray(state?.runs) ? state.runs : []).map(run => String(run?.runId || '')).filter(Boolean));
    for (const rawDispatch of Array.isArray(plannerStep?.dispatches) ? plannerStep.dispatches : []) {
        const todoId = sanitizeIdentifierToken(rawDispatch?.todo_id, '');
        const agent = sanitizeIdentifierToken(rawDispatch?.agent, '');
        const taskBrief = String(rawDispatch?.task_brief || '').trim();
        if (!todoId || !agent || !taskBrief || !agents[agent]) {
            continue;
        }
        const inputRunIds = [...new Set(
            (Array.isArray(rawDispatch?.input_run_ids) ? rawDispatch.input_run_ids : [])
                .map(item => String(item || '').trim())
                .filter(runId => runId && knownRunIds.has(runId)),
        )];
        if (!state.todos.some(todo => String(todo?.id || '') === todoId)) {
            upsertAgendaTodo(state, createAgendaTodo({ id: todoId, goal: taskBrief, status: 'todo' }));
        }
        dispatches.push({
            todoId,
            agent,
            taskBrief,
            inputRunIds,
        });
    }
    const maxConcurrent = getAgendaMaxConcurrentAgents(settings);
    const remainingRunBudget = Math.max(0, getAgendaMaxTotalRuns(settings) - Number(state?.runs?.length || 0));
    return dispatches.slice(0, Math.min(maxConcurrent, remainingRunBudget));
}

export async function runAgendaPlannerStep(context, payload, messages, profile, state, abortSignal = null) {
    const settings = extension_settings[MODULE_NAME];
    const previousOrchestration = await getPreviousOrchestrationCapsuleText(context, payload);
    const planner = createAgendaPlannerDraft(profile?.planner);
    const llmPresetName = resolveOrchestrationAgentPromptPresetName(settings, planner);
    const apiPresetName = resolveOrchestrationAgentApiPresetName(settings, planner);
    const promptText = [
        '## planner_prompt',
        String(planner?.userPromptTemplate || DEFAULT_AGENDA_PLANNER_PROMPT),
        '',
        buildAutoInjectedNodePromptPrelude({
            previousOrchestration,
            approvedReviewFeedbackEntries: [],
        }),
        buildAgendaSharedContextText(context, payload, messages),
        buildAgendaAvailableAgentsText(profile),
        buildAgendaTodosText(state?.todos),
        buildAgendaRunsText(state?.runs),
        [
            '## planner_contract',
            '- Maintain the todo board explicitly through todo_ops.',
            '- Dispatch only agent ids listed in available_agents.',
            '- Dispatch only the next useful agent calls. Parallelize only truly independent work.',
            '- Read complete prior run outputs before adding new work.',
            '- Normal planner steps should include dispatches. todo_ops is optional.',
            '- Only the final planner step should include finalize.',
            '- finalize must be a concise reason/summary string.',
            '- Do not include dispatches in the same step that includes finalize.',
        ].join('\n'),
    ].filter(Boolean).join('\n\n');
    const runtimeWorldInfo = await resolveOrchestrationRuntimeWorldInfo(context, settings, {
        worldInfoMessages: messages,
        worldInfoType: String(payload?.type || 'quiet'),
        runtimeWorldInfo: buildRuntimeWorldInfoFromPayload(payload),
        forceWorldInfoResimulate: Boolean(payload?.forceWorldInfoResimulate),
        abortSignal,
    });
    const systemText = String(planner?.systemPrompt || DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT).trim()
        || 'Return concise guidance through function-call fields.';
    const userText = promptText.trim()
        || 'Use function-call fields only. Do not put JSON strings into summary.';
    return requestToolCallWithRetry(context, settings, {
        taskMessages: [
            { role: 'system', content: systemText },
            { role: 'user', content: userText },
        ],
        runtimeWorldInfo,
        apiPresetName,
        llmPresetName,
        functionName: AGENDA_PLANNER_TOOL,
        functionDescription: 'Update agenda todos and dispatch the next agent calls. Use finalize only once on the last planner step, with a concise reason/summary.',
        parameters: {
            type: 'object',
            anyOf: [
                { required: ['dispatches'] },
                { required: ['finalize'] },
            ],
            properties: {
                todo_ops: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            op: { type: 'string', enum: ['add', 'set_status', 'drop'] },
                            todo_id: { type: 'string' },
                            goal: { type: 'string' },
                            status: { type: 'string', enum: AGENDA_TODO_STATUSES },
                        },
                        required: ['op', 'todo_id'],
                        additionalProperties: false,
                    },
                },
                dispatches: {
                    type: 'array',
                    minItems: 1,
                    items: {
                        type: 'object',
                        properties: {
                            todo_id: { type: 'string' },
                            agent: { type: 'string' },
                            task_brief: { type: 'string' },
                            input_run_ids: {
                                type: 'array',
                                items: { type: 'string' },
                            },
                        },
                        required: ['todo_id', 'agent', 'task_brief', 'input_run_ids'],
                        additionalProperties: false,
                    },
                },
                finalize: {
                    type: 'string',
                    minLength: 1,
                    description: 'Use only on the final planner step. Provide a concise reason/summary and do not include dispatches.',
                },
            },
            additionalProperties: false,
        },
        abortSignal,
        applyAgentTimeout: true,
    });
}

export async function runAgendaTextAgent(context, payload, messages, profile, state, dispatch, {
    kind = 'agent',
    finalReason = '',
}, abortSignal = null) {
    const settings = extension_settings[MODULE_NAME];
    const planner = createAgendaPlannerDraft(profile?.planner);
    const preset = profile?.agents?.[dispatch.agent] || {};
    const llmPresetName = resolveOrchestrationAgentPromptPresetName(settings, preset);
    const apiPresetName = resolveOrchestrationAgentApiPresetName(settings, preset);
    const systemPrompt = [
        String(preset.systemPrompt || 'You are an orchestration agent. Complete the assigned task carefully and return the full useful result through the required tool.').trim(),
        '',
        'Agenda runtime override:',
        '- Ignore any legacy spec-mode output schema wording if present.',
        `- The only valid output is ${AGENDA_RESULT_TOOL} with one complete text result.`,
    ].filter(Boolean).join('\n');
    const selectedRunIds = new Set((Array.isArray(dispatch?.inputRunIds) ? dispatch.inputRunIds : []).map(item => String(item || '').trim()).filter(Boolean));
    const currentTodo = (Array.isArray(state?.todos) ? state.todos : []).find(todo => String(todo?.id || '') === String(dispatch?.todoId || '')) || null;
    const previousOrchestration = await getPreviousOrchestrationCapsuleText(context, payload);
    const renderedAgentPrompt = renderTemplate(
        normalizeTemplateForRuntime(String(preset?.userPromptTemplate || '')),
        {
            recent_chat: buildAgendaRecentChatText(messages, settings),
            last_user: buildAgendaLastUserText(messages),
            previous_outputs: buildAgendaSelectedRunOutputsText(state?.runs, selectedRunIds),
            distiller: buildAgendaDistillerOutputText(state?.runs, selectedRunIds),
        },
    ).trim();
    const promptText = [
        '## planner_prompt',
        String(planner?.userPromptTemplate || DEFAULT_AGENDA_PLANNER_PROMPT),
        '',
        buildAutoInjectedNodePromptPrelude({
            previousOrchestration,
            approvedReviewFeedbackEntries: [],
        }),
        '## current_todo',
        '```yaml',
        toReadableYamlText(currentTodo || {
            id: String(dispatch?.todoId || ''),
            goal: String(dispatch?.taskBrief || ''),
            status: 'doing',
        }, '{}'),
        '```',
        '## task_brief',
        '```text',
        String(dispatch?.taskBrief || ''),
        '```',
        finalReason ? ['## finalize_reason', '```text', String(finalReason || ''), '```'].join('\n') : '',
        buildAgendaSharedContextText(context, payload, messages),
        buildAgendaRunsText(state?.runs, selectedRunIds),
        [
            '## agenda_mode_output_override',
            '- If copied prompt text mentions legacy spec-mode fields or schemas, ignore that wording.',
            `- The only valid output is ${AGENDA_RESULT_TOOL} with one complete text result.`,
        ].join('\n'),
        renderedAgentPrompt
            ? ['## agent_extra_prompt', '```text', renderedAgentPrompt, '```'].join('\n')
            : '',
        [
            '## result_contract',
            `- Return the full result through ${AGENDA_RESULT_TOOL}.`,
            '- The text should contain complete useful content, not a summary placeholder.',
        ].join('\n'),
    ].filter(Boolean).join('\n\n');
    const runtimeWorldInfo = await resolveOrchestrationRuntimeWorldInfo(context, settings, {
        worldInfoMessages: messages,
        worldInfoType: String(payload?.type || 'quiet'),
        runtimeWorldInfo: buildRuntimeWorldInfoFromPayload(payload),
        forceWorldInfoResimulate: Boolean(payload?.forceWorldInfoResimulate),
        abortSignal,
    });
    const systemText = systemPrompt.trim()
        || 'Return concise guidance through function-call fields.';
    const userText = promptText.trim()
        || 'Use function-call fields only. Do not put JSON strings into summary.';
    const result = await requestToolCallWithRetry(context, settings, {
        taskMessages: [
            { role: 'system', content: systemText },
            { role: 'user', content: userText },
        ],
        runtimeWorldInfo,
        apiPresetName,
        llmPresetName,
        functionName: AGENDA_RESULT_TOOL,
        functionDescription: 'Submit the full textual result for the assigned orchestration task.',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string' },
            },
            required: ['text'],
            additionalProperties: false,
        },
        abortSignal,
        applyAgentTimeout: true,
    });
    return {
        runId: createAgendaRunId(),
        todoId: String(dispatch?.todoId || ''),
        agent: String(dispatch?.agent || ''),
        taskBrief: String(dispatch?.taskBrief || ''),
        inputRunIds: Array.isArray(dispatch?.inputRunIds) ? dispatch.inputRunIds.slice() : [],
        outputText: String(result?.text || '').trim(),
        kind: String(kind || 'agent'),
    };
}

export async function runAgendaOrchestration(context, payload, messages, profile) {
    const settings = extension_settings[MODULE_NAME];
    const abortSignal = isAbortSignalLike(payload?.signal) ? payload.signal : null;
    const trace = createOrchestrationRuntimeTrace(context, payload, [], {
        note: 'Agenda mode runtime',
    });
    const state = {
        plannerRounds: 0,
        todos: [{
            id: 'main',
            goal: 'Produce the best next-turn orchestration guidance for the current request.',
            status: 'todo',
        }],
        runs: [],
        finalGuidance: '',
    };
    syncAgendaTrace(trace, state);
    const plannerMaxRounds = Math.min(getAgendaPlannerMaxRounds(settings), Math.max(1, Math.floor(Number(profile?.limits?.plannerMaxRounds) || getAgendaPlannerMaxRounds(settings))));
    let finalizeReason = '';

    for (let round = 1; round <= plannerMaxRounds; round++) {
        throwIfAborted(abortSignal, 'Orchestration aborted.');
        state.plannerRounds = round;
        syncAgendaTrace(trace, state);
        const plannerAttempt = beginOrchestrationRuntimeNodeAttempt(trace, {
            stageIndex: round - 1,
            stageId: `agenda_planner_round_${round}`,
            nodeIndex: 0,
            nodeId: 'agenda_planner',
            preset: 'agenda_planner',
            nodeType: ORCH_NODE_TYPE_WORKER,
            runKind: 'planner',
            slotKey: buildOrchestrationRuntimeSlotKey(round - 1, 0, `agenda_planner_${round}`),
        });
        const plannerStep = await runAgendaPlannerStep(context, payload, messages, profile, state, abortSignal);
        finishOrchestrationRuntimeNodeAttempt(trace, plannerAttempt, {
            status: 'completed',
            output: plannerStep,
        });
        applyAgendaPlannerOps(state, plannerStep);
        const dispatches = normalizeAgendaDispatches(state, plannerStep, profile, settings);
        const finalizeReasonText = String(plannerStep?.finalize || '').trim();
        const finalizeRequested = Boolean(finalizeReasonText);
        if (Array.isArray(plannerStep?.dispatches) && plannerStep.dispatches.length > 0 && dispatches.length === 0 && !finalizeRequested) {
            throw new Error('Agenda planner dispatched no valid agents. Check available agent ids and selected prior run ids.');
        }
        if (finalizeRequested && dispatches.length > 0) {
            throw new Error('Agenda planner cannot dispatch agents and finalize in the same step.');
        }
        for (const dispatch of dispatches) {
            const todo = state.todos.find(item => String(item?.id || '') === String(dispatch.todoId || ''));
            if (todo) {
                todo.status = todo.status === 'done' ? 'done' : 'doing';
            }
        }
        syncAgendaTrace(trace, state);
        if (finalizeRequested) {
            finalizeReason = finalizeReasonText;
            break;
        }
        if (dispatches.length === 0) {
            finalizeReason = finalizeReasonText || 'Planner produced no further dispatches.';
            break;
        }
        const newRuns = await Promise.all(dispatches.map(async (dispatch, dispatchIndex) => {
            const attempt = beginOrchestrationRuntimeNodeAttempt(trace, {
                stageIndex: round - 1,
                stageId: `agenda_agents_round_${round}`,
                nodeIndex: dispatchIndex,
                nodeId: `${dispatch.agent}:${dispatch.todoId}`,
                preset: dispatch.agent,
                nodeType: ORCH_NODE_TYPE_WORKER,
                runKind: 'worker',
                slotKey: buildOrchestrationRuntimeSlotKey(round - 1, dispatchIndex + 1, `${dispatch.agent}_${dispatch.todoId}_${round}`),
            });
            try {
                const result = await runAgendaTextAgent(context, payload, messages, profile, state, dispatch, { kind: 'agent' }, abortSignal);
                finishOrchestrationRuntimeNodeAttempt(trace, attempt, {
                    status: 'completed',
                    output: result.outputText,
                });
                return result;
            } catch (error) {
                finishOrchestrationRuntimeNodeAttempt(trace, attempt, {
                    status: 'failed',
                    error: String(error?.message || error),
                });
                throw error;
            }
        }));
        state.runs.push(...newRuns);
        syncAgendaTrace(trace, state);
        if (state.runs.length >= getAgendaMaxTotalRuns(settings)) {
            finalizeReason = 'Reached maxTotalRuns limit. Finalizing with collected work.';
            break;
        }
    }

    const finalAgentId = sanitizeIdentifierToken(profile?.finalAgentId, Object.keys(profile?.agents || {})[0] || 'finalizer');
    if (!profile?.agents?.[finalAgentId]) {
        throw new Error(`Agenda final agent '${finalAgentId}' is not configured.`);
    }
    const finalDispatch = {
        todoId: 'finalize',
        agent: finalAgentId,
        taskBrief: 'Read the resolved todo state and all completed runs, then produce the final orchestration guidance text.',
        inputRunIds: state.runs.map(run => String(run?.runId || '')).filter(Boolean),
    };
    const finalAttempt = beginOrchestrationRuntimeNodeAttempt(trace, {
        stageIndex: plannerMaxRounds,
        stageId: 'agenda_finalize',
        nodeIndex: 0,
        nodeId: finalAgentId,
        preset: finalAgentId,
        nodeType: ORCH_NODE_TYPE_WORKER,
        runKind: 'final',
        slotKey: buildOrchestrationRuntimeSlotKey(plannerMaxRounds, 0, `agenda_final_${finalAgentId}`),
    });
    const finalRun = await runAgendaTextAgent(context, payload, messages, profile, state, finalDispatch, {
        kind: 'final',
        finalReason: finalizeReason,
    }, abortSignal);
    if (!String(finalRun?.outputText || '').trim()) {
        finishOrchestrationRuntimeNodeAttempt(trace, finalAttempt, {
            status: 'failed',
            error: 'Agenda final agent returned empty guidance text.',
        });
        throw new Error('Agenda final agent returned empty guidance text.');
    }
    finishOrchestrationRuntimeNodeAttempt(trace, finalAttempt, {
        status: 'completed',
        output: finalRun.outputText,
    });
    state.finalGuidance = String(finalRun.outputText || '').trim();
    state.runs.push(finalRun);
    syncAgendaTrace(trace, state);

    return {
        stageOutputs: [{
            id: 'finalize',
            mode: 'serial',
            nodes: [{
                node: finalAgentId,
                output: state.finalGuidance,
            }],
        }],
        previousNodeOutputs: new Map([[finalAgentId, state.finalGuidance]]),
        runtimeTrace: trace,
        reviewRerunCount: 0,
        agendaState: structuredClone(state),
    };
}
