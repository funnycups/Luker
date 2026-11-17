// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workbench IterateTarget implementation owned by Orchestrator (`'orch'`).
// Provides full iter-studio parity across spec, loop, agenda, and director
// modes in both global and character scopes:
//   - per-mode field/profile tools + read_fields + simulate + read_run
//   - lorebook reads (both scopes) & lorebook-write proposals (character scope)
//   - skill-author proposals + policy-binding / extraction helpers
//   - custom-tool-author proposals + compile validation + dry-run
//   - character-scope reset controls (reset_to_blank / reset_to_global)
//   - unbounded tool-call execution driven by workbench/model/iterate.js

import { h, put } from '../../../lens-shared/util.js';
import {
    LOREBOOK_READ_TOOL_DEFS,
    isLorebookReadTool,
    runLorebookReadTool,
} from '../../../iteration-library/tools/lorebook-reads.js';
import {
    LOREBOOK_WRITE_TOOL_DEFS,
    isLorebookWriteTool,
    runLorebookWriteTool,
    applyLorebookProposal,
} from '../../../iteration-library/tools/lorebook-writes.js';
import {
    CHARACTER_PRESET_READ_TOOL_DEFS,
    isCharacterPresetReadTool,
    runCharacterPresetReadTool,
} from '../../../iteration-library/tools/character-presets-reads.js';
import {
    SKILL_ITER_STUDIO_TOOL_DEFS,
    isSkillIterStudioTool,
    runSkillIterStudioTool,
    commitApprovedSkillProposal,
} from '../../../iteration-library/tools/skill-iter-studio.js';
import { skillAuthor, lorebookWrite, customToolAuthor } from '../../../iteration-library/proposal-bus/index.js';
import { SourceError } from '../../../workbench/model/errors.js';
import {
    conflictsLeftAlone,
    fieldPlan,
    mergeOps,
    requireApplied,
    reverseOps,
    saveSettingsChecked,
} from '../../../workbench/model/patch.js';
import {
    CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES,
    isCustomToolIterStudioTool,
    executeCustomToolIterStudioCall,
    commitApprovedCustomToolProposal,
    resanitizeProfileCustomTools,
} from '../custom-tool-iter-studio.js';
import { augmentIterStudioPromptWithSkills } from '../skill-iter-studio-prompt.js';
import { buildSkillRuntimeContext } from '../skill-resolution.js';
import { dispatchReadFields } from '../iter-studio/read-fields-dispatcher.js';
import { interpretSandboxOutcome } from '../iter-studio/sandbox-result.js';
import { buildRunView, displayStatus } from './model/run.js';
import { i18n, i18nFormat, agentName, modeInfo } from './i18n.js';

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const defaultGetContext = () => globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;

const SUPPORTED_MODES = new Set(['spec', 'loop', 'agenda', 'director']);
const PROFILE_READ_TOOLS = new Set([
    'luker_orch_read_director_fields',
    'luker_orch_read_loop_fields',
    'luker_orch_read_agenda_fields',
    'luker_orch_read_spec_fields',
]);
const SKILL_READ_TOOLS = new Set([
    'skill_list_visible',
    'skill_inspect',
    'skill_read_content',
    'skill_search_content',
]);
const CUSTOM_TOOL_READ_TOOLS = new Set([
    CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.LIST,
    CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.GET,
    CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.DRY_RUN,
    CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.CTX_LIST_KEYS,
    CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.CTX_DESCRIBE,
    CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.DOCS_LIST,
    CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.DOCS_READ,
]);
const SIMULATE_TOOL_NAME = 'luker_orch_simulate';
const READ_RUN_TOOL_NAME = 'luker_orch_read_run';

const CONTROL_TOOL_NAMES = Object.freeze({
    resetToBlank: 'luker_orch_reset_live_to_blank',
    resetToGlobal: 'luker_orch_reset_live_to_global',
});
const CONTROL_TOOL_SET = new Set(Object.values(CONTROL_TOOL_NAMES));

const CONTROL_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: CONTROL_TOOL_NAMES.resetToBlank,
            description: 'Replace the working profile with a minimal blank shell for the current mode, discarding the global-profile copy seeded in. Use ONLY when the user wants to author a brand-new orchestration for this character from scratch.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Optional rationale visible to the user.' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CONTROL_TOOL_NAMES.resetToGlobal,
            description: 'Replace the working profile with a fresh clone of the current GLOBAL profile for this mode, discarding the existing character override.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Optional rationale visible to the user.' },
                },
                additionalProperties: false,
            },
        },
    },
];

const READ_RUN_TOOL_DEF = {
    type: 'function',
    function: {
        name: READ_RUN_TOOL_NAME,
        description: 'Read a recorded orchestration run from the Run Panel recorder (summary, lane timings, step sections, tool calls, errors, and final text). Omit run_key to read the latest orchestrator run.',
        parameters: {
            type: 'object',
            properties: {
                run_key: { type: 'string', description: 'Optional composite key like "orchestrator:run_1". Defaults to latest orchestrator run.' },
                step: { type: 'integer', description: 'Optional 1-based step number to return full details for that step.' },
            },
            additionalProperties: false,
        },
    },
};

const SKILL_OP_LABELS = Object.freeze({
    create: 'Create skill',
    content: 'Update skill file',
    frontmatter: 'Update skill frontmatter',
    rename: 'Rename skill',
    change_scope: 'Move skill scope',
    delete: 'Delete skill',
});

function resolveActiveAvatar(ctx) {
    if (!ctx || ctx.groupId) return '';
    return String(ctx.characters?.[ctx.characterId]?.avatar || '').trim();
}

function resolveMode(settings) {
    const raw = String(settings?.executionMode || 'spec').trim().toLowerCase();
    return SUPPORTED_MODES.has(raw) ? raw : 'spec';
}

function getCustomToolContainer(profile, mode) {
    if (mode === 'spec') {
        profile.spec ||= {};
        return profile.spec;
    }
    return profile;
}

function getCustomToolFlagBucket(profile, mode) {
    if (!profile || typeof profile !== 'object') return {};
    if (mode === 'agenda') {
        profile.defaultTools ||= {};
        profile.defaultTools.custom ||= {};
        return profile.defaultTools.custom;
    }
    if (mode === 'spec') {
        profile.spec ||= {};
        profile.spec.defaultTools ||= {};
        profile.spec.defaultTools.custom ||= {};
        return profile.spec.defaultTools.custom;
    }
    profile.tools ||= {};
    profile.tools.custom ||= {};
    return profile.tools.custom;
}

function formatJsonText(val) {
    if (val == null) return '';
    if (typeof val === 'string') return val;
    return JSON.stringify(val, null, 2);
}

function formatSpecStageText(stage) {
    const nodes = (Array.isArray(stage?.nodes) ? stage.nodes : []).map((n) => {
        if (typeof n === 'string') return n;
        const tpl = n?.userPromptTemplate ? ` · task=${n.userPromptTemplate}` : '';
        const tools = n?.tools ? ` · tools=${JSON.stringify(n.tools)}` : '';
        const skills = n?.skills ? ` · skills=${JSON.stringify(n.skills)}` : '';
        return `${n?.id || '?'} (preset=${n?.preset || n?.id || '?'}, type=${n?.type || 'worker'}${tpl}${tools}${skills})`;
    });
    return `mode: ${stage?.mode || 'serial'}\nnodes:\n${nodes.map(n => `  - ${n}`).join('\n')}`;
}

function formatPresetEntryText(entry) {
    return [
        `apiPresetName: ${String(entry?.apiPresetName || '')}`,
        `promptPresetName: ${String(entry?.promptPresetName || '')}`,
        `systemPrompt:\n${String(entry?.systemPrompt || '')}`,
        entry?.userPromptTemplate ? `userPromptTemplate:\n${String(entry.userPromptTemplate)}` : '',
        entry?.tools ? `tools: ${JSON.stringify(entry.tools)}` : '',
        entry?.skills ? `skills: ${JSON.stringify(entry.skills)}` : '',
    ].filter(Boolean).join('\n');
}

