// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sample profiles (one per execution mode, mirroring the orchestrator's
// shipped defaults in shape) and scripted runs that replay through the mock
// store with the same round / section ids the real runtimes use. The story
// (the sample town) is original sample content.

const P = (systemPrompt, userPromptTemplate = '', extra = {}) => ({ systemPrompt, userPromptTemplate, apiPresetName: '', promptPresetName: '', tools: null, ...extra });

export const PROFILES = {
    spec: {
        spec: {
            stages: [
                { id: 'distill', mode: 'serial', nodes: ['distiller'] },
                { id: 'grounding', mode: 'parallel', nodes: ['lorebook_reader', 'anti_data_guard'] },
                { id: 'reason', mode: 'parallel', nodes: ['planner', 'recall_relevance'] },
                { id: 'review', mode: 'serial', nodes: [{ id: 'critic', preset: 'critic', type: 'review' }] },
                { id: 'finalize', mode: 'serial', nodes: ['synthesizer'] },
            ],
            defaultTools: null,
        },
        presets: {
            distiller: P('You are a narrative state distiller. Build a compact, evidence-grounded state snapshot for this turn.', 'Recent chat:\n{{recent_chat}}\n\nCurrent user message:\n{{last_user}}\n\nTask:\n- Distill user intent, scene state, active tensions, and likely immediate direction.'),
            lorebook_reader: P('You are a lorebook compliance reader. Extract only active hard constraints from world-info.', 'Distiller output:\n{{distiller}}\n\nTask:\n- Identify hard constraints that must affect THIS turn.', { apiPresetName: 'Gemini Flash' }),
            anti_data_guard: P('You are the anti-data hard gate for RP prose. Block report-style and metric-style narration.', 'Previous outputs:\n{{previous_outputs}}'),
            planner: P('You are a progression planner. Turn current state into a concrete, believable next-step plan.', 'Distiller output:\n{{distiller}}', { apiPresetName: 'Claude Sonnet' }),
            recall_relevance: P('You are a recall relevance analyst. Decide which recalled memory cues should influence this turn.', 'Distiller output:\n{{distiller}}', { tools: { custom: { memory_search: true, memory_get: true } } }),
            critic: P('You are a hard-gate critic. Audit prior worker outputs against explicit review gates before approving.', 'Previous outputs:\n{{previous_outputs}}'),
            synthesizer: P('You are the final orchestration synthesizer. Produce the single draft-ready guidance for generation.', 'Distiller output:\n{{distiller}}\n\nPrevious outputs:\n{{previous_outputs}}'),
        },
    },
    single: {
        spec: { stages: [{ id: 'single', mode: 'serial', nodes: ['single_agent'] }] },
        presets: { single_agent: P('You are a single-agent orchestration planner for roleplay generation.', 'Recent chat:\n{{recent_chat}}\n\nCurrent user message:\n{{last_user}}') },
    },
    agenda: {
        planner: P('You are an orchestration planner. Maintain a todo list, dispatch the minimum useful set of agents.', '## planner_prompt'),
        agents: {
            distiller: P('You are an agenda-mode state distiller.'),
            lorebook_reader: P('You are an agenda-mode lore and constraint reader.'),
            planner: P('You are an agenda-mode scene progression analyst.'),
            critic: P('You are an agenda-mode critic.'),
            finalizer: P('You are the final orchestration writer.'),
        },
        finalAgentId: 'finalizer',
        limits: { plannerMaxRounds: 6, maxConcurrentAgents: 3, maxTotalRuns: 24 },
    },
    loop: {
        system_prompt: 'You are a single-agent orchestration loop for roleplay generation.\nUse the available tools to gather only the context you actually need.',
        tools: { note: { open: true, close: true }, chat: { read_range: true, search: true }, lorebook: { world_book_list: true, list: false, search: true, get: true }, custom: { memory_search: true }, finalize: true },
        max_rounds: 40,
        wall_clock_budget_ms: 300000,
    },
    director: {
        mainAgent: P('You are the director. Dispatch scouts, draft, dispatch critics, revise, finalize.', '', { tools: { message: { write: true, patch: true }, collab: { dispatch: true, await: true } } }),
        subAgents: [
            { id: 'intent_scout', description: 'Cross-source pre-draft scout.', systemPrompt: 'You are a pre-draft intent / authoring-directive scout.', tools: { chat: { read_range: true, search: true }, lorebook: { search: true, get: true } } },
            { id: 'chat_scout', description: 'Scans the recent chat window.', systemPrompt: 'You are a pre-draft chat scout.', tools: { chat: { read_range: true, search: true } } },
            { id: 'memory_scout', description: 'Looks up the memory graph.', systemPrompt: 'You are a pre-draft memory scout.', tools: { custom: { memory_search: true, memory_get: true } } },
            { id: 'lorebook_scout', description: 'Looks up the lorebook.', systemPrompt: 'You are a pre-draft lorebook scout.', tools: { lorebook: { search: true, get: true } } },
            { id: 'epistemic_scout', description: 'Who knows what.', systemPrompt: 'You are an epistemic-boundary scout.' },
            { id: 'plot_brainstormer', description: 'Sketches structures.', systemPrompt: 'You are a plot brainstormer.' },
            { id: 'voice_critic', description: 'Humanity & voice critic.', systemPrompt: 'You are a voice critic.', apiPresetName: 'Claude Opus' },
            { id: 'continuity_critic', description: 'Hard-conflict critic.', systemPrompt: 'You are a continuity critic.' },
            { id: 'memory_curator', description: 'Writes lasting facts to memory.', systemPrompt: 'You are the memory curator.' },
        ],
        maxRounds: 40,
        maxConcurrentSubagents: 4,
        maxTotalSubagentRuns: 16,
        tools: { chat: { read_range: true } },
    },
};

