// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Display names on top of the orchestrator's i18n helpers. The orchestrator's
// internal ids (agent ids, tool names, statuses) are mapped to translated
// names here; unknown agent ids are the user's own names and are shown as-is.
// Pure: no DOM access.

import { i18n, i18nFormat } from '../i18n.js';

export { i18n, i18nFormat };

const STATUS = {
    running: 'Running',
    committed: 'Complete',
    completed: 'Complete',
    reused: 'Reused',
    done: 'Complete',
    error: 'Errored',
    failed: 'Errored',
    aborted: 'Stopped',
    cancelled: 'Canceled',
    budget_exhausted: 'Over budget',
};

const MODES = {
    spec: { label: 'Pipeline', hint: 'Fixed steps; each starts when the previous one is done' },
    single: { label: 'Single assistant', hint: 'One agent does it all at once; fastest and cheapest' },
    agenda: { label: 'Dispatch', hint: 'A dispatcher assigns work as things develop' },
    loop: { label: 'Research loop', hint: 'One agent keeps looking things up until it has enough' },
    director: { label: 'Director team', hint: 'A lead writer and a team write the reply directly' },
    search: { label: 'Online search', hint: 'Looks things up online before replying' },
};

// Shipped default agents (spec presets, agenda agents, director sub-agents).
// User-created ids fall through to the raw id, which is their own name.
const AGENTS = {
    distiller: { name: 'Scene distiller', role: 'Understands this turn: what the user wants, what the scene is, where the tension lies' },
    lorebook_reader: { name: 'Lorebook keeper', role: 'Picks the hard lorebook rules that must be followed this turn' },
    anti_data_guard: { name: 'Style guard', role: 'Blocks report-like, data-like and announcer-like writing' },
    planner: { name: 'Plot planner', role: 'Plans how the next beat moves forward and explains cause and effect' },
    recall_relevance: { name: 'Memory filter', role: 'Picks the recalled memories that are really useful this turn' },
    critic: { name: 'Reviewer', role: 'Checks the previous output item by item and sends back what fails by name' },
    synthesizer: { name: 'Summarizer', role: 'Combines the approved results into writing guidance for the main model' },
    finalizer: { name: 'Summarizer', role: 'Combines everyone\'s results into writing guidance for the main model' },
    single_agent: { name: 'Single assistant', role: 'Handles scene understanding, planning and risk notes in one go' },
    agenda_planner: { name: 'Dispatcher', role: 'Maintains the to-do list, dispatches agents and decides when to wrap up' },
    loop_agent: { name: 'Researcher', role: 'Checks the chat, lorebook and memory itself, then writes guidance when it has enough' },
    search_agent: { name: 'Search agent', role: 'Looks things up online before replying and writes what is useful into the lorebook' },
    main: { name: 'Lead writer', role: 'Coordinates everything, drafts the text, revises on feedback and finalizes' },
    intent_scout: { name: 'Intent scout', role: 'Finds what the user wants this turn and the writing requirements in the lorebook' },
    chat_scout: { name: 'Chat scout', role: 'Reads recent chat for unresolved emotional threads and setups to pay off' },
    memory_scout: { name: 'Memory scout', role: 'Finds facts related to this scene in the memory graph' },
    lorebook_scout: { name: 'Lorebook scout', role: 'Looks up lorebook settings related to this scene' },
    notes_pickup_scout: { name: 'Notes scout', role: 'Checks whether any plot notes should be paid off this turn' },
    canon_scout: { name: 'Canon scout', role: 'Checks source material to avoid conflicts with the setting' },
    epistemic_scout: { name: 'Knowledge boundaries', role: 'Verifies what each character knows and should not know' },
    plot_brainstormer: { name: 'Plot brainstormer', role: 'Offers several structural sketches for the lead writer to choose from' },
    voice_critic: { name: 'Voice reviewer', role: 'Catches lifeless description and cold, data-like writing' },
    continuity_critic: { name: 'Continuity reviewer', role: 'Finds hard conflicts with earlier text, memory and the lorebook' },
    notes_curator: { name: 'Notes curator', role: 'Updates plot notes (does nothing by default)' },
    memory_curator: { name: 'Memory curator', role: 'Writes lasting facts into the memory graph' },
};

const AGENT_GROUPS = {
    intent_scout: 'scout', chat_scout: 'scout', memory_scout: 'scout', lorebook_scout: 'scout',
    notes_pickup_scout: 'scout', canon_scout: 'scout', epistemic_scout: 'scout',
    plot_brainstormer: 'plan', voice_critic: 'critic', continuity_critic: 'critic',
    notes_curator: 'curator', memory_curator: 'curator',
};