/**
 * Decomposes an orchestrator profile (any of the 4 studio modes) into
 * selectable Workbench change-list units.
 */
export function orchUnits(live, mode = 'spec') {
    const out = new Map();
    const p = live && typeof live === 'object' ? live : {};
    const m = SUPPORTED_MODES.has(mode) ? mode : 'spec';

    if (m === 'spec') {
        const stages = Array.isArray(p?.spec?.stages) ? p.spec.stages : [];
        out.set('spec:stages', {
            key: 'spec:stages',
            label: i18n('Workflow stages'),
            group: i18n('Pipeline'),
            text: stages.map(s => `[${s?.id || '?'}] ${formatSpecStageText(s)}`).join('\n\n'),
            raw: clone(stages),
            fields: { stages: clone(stages) },
        });
        out.set('spec:defaultTools', {
            key: 'spec:defaultTools',
            label: i18n('Default tools'),
            group: i18n('Pipeline'),
            text: formatJsonText(p?.spec?.defaultTools ?? null),
            raw: clone(p?.spec?.defaultTools ?? null),
            fields: { defaultTools: clone(p?.spec?.defaultTools ?? null) },
        });
        out.set('spec:lorebookFilter', {
            key: 'spec:lorebookFilter',
            label: i18n('Lorebook filter'),
            group: i18n('Pipeline'),
            text: formatJsonText(p?.spec?.lorebookFilter ?? { bookPattern: '', entryPattern: '' }),
            raw: clone(p?.spec?.lorebookFilter ?? { bookPattern: '', entryPattern: '' }),
            fields: { lorebookFilter: clone(p?.spec?.lorebookFilter ?? { bookPattern: '', entryPattern: '' }) },
        });
        out.set('spec:skills', {
            key: 'spec:skills',
            label: i18n('Skills'),
            group: i18n('Pipeline'),
            text: formatJsonText(p?.spec?.skills ?? { visible: ['*'], deny: [] }),
            raw: clone(p?.spec?.skills ?? { visible: ['*'], deny: [] }),
            fields: { skills: clone(p?.spec?.skills ?? { visible: ['*'], deny: [] }) },
        });
        const presets = p?.presets && typeof p.presets === 'object' ? p.presets : {};
        for (const [id, entry] of Object.entries(presets)) {
            out.set(`preset:${id}`, {
                key: `preset:${id}`,
                label: agentName(id),
                group: i18n('Agent presets'),
                text: formatPresetEntryText(entry),
                raw: clone(entry),
                fields: { [id]: clone(entry) },
            });
        }
        return out;
    }

    if (m === 'loop') {
        out.set('loop:prompt', {
            key: 'loop:prompt',
            label: i18n('Role prompt (system prompt)'),
            group: i18n('Researcher'),
            text: String(p.system_prompt || ''),
            raw: String(p.system_prompt || ''),
            fields: { system_prompt: String(p.system_prompt || '') },
        });
        out.set('loop:routing', {
            key: 'loop:routing',
            label: i18n('AI model'),
            group: i18n('Researcher'),
            text: `apiPresetName: ${String(p.apiPresetName || '')}\npromptPresetName: ${String(p.promptPresetName || '')}`,
            raw: { apiPresetName: String(p.apiPresetName || ''), promptPresetName: String(p.promptPresetName || '') },
            fields: { apiPresetName: String(p.apiPresetName || ''), promptPresetName: String(p.promptPresetName || '') },
        });
        out.set('loop:tools', {
            key: 'loop:tools',
            label: i18n('Agent tools'),
            group: i18n('Researcher'),
            text: formatJsonText(p.tools || {}),
            raw: clone(p.tools || {}),
            fields: { tools: clone(p.tools || {}) },
        });
        out.set('loop:limits', {
            key: 'loop:limits',
            label: i18n('Runtime limits'),
            group: i18n('Researcher'),
            text: `max_rounds: ${p.max_rounds ?? 0}\nwall_clock_budget_ms: ${p.wall_clock_budget_ms ?? 0}`,
            raw: { max_rounds: p.max_rounds, wall_clock_budget_ms: p.wall_clock_budget_ms },
            fields: { max_rounds: p.max_rounds, wall_clock_budget_ms: p.wall_clock_budget_ms },
        });
        out.set('loop:lorebookFilter', {
            key: 'loop:lorebookFilter',
            label: i18n('Lorebook filter'),
            group: i18n('Researcher'),
            text: formatJsonText(p.lorebookFilter ?? { bookPattern: '', entryPattern: '' }),
            raw: clone(p.lorebookFilter ?? { bookPattern: '', entryPattern: '' }),
            fields: { lorebookFilter: clone(p.lorebookFilter ?? { bookPattern: '', entryPattern: '' }) },
        });
        out.set('loop:skills', {
            key: 'loop:skills',
            label: i18n('Skills'),
            group: i18n('Researcher'),
            text: formatJsonText(p.skills ?? { visible: ['*'], deny: [] }),
            raw: clone(p.skills ?? { visible: ['*'], deny: [] }),
            fields: { skills: clone(p.skills ?? { visible: ['*'], deny: [] }) },
        });
        return out;
    }

    if (m === 'agenda') {
        out.set('agenda:planner', {
            key: 'agenda:planner',
            label: i18n('Planner'),
            group: i18n('Agents'),
            text: formatPresetEntryText(p.planner || {}),
            raw: clone(p.planner || {}),
            fields: { planner: clone(p.planner || {}) },
        });
        for (const [id, entry] of Object.entries(p.agents && typeof p.agents === 'object' ? p.agents : {})) {
            out.set(`agenda:agent:${id}`, {
                key: `agenda:agent:${id}`,
                label: agentName(id),
                group: i18n('Agents'),
                text: formatPresetEntryText(entry),
                raw: clone(entry),
                fields: { [id]: clone(entry) },
            });
        }
        const settingsFields = {
            finalAgentId: String(p.finalAgentId || ''),
            defaultTools: clone(p.defaultTools ?? null),
            limits: clone(p.limits || {}),
            lorebookFilter: clone(p.lorebookFilter ?? { bookPattern: '', entryPattern: '' }),
            skills: clone(p.skills ?? { visible: ['*'], deny: [] }),
        };
        out.set('agenda:settings', {
            key: 'agenda:settings',
            label: i18n('Runtime limits'),
            group: i18n('Settings'),
            text: formatJsonText(settingsFields),
            raw: clone(settingsFields),
            fields: settingsFields,
        });
        return out;
    }

    // director
    out.set('director:mainAgent', {
        key: 'director:mainAgent',
        label: i18n('Main agent'),
        group: i18n('Agents'),
        text: formatPresetEntryText(p.mainAgent || {}),
        raw: clone(p.mainAgent || {}),
        fields: { mainAgent: clone(p.mainAgent || {}) },
    });
    for (const sub of Array.isArray(p.subAgents) ? p.subAgents : []) {
        const id = String(sub?.id || '').trim();
        if (!id) continue;
        out.set(`director:subAgent:${id}`, {
            key: `director:subAgent:${id}`,
            label: agentName(id),
            group: i18n('Agents'),
            text: [
                `description: ${String(sub.description || '')}`,
                sub.maxRounds != null ? `maxRounds: ${sub.maxRounds}` : '',
                formatPresetEntryText(sub),
            ].filter(Boolean).join('\n'),
            raw: clone(sub),
            fields: { [id]: clone(sub) },
        });
    }
    const dirSettings = {
        tools: clone(p.tools ?? null),
        maxRounds: p.maxRounds,
        maxConcurrentSubagents: p.maxConcurrentSubagents,
        maxTotalSubagentRuns: p.maxTotalSubagentRuns,
        discardOnAbort: Boolean(p.discardOnAbort),
        lorebookFilter: clone(p.lorebookFilter ?? { bookPattern: '', entryPattern: '' }),
        skills: clone(p.skills ?? { visible: ['*'], deny: [] }),
    };
    out.set('director:settings', {
        key: 'director:settings',
        label: i18n('Runtime limits'),
        group: i18n('Settings'),
        text: formatJsonText(dirSettings),
        raw: clone(dirSettings),
        fields: dirSettings,
    });
    return out;
}

