// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI assistant and AI diagnosis: prompts, tools and the conversation loop. Pure (no DOM,
// no Luker): the source passes in a `request()` that calls the model, and
// the tools run here against a working copy of the profile, so Node tests
// cover the whole flow.
//
// Messages: { id, role: 'user'|'assistant'|'note', content, toolCalls?, toolResults?, at }
// toolCalls [{id,name,args}], toolResults [{tool_call_id, content, status}].

import { i18n, i18nFormat, listSeparator, dateLocale, agentName, agentRole, modeInfo, statusLabel } from '../i18n.js';
import { listAgents, agentFields, getField, setField, replaceInField, validateField, fieldLabel, EditError } from './edit.js';
import { previewText } from './describe.js';
import { formatDuration } from './run.js';

export const MAX_ROUNDS = 8;
export const MAX_SESSIONS = 12;
const FIELD_KEYS = ['description', 'system', 'task', 'api', 'preset'];

export const makeId = (prefix = 'ol') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// ----- Tools -----------------------------------------------------------------

const fn = (name, description, properties, required) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const AGENT = { type: 'string', description: 'Agent id, exactly as listed in the profile overview.' };
const FIELD = { type: 'string', enum: FIELD_KEYS, description: 'system = role prompt, task = task template, description = sub-agent description (director), api = connection profile name, preset = generation preset name.' };

export const TOOLS = {
    read_agent: fn('olens_read_agent', 'Read the full current text of every editable field of one agent.', { agent_id: AGENT }, ['agent_id']),
    read_step: fn('olens_read_step', 'Read the full recorded process of one numbered step (thinking, output, tool calls, errors).', { step: { type: 'integer', description: 'Step number from the run overview, or the evidence number (E3 → 3) in a stats diagnosis.' } }, ['step']),
    replace: fn('olens_replace_text', 'Replace one exact passage inside a text field. old_text must be copied verbatim from olens_read_agent output and occur exactly once.', {
        agent_id: AGENT, field: FIELD, old_text: { type: 'string' }, new_text: { type: 'string' },
    }, ['agent_id', 'field', 'old_text', 'new_text']),
    set: fn('olens_set_field', 'Replace the whole value of a field. Prefer olens_replace_text for long prompts.', { agent_id: AGENT, field: FIELD, value: { type: 'string' } }, ['agent_id', 'field', 'value']),
};
export const EDIT_TOOL_NAMES = new Set([TOOLS.replace.function.name, TOOLS.set.function.name]);
export const isEditTool = (name) => EDIT_TOOL_NAMES.has(String(name || ''));

export function toolSet({ withRun = false } = {}) {
    return [TOOLS.read_agent, ...(withRun ? [TOOLS.read_step] : []), TOOLS.replace, TOOLS.set];
}

/** Short user-facing line for a tool call. */
export function toolCallText(call) {
    const args = call?.args || {};
    const who = agentName(args.agent_id);
    switch (String(call?.name || '')) {
        case 'olens_read_agent': return i18nFormat('View the settings of "${0}"', who);
        case 'olens_read_step': return i18nFormat('View the process of step ${0}', args.step);
        case 'olens_replace_text':
        case 'olens_set_field': return i18nFormat('Edit the ${1} of "${0}"', who, fieldLabel(args.field) || i18n('agent settings'));
        default: return i18n('Look up references');
    }
}

/**
 * Runs the model's tool calls against `profile` (a working copy).
 * @returns {{ profile: object, results: { id, name, args, result, ok }[] }}
 */