export const PRESET_NAMES = { spec: '默认', single: '', agenda: '默认', loop: '默认', director: '默认（记忆图 + 搜索）' };

// ----- Scripted runs ----------------------------------------------------------
// Each script is a list of steps: [delayMs, fn(store, ids)]. Durations are
// compressed so a full run replays in a few seconds.

const LONG_CAPSULE = '林栖第一次主动提起黑礁沉船，她在试探温澜是否知道父亲的事。\n\n写作指引：\n- 让温澜先回避，再用一句医学上的冷笑话把话题岔开——她嘴硬心软。\n- 窗外开始起雾，灯塔的灯油只够今晚，这是压在两人之间的时间压力。\n- 不要让温澜一口气说出钥匙的来历；只让她下意识摸了一下口袋。\n- 避免数据化描写：不要写“紧张程度”“概率”，把不安写进动作里。\n- 结尾停在温澜的一个问题上，把选择交回给用户。';

const yaml = (obj) => Object.entries(obj).map(([k, v]) => `${k}: ${Array.isArray(v) ? `\n${v.map(x => `  - ${x}`).join('\n')}` : v}`).join('\n');

function specScript({ rerun = false } = {}) {
    const steps = [];
    const at = (ms, fn) => steps.push([ms, fn]);
    const node = (stage, id, ms, body, roundId = `stage-${stage}`) => {
        at(0, (s, r) => s.ensureSection({ runId: r.runId, roundId, section: { id: `node-${id}`, kind: 'text', title: 'Text' } }));
        return [ms, (s, r) => {
            s.appendToSection({ runId: r.runId, roundId, sectionId: `node-${id}`, delta: body });
            s.setSectionStatus({ runId: r.runId, roundId, sectionId: `node-${id}`, status: 'done' });
            s.addTokenUsage({ runId: r.runId, usage: { prompt: 2400 + body.length * 3, completion: 300 + body.length } });
        }];
    };
    const stage = (id, roundId = `stage-${id}`) => at(60, (s, r) => s.appendRound({ runId: r.runId, round: { id: roundId, label: `Stage: ${id}` } }));
    const endStage = (roundId) => at(40, (s, r) => s.setRoundStatus({ runId: r.runId, roundId, status: 'done' }));

    stage('distill');
    steps.push(node('distill', 'distiller', 1400, yaml({ summary: '林栖问起黑礁沉船，想知道温澜是否知道父亲的下落', tension: '雾正在起，灯油只够今晚', direction: '温澜会回避，但留下破绽' })));
    endStage('stage-distill');

    stage('grounding');
    const a = node('grounding', 'lorebook_reader', 900, yaml({ directives: ['雾港夜间禁止出海', '温澜不知道林父的真实死因'], risks: ['不要提前揭示商会阴谋'] }));
    const b = node('grounding', 'anti_data_guard', 1300, yaml({ summary: '未发现数据化表达', directives: ['把焦虑写进动作，不要给数值'] }));
    steps.push(a, b);
    endStage('stage-grounding');

    stage('reason');
    const c = node('reason', 'planner', 1700, yaml({ beats: ['温澜回避', '林栖追问', '温澜下意识摸口袋里的钥匙', '停在温澜的反问上'] }));
    const d = node('reason', 'recall_relevance', 800, yaml({ keep: ['第 11 段：钥匙对应灯塔地下室铁门（高相关）'], skip: ['第 3 段：天气记录'] }));
    steps.push(c, d);
    endStage('stage-reason');

    stage('review');
    at(0, (s, r) => s.ensureSection({ runId: r.runId, roundId: 'stage-review', section: { id: 'node-critic', kind: 'note', title: 'Note' } }));
    at(1100, (s, r) => s.setSectionStatus({ runId: r.runId, roundId: 'stage-review', sectionId: 'node-critic', status: 'done' }));
    endStage('stage-review');
    if (rerun) {
        at(60, (s, r) => s.appendRound({ runId: r.runId, round: { id: 'stage-reason-replay-1', label: 'Stage: reason' } }));
        steps.push(node('reason', 'planner', 1200, yaml({ beats: ['温澜回避', '林栖追问', '温澜摸钥匙但不拿出来', '停在温澜的反问上'] }), 'stage-reason-replay-1'));
        endStage('stage-reason-replay-1');
        at(60, (s, r) => s.appendRound({ runId: r.runId, round: { id: 'stage-review-replay-1', label: 'Stage: review' } }));
        at(0, (s, r) => s.ensureSection({ runId: r.runId, roundId: 'stage-review-replay-1', section: { id: 'node-critic', kind: 'note', title: 'Note' } }));
        at(700, (s, r) => s.setSectionStatus({ runId: r.runId, roundId: 'stage-review-replay-1', sectionId: 'node-critic', status: 'done' }));
        endStage('stage-review-replay-1');
    }

    stage('finalize');
    steps.push(node('finalize', 'synthesizer', 1500, LONG_CAPSULE));
    endStage('stage-finalize');
    at(80, (s, r) => s.finishRun({ runId: r.runId, status: 'committed', finalText: LONG_CAPSULE }));
    return { mode: 'spec', steps };
}

