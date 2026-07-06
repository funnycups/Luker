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

const extension_settings = Luker.getContext().extensionSettings;
import { isAbortSignalLike, throwIfAborted } from './abort-utils.js';
import { canonicalStringifyArgs } from './canonical-stringify.js';
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
    appendRound, appendToSection, ensureSection,
    finishRun, setRoundStatus, setSectionStatus, startRun, addTokenUsage,
} from './run-state/store.js';
import { i18n, i18nFormat } from './i18n.js';
import { getChatKey } from './snapshot-cache.js';
import { normalizeNodeType } from './spec-schema.js';
import { getPreviousOrchestrationCapsuleText } from './snapshot-cache.js';
import {
    getNodeIterationMaxRounds,
    getReviewRerunMaxRounds,
} from './spec-schema.js';
import {
    normalizeTemplateForRuntime,
    renderTemplate,
} from './template-vars.js';
import {
    requestToolCallWithRetry,
    requestToolCallsWithRetry,
    serializeToolResultContent,
    makeRuntimeToolCallId,
} from './tool-calling.js';
import { buildRuntimeWorldInfoFromPayload } from './world-info.js';
import {
    hasAnyToolEnabled,
    resolveAgentToolFlags,
} from './persistence.js';
import {
    executeLoopTool,
    getEnabledToolSchemas,
    resolveToolSource,
} from './loop-tools.js';
import { attachToolContext, isStructuredToolError } from './loop-runtime.js';
import { buildPerRunCustomToolRegistry } from './per-run-custom-tools.js';

// Skill-resolution helpers are loaded lazily (script.js → lib.js dep makes
// eager import unfriendly to Node tests). Same pattern as director / loop /
// spec runtimes.
let _skillResolutionPromise = null;
async function loadSkillResolution() {
    if (!_skillResolutionPromise) {
        _skillResolutionPromise = import('./skill-resolution.js');
    }
    return _skillResolutionPromise;
}

const MODULE_NAME = 'orchestrator';

// Inline trace helpers. Replaces the deleted runtime-trace.js module so
// the existing trace data structure (consumed by the simulation-payload
// adapter and the legacy runtime-trace popup) is still produced by the
// runner. Run-panel state lives in run-state/store.js and is written in
// parallel via startRun / appendRound / appendToSection.

function buildRuntimeSlotKey(stageIndex, nodeIndex, nodeId = '') {
    return [Number(stageIndex), Number(nodeIndex), String(nodeId || '').trim()].join(':');
}

function cloneTraceValue(value) {
    if (typeof value === 'string') return String(value);
    if (value && typeof value === 'object') return structuredClone(value);
    return value;
}

function serializeTraceValue(value) {
    if (typeof value === 'string') return String(value || '');
    if (value && typeof value === 'object') return toReadableYamlText(value, '{}');
    if (value == null) return '';
    return String(value);
}

function truncateTracePreview(value, maxChars = 240) {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}

function sanitizeTraceConversation(conversation) {
    if (!conversation || typeof conversation !== 'object') return null;
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    return { messages: messages.map(m => structuredClone(m)) };
}

