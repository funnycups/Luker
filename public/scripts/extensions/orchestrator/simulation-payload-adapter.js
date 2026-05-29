/**
 * Reshapes the orchestrator's runtime-trace into per-mode payloads
 * consumed by simulation-review renderers. Failed tool calls are
 * filtered; failed attempts are dropped. Reasoning is sourced from
 * `message.reasoning` (spec/agenda/loop) or `round.reasoningText` /
 * `subagent.reasoningText` (director). Prompt-engineered <thought>
 * tags inside assistantText are left in place — they're body, not
 * reasoning.
 *
 * Trace-shape notes (for future maintainers):
 *   - Spec attempts come from `trace.attempts[]`, indexed by
 *     (stageIndex, nodeIndex). Multiple attempts per slot are possible;
 *     the adapter keeps the last completed one.
 *   - Agenda attempts have `runKind` ∈ {planner, worker, final}. Round
 *     grouping uses `attempt.stageIndex` (the runtime stores `round - 1`
 *     there for planner/worker). Worker dispatch metadata is split
 *     across `nodeId = "${agent}:${todoId}"`, `preset = agent`, and
 *     `taskBrief` on `trace.agenda.runs[]` — joined here by (agent, todoId).
 *   - Loop mode bypasses attempts entirely. `trace.loop.conversation.messages`
 *     is a live alias to the running messages array; the runtime mutates
 *     it across rounds and we sanitize at read time.
 *   - Director mode lives on `trace.director`: `mainAgent.rounds[]` is the
 *     structured per-round record (independent of the messages alias), and
 *     `subagents[]` carries dispatch results with `status ∈ {running,
 *     completed, cancelled, failed}`.
 */

const COMPLETED_STATUSES = new Set(['completed', 'success']);

function isToolCallFailed(call, eventsByCallId) {
    const result = call?.result;
    if (result && typeof result === 'object' && result.ok === false) return true;
    if (result instanceof Error) return true;
    const id = call?.id || call?.tool_call_id;
    if (id && eventsByCallId?.get(id) === 'tool_error') return true;
    return false;
}

function indexToolErrors(trace) {
    const map = new Map();
    const events = Array.isArray(trace?.events) ? trace.events : [];
    for (const ev of events) {
        if (ev?.type === 'tool_error' && ev?.tool_call_id) {
            map.set(ev.tool_call_id, 'tool_error');
        }
    }
    return map;
}

function safeJsonParse(s) {
    try { return JSON.parse(String(s || '{}')); } catch { return {}; }
}

/**
 * Reshape an assistant→tool-result message pair into a renderer-friendly
 * turn. Tool results live on the immediately following `role: 'tool'`
 * messages (one per call, addressed by `tool_call_id`). Some traces also
 * inline a `result` directly on the tool_call entry — when both are
 * present the inline one wins.
 *
 * Failed tool calls (`result.ok === false`, instanceof Error, or a
 * corresponding `tool_error` event indexed by tool_call_id) are
 * dropped at this boundary so renderers don't have to filter again.
 */
function turnsFromConversation(messages, eventsByCallId) {
    if (!Array.isArray(messages)) return [];
    const turns = [];
    let i = 0;
    while (i < messages.length) {
        const m = messages[i];
        if (m?.role !== 'assistant') { i += 1; continue; }
        const toolCalls = [];
        const rawCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        for (const tc of rawCalls) {
            const callId = tc?.id || tc?.tool_call_id;
            let result = tc?.result;
            if (typeof result === 'undefined' && callId) {
                for (let j = i + 1; j < messages.length; j += 1) {
                    const cand = messages[j];
                    if (cand?.role === 'tool' && cand?.tool_call_id === callId) {
                        try { result = JSON.parse(cand.content); }
                        catch { result = cand.content; }
                        break;
                    }
                    if (cand?.role === 'assistant') break;
                }
            }
            const synth = { ...tc, result };
            if (isToolCallFailed(synth, eventsByCallId)) continue;
            toolCalls.push({
                name: String(tc?.name || tc?.function?.name || ''),
                args: tc?.args || (tc?.function?.arguments ? safeJsonParse(tc.function.arguments) : {}),
                result: typeof result === 'undefined' ? null : result,
                durationMs: Number(tc?.durationMs || 0),
            });
        }
        turns.push({
            reasoning: String(m.reasoning || ''),
            assistantText: String(m.content || ''),
            toolCalls,
        });
        i += 1;
    }
    return turns;
}