function directorScript() {
    const steps = [];
    const at = (ms, fn) => steps.push([ms, fn]);
    const BODY = '雾是从码头那边漫上来的。\n\n温澜把听诊器收进抽屉，没回头：“黑礁那艘船？退潮的时候连海鸟都不往那边飞。”\n\n她的手在白大褂口袋外停了一下，像是隔着布料确认什么还在。\n\n“你问这个做什么，”她终于转过身，“想去送死，还是想让我陪你一起？”';
    const main = (n) => {
        const rid = `main-${n}`;
        at(50, (s, r) => {
            s.appendRound({ runId: r.runId, round: { id: rid, label: `Director · round ${n + 1}` } });
            s.ensureSection({ runId: r.runId, roundId: rid, section: { id: 'reasoning', kind: 'reasoning', title: 'Reasoning' } });
            s.ensureSection({ runId: r.runId, roundId: rid, section: { id: 'text', kind: 'text', title: 'Text' } });
        });
        return rid;
    };
    const stream = (rid, sec, text, ms) => {
        const parts = text.match(/[\s\S]{1,12}/g) || [];
        const each = Math.max(20, Math.round(ms / parts.length));
        for (const part of parts) at(each, (s, r) => s.appendToSection({ runId: r.runId, roundId: rid, sectionId: sec, delta: part }));
    };
    const tool = (rid, i, name, args, result) => {
        at(40, (s, r) => {
            s.ensureSection({ runId: r.runId, roundId: rid, section: { id: `tool-${i}`, kind: 'tool_call', title: `Tool: ${name}`, meta: { args, source: 'native' } } });
            s.appendToSection({ runId: r.runId, roundId: rid, sectionId: `tool-${i}`, delta: JSON.stringify(args, null, 2) });
        });
        at(120, (s, r) => {
            s.ensureSection({ runId: r.runId, roundId: rid, section: { id: `tool-result-${i}`, kind: 'tool_result', title: `Tool result: ${name}`, meta: { ok: true, err: null } } });
            s.appendToSection({ runId: r.runId, roundId: rid, sectionId: `tool-result-${i}`, delta: JSON.stringify(result, null, 2) });
            s.setSectionStatus({ runId: r.runId, roundId: rid, sectionId: `tool-result-${i}`, status: 'done' });
            s.setSectionStatus({ runId: r.runId, roundId: rid, sectionId: `tool-${i}`, status: 'done' });
        });
    };
    const endRound = (rid) => at(30, (s, r) => {
        for (const sec of ['reasoning', 'text']) s.setSectionStatus({ runId: r.runId, roundId: rid, sectionId: sec, status: 'done' });
        s.setRoundStatus({ runId: r.runId, roundId: rid, status: 'done' });
        s.addTokenUsage({ runId: r.runId, usage: { prompt: 9000, completion: 900 } });
    });
    // Sub-agents run concurrently: interleave their steps by hand.
    const subs = [];
    const sub = (id, n) => {
        const rid = `sub-${id}-${n}`;
        subs.push(rid);
        at(30, (s, r) => {
            s.appendRound({ runId: r.runId, round: { id: rid, label: `Sub-agent ${id} · dispatch ${n}` } });
            s.ensureSection({ runId: r.runId, roundId: rid, section: { id: 'reasoning', kind: 'reasoning', title: 'Reasoning', meta: { isInline: false } } });
            s.ensureSection({ runId: r.runId, roundId: rid, section: { id: 'text', kind: 'text', title: 'Text', meta: { isInline: false } } });
        });
        return rid;
    };
    const finishSub = (rid, text) => at(60, (s, r) => {
        s.appendToSection({ runId: r.runId, roundId: rid, sectionId: 'text', delta: text });
        for (const sec of ['reasoning', 'text']) s.setSectionStatus({ runId: r.runId, roundId: rid, sectionId: sec, status: 'done' });
        s.setRoundStatus({ runId: r.runId, roundId: rid, status: 'done' });
        s.addTokenUsage({ runId: r.runId, usage: { prompt: 4200, completion: 500 } });
    });

    let m = main(0);
    stream(m, 'reasoning', '用户在问沉船。先派侦察：聊天、记忆、认知边界并行。', 500);
    tool(m, 0, 'dispatch_subagent', { subagentId: 'chat_scout', task: '最近 10 楼里关于黑礁沉船和钥匙的线索' }, { ok: true, handle: 'subagent-1' });
    tool(m, 1, 'dispatch_subagent', { subagentId: 'memory_scout', task: '林父失踪、钥匙、地下室铁门' }, { ok: true, handle: 'subagent-2' });
    tool(m, 2, 'dispatch_subagent', { subagentId: 'epistemic_scout', task: '温澜知道林父的哪些事' }, { ok: true, handle: 'subagent-3' });
    const s1 = sub('chat_scout', 1);
    const s2 = sub('memory_scout', 2);
    const s3 = sub('epistemic_scout', 3);
    tool(m, 3, 'await_subagents', { handles: ['subagent-1', 'subagent-2', 'subagent-3'] }, { ok: true, results: 3 });
    endRound(m);
    at(600, () => {});
    finishSub(s3, '- 温澜不知道林父的真实死因（chat[floor=8]）\n- 她见过钥匙上的林家徽记，但没说出口（chat[floor=11]）');
    at(500, () => {});
    finishSub(s1, '- 第 11 楼：钥匙打开了灯塔地下室铁门\n- 第 13 楼：林栖说“退潮那天我要去黑礁”\n- 降权：第 12 楼的天气闲聊');
    at(700, () => {});
    finishSub(s2, '- 林父十年前在黑礁附近失踪（事件 e03）\n- 黑礁沉船船身刻着林家徽记（地点 l_wreck）');

    m = main(1);
    stream(m, 'reasoning', '线索够了。起草：温澜回避，摸口袋，反问。', 400);
    stream(m, 'text', '', 10);
    tool(m, 0, 'write_message', { text: BODY }, { ok: true, chars: BODY.length });
    tool(m, 1, 'dispatch_subagent', { subagentId: 'voice_critic', task: '检查口吻与数据腔' }, { ok: true, handle: 'subagent-4' });
    tool(m, 2, 'dispatch_subagent', { subagentId: 'continuity_critic', task: '对照钥匙与沉船设定' }, { ok: true, handle: 'subagent-5' });
    const c1 = sub('voice_critic', 4);
    const c2 = sub('continuity_critic', 5);
    tool(m, 3, 'await_subagents', { handles: ['subagent-4', 'subagent-5'] }, { ok: true, results: 2 });
    endRound(m);
    at(900, () => {});
    finishSub(c2, '无硬冲突。');
    at(600, () => {});
    finishSub(c1, '- “像是隔着布料确认什么还在”很好，保留\n- 建议：最后一句的反问再短一点');

    m = main(2);
    stream(m, 'reasoning', '采纳口吻评审的建议，收短结尾。定稿。', 300);
    tool(m, 0, 'apply_message_patches', { patches: [{ find: '想去送死，还是想让我陪你一起？', replace: '想去送死？' }] }, { ok: true });
    tool(m, 1, 'finalize', {}, { ok: true });
    endRound(m);
    at(60, (s, r) => s.finishRun({ runId: r.runId, status: 'committed', finalText: BODY.replace('想去送死，还是想让我陪你一起？', '想去送死？') }));
    return { mode: 'director', steps };
}