function createRuntimeTrace(context, payload, extra = {}) {
    const now = new Date().toISOString();
    const trace = {
        runId: `orch_runtime_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        chatKey: String(extra?.chatKey || getChatKey(context) || ''),
        status: 'running',
        startedAt: now,
        updatedAt: now,
        finishedAt: '',
        generationType: String(payload?.type || extra?.generationType || '').trim().toLowerCase(),
        targetLayer: 0,
        note: String(extra?.note || ''),
        capsuleText: '',
        error: '',
        mode: String(extra?.mode || ''),
        stages: [],
        attempts: [],
        events: [],
        nextEventSeq: 1,
        nextAttemptId: 1,
        reviewRerunCount: 0,
    };
    recordRuntimeEvent(trace, 'run_started', {
        status: trace.status,
        generationType: trace.generationType,
        targetLayer: trace.targetLayer,
        note: trace.note,
    });
    return trace;
}

function recordRuntimeEvent(trace, type, details = {}) {
    if (!trace || typeof trace !== 'object') return null;
    const event = {
        seq: Number(trace.nextEventSeq || 1),
        at: new Date().toISOString(),
        type: String(type || 'event'),
        ...(details && typeof details === 'object' ? structuredClone(details) : {}),
    };
    trace.nextEventSeq = event.seq + 1;
    trace.updatedAt = event.at;
    trace.events.push(event);
    return event;
}

function finalizeRuntimeTrace(trace, status, details = {}) {
    if (!trace || typeof trace !== 'object') return;
    const normalizedStatus = String(status || trace.status || 'completed');
    trace.status = normalizedStatus;
    trace.updatedAt = new Date().toISOString();
    trace.finishedAt = normalizedStatus === 'running' ? '' : trace.updatedAt;
    if (Object.prototype.hasOwnProperty.call(details || {}, 'capsuleText')) trace.capsuleText = String(details?.capsuleText || '');
    if (Object.prototype.hasOwnProperty.call(details || {}, 'note')) trace.note = String(details?.note || '');
    if (Object.prototype.hasOwnProperty.call(details || {}, 'error')) trace.error = String(details?.error || '');
    if (Object.prototype.hasOwnProperty.call(details || {}, 'reviewRerunCount')) {
        trace.reviewRerunCount = Math.max(0, Math.floor(Number(details?.reviewRerunCount) || 0));
    }
    recordRuntimeEvent(trace, 'run_finished', {
        status: normalizedStatus,
        note: trace.note,
        error: trace.error,
        reviewRerunCount: Number(trace.reviewRerunCount || 0),
    });
}

function beginRuntimeNodeAttempt(trace, meta = {}) {
    if (!trace || typeof trace !== 'object') return null;
    const attempt = {
        attemptId: `attempt_${Number(trace.nextAttemptId || 1)}`,
        sequence: Number(trace.nextEventSeq || 1),
        stageIndex: Number(meta?.stageIndex || 0),
        stageId: String(meta?.stageId || ''),
        nodeIndex: Number(meta?.nodeIndex || 0),
        nodeId: String(meta?.nodeId || ''),
        preset: String(meta?.preset || ''),
        nodeType: normalizeNodeType(meta?.nodeType),
        slotKey: String(meta?.slotKey || buildRuntimeSlotKey(meta?.stageIndex, meta?.nodeIndex, meta?.nodeId)),
        runKind: String(meta?.runKind || 'worker'),
        round: Math.max(1, Math.floor(Number(meta?.round) || 1)),
        startedAt: new Date().toISOString(),
        endedAt: '',
        status: 'running',
        rerunReason: String(meta?.rerunReason || ''),
        output: null,
        outputText: '',
        previewText: '',
        action: '',
        targetNodeIds: [],
        reason: '',
        replayResult: null,
        error: '',
        conversation: null,
    };
    trace.nextAttemptId = Number(trace.nextAttemptId || 1) + 1;
    trace.attempts.push(attempt);
    recordRuntimeEvent(trace, 'node_started', {
        attemptId: attempt.attemptId,
        stageIndex: attempt.stageIndex,
        stageId: attempt.stageId,
        nodeIndex: attempt.nodeIndex,
        nodeId: attempt.nodeId,
        preset: attempt.preset,
        nodeType: attempt.nodeType,
        runKind: attempt.runKind,
        round: attempt.round,
        rerunReason: attempt.rerunReason,
    });
    return attempt;
}

function finishRuntimeNodeAttempt(trace, attempt, details = {}) {
    if (!trace || typeof trace !== 'object' || !attempt || typeof attempt !== 'object') return;
    attempt.endedAt = new Date().toISOString();
    attempt.status = String(details?.status || attempt.status || 'completed');
    attempt.action = String(details?.action || attempt.action || '');
    attempt.reason = String(details?.reason || attempt.reason || '');
    attempt.rerunReason = String(
        Object.prototype.hasOwnProperty.call(details || {}, 'rerunReason')
            ? details?.rerunReason
            : attempt.rerunReason,
    ) || '';
    attempt.targetNodeIds = Array.isArray(details?.targetNodeIds)
        ? details.targetNodeIds.map(item => String(item || '').trim()).filter(Boolean)
        : (Array.isArray(attempt.targetNodeIds) ? attempt.targetNodeIds : []);
    attempt.replayResult = Object.prototype.hasOwnProperty.call(details || {}, 'replayResult')
        ? cloneTraceValue(details?.replayResult)
        : attempt.replayResult;
    attempt.error = String(details?.error || '');
    if (Object.prototype.hasOwnProperty.call(details || {}, 'output')) {
        attempt.output = cloneTraceValue(details?.output);
        attempt.outputText = serializeTraceValue(details?.output);
        attempt.previewText = truncateTracePreview(attempt.outputText);
    }
    if (Object.prototype.hasOwnProperty.call(details || {}, 'conversation')) {
        attempt.conversation = sanitizeTraceConversation(details?.conversation);
    }
    recordRuntimeEvent(trace, 'node_finished', {
        attemptId: attempt.attemptId,
        stageIndex: attempt.stageIndex,
        stageId: attempt.stageId,
        nodeIndex: attempt.nodeIndex,
        nodeId: attempt.nodeId,
        preset: attempt.preset,
        nodeType: attempt.nodeType,
        runKind: attempt.runKind,
        round: attempt.round,
        status: attempt.status,
        action: attempt.action,
        reason: attempt.reason,
        rerunReason: attempt.rerunReason,
        targetNodeIds: Array.isArray(attempt.targetNodeIds) ? attempt.targetNodeIds.slice() : [],
        previewText: attempt.previewText,
        error: attempt.error,
        replayResult: cloneTraceValue(attempt.replayResult),
    });
}

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
    const plannerStep = await requestToolCallWithRetry(context, settings, {
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
    });
    const conversation = {
        messages: [
            { role: 'system', content: systemText },
            { role: 'user', content: userText },
            {
                role: 'assistant',
                content: '',
                reasoning: '',
                tool_calls: [{ id: '', name: AGENDA_PLANNER_TOOL, args: plannerStep || {} }],
            },
        ],
    };
    return { plannerStep, conversation };
}

export async function runAgendaTextAgent(context, payload, messages, profile, state, dispatch, {
    kind = 'agent',
    finalReason = '',
    customToolRegistry = null,
    panelRunId = null,
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

    // Resolve skills visible to this agenda worker. Mode-level default
    // lives on `profile.skills`; per-agent `skills` (when set on
    // `preset`) layers via the `+` inheritance idiom. The catalog block
    // gets appended to the system prompt below; the visible list rides
    // on `toolContext.__visibleSkillsForAgent` in the multi-round path
    // so skill_list / skill_read / skill_search see scoped visibility
    // (calls without it are rejected by the exec).
    let visibleSkillsForAgent = [];
    let systemTextWithSkills = systemText;
    try {
        const skillRes = await loadSkillResolution();
        visibleSkillsForAgent = await skillRes.resolveAgentVisibleSkills({
            modeProfile: profile || {},
            agentConfig: preset,
            runtimeContext: skillRes.buildSkillRuntimeContext(
                context,
                preset,
                { mode: 'agenda', name: String(preset?.name || '').trim() },
            ),
        });
        const block = skillRes.buildAvailableSkillsBlock(visibleSkillsForAgent);
        if (block) systemTextWithSkills = systemText + '\n\n' + block;
    } catch (e) {
        console.warn('[orchestrator-agenda] worker skill resolution failed:', e?.message || e);
    }

    // Tool-cascade: preset.tools overrides profile.defaultTools, which
    // overrides the built-in (null = no tools, the historical agenda
    // behaviour). When the resolved set has any loop tool enabled, run
    // the multi-round tool loop instead of a single forced function call.
    const resolvedToolFlags = resolveAgentToolFlags(
        preset?.tools,
        profile?.defaultTools || null,
        null,
    );
    const enableLoopTools = hasAnyToolEnabled(resolvedToolFlags);

    const resultToolSchema = {
        type: 'function',
        function: {
            name: AGENDA_RESULT_TOOL,
            description: 'Submit the full textual result for the assigned orchestration task.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                },
                required: ['text'],
                additionalProperties: false,
            },
        },
    };

    if (!enableLoopTools) {
        const result = await requestToolCallWithRetry(context, settings, {
            taskMessages: [
                { role: 'system', content: systemTextWithSkills },
                { role: 'user', content: userText },
            ],
            runtimeWorldInfo,
            apiPresetName,
            llmPresetName,
            functionName: AGENDA_RESULT_TOOL,
            functionDescription: resultToolSchema.function.description,
            parameters: resultToolSchema.function.parameters,
            abortSignal,
        });
        const conversation = {
            messages: [
                { role: 'system', content: systemTextWithSkills },
                { role: 'user', content: userText },
                {
                    role: 'assistant',
                    content: '',
                    reasoning: '',
                    tool_calls: [{ id: '', name: AGENDA_RESULT_TOOL, args: { text: String(result?.text || '') } }],
                },
            ],
        };
        return {
            runId: createAgendaRunId(),
            todoId: String(dispatch?.todoId || ''),
            agent: String(dispatch?.agent || ''),
            taskBrief: String(dispatch?.taskBrief || ''),
            inputRunIds: Array.isArray(dispatch?.inputRunIds) ? dispatch.inputRunIds.slice() : [],
            outputText: String(result?.text || '').trim(),
            kind: String(kind || 'agent'),
            conversation,
        };
    }

    // Multi-round path: agent can interleave loop tool calls with the
    // terminator. We reuse the loop-tool dispatch context (memory store,
    // notes adapter, activated lorebook keys) per attachToolContext.
    const loopToolSchemas = getEnabledToolSchemas({ tools: resolvedToolFlags }, customToolRegistry)
        .filter(s => String(s?.function?.name || '') !== 'finalize');
    const tools = [...loopToolSchemas, resultToolSchema];
    const allowedNames = new Set(tools.map(t => String(t?.function?.name || '').trim()).filter(Boolean));
    const toolContext = await attachToolContext(context, payload);
    if (toolContext && customToolRegistry) {
        toolContext.__customToolRegistry = customToolRegistry;
    }
    // Make the agent's scoped skill visibility reachable through the
    // tool dispatch context so skill_list / skill_read / skill_search
    // resolve against the filtered list.
    if (toolContext) toolContext.__visibleSkillsForAgent = visibleSkillsForAgent;
    const maxRounds = Math.max(1, getNodeIterationMaxRounds(settings));
    const runtimeToolMessages = [];
    let outputText = '';
    const conversation = {
        messages: [
            { role: 'system', content: systemTextWithSkills },
            { role: 'user', content: userText },
        ],
    };

    for (let round = 1; round <= maxRounds; round += 1) {
        throwIfAborted(abortSignal, 'Orchestration aborted.');
        const taskMessages = [
            { role: 'system', content: systemTextWithSkills },
            ...runtimeToolMessages,
            { role: 'user', content: userText },
        ];
        const detailed = await requestToolCallsWithRetry(context, settings, {
            taskMessages,
            runtimeWorldInfo,
            apiPresetName,
            llmPresetName,
            tools,
            allowedNames,
            abortSignal,
            includeAssistantText: true,
            allowNoToolCalls: false,
            onUsage: panelRunId
                ? (usage) => {
                    try { addTokenUsage({ runId: panelRunId, usage }); } catch (_) { /* store may have been cleared */ }
                }
                : null,
        });
        throwIfAborted(abortSignal, 'Orchestration aborted.');
        const calls = Array.isArray(detailed?.toolCalls) ? detailed.toolCalls : [];
        if (calls.length === 0) {
            throw new Error(`Agenda agent '${dispatch?.agent}' did not return tool calls.`);
        }

        const terminator = calls.find(c => String(c?.name || '') === AGENDA_RESULT_TOOL);
        if (terminator) {
            outputText = String(terminator?.args?.text || '').trim();
            conversation.messages.push({
                role: 'assistant',
                content: String(detailed?.assistantText || ''),
                reasoning: String(detailed?.reasoning || ''),
                tool_calls: [{ id: terminator?.id || '', name: AGENDA_RESULT_TOOL, args: terminator?.args || {} }],
                _round: round,
            });
            break;
        }

        // Dispatch loop-tool calls and feed results back so the agent can
        // refine on the next round.
        const assistantToolCallEntries = calls.map(tc => {
            const normalizedName = String(tc?.name || '').replace(/\./g, '_');
            return {
                id: String(tc?.id || makeRuntimeToolCallId()),
                type: 'function',
                function: {
                    name: normalizedName,
                    arguments: canonicalStringifyArgs(tc?.args),
                },
                source: resolveToolSource(normalizedName, toolContext),
            };
        });
        runtimeToolMessages.push({
            role: 'assistant',
            content: String(detailed?.assistantText || ''),
            ...(detailed?.reasoning ? { reasoning: String(detailed.reasoning) } : {}),
            ...(Array.isArray(detailed?.reasoningBlocks) && detailed.reasoningBlocks.length > 0 ? { reasoning_blocks: detailed.reasoningBlocks } : {}),
            ...(Array.isArray(detailed?.reasoningDetails) && detailed.reasoningDetails.length > 0 ? { reasoning_details: detailed.reasoningDetails } : {}),
            tool_calls: assistantToolCallEntries,
        });
        conversation.messages.push({
            role: 'assistant',
            content: String(detailed?.assistantText || ''),
            reasoning: String(detailed?.reasoning || ''),
            tool_calls: calls.map((tc, i) => ({
                id: assistantToolCallEntries[i].id,
                name: String(tc?.name || ''),
                args: tc?.args || {},
                source: assistantToolCallEntries[i].source,
            })),
            _round: round,
        });
        for (let i = 0; i < calls.length; i += 1) {
            const tc = calls[i];
            const callId = assistantToolCallEntries[i].id;
            let toolResult;
            try {
                const raw = await executeLoopTool(
                    String(tc?.name || ''),
                    tc?.args && typeof tc.args === 'object' ? tc.args : {},
                    toolContext,
                );
                toolResult = { ok: true, data: raw };
            } catch (toolError) {
                if (isStructuredToolError(toolError)) {
                    toolResult = {
                        ok: false,
                        error: String(toolError.message || ''),
                        code: String(toolError.code || 'TOOL_ERROR'),
                        hint: String(toolError.hint || ''),
                    };
                } else {
                    throw toolError;
                }
            }
            const serialized = serializeToolResultContent(toolResult);
            runtimeToolMessages.push({
                role: 'tool',
                tool_call_id: callId,
                content: serialized,
            });
            conversation.messages.push({
                role: 'tool',
                tool_call_id: callId,
                name: String(tc?.name || ''),
                content: serialized,
                _round: round,
            });
        }
    }

    if (!outputText) {
        throw new Error(`Agenda agent '${dispatch?.agent}' exhausted rounds without calling ${AGENDA_RESULT_TOOL}.`);
    }

    return {
        runId: createAgendaRunId(),
        todoId: String(dispatch?.todoId || ''),
        agent: String(dispatch?.agent || ''),
        taskBrief: String(dispatch?.taskBrief || ''),
        inputRunIds: Array.isArray(dispatch?.inputRunIds) ? dispatch.inputRunIds.slice() : [],
        outputText,
        kind: String(kind || 'agent'),
        conversation,
    };
}

export async function runAgendaOrchestration(context, payload, messages, profile) {
    const settings = extension_settings[MODULE_NAME];
    const abortSignal = isAbortSignalLike(payload?.signal) ? payload.signal : null;
    const trace = createRuntimeTrace(context, payload, { mode: ORCH_EXECUTION_MODE_AGENDA, note: 'Agenda mode runtime' });
    const chatKey = String(trace.chatKey || '');
    const runId = startRun({
        mode: 'agenda',
        chatKey,
        abortFn: () => { try { Luker.getContext().stopGeneration(); } catch (_) { /* best-effort */ } },
        quiet: Boolean(payload?.__lukerSimulate),
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
    // Layer-3 custom tools live on the profile root. Built once per
    // orchestration and threaded into every agent dispatch via the
    // dispatch options bag (NOT on `state`, which is structuredClone'd
    // into the runtime trace and would choke on the AsyncFunction refs
    // the registry holds).
    const customToolRegistry = buildPerRunCustomToolRegistry(profile, trace, recordRuntimeEvent);
    syncAgendaTrace(trace, state);
    const plannerMaxRounds = Math.max(1, Math.floor(Number(profile?.limits?.plannerMaxRounds) || getAgendaPlannerMaxRounds(settings)));
    let finalizeReason = '';

    try {
        for (let round = 1; round <= plannerMaxRounds; round++) {
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            state.plannerRounds = round;
            syncAgendaTrace(trace, state);
            const plannerAttempt = beginRuntimeNodeAttempt(trace, {
                stageIndex: round - 1,
                stageId: `agenda_planner_round_${round}`,
                nodeIndex: 0,
                nodeId: 'agenda_planner',
                preset: 'agenda_planner',
                nodeType: ORCH_NODE_TYPE_WORKER,
                runKind: 'planner',
                slotKey: buildRuntimeSlotKey(round - 1, 0, `agenda_planner_${round}`),
            });
            const plannerRoundId = `node-agenda_planner-${round}`;
            appendRound({ runId, round: { id: plannerRoundId, label: i18nFormat('Node: ${0} (attempt ${1})', 'agenda_planner', round) } });
            const { plannerStep, conversation: plannerConversation } = await runAgendaPlannerStep(context, payload, messages, profile, state, abortSignal);
            finishRuntimeNodeAttempt(trace, plannerAttempt, {
                status: 'completed',
                output: plannerStep,
                conversation: plannerConversation,
            });
            const plannerSectionId = ensureSection({
                runId, roundId: plannerRoundId,
                section: { id: 'planner', kind: 'note', title: i18n('Note'), meta: { output: plannerStep } },
            });
            appendToSection({ runId, roundId: plannerRoundId, sectionId: plannerSectionId, delta: serializeTraceValue(plannerStep) });
            setSectionStatus({ runId, roundId: plannerRoundId, sectionId: plannerSectionId, status: 'done' });
            setRoundStatus({ runId, roundId: plannerRoundId, status: 'done' });
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
                const attempt = beginRuntimeNodeAttempt(trace, {
                    stageIndex: round - 1,
                    stageId: `agenda_agents_round_${round}`,
                    nodeIndex: dispatchIndex,
                    nodeId: `${dispatch.agent}:${dispatch.todoId}`,
                    preset: dispatch.agent,
                    nodeType: ORCH_NODE_TYPE_WORKER,
                    runKind: 'worker',
                    slotKey: buildRuntimeSlotKey(round - 1, dispatchIndex + 1, `${dispatch.agent}_${dispatch.todoId}_${round}`),
                });
                const workerRoundId = `node-${dispatch.agent}-${dispatch.todoId}-${round}`;
                appendRound({ runId, round: { id: workerRoundId, label: i18nFormat('Node: ${0} (attempt ${1})', `${dispatch.agent}:${dispatch.todoId}`, round) } });
                try {
                    const result = await runAgendaTextAgent(context, payload, messages, profile, state, dispatch, { kind: 'agent', customToolRegistry, panelRunId: runId }, abortSignal);
                    finishRuntimeNodeAttempt(trace, attempt, {
                        status: 'completed',
                        output: result.outputText,
                        conversation: result.conversation,
                    });
                    const workerSectionId = ensureSection({
                        runId, roundId: workerRoundId,
                        section: { id: 'output', kind: 'text', title: i18n('Text') },
                    });
                    appendToSection({ runId, roundId: workerRoundId, sectionId: workerSectionId, delta: String(result.outputText || '') });
                    setSectionStatus({ runId, roundId: workerRoundId, sectionId: workerSectionId, status: 'done' });
                    setRoundStatus({ runId, roundId: workerRoundId, status: 'done' });
                    return result;
                } catch (error) {
                    finishRuntimeNodeAttempt(trace, attempt, {
                        status: 'failed',
                        error: String(error?.message || error),
                    });
                    setRoundStatus({ runId, roundId: workerRoundId, status: 'failed' });
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
        const finalAttempt = beginRuntimeNodeAttempt(trace, {
            stageIndex: plannerMaxRounds,
            stageId: 'agenda_finalize',
            nodeIndex: 0,
            nodeId: finalAgentId,
            preset: finalAgentId,
            nodeType: ORCH_NODE_TYPE_WORKER,
            runKind: 'final',
            slotKey: buildRuntimeSlotKey(plannerMaxRounds, 0, `agenda_final_${finalAgentId}`),
        });
        const finalRoundId = `node-${finalAgentId}-final`;
        appendRound({ runId, round: { id: finalRoundId, label: i18nFormat('Node: ${0} (attempt ${1})', finalAgentId, plannerMaxRounds + 1) } });
        const finalRun = await runAgendaTextAgent(context, payload, messages, profile, state, finalDispatch, {
            kind: 'final',
            finalReason: finalizeReason,
            customToolRegistry,
            panelRunId: runId,
        }, abortSignal);
        if (!String(finalRun?.outputText || '').trim()) {
            finishRuntimeNodeAttempt(trace, finalAttempt, {
                status: 'failed',
                error: 'Agenda final agent returned empty guidance text.',
                conversation: finalRun?.conversation,
            });
            setRoundStatus({ runId, roundId: finalRoundId, status: 'failed' });
            throw new Error('Agenda final agent returned empty guidance text.');
        }
        finishRuntimeNodeAttempt(trace, finalAttempt, {
            status: 'completed',
            output: finalRun.outputText,
            conversation: finalRun.conversation,
        });
        const finalSectionId = ensureSection({
            runId, roundId: finalRoundId,
            section: { id: 'final', kind: 'text', title: i18n('Text') },
        });
        appendToSection({ runId, roundId: finalRoundId, sectionId: finalSectionId, delta: String(finalRun.outputText || '') });
        setSectionStatus({ runId, roundId: finalRoundId, sectionId: finalSectionId, status: 'done' });
        setRoundStatus({ runId, roundId: finalRoundId, status: 'done' });
        state.finalGuidance = String(finalRun.outputText || '').trim();
        state.runs.push(finalRun);
        syncAgendaTrace(trace, state);

        finalizeRuntimeTrace(trace, 'completed', { capsuleText: state.finalGuidance });
        try {
            finishRun({ runId, status: 'committed', finalText: state.finalGuidance });
        } catch (_) { /* run may already be cleared */ }

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
    } catch (error) {
        finalizeRuntimeTrace(trace, 'failed', { error: String(error?.message || error) });
        try {
            finishRun({ runId, status: 'error', error: String(error?.message || error) });
        } catch (_) { /* run may already be cleared */ }
        throw error;
    }
}