function lastCompletedAttempt(attempts) {
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
        if (COMPLETED_STATUSES.has(String(attempts[i]?.status || ''))) return attempts[i];
    }
    return null;
}

export function exportSpecPayload(trace) {
    const eventsByCallId = indexToolErrors(trace);
    const stages = Array.isArray(trace?.stages) ? trace.stages : [];
    const attempts = Array.isArray(trace?.attempts) ? trace.attempts : [];
    const byStageNode = new Map();
    for (const a of attempts) {
        const key = `${a.stageIndex}.${a.nodeIndex}`;
        if (!byStageNode.has(key)) byStageNode.set(key, []);
        byStageNode.get(key).push(a);
    }
    const outStages = stages.map(stage => ({
        stageIndex: Number(stage.stageIndex || 0),
        id: String(stage.id || ''),
        mode: String(stage.mode || 'serial'),
        nodes: (Array.isArray(stage.nodes) ? stage.nodes : []).map(node => {
            const key = `${stage.stageIndex}.${node.nodeIndex}`;
            const last = lastCompletedAttempt(byStageNode.get(key) || []);
            return {
                nodeIndex: Number(node.nodeIndex || 0),
                id: String(node.id || ''),
                kind: String(node.type || 'worker'),
                reviewReplayedStages: Array.isArray(last?.reviewReplayedStages) ? last.reviewReplayedStages : undefined,
                turns: last ? turnsFromConversation(last?.conversation?.messages, eventsByCallId) : [],
                output: String(last?.output || ''),
            };
        }),
    }));
    return {
        stages: outStages,
        finalCapsule: typeof trace?.capsuleText === 'string' ? trace.capsuleText : undefined,
    };
}

/**
 * Look up dispatch metadata for an agenda worker attempt. Worker attempts
 * carry their agent on `preset` and their (agent, todoId) pair encoded as
 * `nodeId = "${agent}:${todoId}"`. The taskBrief lives on `trace.agenda.runs[]`,
 * which the runtime push-appends in dispatch order — we join by (agent, todoId).
 */
function resolveAgendaDispatchMeta(attempt, agendaRuns) {
    const agent = String(attempt?.preset || '').trim();
    const nodeId = String(attempt?.nodeId || '');
    // `nodeId` shape is `${agent}:${todoId}`. Recover todoId by stripping
    // the agent prefix; fall back to the whole nodeId if the format
    // doesn't match (defensive against future runtime changes).
    let todoId = '';
    if (agent && nodeId.startsWith(`${agent}:`)) {
        todoId = nodeId.slice(agent.length + 1);
    } else {
        const colonIdx = nodeId.indexOf(':');
        todoId = colonIdx >= 0 ? nodeId.slice(colonIdx + 1) : nodeId;
    }
    let taskBrief = '';
    if (Array.isArray(agendaRuns)) {
        const match = agendaRuns.find(run =>
            String(run?.agent || '') === agent
            && String(run?.todoId || '') === todoId,
        );
        if (match) taskBrief = String(match.taskBrief || '');
    }
    return { agentName: agent, todoId, taskBrief };
}