function agendaScript() {
    const steps = [];
    const at = (ms, fn) => steps.push([ms, fn]);
    const planner = (n, output) => {
        const rid = `node-agenda_planner-${n}`;
        at(50, (s, r) => s.appendRound({ runId: r.runId, round: { id: rid, label: `Node: agenda_planner (attempt ${n})` } }));
        at(900, (s, r) => {
            s.ensureSection({ runId: r.runId, roundId: rid, section: { id: 'planner', kind: 'note', title: 'Note', meta: { output } } });
            s.appendToSection({ runId: r.runId, roundId: rid, sectionId: 'planner', delta: JSON.stringify(output) });
            s.setSectionStatus({ runId: r.runId, roundId: rid, sectionId: 'planner', status: 'done' });
            s.setRoundStatus({ runId: r.runId, roundId: rid, status: 'done' });
        });
    };
    const workers = (n, list) => {
        for (const [agent, todo] of list) at(20, (s, r) => s.appendRound({ runId: r.runId, round: { id: `node-${agent}-${todo}-${n}`, label: `Node: ${agent}:${todo} (attempt ${n})` } }));
        for (const [agent, todo, ms, text] of list) {
            at(ms, (s, r) => {
                const rid = `node-${agent}-${todo}-${n}`;
                s.ensureSection({ runId: r.runId, roundId: rid, section: { id: 'output', kind: 'text', title: 'Text' } });
                s.appendToSection({ runId: r.runId, roundId: rid, sectionId: 'output', delta: text });
                s.setSectionStatus({ runId: r.runId, roundId: rid, sectionId: 'output', status: 'done' });
                s.setRoundStatus({ runId: r.runId, roundId: rid, status: 'done' });
                s.addTokenUsage({ runId: r.runId, usage: { prompt: 3000, completion: 400 } });
            });
        }
    };
    planner(1, { todo_ops: [{ op: 'add', todo_id: 'state', goal: '读懂林栖这一问的用意' }, { op: 'add', todo_id: 'lore', goal: '确认雾港夜间的规矩' }], dispatches: [{ agent: 'distiller', todo_id: 'state', task_brief: '提炼当前场面和林栖的意图' }, { agent: 'lorebook_reader', todo_id: 'lore', task_brief: '找出夜间出海、灯塔相关的硬规则' }], finalize: false });
    workers(1, [['distiller', 'state', 900, '林栖在试探温澜；雾正在起。'], ['lorebook_reader', 'lore', 600, '夜间禁止出海；灯塔不可熄灯。']]);
    planner(2, { todo_ops: [{ op: 'set_status', todo_id: 'state', status: 'done' }, { op: 'set_status', todo_id: 'lore', status: 'done' }, { op: 'add', todo_id: 'beat', goal: '规划下一拍' }], dispatches: [{ agent: 'planner', todo_id: 'beat', task_brief: '温澜该怎么回应，停在哪里' }], finalize: false });
    workers(2, [['planner', 'beat', 1200, '回避 → 摸口袋 → 反问。']]);
    planner(3, { todo_ops: [{ op: 'set_status', todo_id: 'beat', status: 'done' }], dispatches: [], finalize: true });
    at(50, (s, r) => s.appendRound({ runId: r.runId, round: { id: 'node-finalizer-final', label: 'Node: finalizer (attempt 7)' } }));
    at(1000, (s, r) => {
        s.ensureSection({ runId: r.runId, roundId: 'node-finalizer-final', section: { id: 'final', kind: 'text', title: 'Text' } });
        s.appendToSection({ runId: r.runId, roundId: 'node-finalizer-final', sectionId: 'final', delta: LONG_CAPSULE });
        s.setSectionStatus({ runId: r.runId, roundId: 'node-finalizer-final', sectionId: 'final', status: 'done' });
        s.setRoundStatus({ runId: r.runId, roundId: 'node-finalizer-final', status: 'done' });
        s.finishRun({ runId: r.runId, status: 'committed', finalText: LONG_CAPSULE });
    });
    return { mode: 'agenda', steps };
}