export function executeTools(calls, { mode, profile, steps = [], options = null }) {
    let current = profile;
    const results = [];
    for (const raw of calls || []) {
        const name = String(raw?.name || '');
        const args = raw?.args && typeof raw.args === 'object' ? raw.args : {};
        const id = String(raw?.id || '') || makeId('call');
        let result;
        let ok = true;
        try {
            const agentId = String(args.agent_id || '');
            const needAgent = () => {
                if (!listAgents(mode, current).includes(agentId)) throw new EditError('agent', i18nFormat('No such agent: ${0}. Available: ${1}', agentId, listAgents(mode, current).join(', ')));
            };
            const needField = () => {
                needAgent();
                if (!agentFields(mode, current, agentId).includes(args.field)) throw new EditError('field', i18nFormat('${0} has no field ${1}. Editable: ${2}', agentId, args.field, agentFields(mode, current, agentId).join(', ')));
            };
            if (name === 'olens_read_agent') {
                needAgent();
                result = Object.fromEntries(agentFields(mode, current, agentId).map(field => [field, getField(mode, current, agentId, field)]));
            } else if (name === 'olens_read_step') {
                const step = steps[Number(args.step) - 1];
                if (!step) throw new EditError('step', i18nFormat('There is no step ${0} (${1} steps in total)', args.step, steps.length));
                result = step.full;
            } else if (name === 'olens_replace_text' || name === 'olens_set_field') {
                needField();
                const field = String(args.field);
                if ((field === 'api' || field === 'preset') && name === 'olens_replace_text') throw new EditError('field', i18n('Use olens_set_field for connection profiles and generation presets'));
                const value = name === 'olens_set_field'
                    ? String(args.value ?? '')
                    : null;
                if (value !== null && (field === 'api' || field === 'preset') && value && options) {
                    const allowed = field === 'api' ? options.connections : options.presets;
                    if (Array.isArray(allowed) && allowed.length && !allowed.includes(value)) throw new EditError('value', i18nFormat('No such ${0}: ${1}. Options: ${2}; leave empty to follow the default', fieldLabel(field), value, allowed.join(', ')));
                }
                const next = value !== null
                    ? setField(mode, current, agentId, field, value)
                    : replaceInField(mode, current, agentId, field, args.old_text, args.new_text);
                const problem = validateField(mode, agentId, field, getField(mode, next, agentId, field));
                if (problem) throw new EditError('invalid', problem);
                if (getField(mode, next, agentId, field) === getField(mode, current, agentId, field)) {
                    ok = false;
                    result = { status: 'noop', message: 'Already matches; nothing changed.' };
                } else {
                    current = next;
                    result = { status: 'applied', message: 'Applied to the working draft. The user reviews and saves it.' };
                }
            } else {
                throw new EditError('tool', `unknown tool ${name}`);
            }
        } catch (err) {
            ok = false;
            result = { error: String(err?.message || err) };
        }
        results.push({ id, name, args, result, ok });
    }
    return { profile: current, results };
}

// ----- Prompts ---------------------------------------------------------------

