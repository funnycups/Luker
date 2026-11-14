// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Turns an orchestrator profile (any of the five execution modes) into one
// display shape the flow view can draw:
//
//   { mode, source, presetName, columns: [{ id, kind, label, parallel, review, nodes: [nodeId] }],
//     agents: { [nodeId]: Agent }, limits: [{ key, value }] }
//
// Columns are left-to-right steps. For spec/single they are the stages; for
// agenda / loop / director they are a small fixed layout around the driver
// agent. Pure: no DOM, no Luker — tests import it in Node.

import { agentGroup } from '../i18n.js';

const str = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** Flattens a tool-flag tree ({chat:{search:true}, finalize:true, custom:{memory_x:true}}) into enabled tool keys. */
export function enabledTools(flags) {
    if (!flags || typeof flags !== 'object') return [];
    const out = [];
    for (const [group, value] of Object.entries(flags)) {
        if (value === true) out.push(group);
        else if (value && typeof value === 'object') {
            for (const [verb, on] of Object.entries(value)) {
                if (on !== true) continue;
                out.push(group === 'custom' ? verb : `${group}_${verb}`);
            }
        }
    }
    return out;
}

function makeAgent(id, raw, extra = {}) {
    const source = obj(raw);
    return {
        id,
        systemPrompt: str(source.systemPrompt ?? source.system_prompt),
        userPrompt: str(source.userPromptTemplate),
        description: str(source.description),
        apiPreset: str(source.apiPresetName),
        promptPreset: str(source.promptPresetName),
        // null = inherits the profile-level tool set.
        tools: source.tools === null || source.tools === undefined ? null : enabledTools(source.tools),
        group: agentGroup(id),
        kind: 'worker',
        ...extra,
    };
}

function nodeOf(raw) {
    if (typeof raw === 'string') return { id: raw, preset: raw, type: 'worker' };
    const node = obj(raw);
    const id = str(node.id || node.preset);
    return { id, preset: str(node.preset || id), type: node.type === 'review' ? 'review' : 'worker', userPromptTemplate: str(node.userPromptTemplate), tools: node.tools };
}

function specColumns(spec, presets, profileTools) {
    const columns = [];
    const agents = {};
    const stages = Array.isArray(spec?.stages) ? spec.stages : [];
    stages.forEach((stage, index) => {
        const nodes = (Array.isArray(stage?.nodes) ? stage.nodes : []).map(nodeOf).filter(node => node.id);
        const review = nodes.some(node => node.type === 'review');
        const column = {
            id: str(stage?.id) || `stage_${index + 1}`,
            kind: 'stage',
            index: index + 1,
            // A stage holding a review node always runs serially.
            parallel: stage?.mode === 'parallel' && !review && nodes.length > 1,
            review,
            nodes: [],
        };
        for (const node of nodes) {
            const preset = obj(presets?.[node.preset]);
            const agent = makeAgent(node.id, preset, {
                preset: node.preset,
                kind: node.type,
                stageId: column.id,
            });
            if (node.userPromptTemplate) agent.userPrompt = node.userPromptTemplate;
            if (node.tools !== undefined && node.tools !== null) agent.tools = enabledTools(node.tools);
            if (agent.tools === null && profileTools) agent.inheritedTools = enabledTools(profileTools);
            agents[node.id] = agent;
            column.nodes.push(node.id);
        }
        columns.push(column);
    });
    // The last stage's output is the capsule for the main model.
    if (columns.length) columns[columns.length - 1].final = true;
    return { columns, agents };
}

function limitList(pairs) {
    return pairs.filter(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0).map(([key, value]) => ({ key, value: Number(value) }));
}

/**
 * @param {object} profile  effective profile as resolved from settings (see source-luker.js)
 * @param {object} [meta]   { source, presetName, settings }
 */
export function buildFlow(profile, meta = {}) {
    const p = obj(profile);
    const mode = str(meta.mode || p.mode || 'spec');
    const base = { mode, source: str(meta.source || 'global'), presetName: str(meta.presetName), scopeLabel: str(meta.scopeLabel) };
    const settings = obj(meta.settings);

    if (mode === 'spec' || mode === 'single') {
        const { columns, agents } = specColumns(p.spec, p.presets, p.spec?.defaultTools);
        return {
            ...base,
            columns,
            agents,
            output: 'capsule',
            limits: mode === 'spec' ? limitList([['limitRerun', settings.reviewRerunMaxRounds]]) : [],
        };
    }

    if (mode === 'agenda') {
        const agents = {};
        const planner = makeAgent('agenda_planner', p.planner, { kind: 'planner' });
        agents.agenda_planner = planner;
        const finalId = str(p.finalAgentId);
        const pool = [];
        for (const [id, raw] of Object.entries(obj(p.agents))) {
            agents[id] = makeAgent(id, raw, { kind: id === finalId ? 'final' : 'worker' });
            if (id !== finalId) pool.push(id);
        }
        const columns = [
            { id: 'planner', kind: 'driver', nodes: ['agenda_planner'] },
            { id: 'pool', kind: 'pool', parallel: true, nodes: pool },
        ];
        if (finalId && agents[finalId]) columns.push({ id: 'final', kind: 'stage', final: true, nodes: [finalId] });
        const limits = obj(p.limits);
        return {
            ...base, columns, agents, output: 'capsule',
            limits: limitList([['limitRounds', limits.plannerMaxRounds], ['limitConcurrent', limits.maxConcurrentAgents], ['limitTotal', limits.maxTotalRuns]]),
        };
    }

    if (mode === 'loop') {
        const agent = makeAgent('loop_agent', p, { kind: 'driver' });
        if (agent.tools === null) agent.tools = [];
        return {
            ...base,
            columns: [{ id: 'loop', kind: 'loop', final: true, nodes: ['loop_agent'] }],
            agents: { loop_agent: agent },
            output: 'capsule',
            limits: limitList([['limitRounds', p.max_rounds], ['limitTime', Math.round(Number(p.wall_clock_budget_ms) / 1000)]]),
        };
    }

    // director
    const agents = {};
    const main = makeAgent('main', p.mainAgent, { kind: 'driver' });
    if (main.tools === null) main.inheritedTools = enabledTools(p.tools);
    agents.main = main;
    const groups = { scout: [], plan: [], critic: [], curator: [], other: [] };
    for (const raw of Array.isArray(p.subAgents) ? p.subAgents : []) {
        const id = str(raw?.id);
        if (!id || agents[id]) continue;
        const agent = makeAgent(id, raw, { kind: 'sub', maxRounds: Number(raw?.maxRounds) || null });
        if (agent.tools === null) agent.inheritedTools = enabledTools(p.tools);
        agents[id] = agent;
        groups[agent.group].push(id);
    }
    const columns = [{ id: 'main', kind: 'driver', final: true, nodes: ['main'] }];
    for (const key of ['scout', 'plan', 'critic', 'curator', 'other']) {
        if (groups[key].length) columns.push({ id: key, kind: 'group', group: key, parallel: true, nodes: groups[key] });
    }
    return {
        ...base, columns, agents, output: 'body',
        limits: limitList([['limitRounds', p.maxRounds], ['limitConcurrent', p.maxConcurrentSubagents], ['limitTotal', p.maxTotalSubagentRuns]]),
    };
}

/** Counts used in the topbar / overview. */
export function flowStats(flow) {
    const ids = Object.keys(flow?.agents || {});
    return { agents: ids.length, steps: flow?.columns?.length || 0 };
}
