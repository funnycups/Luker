/**
 * Reshapes orchestrator runtime output into per-mode payloads consumed
 * by simulation-review renderers. Failed tool calls are filtered; failed
 * attempts are dropped. Reasoning is sourced from `message.reasoning` on
 * each assistant turn for spec/agenda/loop (their internal trace), and
 * from the RunStateStore round's `reasoning` section for director.
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
 *   - Director mode reads from a RunStateStore snapshot instead of a
 *     trace object. Main-agent rounds are `rounds[]` whose id is
 *     `main-<n>`; sub-agent dispatches are `rounds[]` whose id is
 *     `sub-<subagentId>-<handleTail>`. Per-section bodies carry full
 *     tool args / results so the popup can show them at full fidelity.
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
                ...(typeof tc?.source === 'string' && tc.source ? { source: tc.source } : {}),
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

export function exportDirectorPayload(runSnapshot) {
    // RunStateStore snapshot shape: { rounds: [{ id, status, sections: [{ id, kind, title, body, meta }] }], finalText }
    // Main-agent rounds: id matches `main-<n>` (n = round index, 0-based).
    // Sub-agent dispatches: id matches `sub-<subagentId>-<handleTail>`; one round per dispatch.
    const rounds = Array.isArray(runSnapshot?.rounds) ? runSnapshot.rounds : [];
    const mainRoundEntries = rounds
        .filter(r => /^main-/.test(String(r?.id || '')))
        .map(r => {
            const n = Number(String(r.id).slice(5));
            return { idx: Number.isFinite(n) ? n : 0, round: r };
        })
        .sort((a, b) => a.idx - b.idx);
    const mainRounds = mainRoundEntries.map(({ idx, round }) => {
        const sections = Array.isArray(round.sections) ? round.sections : [];
        const reasoning = sections.find(s => s.id === 'reasoning' && s.kind === 'reasoning')?.body || '';
        const assistantText = sections.find(s => s.id === 'text' && s.kind === 'text')?.body || '';
        const toolCalls = sectionsToToolCalls(sections);
        return { roundIndex: idx, reasoning, assistantText, toolCalls };
    });

    const subagents = rounds
        .filter(r => /^sub-/.test(String(r?.id || '')))
        .map(round => {
            const sections = Array.isArray(round.sections) ? round.sections : [];
            const reasoningSection = sections.find(s => s.id === 'reasoning' && s.kind === 'reasoning');
            const textSection = sections.find(s => s.id === 'text' && s.kind === 'text');
            // round.id format: sub-<subagentId>-<handleTail>; subagentId can
            // include dashes (`(inline)`) so we strip the prefix and the
            // trailing handle tail rather than splitting on `-`.
            const rawId = String(round.id || '');
            const withoutPrefix = rawId.replace(/^sub-/, '');
            const lastDash = withoutPrefix.lastIndexOf('-');
            const subagentId = lastDash >= 0 ? withoutPrefix.slice(0, lastDash) : withoutPrefix;
            const meta = reasoningSection?.meta || textSection?.meta || null;
            return {
                subagentId,
                isInline: Boolean(meta?.isInline),
                task: String(meta?.task || ''),
                reasoning: String(reasoningSection?.body || ''),
                output: String(textSection?.body || ''),
            };
        });

    return {
        mainAgent: { rounds: mainRounds },
        subagents,
        finalMessage: String(runSnapshot?.finalText || ''),
    };
}

// Walk a round's sections, pairing each tool_call with its matching
// tool_result, into the `{name, args, result, source}` shape the popup
// renderer expects. tool_call id `tool-<i>` (main) or `tool-<r>-<i>`
// (sub-agent); the matching result is `tool-result-<...>` with the
// same trailing index.
function sectionsToToolCalls(sections) {
    const calls = sections.filter(s => s?.kind === 'tool_call');
    const out = [];
    for (const call of calls) {
        // Pair: replace `tool-` prefix with `tool-result-`. Both naming
        // conventions in director-runtime.js / director-tools.js follow
        // this rule.
        const resultId = String(call.id).replace(/^tool-/, 'tool-result-');
        const result = sections.find(s => s?.id === resultId && s?.kind === 'tool_result');
        const meta = call.meta || {};
        // Result body is the full JSON dump (the section body we append
        // alongside ensureSection). meta.ok/err is panel-friendly status
        // bookkeeping; the body carries the actual payload the AI saw.
        let resultValue = null;
        if (result) {
            try { resultValue = JSON.parse(result.body); }
            catch { resultValue = result.body || null; }
        }
        // Strip the `Tool: ` prefix the runtime adds for display.
        const name = String(call.title || '').replace(/^Tool:\s*/, '') || '?';
        out.push({
            name,
            args: meta.args && typeof meta.args === 'object' ? meta.args : {},
            result: resultValue,
            source: meta.source || undefined,
        });
    }
    return out;
}