export function exportAgendaPayload(trace) {
    const eventsByCallId = indexToolErrors(trace);
    const attempts = Array.isArray(trace?.attempts) ? trace.attempts : [];
    const agendaRuns = Array.isArray(trace?.agenda?.runs) ? trace.agenda.runs : [];

    // Group by stageIndex; planner and workers in the same agenda round
    // share `stageIndex = round - 1`. Final agent uses `stageIndex = plannerMaxRounds`
    // but is identified by `runKind === 'final'` so it doesn't get grouped here.
    const roundsMap = new Map();
    let finalAttempt = null;
    for (const a of attempts) {
        if (!COMPLETED_STATUSES.has(String(a?.status || ''))) continue;
        if (a.runKind === 'final') { finalAttempt = a; continue; }
        const roundIdx = Number(a.stageIndex || 0);
        if (!roundsMap.has(roundIdx)) roundsMap.set(roundIdx, { planner: null, dispatches: [] });
        const row = roundsMap.get(roundIdx);
        if (a.runKind === 'planner') row.planner = a;
        else if (a.runKind === 'worker') row.dispatches.push(a);
    }

    const rounds = Array.from(roundsMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([roundIndex, row]) => ({
            roundIndex,
            planner: {
                turns: row.planner ? turnsFromConversation(row.planner.conversation?.messages, eventsByCallId) : [],
                output: String(row.planner?.output || ''),
            },
            dispatches: row.dispatches.map(d => {
                const meta = resolveAgendaDispatchMeta(d, agendaRuns);
                return {
                    todoId: meta.todoId,
                    agentName: meta.agentName,
                    taskBrief: meta.taskBrief,
                    turns: turnsFromConversation(d.conversation?.messages, eventsByCallId),
                    output: String(d.output || ''),
                };
            }),
        }));

    return {
        rounds,
        finalizer: {
            turns: finalAttempt ? turnsFromConversation(finalAttempt.conversation?.messages, eventsByCallId) : [],
            output: String(finalAttempt?.output || ''),
        },
        finalComposedOutput: String(finalAttempt?.output || ''),
    };
}

function inferLoopTermination(trace) {
    const events = Array.isArray(trace?.events) ? trace.events : [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i];
        if (ev?.type === 'budget_exhausted') return 'budget';
        if (ev?.type === 'tool_call' && ev?.name === 'finalize') return 'finalize';
        if (ev?.type === 'agent_no_tool_call') return 'no_tool_call_streak';
    }
    if (trace?.capsuleText) return 'finalize';
    return 'max_rounds';
}

export function exportLoopPayload(trace) {
    const eventsByCallId = indexToolErrors(trace);
    const messages = Array.isArray(trace?.loop?.conversation?.messages) ? trace.loop.conversation.messages : [];
    const turns = turnsFromConversation(messages, eventsByCallId);
    const rounds = turns.map((t, i) => ({
        roundIndex: i,
        reasoning: t.reasoning,
        assistantText: t.assistantText,
        toolCalls: t.toolCalls,
    }));
    const terminationReason = inferLoopTermination(trace);
    return {
        rounds,
        capsule: typeof trace?.capsuleText === 'string' && trace.capsuleText ? trace.capsuleText : undefined,
        terminationReason,
    };
}

export function exportDirectorPayload(trace) {
    const d = trace?.director || {};
    const eventsByCallId = indexToolErrors(trace);
    const rawRounds = Array.isArray(d?.mainAgent?.rounds) ? d.mainAgent.rounds : [];
    // mainAgent rounds default to success when `status` is unset — the
    // happy-path runtime push leaves the field off, so an absent status
    // means "completed normally" rather than a failure. Explicit failure
    // markers (e.g. 'failed-no-tool-call') are dropped.
    const mainRounds = rawRounds
        .filter(r => {
            const status = String(r?.status || '');
            return !status || COMPLETED_STATUSES.has(status);
        })
        .map((r, idx) => ({
            roundIndex: idx,
            reasoning: String(r.reasoningText || ''),
            assistantText: String(r.assistantText || ''),
            toolCalls: (Array.isArray(r.toolCalls) ? r.toolCalls : [])
                .filter(c => !isToolCallFailed(c, eventsByCallId))
                .map(c => ({
                    name: String(c?.name || ''),
                    args: c?.args || {},
                    result: typeof c?.result === 'undefined' ? null : c.result,
                    durationMs: Number(c?.durationMs || 0),
                })),
        }));
    const subs = Array.isArray(d?.subagents) ? d.subagents : [];
    const subagents = subs
        .filter(s => COMPLETED_STATUSES.has(String(s?.status || 'completed')))
        .map(s => ({
            subagentId: String(s.subagentId || ''),
            isInline: Boolean(s.isInline),
            task: String(s.task || ''),
            reasoning: String(s.reasoningText || ''),
            output: String(s.outputText || ''),
        }));
    return {
        mainAgent: { rounds: mainRounds },
        subagents,
        finalMessage: String(trace?.finalMessage || ''),
    };
}