function loopScript() {
    const steps = [];
    const at = (ms, fn) => steps.push([ms, fn]);
    const calls = [
        ['chat_search', { query: '黑礁' }],
        ['lorebook_search', { query: '雾港 夜间' }],
        ['memory_search', { query: '林父 失踪' }],
    ];
    calls.forEach(([name, args], i) => {
        const rid = `agent-${i + 1}`;
        at(50, (s, r) => {
            s.appendRound({ runId: r.runId, round: { id: rid, label: `Agent · round ${i + 1}` } });
            s.ensureSection({ runId: r.runId, roundId: rid, section: { id: 'text', kind: 'text', title: 'Text' } });
        });
        at(700, (s, r) => {
            s.appendToSection({ runId: r.runId, roundId: rid, sectionId: 'text', delta: `先查一下「${args.query}」。` });
            s.setSectionStatus({ runId: r.runId, roundId: rid, sectionId: 'text', status: 'done' });
            s.ensureSection({ runId: r.runId, roundId: rid, section: { id: 'tool-0', kind: 'tool_call', title: `Tool: ${name}`, meta: { args, source: 'native' } } });
            s.setSectionStatus({ runId: r.runId, roundId: rid, sectionId: 'tool-0', status: 'done' });
        });
        at(400, (s, r) => {
            s.ensureSection({ runId: r.runId, roundId: rid, section: { id: 'tool-result-0', kind: 'tool_result', title: `Tool result: ${name}`, meta: { ok: true } } });
            s.setSectionStatus({ runId: r.runId, roundId: rid, sectionId: 'tool-result-0', status: 'done' });
            s.setRoundStatus({ runId: r.runId, roundId: rid, status: 'done' });
            s.addTokenUsage({ runId: r.runId, usage: { prompt: 5000 + i * 1500, completion: 200 } });
        });
    });
    at(50, (s, r) => {
        s.appendRound({ runId: r.runId, round: { id: 'agent-4', label: 'Agent · round 4' } });
        s.ensureSection({ runId: r.runId, roundId: 'agent-4', section: { id: 'text', kind: 'text', title: 'Text' } });
    });
    at(900, (s, r) => {
        s.setSectionStatus({ runId: r.runId, roundId: 'agent-4', sectionId: 'text', status: 'done' });
        s.ensureSection({ runId: r.runId, roundId: 'agent-4', section: { id: 'tool-0', kind: 'tool_call', title: 'Tool: finalize', meta: { args: { capsule_text: LONG_CAPSULE }, source: 'native' } } });
        s.ensureSection({ runId: r.runId, roundId: 'agent-4', section: { id: 'tool-result-0', kind: 'tool_result', title: 'Tool result: finalize', meta: { ok: true, finalized: true } } });
        s.setSectionStatus({ runId: r.runId, roundId: 'agent-4', sectionId: 'tool-0', status: 'done' });
        s.setSectionStatus({ runId: r.runId, roundId: 'agent-4', sectionId: 'tool-result-0', status: 'done' });
        s.setRoundStatus({ runId: r.runId, roundId: 'agent-4', status: 'done' });
        s.finishRun({ runId: r.runId, status: 'committed', finalText: LONG_CAPSULE });
    });
    return { mode: 'loop', steps };
}