const TOOLS = {
    chat_read_range: 'Read the chat',
    chat_search: 'Search the chat',
    draft_search: 'Search the draft',
    get_draft: 'Read the draft',
    world_book_list: 'List lorebooks',
    lorebook_list: 'List lorebook entries',
    lorebook_search: 'Search the lorebook',
    lorebook_get: 'Read lorebook entry',
    lorebook_force_activate: 'Force-activate lorebook entry',
    note_open: 'Open a note',
    note_close: 'Close a note',
    note_add: 'Write a note',
    write_message: 'Write the text',
    apply_message_patches: 'Revise the text',
    finalize: 'Wrap up',
    dispatch_subagent: 'Dispatch an agent',
    dispatch_inline_subagent: 'Dispatch a temporary agent',
    await_subagents: 'Wait for agents',
    cancel_subagent: 'Cancel an agent',
    skill_read: 'Read a skill',
    skill_list: 'List skills',
    chat_read: 'Read the chat',
    lorebook_world_book_list: 'List lorebooks',
    message_write: 'Write the text',
    message_patch: 'Revise the text',
    message_read: 'Read the text',
    message_get: 'Read the text',
    collab_dispatch: 'Dispatch an agent',
    collab_await: 'Wait for agents',
    collab_cancel: 'Cancel an agent',
    collab_inline: 'Dispatch a temporary agent',
    luker_orch_review_approve: 'Review passed',
    luker_orch_request_rerun: 'Send back for redo',
    luker_orch_planner_step: 'Dispatch decision',
    luker_orch_submit_result: 'Submit result',
};

const MEMORY_VERBS = {
    search: 'Search memory',
    get: 'Read memory',
    recall: 'Recall memory',
    list: 'List memory',
    write: 'Write memory',
    edit: 'Edit memory',
    upsert: 'Write memory',
};

const TOOL_GROUPS = {
    chat: 'Chat messages',
    lorebook: 'Lorebook',
    note: 'Notes',
    collab: 'Collaboration',
    message: 'Message text',
    custom: 'Extension',
    finalize: 'Wrap up',
};

const STAGE_NAMES = {
    distill: 'Distill',
    grounding: 'Set the rules',
    reason: 'Planning',
    review: 'Review step',
    finalize: 'Summarize',
    single: 'Single assistant',
    plan: 'Planning',
    final: 'Summarize',
};

function currentLocale() {
    return String(Luker.getContext().getCurrentLocale() || '');
}

export function isChineseLocale() {
    return currentLocale().toLowerCase().startsWith('zh');
}

export function listSeparator() {
    return isChineseLocale() ? '\u3001' : ', ';
}

/** Locale for toLocaleString; undefined falls back to the browser's. */
export function dateLocale() {
    return currentLocale() || undefined;
}

export const statusLabel = (status) => i18n(STATUS[status] || STATUS.done);

export function modeInfo(mode) {
    const info = MODES[mode] || MODES.spec;
    return { label: i18n(info.label), hint: i18n(info.hint) };
}

export const MODE_IDS = Object.keys(MODES).filter(id => id !== 'search');

/** Display name for an agent id. Unknown ids are user-defined names: keep them. */
export function agentName(id) {
    const key = String(id || '');
    return AGENTS[key]?.name ? i18n(AGENTS[key].name) : humanizeId(key);
}

export function agentRole(id) {
    const role = AGENTS[String(id || '')]?.role;
    return role ? i18n(role) : '';
}

export const agentGroup = (id) => AGENT_GROUPS[String(id || '')] || 'other';
export const isKnownAgent = (id) => Object.prototype.hasOwnProperty.call(AGENTS, String(id || ''));

export function toolName(name) {
    const key = String(name || '');
    if (TOOLS[key]) return i18n(TOOLS[key]);
    if (key.startsWith('memory_')) return i18n(MEMORY_VERBS[key.slice(7)] || 'Memory graph tool');
    if (key.startsWith('search_')) return i18n(key === 'search_visit' ? 'Open web page' : 'Online search');
    const group = key.split('_')[0];
    if (TOOL_GROUPS[group] && group !== key) return i18nFormat('${0} tool', i18n(TOOL_GROUPS[group]));
    if (key.startsWith('mg_')) return i18n('Memory graph tool');
    return humanizeId(key) || i18n('Tool');
}

export const toolGroupName = (group) => (TOOL_GROUPS[group] ? i18n(TOOL_GROUPS[group]) : humanizeId(group));

export function stageName(id) {
    const key = String(id || '');
    return STAGE_NAMES[key] ? i18n(STAGE_NAMES[key]) : humanizeId(key);
}

/** "lorebook_reader" -> "lorebook reader"; ids in other scripts stay untouched. */
export function humanizeId(id) {
    return String(id || '').replace(/[_-]+/g, ' ').trim();
}