export function rebuildOrchProfile(base, ai, accepted = [], mode = 'spec') {
    const keys = new Set(Array.isArray(accepted) ? accepted : []);
    const next = clone(base || {});
    const src = ai && typeof ai === 'object' ? ai : {};
    const m = SUPPORTED_MODES.has(mode) ? mode : 'spec';

    if (m === 'spec') {
        next.spec ||= {};
        next.presets ||= {};
        if (keys.has('spec:stages')) next.spec.stages = clone(src.spec?.stages || []);
        if (keys.has('spec:defaultTools')) next.spec.defaultTools = clone(src.spec?.defaultTools ?? null);
        if (keys.has('spec:lorebookFilter')) next.spec.lorebookFilter = clone(src.spec?.lorebookFilter ?? { bookPattern: '', entryPattern: '' });
        if (keys.has('spec:skills')) next.spec.skills = clone(src.spec?.skills ?? { visible: ['*'], deny: [] });
        for (const k of keys) {
            if (!k.startsWith('preset:')) continue;
            const id = k.slice('preset:'.length);
            if (src.presets?.[id]) next.presets[id] = clone(src.presets[id]);
            else delete next.presets[id];
        }
        return next;
    }

    if (m === 'loop') {
        if (keys.has('loop:prompt')) next.system_prompt = String(src.system_prompt || '');
        if (keys.has('loop:routing')) {
            next.apiPresetName = String(src.apiPresetName || '');
            next.promptPresetName = String(src.promptPresetName || '');
        }
        if (keys.has('loop:tools')) next.tools = clone(src.tools || {});
        if (keys.has('loop:limits')) {
            next.max_rounds = src.max_rounds;
            next.wall_clock_budget_ms = src.wall_clock_budget_ms;
        }
        if (keys.has('loop:lorebookFilter')) next.lorebookFilter = clone(src.lorebookFilter);
        if (keys.has('loop:skills')) next.skills = clone(src.skills);
        return next;
    }

    if (m === 'agenda') {
        next.agents ||= {};
        if (keys.has('agenda:planner')) next.planner = clone(src.planner || {});
        for (const k of keys) {
            if (!k.startsWith('agenda:agent:')) continue;
            const id = k.slice('agenda:agent:'.length);
            if (src.agents?.[id]) next.agents[id] = clone(src.agents[id]);
            else delete next.agents[id];
        }
        if (keys.has('agenda:settings')) {
            next.finalAgentId = String(src.finalAgentId || '');
            next.defaultTools = clone(src.defaultTools ?? null);
            next.limits = clone(src.limits || {});
            next.lorebookFilter = clone(src.lorebookFilter);
            next.skills = clone(src.skills);
        }
        return next;
    }

    // director
    if (keys.has('director:mainAgent')) next.mainAgent = clone(src.mainAgent || {});
    const baseSubs = Array.isArray(next.subAgents) ? next.subAgents : [];
    const aiSubsById = new Map((Array.isArray(src.subAgents) ? src.subAgents : []).map(s => [String(s?.id || '').trim(), s]));
    const kept = [];
    const seen = new Set();
    for (const sub of baseSubs) {
        const id = String(sub?.id || '').trim();
        if (!id) continue;
        if (keys.has(`director:subAgent:${id}`)) {
            const rep = aiSubsById.get(id);
            if (rep) { kept.push(clone(rep)); seen.add(id); }
        } else {
            kept.push(clone(sub));
            seen.add(id);
        }
    }
    for (const [id, sub] of aiSubsById) {
        if (!seen.has(id) && keys.has(`director:subAgent:${id}`)) {
            kept.push(clone(sub));
        }
    }
    next.subAgents = kept;
    if (keys.has('director:settings')) {
        next.tools = clone(src.tools ?? null);
        next.maxRounds = src.maxRounds;
        next.maxConcurrentSubagents = src.maxConcurrentSubagents;
        next.maxTotalSubagentRuns = src.maxTotalSubagentRuns;
        next.discardOnAbort = Boolean(src.discardOnAbort);
        next.lorebookFilter = clone(src.lorebookFilter);
        next.skills = clone(src.skills);
    }
    return next;
}

function applyOrchOps(doc, ops, mode) {
    let current = clone(doc || {});
    const byKey = new Map();
    for (const op of ops) byKey.set(op.key, op);

    if (mode === 'spec') {
        current.spec ||= {};
        current.presets ||= {};
        for (const op of ops) {
            if (op.key === 'spec:stages') {
                const c = op.changes.find(x => x.field === 'stages');
                if (c) current.spec.stages = clone(c.after || []);
            } else if (op.key === 'spec:defaultTools') {
                const c = op.changes.find(x => x.field === 'defaultTools');
                if (c) current.spec.defaultTools = clone(c.after ?? null);
            } else if (op.key === 'spec:lorebookFilter') {
                const c = op.changes.find(x => x.field === 'lorebookFilter');
                if (c) current.spec.lorebookFilter = clone(c.after);
            } else if (op.key === 'spec:skills') {
                const c = op.changes.find(x => x.field === 'skills');
                if (c) current.spec.skills = clone(c.after);
            } else if (op.key.startsWith('preset:')) {
                const id = op.key.slice('preset:'.length);
                if (op.kind === 'remove') delete current.presets[id];
                else {
                    const c = op.changes.find(x => x.field === id);
                    if (c) current.presets[id] = clone(c.after);
                }
            }
        }
        return current;
    }

    if (mode === 'loop' || mode === 'agenda') {
        for (const op of ops) {
            if (mode === 'agenda' && op.key.startsWith('agenda:agent:')) {
                current.agents ||= {};
                const id = op.key.slice('agenda:agent:'.length);
                if (op.kind === 'remove') delete current.agents[id];
                else {
                    const c = op.changes.find(x => x.field === id);
                    if (c) current.agents[id] = clone(c.after);
                }
                continue;
            }
            for (const c of op.changes) {
                if (c.after === undefined) delete current[c.field];
                else current[c.field] = clone(c.after);
            }
        }
        return current;
    }

    // director
    current.subAgents = Array.isArray(current.subAgents) ? current.subAgents : [];
    for (const op of ops) {
        if (op.key.startsWith('director:subAgent:')) {
            const id = op.key.slice('director:subAgent:'.length);
            const idx = current.subAgents.findIndex(s => String(s?.id || '').trim() === id);
            if (op.kind === 'remove') {
                if (idx >= 0) current.subAgents.splice(idx, 1);
            } else {
                const c = op.changes.find(x => x.field === id);
                if (c) {
                    if (idx >= 0) current.subAgents[idx] = clone(c.after);
                    else current.subAgents.push(clone(c.after));
                }
            }
            continue;
        }
        for (const c of op.changes) {
            if (c.after === undefined) delete current[c.field];
            else current[c.field] = clone(c.after);
        }
    }
    return current;
}