/** The search-tools agent: round-N rounds, web search / visit / lorebook upsert. */
export function searchScript() {
    const steps = [];
    const at = (ms, fn) => steps.push([ms, fn]);
    const round = (n, calls, text = '') => {
        const rid = `round-${n}`;
        at(60, (s, r) => s.appendRound({ runId: r.runId, round: { id: rid, label: `Round ${n}` } }));
        at(900, (s, r) => {
            if (text) {
                s.ensureSection({ runId: r.runId, roundId: rid, section: { id: 'text', kind: 'text', title: 'Response' } });
                s.appendToSection({ runId: r.runId, roundId: rid, sectionId: 'text', delta: text });
                s.setSectionStatus({ runId: r.runId, roundId: rid, sectionId: 'text', status: 'done' });
            }
            s.addTokenUsage({ runId: r.runId, usage: { prompt: 2600, completion: 180 } });
        });
        calls.forEach(([name, args, result], i) => {
            at(60, (s, r) => {
                s.ensureSection({ runId: r.runId, roundId: rid, section: { id: `tool-c${i}`, kind: 'tool_call', title: `Tool: ${name}`, meta: { args } } });
                s.setSectionStatus({ runId: r.runId, roundId: rid, sectionId: `tool-c${i}`, status: 'done' });
            });
            at(700, (s, r) => {
                s.ensureSection({ runId: r.runId, roundId: rid, section: { id: `tool-result-c${i}`, kind: 'tool_result', title: `Tool result: ${name}`, meta: { ok: true } } });
                s.appendToSection({ runId: r.runId, roundId: rid, sectionId: `tool-result-c${i}`, delta: JSON.stringify(result, null, 2) });
                s.setSectionStatus({ runId: r.runId, roundId: rid, sectionId: `tool-result-c${i}`, status: 'done' });
            });
        });
        at(40, (s, r) => s.setRoundStatus({ runId: r.runId, roundId: rid, status: 'done' }));
    };
    round(1, [['luker_search_agent_search', { query: '灯塔 灯油 历史 煤油' }, { ok: true, results: 5 }]]);
    round(2, [['luker_search_agent_visit', { url: 'https://en.wikipedia.org/wiki/Lighthouse' }, { ok: true, chars: 4000 }]]);
    round(3, [['luker_search_agent_upsert_lorebook_entry', { title: '灯塔用油', content: '```yaml\n燃料: 煤油\n```' }, { ok: true, changed: true }]]);
    round(4, [], '已把灯塔用油的资料写进世界书，够用了。');
    at(40, (s, r) => s.finishRun({ runId: r.runId, status: 'committed' }));
    return { mode: 'search', steps };
}