const clip = (text, max) => {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max)}${i18nFormat('… (${0} characters in total; use olens_read_agent to read it all)', value.length)}` : value;
};

const named = (id) => i18nFormat('${0} [${1}]', id, agentName(id));

/** Compact description of the profile the AI is editing. */
export function profileOverview(mode, profile) {
    const lines = [i18nFormat('Execution mode: ${0} (${1}: ${2})', mode, modeInfo(mode).label, modeInfo(mode).hint)];
    if (mode === 'spec' || mode === 'single') {
        const stages = Array.isArray(profile?.spec?.stages) ? profile.spec.stages : [];
        lines.push(i18nFormat('Steps: ${0}', stages.map((s, i) => i18nFormat('${0}. ${1} (${2}: ${3})', i + 1, s.id, s.mode === 'parallel' ? i18n('At once') : i18n('In order'), (s.nodes || []).map(n => (typeof n === 'string' ? n : `${n.id}${n.type === 'review' ? i18n('[review]') : ''}`)).join(listSeparator()))).join(' → ')));
        lines.push(i18n('The output of the last step is injected for the main model as guidance for writing the reply.'));
    } else if (mode === 'agenda') {
        lines.push(i18nFormat('The dispatcher agenda_planner assigns work dynamically. Wrap-up agent: ${0} (its output is injected for the main model).', profile?.finalAgentId || 'finalizer'));
    } else if (mode === 'loop') {
        lines.push(i18n('One agent, loop_agent, keeps calling tools to look things up and finally writes guidance injected for the main model.'));
    } else if (mode === 'director') {
        lines.push(i18n('The lead writer, main, dispatches sub-agents, drafts on its own and writes the reply text directly.'));
    }
    lines.push('', i18n('Agents:'));
    for (const id of listAgents(mode, profile)) {
        const fields = agentFields(mode, profile, id);
        const role = agentRole(id) || getField(mode, profile, id, 'description');
        lines.push(`- ${named(id)}${role ? i18nFormat(': ${0}', role) : ''}`);
        for (const field of fields) {
            const value = getField(mode, profile, id, field);
            if (field === 'description') continue;
            if (field === 'api' || field === 'preset') {
                lines.push(`  ${field}: ${value || i18n('(follows default)')}`);
                continue;
            }
            lines.push(`  ${field}: ${value ? clip(value.replace(/\s+/g, ' '), 260) : i18n('(empty)')}`);
        }
    }
    return lines.join('\n');
}

const sectionText = (section) => {
    const kind = section.kind;
    const body = String(section.body || '');
    const title = section.title ? ` ${section.title}` : '';
    if (kind === 'tool_call') return `[${i18n('Tool call')}${title}] ${clip(JSON.stringify(section.meta?.args ?? body), 1500)}`;
    if (kind === 'tool_result') return `[${i18n('Tool result')}${title}${section.meta?.ok === false ? ` ${i18n('Failed')}` : ''}] ${clip(section.meta?.err || body, 2000)}`;
    if (kind === 'reasoning') return body.trim() ? `[${i18n('Model thinking')}] ${clip(body, 2500)}` : '';
    if (kind === 'note' && section.meta?.output) return `[${i18n('Planner decision')}] ${clip(JSON.stringify(section.meta.output), 2500)}`;
    const err = section.meta?.err ? `[${i18n('Error text')}] ${clip(section.meta.err, 1500)}` : '';
    return [body.trim() ? `[${i18n('Output')}${title}] ${clip(body, 6000)}` : '', err].filter(Boolean).join('\n');
};

/**
 * Numbered steps of a run view (from buildRunView), with a short and a full form.
 * @returns {{ n, agentId, key, status, short: string, full: string }[]}
 */
export function runSteps(view) {
    return (view?.segments || []).map((seg, i) => {
        const err = seg.sections.map(s => s.meta?.err).find(Boolean);
        const out = seg.sections.filter(s => s.kind === 'text' || s.kind === 'note').map(s => s.body).filter(Boolean).join('\n');
        const head = `${i + 1}. ${named(seg.agentId)}${seg.replay ? ` ${i18n('Redo run')}` : ''}${seg.final ? ` ${i18n('Wrap up')}` : ''} · ${statusLabel(seg.status)} · ${formatDuration(seg.duration)}`;
        const tools = seg.sections.filter(s => s.kind === 'tool_call').length;
        return {
            n: i + 1,
            agentId: seg.agentId,
            key: seg.key,
            status: seg.status,
            short: `${head}${tools ? ` · ${i18nFormat('Called tools ${0} times', tools)}` : ''}${err ? `\n   ${i18nFormat('Error: ${0}', clip(err, 300))}` : ''}${out ? `\n   ${i18nFormat('Output: ${0}', previewText(out, { max: 220 }))}` : ''}`,
            full: `${head}\n${seg.sections.map(sectionText).filter(Boolean).join('\n')}`,
        };
    });
}

const BASE = [
    'You are the tuning assistant for Luker\'s "Multi-agent orchestration", helping the user improve orchestration profiles in Orchestra Lens. Orchestration runs every time the user sends a message: several agents (each with a role prompt and a task template) divide the work of reading the chat, looking things up and planning, then hand writing guidance to the main model (in director mode the lead writer writes the reply directly).',
    'This is a tool task, not storytelling. Preset requirements about style, narration or roleplay do not apply here.',
    '',
    '[What you can change] For each agent: system (role prompt), task (task template, with macros such as {{recent_chat}}), description (description of a director-mode sub-agent, which the lead writer uses to decide whom to dispatch), api (connection profile name), preset (generation preset name). Adding or removing agents and changing steps or tool switches is not done here; when needed, tell the user to use the native panel.',
    '[How to change it] First read the full text with olens_read_agent, then replace one exact passage with olens_replace_text (old_text copied verbatim and occurring only once); use olens_set_field only to rewrite a whole field. Your edits go into a draft that the user reviews item by item before saving, so do not ask the user to confirm each step.',
    '[Editing principles] Fix the root cause: adjust responsibilities, criteria and output formats so the same kind of problem stops appearing in other scenes too; do not patch specific wording with "do not write X" rules. Keep existing macros, format constraints and the output structure other agents depend on (later agents quote earlier output). Make few, precise changes.',
    '[Language] Reply to the user in English, in short sentences; call agents by their display names and do not mention tool or field names. Keep prompts themselves in their original language (edit in English if they are in English).',
    'After tool calls the next round starts automatically; replying with text and no tool calls ends the turn.',
];

const DIAGNOSE = [
    '',
    '[This task: diagnosis] The user wants to know what went wrong in the run below.',
    '1. First find the symptoms from the run overview and the final reply; when you need details, read a step\'s full process with olens_read_step and the related agent\'s settings with olens_read_agent.',
    '2. Reply to the user: first one sentence with the conclusion (which step and which agent caused it), then the evidence point by point (quoting specific output), and finally the fix. If nothing is clearly wrong, say so.',
    '3. If changing settings can solve it, call the edit tools to put the fix into the draft; if it is about model ability, tool switches or the flow structure, explain why and suggest what the user can adjust.',
];

const STATS = [
    '',
    '[This task: stats diagnosis] The user has provided statistics of recent runs and wants to know why some agents are slow, why they fail, and how to fix it.',
    '1. First read the stats table and the evidence list and find the one or two problems most worth handling (the agents that take the most time, are the slowest or fail the most); do not spread your effort evenly. When you need details, read an evidence item (numbered like E3) with olens_read_step and an agent\'s settings with olens_read_agent.',
    '2. Separate the causes:',
    '   - Errors: read the original error text. API problems (API key, quota, 429 rate limits, timeouts, 5xx, context too long) should be described as connection or model problems; suggest another connection profile or less input, and do not edit prompts. Malformed tool calls, output in the wrong format and refusals are mostly prompt or model ability problems.',
    '   - Slowness: compare the fast and slow runs of the same agent. Common causes: too many rounds of tool calls, output too long, long repetitive prompts, too much thinking, a slow model, being sent back for redo by review.',
    '3. Reply to the user: first one sentence with the conclusion, then the evidence point by point (quoting stats figures and evidence numbers), and finally the fix.',
    '4. If settings can solve it, call the edit tools to put it into the draft: for example trim prompts, cap output length, limit tool-call counts, or move a slow agent to a faster connection profile (only names from the available list). If it is about tool switches or the flow structure, explain why and suggest adjusting it in the native panel.',
];

export function systemPrompt({ mode, profile, options = null, diagnose = false }) {
    const lines = [...BASE, ...(diagnose === 'stats' ? STATS : diagnose ? DIAGNOSE : [])].map(line => (line ? i18n(line) : ''));
    if (options?.connections?.length) lines.push('', i18nFormat('Available connection profiles: ${0} (leave empty to follow the default)', options.connections.join(listSeparator())));
    if (options?.presets?.length) lines.push(i18nFormat('Available generation presets: ${0} (leave empty to follow the default)', options.presets.slice(0, 60).join(listSeparator())));
    lines.push('', i18n('[Current profile]'), profileOverview(mode, profile));
    return lines.join('\n');
}

/**
 * First user message of a diagnosis session.
 * @param {{ view: object, steps: object[], reply?: string, focusStep?: number, complaint?: string }} input
 */
export function diagnoseMessage({ view, steps, reply = '', focusStep = 0, complaint = '' }) {
    const lines = [];
    lines.push(focusStep
        ? i18nFormat('Please diagnose whether step ${0} (${1}) of this run has a problem, and where.', focusStep, agentName(steps[focusStep - 1]?.agentId))
        : i18n('Please diagnose what went wrong in this orchestration run.'));
    lines.push(i18nFormat('User comment: ${0}', String(complaint || '').trim() || i18n('(none; decide yourself whether there is a problem)')));
    lines.push('', i18nFormat('Run overview: ${0}', `${modeInfo(view.mode).label} · ${statusLabel(view.status)} · ${formatDuration(view.duration)}${view.error ? ` · ${i18nFormat('Error: ${0}', clip(view.error, 300))}` : ''}`));
    lines.push(...steps.map(s => s.short));
    if (focusStep && steps[focusStep - 1]) lines.push('', i18n('Full process of the step to diagnose:'), clip(steps[focusStep - 1].full, 12000));
    if (view.finalText) lines.push('', i18nFormat('Final orchestration result (${0}):', view.mode === 'director' ? i18n('the reply text') : i18n('guidance injected for the main model')), clip(view.finalText, 5000));
    if (reply && view.mode !== 'director') lines.push('', i18n('Reply the main model wrote from it:'), clip(reply, 4000));
    return lines.join('\n');
}

/**
 * Evidence for a stats diagnosis: for the agents worth looking at, their
 * failed steps and their slowest / fastest step across the given runs.
 * @param {object} stats   agentStats() result
 * @param {object[]} views buildRunView() of the same runs
 * @param {{ focus?: string, maxAgents?: number }} [opts]  focus = one agent id
 * @returns {{ n, label, agentId, short, full }[]}  numbered E1, E2…
 */
export function statsEvidence(stats, views, { focus = '', maxAgents = 4 } = {}) {
    const pick = focus
        ? stats.agents.filter(a => a.agentId === focus)
        : [...stats.agents].sort((a, b) => (b.failed - a.failed) || (b.share - a.share)).filter((a, i) => a.failed || i < 2).slice(0, maxAgents);
    const out = [];
    for (const agent of pick) {
        const segs = [];
        views.forEach((view, ri) => (view?.segments || []).forEach((seg) => { if (seg.agentId === agent.agentId) segs.push({ seg, view, ri }); }));
        if (!segs.length) continue;
        const failed = segs.filter(x => x.seg.status === 'failed').slice(0, 3);
        const byTime = segs.filter(x => x.seg.status !== 'failed').sort((a, b) => b.seg.duration - a.seg.duration);
        const chosen = [...failed.map(x => ({ ...x, why: i18n('error run') })), byTime[0] && { ...byTime[0], why: i18n('slowest run') }, byTime.length > 2 && { ...byTime[byTime.length - 1], why: i18n('fastest run (for comparison)') }].filter(Boolean);
        for (const { seg, view, ri, why } of chosen) {
            const [step] = runSteps({ segments: [seg] });
            const n = out.length + 1;
            const when = view.startedAtWall ? new Date(view.startedAtWall).toLocaleString(dateLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : i18nFormat('Run ${0}', ri + 1);
            const head = `E${n}. ${named(agent.agentId)} · ${why} · ${when}`;
            out.push({ n, agentId: agent.agentId, label: why, short: `${head}\n   ${step.short.replace(/^1\. /, '')}`, full: `${head}\n${step.full.replace(/^1\. /, '')}` });
        }
    }
    return out;
}

/**
 * First user message of a stats diagnosis.
 * @param {{ stats: object, evidence: object[], mode: string, focus?: string, complaint?: string }} input
 */
export function statsMessage({ stats, evidence, mode, focus = '', complaint = '' }) {
    const pct = (x) => `${Math.round(x * 100)}%`;
    const lines = [focus
        ? i18nFormat('Using the statistics, diagnose why "${0}" (${1}) is slow or fails, and give a fix.', agentName(focus), focus)
        : i18n('Using the statistics below, find the slowest and most error-prone agents in this orchestration, diagnose why and give a fix.')];
    lines.push(i18nFormat('User comment: ${0}', String(complaint || '').trim() || i18n('(no comment)')));
    lines.push('', `${i18nFormat('Scope: the last ${0} "${1}" runs, ${2} on average each, ${3} failed', stats.runs, modeInfo(mode).label, formatDuration(stats.avgDuration), stats.failedRuns)}${stats.avgTokens ? i18nFormat(', ${0} tokens on average each (totals per run only)', Math.round(stats.avgTokens)) : ''}${i18n('stats scope end')}`);
    lines.push('', i18n('Each agent (average time / median / longest / appearances / errors / share of all agents\' working time):'));
    for (const a of stats.agents) {
        lines.push(`- ${named(a.agentId)}${i18nFormat(': ${0}', [formatDuration(a.avg), formatDuration(a.median), formatDuration(a.max), `${i18nFormat('${0} times', a.runs)}${a.steps > a.runs ? i18nFormat(' (${0} segments, including redos or multiple rounds)', a.steps) : ''}`, a.failed ? i18nFormat('${0} errors (${1})', a.failed, pct(a.failRate)) : i18n('no errors'), i18nFormat('time share ${0}', pct(a.share))].join(' / '))}${a.lastError ? `\n  ${i18nFormat('Latest error: ${0}', clip(a.lastError, 300))}` : ''}`);
    }
    if (evidence.length) {
        lines.push('', i18n('Evidence (use olens_read_step with the number to read the full process, e.g. step=3 for E3):'));
        lines.push(...evidence.map(e => e.short));
    }
    return lines.join('\n');
}

// ----- Conversation ----------------------------------------------------------

/** Messages for the LLM: system + replayable turns (tool calls with their results). */
export function buildTaskMessages(system, messages) {
    const out = [{ role: 'system', content: system }];
    for (const m of messages || []) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        if (m.role === 'assistant' && calls.length) {
            const msg = {
                role: 'assistant',
                content: String(m.content || ''),
                tool_calls: calls.map(tc => ({ id: String(tc.id), type: 'function', function: { name: String(tc.name), arguments: JSON.stringify(tc.args || {}) } })),
            };
            if (m.reasoning) msg.reasoning = m.reasoning;
            out.push(msg);
            const results = new Map((m.toolResults || []).map(r => [String(r.tool_call_id), r]));
            for (const tc of calls) {
                const r = results.get(String(tc.id));
                out.push({ role: 'tool', tool_call_id: String(tc.id), content: typeof r?.content === 'string' ? r.content : JSON.stringify(r?.content ?? { status: 'ok' }) });
            }
            continue;
        }
        out.push({ role: m.role, content: String(m.content || '') });
    }
    return out;
}

/**
 * One user turn: keeps calling the model while it calls tools.
 * @param {(args: { messages: object[], tools: object[], signal?: AbortSignal }) => Promise<{ assistantText: string, reasoning?: string, toolCalls: {id,name,args}[] }>} request
 * @param {{ messages: object[] }} session  mutated: assistant messages appended
 * @param {{ mode: string, profile: object, system: () => string, tools: object[], steps?: object[], options?: object, signal?: AbortSignal, onUpdate?: Function, maxRounds?: number }} ctx
 * @returns {Promise<{ profile: object, rounds: number }>}
 */
export async function runTurn(request, session, { mode, profile, system, tools, steps = [], options = null, signal = null, onUpdate = null, maxRounds = MAX_ROUNDS }) {
    let current = profile;
    let rounds = 0;
    while (rounds < maxRounds) {
        if (signal?.aborted) throw abortError();
        rounds++;
        const out = await request({ messages: buildTaskMessages(system(current), session.messages), tools, signal });
        const calls = Array.isArray(out?.toolCalls) ? out.toolCalls : [];
        const exec = executeTools(calls, { mode, profile: current, steps, options });
        current = exec.profile;
        const message = { id: makeId('msg'), role: 'assistant', content: String(out?.assistantText || '').trim(), at: Date.now() };
        if (out?.reasoning) message.reasoning = String(out.reasoning);
        if (exec.results.length) {
            message.toolCalls = exec.results.map(r => ({ id: r.id, name: r.name, args: r.args }));
            message.toolResults = exec.results.map(r => ({ tool_call_id: r.id, content: r.result, status: r.ok ? 'ok' : 'fail' }));
        }
        session.messages.push(message);
        session.at = Date.now();
        onUpdate?.(current, message);
        if (!calls.length) break;
    }
    return { profile: current, rounds };
}

export function abortError() {
    const err = new Error('aborted');
    err.name = 'AbortError';
    return err;
}

export function newSession(kind = 'chat') {
    return { id: makeId('sess'), kind, title: '', at: Date.now(), messages: [] };
}

export function sessionTitle(text) {
    const line = String(text || '').trim().split('\n')[0];
    return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

export function upsertSession(list, session) {
    const rest = (list || []).filter(s => s.id !== session.id);
    const next = session.messages.length ? [session, ...rest] : rest;
    return next.sort((a, b) => b.at - a.at).slice(0, MAX_SESSIONS);
}

/** Rewrites the edit results of the given messages (undone / not applied), so the AI knows next turn. */
export function markEdits(messages, ids, payload) {
    const set = new Set(ids);
    for (const m of messages) {
        if (!set.has(m.id) || !Array.isArray(m.toolResults)) continue;
        const editIds = new Set((m.toolCalls || []).filter(c => isEditTool(c.name)).map(c => String(c.id)));
        for (const r of m.toolResults) if (editIds.has(String(r.tool_call_id)) && r.status === 'ok') r.content = payload;
    }
}