function renderOrchPreview({ base, ai, target }) {
    const mode = SUPPORTED_MODES.has(target?.mode) ? target.mode : 'spec';
    const current = ai || base;
    if (!current || typeof current !== 'object') return null;

    const baseUnits = orchUnits(base, mode);
    const aiUnits = orchUnits(current, mode);
    const wrap = h('div', { class: 'wb-mg-preview' });

    const rowState = (key) => {
        const b = baseUnits.get(key);
        const a = aiUnits.get(key);
        if (!b && a) return 'is-add';
        if (b && !a) return 'is-del';
        if (b && a && b.text !== a.text) return 'is-change';
        return '';
    };

    if (mode === 'spec') {
        const stages = Array.isArray(current?.spec?.stages) ? current.spec.stages : [];
        const presets = current?.presets && typeof current.presets === 'object' ? current.presets : {};
        put(wrap,
            h('div', { class: 'wb-sec-title' }, h('span', { text: i18n('Pipeline') })),
            h('div', { class: 'wb-mg-preview-list' }, stages.length
                ? stages.map(s => h('div', { class: `wb-mg-preview-row ${rowState('spec:stages')}`.trim() },
                    h('span', { class: 'wb-mg-preview-label', text: `${s?.id || '?'} (${s?.mode || 'serial'})` }),
                    h('div', { class: 'wb-note', text: (s?.nodes || []).map(n => (typeof n === 'string' ? n : n?.id || '?')).join(', ') })))
                : h('div', { class: 'wb-note', text: i18n('No stages') })),
            h('div', { class: 'wb-sec-title' }, h('span', { text: i18n('Agent presets') })),
            h('div', { class: 'wb-mg-preview-list' }, Object.entries(presets).map(([id, pr]) =>
                h('div', { class: `wb-mg-preview-row ${rowState(`preset:${id}`)}`.trim() },
                    h('span', { class: 'wb-mg-preview-label', text: id }),
                    h('div', { class: 'wb-note', text: [pr?.promptPresetName, pr?.apiPresetName].filter(Boolean).join(' / ') || '—' })))));
        return wrap;
    }

    if (mode === 'loop') {
        put(wrap,
            h('div', { class: 'wb-sec-title' }, h('span', { text: i18n('Researcher') })),
            h('div', { class: 'wb-mg-preview-list' }, [
                ['loop:routing', i18n('AI model'), [current.promptPresetName, current.apiPresetName].filter(Boolean).join(' / ') || '—'],
                ['loop:limits', i18n('Runtime limits'), `${current.max_rounds ?? 0} · ${Math.round(Number(current.wall_clock_budget_ms || 0) / 1000)}s`],
                ['loop:prompt', i18n('Role prompt (system prompt)'), String(current.system_prompt || '').slice(0, 140)],
            ].map(([k, label, txt]) => h('div', { class: `wb-mg-preview-row ${rowState(k)}`.trim() },
                h('span', { class: 'wb-mg-preview-label', text: label }),
                h('div', { class: 'wb-note', text: txt })))));
        return wrap;
    }

    if (mode === 'agenda') {
        const agents = current?.agents && typeof current.agents === 'object' ? current.agents : {};
        put(wrap,
            h('div', { class: 'wb-sec-title' }, h('span', { text: i18n('Agents') })),
            h('div', { class: 'wb-mg-preview-list' },
                h('div', { class: `wb-mg-preview-row ${rowState('agenda:planner')}`.trim() },
                    h('span', { class: 'wb-mg-preview-label', text: i18n('Planner') })),
                Object.keys(agents).map(id => h('div', { class: `wb-mg-preview-row ${rowState(`agenda:agent:${id}`)}`.trim() },
                    h('span', { class: 'wb-mg-preview-label', text: id === current.finalAgentId ? `${id} (final)` : id })))));
        return wrap;
    }

    // director
    const subs = Array.isArray(current.subAgents) ? current.subAgents : [];
    put(wrap,
        h('div', { class: 'wb-sec-title' }, h('span', { text: i18n('Agents') })),
        h('div', { class: 'wb-mg-preview-list' },
            h('div', { class: `wb-mg-preview-row ${rowState('director:mainAgent')}`.trim() },
                h('span', { class: 'wb-mg-preview-label', text: i18n('Main agent') })),
            subs.map(sub => h('div', { class: `wb-mg-preview-row ${rowState(`director:subAgent:${sub?.id}`)}`.trim() },
                h('span', { class: 'wb-mg-preview-label', text: String(sub?.id || '?') }),
                sub?.description ? h('div', { class: 'wb-note', text: sub.description }) : null))));
    return wrap;
}

function appendScopeHint(basePrompt, { scope, hasOverride, characterDisplayName }) {
    if (scope !== 'character') return basePrompt;
    const display = String(characterDisplayName || '').trim() || 'this character';
    if (!hasOverride) {
        return [
            basePrompt,
            '',
            '# Iteration scope',
            `You are iterating on the character override for "${display}". This card has NO character override yet.`,
            '- Adjust the existing setup: working profile starts as a copy of GLOBAL.',
            `- Author from scratch: call \`${CONTROL_TOOL_NAMES.resetToBlank}\` once to start with a blank shell.`,
        ].join('\n');
    }
    return [
        basePrompt,
        '',
        '# Iteration scope',
        `You are iterating on the character override for "${display}". This card ALREADY has a character override.`,
        '- Continue adjusting the current override (default).',
        `- Author from scratch: call \`${CONTROL_TOOL_NAMES.resetToBlank}\` once.`,
        `- Match the global profile: call \`${CONTROL_TOOL_NAMES.resetToGlobal}\` once.`,
    ].join('\n');
}