export function scriptFor(mode, options = {}) {
    if (mode === 'director') return directorScript();
    if (mode === 'agenda') return agendaScript();
    if (mode === 'loop') return loopScript();
    if (mode === 'single') {
        return { mode: 'spec', steps: [
            [60, (st, r) => st.appendRound({ runId: r.runId, round: { id: 'stage-single', label: 'Stage: single' } })],
            [0, (st, r) => st.ensureSection({ runId: r.runId, roundId: 'stage-single', section: { id: 'node-single_agent', kind: 'text', title: 'Text' } })],
            [1800, (st, r) => { st.appendToSection({ runId: r.runId, roundId: 'stage-single', sectionId: 'node-single_agent', delta: LONG_CAPSULE }); st.setSectionStatus({ runId: r.runId, roundId: 'stage-single', sectionId: 'node-single_agent', status: 'done' }); st.setRoundStatus({ runId: r.runId, roundId: 'stage-single', status: 'done' }); st.addTokenUsage({ runId: r.runId, usage: { prompt: 6000, completion: 500 } }); }],
            [40, (st, r) => st.finishRun({ runId: r.runId, status: 'committed', finalText: LONG_CAPSULE })],
        ] };
    }
    return specScript(options);
}

/** A clock both the mock store and the recorder read; replay advances it. */
export function createClock(start = 1000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

/**
 * Replays a script. Each step advances `clock` by its delay, so timings look
 * real even when replaying instantly. speed = Infinity runs synchronously
 * (screenshots / tests); stopAt freezes the run mid-way ("still running").
 */
export function playScript(store, script, { speed = 1, stopAt = Infinity, chatKey = 'demo', clock } = {}) {
    let i = 0;
    let timer = 0;
    let cancelled = false;
    const runId = store.startRun({ mode: script.mode, chatKey, stopFn: () => cancel() });
    const ctx = { runId };
    function cancel() {
        cancelled = true;
        clearTimeout(timer);
        if (store.getCurrentRun()?.status === 'running') store.finishRun({ runId, status: 'error', error: 'Orchestration aborted.' });
    }
    function step() {
        const [delay, fn] = script.steps[i];
        clock?.advance(delay);
        fn(store, ctx);
        i += 1;
    }
    function next() {
        while (!cancelled && i < script.steps.length && i < stopAt) {
            const delay = script.steps[i][0];
            if (speed !== Infinity && delay > 0) {
                timer = setTimeout(() => { if (!cancelled) { step(); next(); } }, delay / speed);
                return;
            }
            step();
        }
    }
    next();
    return { cancel, runId };
}