export function createOrchIterateTarget(getCtx = defaultGetContext, deps = {}) {
    const resolveCtx = (explicitCtx = null) => explicitCtx || getCtx();
    const blankSeedKeys = new Set();
    const metaByRef = new WeakMap();

    const getOrchSettings = () => deps.getSettings?.() || resolveCtx()?.extensionSettings?.orchestrator || null;

    const reportError = (message) => {
        if (typeof deps.onError === 'function') {
            deps.onError(message);
        } else {
            globalThis.toastr?.error?.(message, i18n('Orchestration'));
        }
    };

    function inferModeFromLive(live, fallbackSettings = null) {
        if (live && typeof live === 'object') {
            if (live.spec && live.presets) return 'spec';
            if ('mainAgent' in live || 'subAgents' in live) return 'director';
            if ('planner' in live || ('agents' in live && 'finalAgentId' in live)) return 'agenda';
            if ('system_prompt' in live || live.mode === 'loop') return 'loop';
        }
        return resolveMode(fallbackSettings);
    }

    function resolveMeta(live, targetRef = null, { scope = null, ctx = null, settings = null } = {}) {
        if (targetRef && typeof targetRef === 'object' && (targetRef.mode || targetRef.scope)) {
            const m = SUPPORTED_MODES.has(targetRef.mode) ? targetRef.mode : inferModeFromLive(live, settings);
            const sc = targetRef.scope === 'character' ? 'character' : 'global';
            return {
                mode: m,
                scope: sc,
                avatar: String(targetRef.avatar || ''),
                presetId: String(targetRef.presetId || ''),
                presetName: String(targetRef.presetName || ''),
                hasOverride: Boolean(targetRef.hasOverride),
            };
        }
        if (targetRef && typeof targetRef === 'object' && metaByRef.has(targetRef)) {
            return metaByRef.get(targetRef);
        }
        if (live && typeof live === 'object' && metaByRef.has(live)) {
            return metaByRef.get(live);
        }
        const m = inferModeFromLive(live, settings);
        const sc = scope === 'character' ? 'character' : 'global';
        const av = sc === 'character' ? resolveActiveAvatar(ctx) : '';
        const hasOverride = sc === 'character' && av ? (deps.getRuntimePresetScope?.(ctx, av, m) === 'character') : false;
        const presetId = hasOverride
            ? String(deps.getCharacterActivePresetId?.(ctx, av, m) || '')
            : String(deps.getActivePresetId?.(settings, m, { scope: 'global' }) || '');
        return {
            mode: m,
            scope: sc,
            avatar: av,
            presetId,
            presetName: '',
            hasOverride,
        };
    }

    function sanitizeForMode(mode, profile) {
        if (mode === 'loop') return deps.sanitizeLoopProfile ? deps.sanitizeLoopProfile(profile) : clone(profile);
        if (mode === 'agenda') return deps.sanitizeAgendaWorkingProfile ? deps.sanitizeAgendaWorkingProfile(profile) : clone(profile);
        if (mode === 'director') return deps.sanitizeDirectorProfile ? deps.sanitizeDirectorProfile(profile) : clone(profile);
        return {
            spec: deps.sanitizeSpec ? deps.sanitizeSpec(profile?.spec) : clone(profile?.spec || { stages: [] }),
            presets: deps.sanitizePresetMap ? deps.sanitizePresetMap(profile?.presets) : clone(profile?.presets || {}),
        };
    }

    function createBlankProfileForMode(mode) {
        if (mode === 'director') return sanitizeForMode('director', {});
        if (mode === 'loop') return sanitizeForMode('loop', {});
        if (mode === 'agenda') return sanitizeForMode('agenda', {});
        return { spec: { stages: [], defaultTools: null, customTools: [], skills: { visible: ['*'], deny: [] }, lorebookFilter: { bookPattern: '', entryPattern: '' } }, presets: {} };
    }

    function readScopeProfile(ctx, settings, mode, scope, avatar) {
        const res = deps.getActivePreset?.(settings, mode, { scope, context: ctx, avatar });
        const raw = res?.ok && res?.state ? res.state : null;
        return sanitizeForMode(mode, raw || {});
    }

    const skillTargetHandler = {
        read: async (target) => ({ skill: target?.name || '', path: target?.path || '' }),
        write: async (target) => {
            if (target?._op) await commitApprovedSkillProposal(target._op);
        },
        describe: (target) => String(target?.name || 'skill'),
    };

    const lorebookTargetHandler = {
        read: async (target) => {
            const c = resolveCtx();
            const book = await c?.loadWorldInfo?.(target?.name || '');
            const uid = target?.uid;
            const entry = (uid != null && book?.entries) ? book.entries[uid] : null;
            return clone(entry || {});
        },
        write: async (target) => {
            const c = resolveCtx();
            if (target?._op) {
                await applyLorebookProposal(c, target._op);
            }
        },
        describe: (target) => `${target?.name || ''}#${target?.uid ?? ''}`,
    };

    const customToolTargetHandler = {
        read: async (target) => {
            const c = resolveCtx();
            const settings = getOrchSettings();
            const m = target?._mode || resolveMode(settings);
            const sc = target?._scope || 'global';
            const av = target?._avatar || resolveActiveAvatar(c);
            const useChar = sc === 'character' && deps.getRuntimePresetScope?.(c, av, m) === 'character';
            const prof = readScopeProfile(c, settings, m, useChar ? 'character' : 'global', av);
            const container = getCustomToolContainer(prof, m);
            const tools = Array.isArray(container?.customTools) ? container.customTools : [];
            return { name: target?.name || '', tool: tools.find(t => String(t?.name || '') === String(target?.name || '')) || null };
        },
        write: async (target) => {
            if (!target?._op) return;
            const c = resolveCtx();
            const settings = getOrchSettings();
            const m = target._mode || resolveMode(settings);
            const sc = target._scope || 'global';
            const av = target._avatar || resolveActiveAvatar(c);
            const useChar = sc === 'character' && deps.getRuntimePresetScope?.(c, av, m) === 'character';
            const prof = readScopeProfile(c, settings, m, useChar ? 'character' : 'global', av);
            const flagBucket = getCustomToolFlagBucket(prof, m);
            const container = getCustomToolContainer(prof, m);
            commitApprovedCustomToolProposal(container, flagBucket, target._op);
            resanitizeProfileCustomTools(container);
            await persistProfileToScope(c, settings, m, sc, av, prof);
        },
        describe: (target) => String(target?.name || 'custom-tool'),
    };

    async function persistProfileToScope(ctx, settings, mode, scope, avatar, profile) {
        const sanitized = sanitizeForMode(mode, profile);
        if (scope === 'character') {
            if (!avatar) throw new SourceError('no-character', i18n('No character selected.'));
            const idx = deps.getCharacterIndexByAvatar?.(ctx, avatar) ?? -1;
            if (idx < 0) throw new SourceError('no-character', i18n('No character selected.'));
            const ext = clone(deps.getCharacterExtensionDataByAvatar?.(ctx, avatar) || {});
            ext.presetLibraries ||= {};
            ext.presetLibraries[mode] ||= {};
            ext.activePresetIds ||= {};
            let id = String(ext.activePresetIds[mode] || '');
            if (!id || !ext.presetLibraries[mode][id]) {
                id = Object.keys(ext.presetLibraries[mode])[0] || 'default';
                ext.activePresetIds[mode] = id;
            }
            const existingName = ext.presetLibraries[mode][id]?.name || 'Default';
            const entry = deps.sanitizePresetEntry ? deps.sanitizePresetEntry(mode, { ...sanitized, name: existingName }) : { name: existingName, ...sanitized };
            ext.presetLibraries[mode][id] = entry;
            const ok = await deps.persistOrchestratorCharacterExtension?.(ctx, idx, ext);
            if (!ok) throw new SourceError('write-failed', i18n('Failed to persist character override.'));
            deps.initializeUiState?.(ctx);
            return;
        }
        const wr = deps.writeActivePreset?.(settings, mode, 'global', sanitized, { context: ctx });
        if (!wr?.ok) throw new SourceError('write-failed', wr?.hint || wr?.reason || i18n('Could not save the preset.'));
        await saveSettingsChecked(ctx);
        deps.initializeUiState?.(ctx);
    }

    const proposalKinds = {
        'skill-author': {
            ...skillAuthor,
            inverseAvailable: false,
            targetHandler: skillTargetHandler,
            label: (entry) => {
                const opKind = entry?.meta?.kind || entry?.meta?.op?.name;
                const name = String(entry?.meta?.skillName || entry?.target?.name || '').trim();
                const prefix = i18n(SKILL_OP_LABELS[opKind] || 'Create skill');
                return name ? `${prefix}: ${name}` : prefix;
            },
            group: () => i18n('Skills'),
        },
        'lorebook-write': {
            ...lorebookWrite,
            targetType: 'orch-lorebook',
            inverseAvailable: false,
            targetHandler: lorebookTargetHandler,
            label: (entry) => `${entry?.meta?.bookName || ''}#${entry?.meta?.uid ?? ''}`,
            group: () => i18n('Lorebook'),
        },
        'custom-tool-author': {
            ...customToolAuthor,
            inverseAvailable: false,
            targetHandler: customToolTargetHandler,
            label: (entry) => {
                const opKind = String(entry?.meta?.kind || 'upsert');
                const name = String(entry?.meta?.name || entry?.target?.name || '');
                return name ? `${i18n('Custom tools')}: ${name} (${opKind})` : i18n('Custom tools');
            },
            group: () => i18n('Custom tools'),
        },
    };

    return {
        id: 'orch',
        get label() { return i18n('Orchestration'); },
        tone: 'orch',
        order: 20,
        proposalKinds,
        isEnabled: (ctx) => Boolean(deps.getSettings?.() || resolveCtx(ctx)?.extensionSettings?.orchestrator),
        chips: () => [
            i18n('What was slow in the last run'),
            i18n('Can this agent\'s prompt be shorter'),
            i18n('Make the reviewer stricter'),
            i18n('Give the slowest agent a faster connection'),
        ],
        scopeNotes: {
            global: () => i18n('Edit the orchestration profile shared by all characters'),
            character: () => i18n('Edit only this character\'s own orchestration profile'),
        },
        async scopes(ctx) {
            const c = resolveCtx(ctx);
            return { global: true, character: Boolean(resolveActiveAvatar(c)) };
        },
        getNativeAi(ctx) {
            const s = deps.getSettings?.() || resolveCtx(ctx)?.extensionSettings?.orchestrator;
            if (!s) return null;
            return {
                connection: String(s.requestApiPresetName || '').trim(),
                preset: String(s.requestLlmPresetName || '').trim(),
            };
        },
        async promptInfo(ctx) {
            const s = deps.getSettings?.() || resolveCtx(ctx)?.extensionSettings?.orchestrator || {};
            const mode = resolveMode(s);
            const defaults = deps.ITERATION_MODE_PROMPT_DEFAULTS || {};
            const defaultBase = deps.getDefaultRequestSystemPrompt?.() || '';
            const modeKey = { spec: 'iterModePromptSpec', loop: 'iterModePromptLoop', director: 'iterModePromptDirector', agenda: 'iterModePromptAgenda' }[mode];
            const storedBase = String(s.requestSystemPrompt || '').trim();
            const storedMode = String(s[modeKey] || '').trim();
            const custom = (Boolean(storedBase) && storedBase !== defaultBase.trim())
                || (Boolean(storedMode) && storedMode !== String(defaults[mode] || '').trim());
            const text = [storedBase || defaultBase, storedMode || defaults[mode] || ''].filter(Boolean).join('\n\n');
            return {
                from: i18nFormat('Built into Luker · ${0}', i18n('AI Iteration Studio configuration')),
                custom,
                text,
            };
        },
        renderControls({ scope, onReload } = {}) {
            const c = resolveCtx();
            const settings = getOrchSettings();
            if (!settings) return null;
            const mode = resolveMode(settings);
            const avatar = resolveActiveAvatar(c);
            const items = [
                h('span', { class: 'wb-pill', text: modeInfo(mode).label }),
            ];
            if (scope === 'character' && avatar) {
                const hasOverride = deps.getRuntimePresetScope?.(c, avatar, mode) === 'character';
                const blankKey = `${mode}:${avatar}`;
                const isBlank = blankSeedKeys.has(blankKey);
                items.push(
                    h('button', {
                        type: 'button',
                        class: 'lw-btn is-ghost is-sm',
                        'aria-pressed': String(isBlank),
                        dataset: { wbOrchControl: 'reset-blank' },
                        onClick: async () => {
                            try {
                                if (blankSeedKeys.has(blankKey)) blankSeedKeys.delete(blankKey);
                                else blankSeedKeys.add(blankKey);
                                await onReload?.();
                            } catch (err) {
                                reportError(String(err?.message || err || i18n('Operation failed')));
                            }
                        },
                    }, i18n('Reset to blank')),
                    h('button', {
                        type: 'button',
                        class: 'lw-btn is-ghost is-sm',
                        disabled: !hasOverride && !isBlank,
                        dataset: { wbOrchControl: 'reset-global' },
                        onClick: async () => {
                            try {
                                blankSeedKeys.delete(blankKey);
                                if (hasOverride && typeof deps.clearCharacterExtensionForMode === 'function') {
                                    const idx = deps.getCharacterIndexByAvatar?.(c, avatar) ?? -1;
                                    const prev = deps.getCharacterExtensionDataByAvatar?.(c, avatar) || {};
                                    const nextExt = deps.clearCharacterExtensionForMode(prev, mode);
                                    const ok = await deps.persistOrchestratorCharacterExtension?.(c, idx, nextExt);
                                    if (!ok) throw new SourceError('write-failed', i18n('Failed to persist character override.'));
                                }
                                await onReload?.();
                            } catch (err) {
                                reportError(String(err?.message || err || i18n('Failed to persist character override.')));
                            }
                        },
                    }, i18n('Reset to global')),
                );
            }
            return h('div', { class: 'wb-preset-controls wb-orch-controls' }, items);
        },
        renderPreview: ({ base, ai, target }) => renderOrchPreview({ base, ai, target }),
        async load(scope, ctx) {
            const c = resolveCtx(ctx);
            const settings = getOrchSettings();
            if (!settings) throw new SourceError('no-extension', i18n('Orchestrator extension not detected. Make sure it is enabled.'));
            const mode = resolveMode(settings);
            const resolvedScope = scope === 'character' ? 'character' : 'global';

            if (resolvedScope === 'character') {
                const avatar = resolveActiveAvatar(c);
                if (!avatar) throw new SourceError('no-character', i18n('No character selected.'));
                const hasOverride = deps.getRuntimePresetScope?.(c, avatar, mode) === 'character';
                const blankKey = `${mode}:${avatar}`;
                const presetId = String((hasOverride ? deps.getCharacterActivePresetId?.(c, avatar, mode) : deps.getActivePresetId?.(settings, mode, { scope: 'global' })) || '');
                const live = blankSeedKeys.has(blankKey)
                    ? createBlankProfileForMode(mode)
                    : readScopeProfile(c, settings, mode, hasOverride ? 'character' : 'global', avatar);
                const charName = deps.getCharacterDisplayNameByAvatar?.(c, avatar) || avatar;
                const activeRes = deps.getActivePreset?.(settings, mode, { scope: hasOverride ? 'character' : 'global', context: c, avatar });
                const presetName = String(activeRes?.state?.name || presetId || '');
                const target = { mode, scope: 'character', avatar, presetId, presetName, hasOverride };
                const meta = { mode, scope: 'character', avatar, presetId, presetName, hasOverride };
                metaByRef.set(live, meta);
                metaByRef.set(target, meta);
                return {
                    live,
                    target,
                    title: `${charName} · ${modeInfo(mode).label}${hasOverride ? '' : ' (global copy)'}`,
                };
            }

            const presetId = String(deps.getActivePresetId?.(settings, mode, { scope: 'global' }) || '');
            const activeRes = deps.getActivePreset?.(settings, mode, { scope: 'global', context: c });
            const presetName = String(activeRes?.state?.name || presetId || '');
            const live = readScopeProfile(c, settings, mode, 'global', '');
            const target = { mode, scope: 'global', avatar: '', presetId, presetName, hasOverride: false };
            const meta = { mode, scope: 'global', avatar: '', presetId, presetName, hasOverride: false };
            metaByRef.set(live, meta);
            metaByRef.set(target, meta);
            return {
                live,
                target,
                title: `${i18n('Global')} · ${modeInfo(mode).label}${presetName ? ` "${presetName}"` : ''}`,
            };
        },
        async prompt(live, scope, ctx, extra = {}) {
            const c = resolveCtx(ctx);
            const settings = getOrchSettings() || {};
            const meta = resolveMeta(live, extra?.target, { scope, ctx: c, settings });
            const mode = meta.mode;
            const resolvedScope = meta.scope;
            const avatar = meta.avatar || (resolvedScope === 'character' ? resolveActiveAvatar(c) : '');
            const hasOverride = resolvedScope === 'character' ? meta.hasOverride : false;
            const helperSession = {
                mode,
                scope: resolvedScope,
                hasOverride,
                characterDisplayName: resolvedScope === 'character' && avatar ? (deps.getCharacterDisplayNameByAvatar?.(c, avatar) || avatar) : '',
                workingProfile: live,
            };
            const rawBase = deps.buildAiIterationSystemPrompt ? deps.buildAiIterationSystemPrompt(settings, helperSession) : '';
            const hinted = appendScopeHint(rawBase, {
                scope: resolvedScope,
                hasOverride,
                characterDisplayName: helperSession.characterDisplayName,
            });
            const orchPresetForRuntime = meta.presetId ? { mode, name: meta.presetId } : null;
            const defaultScope = orchPresetForRuntime ? { kind: 'orch-preset', mode, name: orchPresetForRuntime.name } : null;
            const skillRuntimeContext = buildSkillRuntimeContext(c, null, orchPresetForRuntime);
            return augmentIterStudioPromptWithSkills(hinted, live, skillRuntimeContext, { defaultScope });
        },
        async tools(live, scope, ctx, extra = {}) {
            const c = resolveCtx(ctx);
            const settings = getOrchSettings() || {};
            const meta = resolveMeta(live, extra?.target, { scope, ctx: c, settings });
            const mode = meta.mode;
            const resolvedScope = meta.scope;
            const hasOverride = resolvedScope === 'character' ? meta.hasOverride : false;

            const helperSession = { mode, scope: resolvedScope, hasOverride, workingProfile: live };
            const baseTools = (deps.buildAiIterationToolSet?.(helperSession) || []).filter(t => !CONTROL_TOOL_SET.has(t?.function?.name));
            const controlTools = resolvedScope === 'character'
                ? CONTROL_TOOL_DEFS.filter(t => t.function.name !== CONTROL_TOOL_NAMES.resetToGlobal || hasOverride)
                : [];
            const charTools = resolvedScope === 'character'
                ? [...LOREBOOK_WRITE_TOOL_DEFS]
                : [];
            return [
                ...baseTools,
                ...LOREBOOK_READ_TOOL_DEFS,
                ...CHARACTER_PRESET_READ_TOOL_DEFS,
                ...charTools,
                ...controlTools,
                ...SKILL_ITER_STUDIO_TOOL_DEFS,
                READ_RUN_TOOL_DEF,
            ];
        },
        isRead(name) {
            const n = String(name || '');
            return PROFILE_READ_TOOLS.has(n)
                || n === SIMULATE_TOOL_NAME
                || n === READ_RUN_TOOL_NAME
                || isLorebookReadTool(n)
                || isCharacterPresetReadTool(n)
                || SKILL_READ_TOOLS.has(n)
                || CUSTOM_TOOL_READ_TOOLS.has(n);
        },
        async runRead(call, live, helpers = {}) {
            const c = resolveCtx();
            const name = String(call?.name || '');
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            const callId = String(call?.id || `read_${Date.now().toString(36)}`);
            const meta = resolveMeta(live, helpers?.target, { ctx: c, settings: getOrchSettings() });
            const avatar = meta.scope === 'character' ? (meta.avatar || resolveActiveAvatar(c)) : '';

            if (PROFILE_READ_TOOLS.has(name)) {
                return dispatchReadFields({ sanitizedProfile: sanitizeForMode(meta.mode, live), args });
            }
            if (isLorebookReadTool(name)) {
                const out = await runLorebookReadTool({ id: callId, name, args }, { context: c, avatar });
                if (!out?.ok) throw new SourceError('read', String(out?.error || i18n('Read failed')));
                return out.result;
            }
            if (isCharacterPresetReadTool(name)) {
                const presetAvatar = meta.avatar || resolveActiveAvatar(c);
                const out = await runCharacterPresetReadTool({ id: callId, name, args }, { context: c, avatar: presetAvatar });
                if (!out?.ok) {
                    const err = new SourceError('read', String(out?.error || i18n('Read failed')));
                    err.envelope = out;
                    throw err;
                }
                return out.result;
            }
            if (SKILL_READ_TOOLS.has(name)) {
                const orchPreset = meta.presetId ? { mode: meta.mode, name: meta.presetId } : null;
                const defaultScope = orchPreset ? { kind: 'orch-preset', mode: orchPreset.mode, name: orchPreset.name } : undefined;
                const out = await runSkillIterStudioTool({ name, args }, { getWorkingProfile: () => live, defaultScope });
                if (!out?.ok) throw new SourceError('read', String(out?.error || i18n('Read failed')));
                return out.result;
            }
            if (CUSTOM_TOOL_READ_TOOLS.has(name)) {
                const toolProfile = meta.mode === 'spec' ? (live?.spec || {}) : live;
                const out = await executeCustomToolIterStudioCall({ name, args }, { profile: toolProfile });
                if (!out?.ok) {
                    const err = new SourceError('read', String(out?.hint || out?.error || i18n('Read failed')));
                    err.envelope = out;
                    throw err;
                }
                return out.result;
            }
            if (name === SIMULATE_TOOL_NAME) {
                const sandbox = clone(live);
                const fakeSession = { mode: meta.mode, scope: meta.scope, hasOverride: meta.hasOverride, workingProfile: sandbox };
                const execResult = await deps.executeAiIterationToolCalls?.(c, fakeSession, [{ id: callId, name, args }], null);
                const match = (execResult?.toolResults || []).find(r => String(r?.tool_call_id || '') === callId) || execResult?.toolResults?.[0];
                let parsed = match?.content;
                try { if (typeof parsed === 'string') parsed = JSON.parse(parsed); } catch { /* keep string */ }
                if (!parsed || parsed.ok === false) {
                    const err = new SourceError('simulate', String(parsed?.hint || parsed?.error || 'Simulation failed'));
                    err.envelope = parsed;
                    throw err;
                }
                return parsed;
            }
            if (name === READ_RUN_TOOL_NAME) {
                const rec = c?.runPanel?.getRunRecorder?.();
                const all = [...(rec?.currents?.() || []), ...(rec?.history?.() || [])].filter(r => r && (r.source || 'orchestrator') === 'orchestrator');
                const key = String(args.run_key || '').trim();
                const raw = key
                    ? all.find(r => `${r.source || 'orchestrator'}:${r.runId}` === key || r.runId === key)
                    : all.find(r => !r.quiet) || all[0];
                if (!raw) return { error: 'No recorded orchestrator run found.' };
                const view = buildRunView(raw, []);
                const stepNum = Number(args.step) || 0;
                if (stepNum > 0) {
                    const seg = view.segments?.[stepNum - 1];
                    if (!seg) return { error: `Step ${stepNum} not found (${view.segments.length} steps total).` };
                    return {
                        runId: view.runId,
                        step: stepNum,
                        agentId: seg.agentId,
                        status: seg.status,
                        duration: seg.duration,
                        sections: seg.sections,
                    };
                }
                return {
                    runId: view.runId,
                    mode: view.mode,
                    status: displayStatus(raw.status, raw.error),
                    duration: view.duration,
                    tokens: view.tokens,
                    error: view.error,
                    finalText: view.finalText,
                    steps: view.segments.map((seg, i) => ({
                        step: i + 1,
                        agentId: seg.agentId,
                        status: seg.status,
                        duration: seg.duration,
                        sectionCount: seg.sections.length,
                    })),
                };
            }
            throw new SourceError('unknown_tool', `Unknown read tool: ${name}`);
        },
        async runEdit(call, live, helpers = {}) {
            const c = resolveCtx();
            const settings = getOrchSettings() || {};
            const name = String(call?.name || '');
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            const callId = String(call?.id || `edit_${Date.now().toString(36)}`);
            const meta = resolveMeta(live, helpers?.target, { ctx: c, settings });
            const avatar = meta.scope === 'character' ? (meta.avatar || resolveActiveAvatar(c)) : '';

            const tagNext = (next) => {
                if (next && typeof next === 'object' && next !== live) {
                    metaByRef.set(next, meta);
                }
                return next;
            };

            if (CONTROL_TOOL_SET.has(name)) {
                if (meta.scope !== 'character') {
                    throw new SourceError('not_allowed', `${name}: not_allowed — resets are only available in character scope.`);
                }
                if (name === CONTROL_TOOL_NAMES.resetToBlank) {
                    if (meta.hasOverride) {
                        throw new SourceError('not_allowed', `${name}: not_allowed — Reset rejected: this card already has an override. Use reset_to_global instead.`);
                    }
                    return tagNext(createBlankProfileForMode(meta.mode));
                }
                if (name === CONTROL_TOOL_NAMES.resetToGlobal) {
                    if (!meta.hasOverride) {
                        throw new SourceError('not_allowed', `${name}: not_allowed — Reset rejected: this card has no character override yet. Use reset_to_blank instead.`);
                    }
                    return tagNext(readScopeProfile(c, settings, meta.mode, 'global', ''));
                }
            }

            if (isLorebookWriteTool(name)) {
                const out = await runLorebookWriteTool({ id: callId, name, args }, { context: c });
                if (!out?.ok) {
                    const err = new SourceError('lorebook', String(out?.hint || out?.error || 'Lorebook write failed'));
                    err.envelope = out;
                    throw err;
                }
                if (out.result?.before && out.result?.after) {
                    const op = { kind: out.result.kind, args };
                    await helpers.propose?.({
                        kind: 'lorebook-write',
                        target: { type: 'orch-lorebook', name: out.result.book_name, uid: out.result.uid, _op: op },
                        before: out.result.before,
                        after: out.result.after,
                        meta: { op, bookName: out.result.book_name, uid: out.result.uid, before: out.result.before, after: out.result.after },
                    });
                }
                return live;
            }

            if (isSkillIterStudioTool(name)) {
                const orchPreset = meta.presetId ? { mode: meta.mode, name: meta.presetId } : null;
                const defaultScope = orchPreset ? { kind: 'orch-preset', mode: orchPreset.mode, name: orchPreset.name } : undefined;
                const out = await runSkillIterStudioTool({ name, args }, { getWorkingProfile: () => live, defaultScope });
                if (!out?.ok) throw new SourceError('skill', String(out?.error || 'Skill tool failed'));
                if (out.pendingSkillEdit) {
                    const pse = out.pendingSkillEdit;
                    const stable = { skillName: pse.skillName || '', scope: pse.scope || null, path: pse.path || '' };
                    await helpers.propose?.({
                        kind: 'skill-author',
                        target: { type: 'skill-registry', name: stable.skillName, path: stable.path, _op: pse.op },
                        before: stable,
                        after: stable,
                        meta: { op: pse.op, skillName: pse.skillName, scope: pse.scope, path: pse.path, before: pse.before, after: pse.after, extras: pse.extras || null },
                    });
                    return live;
                }
                if (out.pendingEdit) {
                    return tagNext(out.pendingEdit.newValue);
                }
                return live;
            }

            if (isCustomToolIterStudioTool(name)) {
                const toolProfile = meta.mode === 'spec' ? (live?.spec || {}) : live;
                const out = await executeCustomToolIterStudioCall({ name, args }, { profile: toolProfile });
                if (!out?.ok) {
                    const err = new SourceError('custom-tool', String(out?.hint || out?.error || 'Custom tool failed'));
                    err.envelope = out;
                    throw err;
                }
                if (out.pendingCustomToolEdit) {
                    const blob = out.pendingCustomToolEdit;
                    const stable = { name: String(blob.name || ''), kind: String(blob.kind || '') };
                    await helpers.propose?.({
                        kind: 'custom-tool-author',
                        target: {
                            type: 'orch-custom-tool',
                            name: stable.name,
                            _op: blob.op,
                            _mode: meta.mode,
                            _scope: meta.scope,
                            _avatar: avatar,
                        },
                        before: stable,
                        after: stable,
                        meta: { op: blob.op, kind: blob.kind, name: blob.name, before: blob.before, after: blob.after },
                    });
                }
                return live;
            }

            const sandbox = clone(live);
            const fakeSession = { mode: meta.mode, scope: meta.scope, hasOverride: meta.hasOverride, workingProfile: sandbox };
            const executorResult = await deps.executeAiIterationToolCalls?.(c, fakeSession, [{ id: callId, name, args }], null);
            const after = fakeSession.workingProfile != null ? fakeSession.workingProfile : sandbox;
            const outcome = interpretSandboxOutcome({ before: live, after, executorResult });
            if (outcome.kind === 'failure') {
                const envelope = outcome.content || outcome.envelope || null;
                const err = new SourceError('edit-failed', String(envelope?.detail || envelope?.error || outcome.actionText || 'Edit failed'));
                if (envelope) err.envelope = envelope;
                throw err;
            }
            if (outcome.kind === 'edits') return tagNext(after);
            return live;
        },
        units: (live, targetRef = null) => orchUnits(live, resolveMeta(live, targetRef, { settings: getOrchSettings() }).mode),
        rebuild: (base, ai, keys, targetRef = null) => rebuildOrchProfile(base, ai, keys, resolveMeta(base, targetRef, { settings: getOrchSettings() }).mode),
        async commit(targetRef, base, next, keys) {
            const c = resolveCtx();
            const settings = getOrchSettings();
            if (!settings) throw new SourceError('no-extension', i18n('Orchestrator extension not detected. Make sure it is enabled.'));
            const meta = resolveMeta(base, targetRef, { settings });
            const m = targetRef?.mode || meta.mode;
            const sc = targetRef?.scope === 'character' ? 'character' : 'global';
            const expectedAvatar = String(targetRef?.avatar || '').trim();

            const checkAvatar = () => {
                if (sc !== 'character') return '';
                const liveAvatar = resolveActiveAvatar(c);
                if (!expectedAvatar || liveAvatar !== expectedAvatar) {
                    throw new SourceError('character-changed', i18n('The active character has changed.'));
                }
                return expectedAvatar;
            };

            const avatar = checkAvatar();
            if (sc === 'character' && typeof deps.promptEmbedUnembeddedPresetsForCharacterApply === 'function') {
                const activeCharacter = c?.characters?.find(ch => ch?.avatar === avatar) || null;
                const preflight = await deps.promptEmbedUnembeddedPresetsForCharacterApply({
                    context: c,
                    activeCharacter,
                    profile: { ...next, mode: m },
                    i18n,
                    i18nFormat,
                    notifyError: (msg) => { throw new SourceError('embed-failed', String(msg)); },
                    escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch])),
                });
                if (!preflight.proceed) {
                    throw new SourceError('cancelled', i18n('Cancel'));
                }
            }

            const readDisk = (av) => {
                const useChar = sc === 'character' && deps.getRuntimePresetScope?.(c, av, m) === 'character';
                return readScopeProfile(c, settings, m, useChar ? 'character' : 'global', av);
            };

            const beforeDisk = readDisk(avatar);
            const ops = fieldPlan(orchUnits(base, m), orchUnits(next, m), keys);
            const merged = mergeOps(orchUnits(beforeDisk, m), ops);
            const applied = [...merged.write, ...merged.already].map(op => op.key);
            requireApplied({ applied, skipped: merged.skipped });

            if (merged.write.length) {
                const mergedDoc = applyOrchOps(beforeDisk, merged.write, m);
                await persistProfileToScope(c, settings, m, sc, avatar, mergedDoc);
            }
            if (sc === 'character') blankSeedKeys.delete(`${m}:${avatar}`);

            return {
                applied,
                skipped: merged.skipped,
                failure: '',
                async undo() {
                    if (!merged.write.length) return;
                    const undoAvatar = checkAvatar();
                    const nowDisk = readDisk(undoAvatar);
                    const back = mergeOps(orchUnits(nowDisk, m), reverseOps(merged.write));
                    if (back.write.length) {
                        const revertedDoc = applyOrchOps(nowDisk, back.write, m);
                        await persistProfileToScope(c, settings, m, sc, undoAvatar, revertedDoc);
                    }
                    if (back.skipped.length) throw conflictsLeftAlone(back.skipped.length);
                },
            };
        },
    };
}
