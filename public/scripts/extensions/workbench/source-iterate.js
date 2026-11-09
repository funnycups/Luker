// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Luker halves of the four AI iteration adapters. Each adapter:
//   scopes(ctx)            which scopes exist right now (global / character)
//   load(scope)            → { live, target, title }   fresh working copy
//   prompt(live, scope)    the workbench's own system prompt (Luker's, untouched)
//   tools(live)            OpenAI tool defs (Luker's own where exported)
//   isRead(name)
//   runRead(call, live)    → result
//   runEdit(call, live)    → next live
//   units(live)            → Map of units for the change list (model/adapters.js)
//   rebuild(base, ai, keys) → live with accepted keys applied
//   commit(target, base, next, keys) → { undo() } writes to Luker
// `ext` names the Luker extension an adapter depends on; while the user has it
// disabled the adapter reports itself unavailable and none of its modules load.

import { i18n, i18nFormat, listSeparator } from './i18n.js';
import { LEGACY_SCHEMA_ITER_SYSTEM_PROMPT } from '../memory-graph/config-iteration/prompt-migration.js';
import { CONTROL_TOOL_NAMES, buildToolCatalog as buildMemoryToolCatalog, normalizeToolCallToEdit as normalizeMemoryToolCall, projectNodeTypeForRead } from '../memory-graph/config-iteration/tools.js';
import { readFieldsByPaths } from '../../iteration-library/read-fields-helper.js';
import { getContext, currentCharacter, boundBooks, SourceError } from './source-luker.js';
import { ceaHelperSource, commitCardAndBooks, orchCharacterRecord, writeCharacterProfile } from './model/commit.js';
import { memoryUnits, memoryRebuild, orchUnits, orchRebuild, presetUnits, presetRebuild, cardUnits, cardRebuild, cardEditsFor, worldUnits, worldRebuild } from './model/adapters.js';
import { listAgents, agentFields, getField, setField, replaceInField, validateField, fieldLabel, EditError } from '../orchestrator/lens/model/edit.js';

const memoryMain = () => import('../memory-graph/main.js');
const orchDefaults = () => import('../orchestrator/defaults.js');
const orchEditorState = () => import('../orchestrator/editor-state.js');
const cpaTools = () => import('../completion-preset-assistant/cpa-iteration/tools.js');
const cpaPrompts = () => import('../completion-preset-assistant/cpa-iteration/system-prompts.js');
const ceaMain = () => import('../character-editor-assistant/main.js');
const ceaTools = () => import('../character-editor-assistant/editor-iteration/tools.js');
const ceaStudio = () => import('../character-editor-assistant/editor-iteration/studio.js');

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const fnName = (t) => t?.function?.name;

function applyEditsTo(edits, live) {
    const res = getContext().iterationLibrary.applyEdits(edits, clone(live));
    if (res?.conflicts?.length) {
        const c = res.conflicts[0];
        throw new SourceError('conflict', i18nFormat('Not changed (${0}): ${1}. Read the latest content first.', c.reason, c.edit?.path || ''));
    }
    return res.newLive;
}

// ---------------------------------------------------------------------------
// memory graph: node-type schema
// ---------------------------------------------------------------------------

const MG_READ = {
    type: 'function',
    function: {
        name: 'mg_schema_read_fields',
        description: 'Read exact values from the current live MG node-type schema by lodash-style paths. Read-only. Root is the schema array; e.g. "[N].id", "[N].tableColumns", "[N].columnHints", "[N].extractionInstructions", "length".',
        parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'], additionalProperties: false },
    },
};

const memory = {
    name: i18n('Memory graph'),
    ext: 'memory-graph',
    async scopes(ctx) {
        const c = currentCharacter(ctx);
        return { global: true, character: Boolean(c) };
    },
    async load(scope) {
        const ctx = getContext();
        const mg = ctx.getExtensionApi('memory-graph');
        const main = await memoryMain();
        const settings = main.getSettings();
        const info = mg.getSchemaScopeInfo(ctx, settings);
        let schema;
        if (scope === 'character') {
            if (!info?.hasAvatar) throw new SourceError('no-character', i18n('No character card selected'));
            schema = info.hasOverride ? info.schema : settings.nodeTypeSchema;
        } else {
            schema = settings.nodeTypeSchema;
        }
        const live = clone(main.normalizeNodeTypeSchema(schema));
        return { live, target: { scope, avatar: info?.avatar || '', hadOverride: Boolean(info?.hasOverride) }, title: scope === 'character' ? i18nFormat('Memory structure for "${0}" only${1}', info.characterName, info.hasOverride ? '' : i18n(' (none yet; created on save)')) : i18n('Memory structure shared by all characters') };
    },
    async prompt() {
        // The configuration workbench prompt documents settings tools this
        // workbench does not offer, so the schema-only prompt stays in use.
        const main = await memoryMain();
        return String(main.getSettings()?.schemaIterSystemPrompt || '').trim() || LEGACY_SCHEMA_ITER_SYSTEM_PROMPT;
    },
    async tools() {
        const control = new Set(Object.values(CONTROL_TOOL_NAMES));
        return [...buildMemoryToolCatalog().filter(d => String(fnName(d)).startsWith('mg_schema_') && !control.has(fnName(d))), MG_READ];
    },
    isRead: (name) => name === 'mg_schema_read_fields',
    async runRead(call, live) {
        return readFieldsByPaths(live.map(projectNodeTypeForRead), call.args?.paths);
    },
    async runEdit(call, live) {
        const main = await memoryMain();
        const edits = await normalizeMemoryToolCall({ function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }, { live: { schema: live, settings: {} }, normalizeNodeTypeSchema: main.normalizeNodeTypeSchema });
        return edits?.length ? edits[edits.length - 1].newValue.schema : live;
    },
    units: (live) => memoryUnits(live),
    rebuild: (base, ai, keys) => memoryRebuild(base, ai, keys),
    async commit(target, base, next) {
        const ctx = getContext();
        const mg = ctx.getExtensionApi('memory-graph');
        const main = await memoryMain();
        const settings = main.getSettings();
        const normalized = main.normalizeNodeTypeSchema(next);
        if (target.scope === 'character') {
            const before = mg.getSchemaScopeInfo(ctx, settings);
            const ok = await mg.persistCharacterSchemaOverride(ctx, target.avatar, normalized);
            if (!ok) throw new SourceError('write-failed', i18n('Failed to write to the character card'));
            return {
                async undo() {
                    if (before.hasOverride) await mg.persistCharacterSchemaOverride(ctx, target.avatar, before.schema);
                    else await mg.removeCharacterSchemaOverride(ctx, target.avatar);
                },
            };
        }
        const previous = clone(settings.nodeTypeSchema);
        settings.nodeTypeSchema = normalized;
        await ctx.saveSettings();
        return { async undo() { settings.nodeTypeSchema = previous; await ctx.saveSettings(); } };
    },
};

// ---------------------------------------------------------------------------
// orchestration: per-agent settings (the native iteration tools are not exported, so four own tools)
// ---------------------------------------------------------------------------

const AGENT_NAMES = {
    distiller: i18n('Scene distiller'), lorebook_reader: i18n('Lorebook keeper'), anti_data_guard: i18n('Style guard'), planner: i18n('Plot planner'), recall_relevance: i18n('Memory filter'),
    critic: i18n('Reviewer'), synthesizer: i18n('Summarizer'), finalizer: i18n('Summarizer'), single_agent: i18n('Single assistant'), agenda_planner: i18n('Dispatcher'), loop_agent: i18n('Researcher'), main: i18n('Lead writer'),
    intent_scout: i18n('Intent scout'), chat_scout: i18n('Chat scout'), memory_scout: i18n('Memory scout'), lorebook_scout: i18n('Lorebook scout'), plot_brainstormer: i18n('Plot brainstormer'),
    voice_critic: i18n('Voice reviewer'), continuity_critic: i18n('Continuity reviewer'), notes_curator: i18n('Notes curator'), memory_curator: i18n('Memory curator'),
};
export const agentName = (id) => AGENT_NAMES[id] || id;

const fn = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const AGENT = { type: 'string', description: 'Agent id exactly as listed in the overview.' };
const FIELD = { type: 'string', enum: ['description', 'system', 'task', 'api', 'preset'], description: 'system = role prompt, task = task template, description = director sub-agent description, api = connection profile name, preset = generation preset name.' };
const ORCH_TOOLS = [
    fn('wb_orch_overview', 'List agents and which fields each one has, with short previews.', {}, []),
    fn('wb_orch_read_agent', 'Read the full current text of every editable field of one agent.', { agent_id: AGENT }, ['agent_id']),
    fn('wb_orch_replace_text', 'Replace one exact passage inside a text field. old_text must be copied verbatim and occur exactly once.', { agent_id: AGENT, field: FIELD, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['agent_id', 'field', 'old_text', 'new_text']),
    fn('wb_orch_set_field', 'Replace the whole value of a field. Prefer wb_orch_replace_text for long prompts.', { agent_id: AGENT, field: FIELD, value: { type: 'string' } }, ['agent_id', 'field', 'value']),
];
// The orchestrator's own iteration tools are not exported, so only its
// mode-agnostic base prompt (settings.requestSystemPrompt or the default) is
// reused; the mode blocks name luker_orch_* tools we do not offer.
const ORCH_TOOL_NOTE = [
    '## Tools available in this session (they replace the luker_orch_* tools)',
    '- You can edit, per agent: system (role prompt), task (task template, keep macros like {{recent_chat}}), description (director sub-agent description), api (connection profile name), preset (chat completion preset name). Adding / removing agents, stages or tool switches is not possible here — tell the user to use the native orchestrator panel for that.',
    '- Read first with wb_orch_overview / wb_orch_read_agent, then patch with wb_orch_replace_text (old_text verbatim, occurring once); use wb_orch_set_field only for a full rewrite. Keep macros, output formats and the structure later agents depend on.',
].join('\n');

async function orchBasePrompt() {
    const s = getContext().extensionSettings?.orchestrator || {};
    const custom = String(s.requestSystemPrompt || '').trim();
    if (custom) return { text: custom, custom: true };
    const defaults = await orchDefaults();
    return { text: String(defaults.getDefaultRequestSystemPrompt() || ''), custom: false };
}

function resolveOrch(ctx, scope) {
    const settings = ctx.extensionSettings?.orchestrator;
    if (!settings) throw new SourceError('no-extension', i18n('Orchestrator not found'));
    const mode = ['spec', 'agenda', 'loop', 'director', 'single'].includes(String(settings.executionMode)) ? String(settings.executionMode) : 'spec';
    if (mode === 'single') {
        if (scope === 'character') throw new SourceError('scope', i18n('Single-assistant mode has no per-character profile; only global can be edited'));
        return { settings, mode, presetId: '', profile: { spec: { stages: [{ id: 'single', mode: 'serial', nodes: ['single_agent'] }] }, presets: { single_agent: { systemPrompt: settings.singleAgentSystemPrompt, userPromptTemplate: settings.singleAgentUserPromptTemplate } } }, name: i18n('Single assistant') };
    }
    if (scope === 'character') {
        const c = currentCharacter(ctx);
        if (!c) throw new SourceError('no-character', i18n('No character card selected'));
        const ext = ctx.characters[c.index]?.data?.extensions?.orchestrator;
        const id = String(ext?.activePresetIds?.[mode] || '');
        const raw = id ? ext?.presetLibraries?.[mode]?.[id] : null;
        if (!raw) throw new SourceError('no-preset', i18nFormat('"${0}" has no profile of its own yet. Save one for this character in the orchestrator panel first.', c.name));
        return { settings, mode, presetId: id, profile: clone(raw), name: raw.name || id, avatar: c.avatar, index: c.index };
    }
    const lib = settings.presetLibraries?.[mode] || {};
    let id = String(settings.activePresetIds?.[mode] || '');
    if (!lib[id]) id = Object.keys(lib)[0] || '';
    if (!id) throw new SourceError('no-preset', i18n('No orchestration profile has been saved yet. Save one in the orchestrator panel first.'));
    return { settings, mode, presetId: id, profile: clone(lib[id]), name: lib[id].name || id };
}

/** The exact stored profile a change was made to, whatever is selected now. */
function resolveOrchTarget(ctx, target) {
    const settings = ctx.extensionSettings?.orchestrator;
    if (!settings) throw new SourceError('no-extension', i18n('Orchestrator not found'));
    if (target.mode === 'single') return { settings };
    const gone = () => new SourceError('target-gone', i18n('The orchestration profile this change was made to no longer exists'));
    if (target.scope === 'character') {
        const record = orchCharacterRecord(ctx.characters, target);
        if (!record) throw gone();
        return { settings, profile: clone(record.raw), index: record.index };
    }
    const raw = settings.presetLibraries?.[target.mode]?.[target.presetId];
    if (!raw) throw gone();
    return { settings, profile: clone(raw) };
}

const orch = {
    name: i18n('Orchestration'),
    ext: 'orchestrator',
    async scopes(ctx) {
        return { global: Boolean(ctx.extensionSettings?.orchestrator), character: Boolean(currentCharacter(ctx)) };
    },
    async load(scope) {
        const r = resolveOrch(getContext(), scope);
        return { live: { mode: r.mode, profile: r.profile }, target: { scope, mode: r.mode, presetId: r.presetId, avatar: r.avatar || '', index: r.index }, title: i18nFormat('${0} profile "${1}"', scope === 'character' ? i18n('Character-only') : i18n('Global'), String(r.name).replace(/^Default/i, i18n('Default'))) };
    },
    async prompt(live) {
        const base = await orchBasePrompt();
        const lines = [base.text, '', ORCH_TOOL_NOTE, '', `Execution mode: ${live.mode}`, 'Agents:'];
        for (const id of listAgents(live.mode, live.profile)) lines.push(`- ${id}（${agentName(id)}）：${agentFields(live.mode, live.profile, id).map(f => fieldLabel(f)).join(listSeparator())}`);
        return lines.join('\n');
    },
    tools: async () => ORCH_TOOLS,
    isRead: (name) => name === 'wb_orch_overview' || name === 'wb_orch_read_agent',
    async runRead(call, live) {
        const { mode, profile } = live;
        if (call.name === 'wb_orch_overview') {
            return listAgents(mode, profile).map(id => ({ id, name: agentName(id), fields: Object.fromEntries(agentFields(mode, profile, id).map(f => [f, getField(mode, profile, id, f).slice(0, 160)])) }));
        }
        const id = String(call.args?.agent_id || '');
        if (!listAgents(mode, profile).includes(id)) throw new EditError('agent', i18nFormat('No such agent: ${0}', id));
        return Object.fromEntries(agentFields(mode, profile, id).map(f => [f, getField(mode, profile, id, f)]));
    },
    async runEdit(call, live) {
        const { mode, profile } = live;
        const a = call.args || {};
        const id = String(a.agent_id || '');
        if (!agentFields(mode, profile, id).includes(a.field)) throw new EditError('field', i18nFormat('${0} has no field ${1}', id, a.field));
        const next = call.name === 'wb_orch_set_field' ? setField(mode, profile, id, a.field, a.value) : replaceInField(mode, profile, id, a.field, a.old_text, a.new_text);
        const problem = validateField(mode, id, a.field, getField(mode, next, id, a.field));
        if (problem) throw new EditError('invalid', problem);
        return { mode, profile: next };
    },
    units: (live) => orchUnits(live, agentName),
    rebuild: (base, ai, keys) => orchRebuild(base, ai, keys),
    async commit(target, base, next) {
        const ctx = getContext();
        const character = target.scope === 'character';
        const fresh = character ? resolveOrchTarget(ctx, target) : resolveOrch(ctx, target.scope);
        if (!character && (fresh.mode !== target.mode || fresh.presetId !== target.presetId)) throw new SourceError('target-gone', i18n('The orchestration profile was switched elsewhere; reopen this chat'));
        const previous = clone(fresh.profile);
        // Only the fields that changed, on top of what is stored now.
        let merged = clone(fresh.profile);
        for (const id of listAgents(next.mode, next.profile)) {
            for (const f of agentFields(next.mode, next.profile, id)) {
                const v = getField(next.mode, next.profile, id, f);
                if (v !== getField(base.mode, base.profile, id, f)) merged = setField(next.mode, merged, id, f, v);
            }
        }
        await writeOrch(ctx, target, fresh, merged);
        return { undo: () => writeOrch(getContext(), target, resolveOrchTarget(getContext(), target), previous) };
    },
};

async function writeOrch(ctx, target, fresh, profile) {
    const s = fresh.settings;
    if (target.mode === 'single') {
        const sa = profile?.presets?.single_agent || {};
        s.singleAgentSystemPrompt = String(sa.systemPrompt || '');
        s.singleAgentUserPromptTemplate = String(sa.userPromptTemplate || '');
    } else if (target.scope === 'global') {
        const lib = s.presetLibraries[target.mode];
        lib[target.presetId] = { ...profile, name: lib[target.presetId]?.name };
    } else {
        await writeCharacterProfile(ctx, target, fresh.index, profile);
        return;
    }
    await ctx.saveSettings();
    // Native editor caches drafts; make it reload from settings.
    try { (await orchEditorState()).initializeUiState(ctx); } catch { /* panel not built yet */ }
}

// ---------------------------------------------------------------------------
// preset: the current chat completion preset (completion-preset-assistant tools)
// ---------------------------------------------------------------------------

const preset = {
    name: i18n('Preset'),
    ext: 'completion-preset-assistant',
    async scopes() { return { global: true, character: false }; },
    async load() {
        const ctx = getContext();
        const ref = ctx.presets.getSelected('openai');
        if (!ref?.name) throw new SourceError('no-preset', i18n('No chat completion preset selected'));
        const stored = ctx.presets.getStored(ref);
        if (!stored?.body) throw new SourceError('no-preset', i18nFormat('Preset "${0}" is unreadable', ref.name));
        const live = clone(ctx.openai.stripPresetConnectionFields(stored.body));
        return { live, target: { ref: clone(ref) }, title: i18nFormat('Preset "${0}"${1}', ref.name, ref.origin?.kind === 'character' ? i18n(' (bound to the character card)') : '') };
    },
    async prompt() {
        const sp = await cpaPrompts();
        const s = getContext().extensionSettings?.completion_preset_assistant;
        const base = String(s?.iterBaseSystemPrompt || '').trim();
        return base || sp.buildModelSystemPrompt({ mode: 'general' });
    },
    async tools() {
        const t = await cpaTools();
        // No reference preset, no skill tools, no clone-to-new (side effect).
        return t.buildToolCatalog({ hasReference: false }).filter(d => !t.isCpaSkillTool(fnName(d)) && fnName(d) !== 'preset_clone_to_new');
    },
    isRead: (name) => /^preset_(read|diff|simulate)/.test(name),
    async runRead(call, live) {
        const t = await cpaTools();
        const res = await t.runCpaReadTool({ id: call.id, name: call.name, args: call.args || {} }, { live, reference: null, referenceName: '', presetName: getContext().presets.getSelected('openai')?.name || '', context: getContext() });
        if (res?.ok === false) throw new SourceError('read', res.error || i18n('Read failed'));
        return res?.toolResultText || res?.result;
    },
    async runEdit(call, live) {
        const t = await cpaTools();
        const edits = await t.normalizeToolCallToEdit({ function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }, { live, session: {}, getReferencePresetBody: () => null });
        if (!edits) throw new SourceError('bad-args', i18n('Invalid arguments'));
        return edits.length ? applyEditsTo(edits, live) : live;
    },
    units: (live) => presetUnits(live),
    rebuild: (base, ai, keys) => presetRebuild(base, ai, keys),
    async commit(target, base, next, keys) {
        const ctx = getContext();
        const previous = clone(ctx.presets.getStored(target.ref)?.body);
        if (!previous) throw new SourceError('no-preset', i18nFormat('Preset "${0}" is unreadable', target.ref?.name || ''));
        // Only approved units, on top of what is stored now (connection fields included).
        const body = presetRebuild(previous, next, keys);
        const res = await ctx.presets.save(target.ref, body, { select: true });
        if (res?.ok === false) throw new SourceError('write-failed', i18n('Failed to save the preset'));
        return {
            async undo() {
                const c = getContext();
                const now = c.presets.getStored(target.ref)?.body;
                if (now) await c.presets.save(target.ref, presetRebuild(clone(now), previous, keys), { select: true });
            },
        };
    },
};

// ---------------------------------------------------------------------------
// character card + world book (character-editor-assistant tools and saving)
// ---------------------------------------------------------------------------

const card = {
    name: i18n('Character card'),
    ext: 'character-editor-assistant',
    async scopes(ctx) { return { global: false, character: Boolean(currentCharacter(ctx)) }; },
    async load() {
        const ctx = getContext();
        const c = currentCharacter(ctx);
        if (!c) throw new SourceError('no-character', i18n('No character card selected'));
        const main = await ceaMain();
        const snap = await main.buildUnifiedCharacterEditorLiveSnapshot(ctx, c.avatar);
        const live = { character: clone(snap.character), lorebooks: clone(snap.lorebooks || {}) };
        for (const name of await boundBooks(ctx)) {
            if (live.lorebooks[name]) continue;
            try { const data = await ctx.loadWorldInfo(name); if (data) live.lorebooks[name] = clone(data); } catch { /* skip */ }
        }
        return { live, target: { avatar: c.avatar }, title: i18nFormat('Character card of "${0}"${1}', c.name, Object.keys(live.lorebooks).length ? i18nFormat(' · ${0} world books', Object.keys(live.lorebooks).length) : '') };
    },
    async prompt() {
        const st = await ceaStudio();
        const s = getContext().extensionSettings?.character_editor_assistant;
        return String(s?.editorIterationSystemPrompt || '').trim() || st.DEFAULT_SYSTEM_PROMPT;
    },
    async tools() {
        const t = await ceaTools();
        return t.buildCeaEditorToolSet(getContext(), {}, { hasSearchTools: false }).filter(d => fnName(d) !== 'web_search');
    },
    isRead: (name) => /^(cea_read_|lorebook_|world_book_|simulate_|inspect_)/.test(name),
    async runRead(call, live) {
        const ctx = getContext();
        const [t, cea] = await Promise.all([ceaTools(), ceaHelperSource(ctx, ceaMain)]);
        const helperApis = cea.buildCharacterEditorHelperApis(ctx, { avatar: currentCharacter(ctx)?.avatar }) || [];
        const settings = ctx.extensionSettings?.character_editor_assistant || {};
        const res = await t.runCeaEditorReadTool({ id: call.id, name: call.name, args: call.args || {} }, { context: ctx, settings, helperApis, state: { live } });
        if (res?.ok === false) throw new SourceError('read', res.error || i18n('Read failed'));
        return res?.result ?? res;
    },
    async runEdit(call, live) {
        const t = await ceaTools();
        const edits = await t.normalizeToolCallToEdit({ id: call.id, name: call.name, args: call.args || {} }, { context: getContext(), live });
        if (!edits) throw new SourceError('bad-args', i18n('Invalid arguments'));
        let next = clone(live);
        for (const e of edits) {
            const kind = e?.target?.kind;
            if (kind === 'lorebook') {
                const book = e.target.bookName;
                const rel = { ...e, path: String(e.path).replace(/^lorebook\./, '') };
                next.lorebooks[book] = await applyEditsTo([rel], next.lorebooks[book] || { entries: {} });
            } else {
                const rel = { ...e, path: String(e.path).replace(/^card\./, '') };
                next.character = await applyEditsTo([rel], next.character || {});
            }
        }
        return next;
    },
    units: (live) => cardUnits(live),
    rebuild: (base, ai, keys) => cardRebuild(base, ai, keys),
    async commit(target, base, next, keys) {
        const main = await ceaMain();
        const settings = getContext().extensionSettings?.character_editor_assistant || {};
        return commitCardAndBooks(cardEditsFor(base, next, keys), {
            commitCard(edits) {
                const ctx = getContext();
                return main.commitCharacterEditorOperations(ctx, target.avatar, edits, { liveCharacter: (ctx.characters || []).find(c => c?.avatar === target.avatar) });
            },
            readBook: async (book) => clone(await getContext().loadWorldInfo(book)),
            commitBook: (book, before, edits) => main.commitLorebookOperations(book, before, edits, { context: getContext(), settings }),
            saveBook: (book, data) => getContext().saveWorldInfo(book, data, true, { refreshEditor: true }),
        });
    },
};

// ---------------------------------------------------------------------------
// world book: world book entries only (the character assistant's tools and saving)
//   global = globally active books; character = main book, extra books and chat-bound books
// ---------------------------------------------------------------------------

async function worldBookNames(ctx, scope) {
    const names = new Set();
    if (scope === 'global') {
        for (const n of ctx.chatWorldInfo?.globalSelection || []) names.add(String(n));
    } else {
        const c = currentCharacter(ctx);
        if (!c) throw new SourceError('no-character', i18n('No character card selected'));
        const full = ctx.characters[c.index];
        if (full?.data?.extensions?.world) names.add(String(full.data.extensions.world));
        try { for (const n of ctx.getCharaAuxWorlds(String(full?.avatar || '').replace(/\.[^.]+$/, '')) || []) names.add(String(n)); } catch { /* ignore */ }
        try { for (const n of ctx.chatWorldInfo.getNames() || []) names.add(String(n)); } catch { /* ignore */ }
    }
    return [...names].filter(Boolean);
}

const WORLD_TOOL = /^(cea_(add|update|str_replace|remove)_lorebook_entry(_field)?|cea_set_lorebook_metadata|lorebook_(list|query|get)|world_book_list|simulate_prompt)$/;

const WORLD_NOTE = (books) => [
    '## This session edits world books only',
    `- Books you may edit: ${books.map(b => `「${b}」`).join(listSeparator())}. Always pass book_name exactly as written here.`,
    '- Character card fields are not editable here (the card tools are not offered). If the fix belongs on the card, say so and the user will switch to the 角色卡 workbench.',
    '- Read before editing: lorebook_list / lorebook_query to find entries, lorebook_get for full text, then patch with cea_str_replace_lorebook_entry_field or cea_update_lorebook_entry. New entries need a uid not used in that book.',
].join('\n');

const world = {
    name: i18n('World book'),
    ext: 'character-editor-assistant',
    async scopes(ctx) {
        let global = false;
        try { global = (await worldBookNames(ctx, 'global')).length > 0; } catch { global = false; }
        return { global, character: Boolean(currentCharacter(ctx)) };
    },
    async load(scope) {
        const ctx = getContext();
        const names = await worldBookNames(ctx, scope);
        if (!names.length) throw new SourceError('no-book', scope === 'global' ? i18n('No globally active world book. Select one in Luker\'s world info panel first.') : i18n('This character has no world books bound (no main book, extra books or chat binding).'));
        const lorebooks = {};
        for (const name of names) {
            try { const data = await ctx.loadWorldInfo(name); if (data) lorebooks[name] = clone(data); } catch { /* skip */ }
        }
        const c = currentCharacter(ctx);
        const who = scope === 'global' ? i18n('Globally active world books') : i18nFormat('World books of "${0}"', c?.name || i18n('Character'));
        return { live: { lorebooks }, target: { scope, avatar: scope === 'character' ? c?.avatar || '' : '' }, title: `${who} · ${Object.keys(lorebooks).join('、')}` };
    },
    async prompt(live) {
        const base = await card.prompt();
        return [base, '', WORLD_NOTE(Object.keys(live?.lorebooks || {}))].join('\n');
    },
    async tools() {
        return (await card.tools()).filter(d => WORLD_TOOL.test(fnName(d)));
    },
    isRead: (name) => /^(lorebook_|world_book_|simulate_)/.test(name),
    async runRead(call, live) {
        if (call.name === 'world_book_list') return { books: Object.keys(live?.lorebooks || {}) };
        return card.runRead(call, live);
    },
    async runEdit(call, live) {
        const book = String(call.args?.book_name || '').trim();
        if (!book || !live?.lorebooks?.[book]) throw new SourceError('book', i18nFormat('Only these can be edited: ${0}', Object.keys(live?.lorebooks || {}).join(listSeparator())));
        const next = await card.runEdit(call, { character: {}, lorebooks: live.lorebooks });
        return { lorebooks: next.lorebooks };
    },
    units: (live) => worldUnits(live),
    rebuild: (base, ai, keys) => worldRebuild(base, ai, keys),
    async commit(target, base, next, keys) {
        return card.commit({ avatar: target.avatar }, { character: {}, ...base }, { character: {}, ...next }, keys.filter(k => k.startsWith('wi:')));
    },
};

export const ADAPTERS = { memory, orch, preset, card, world };

function adapterEnabled(ws, ctx = getContext()) {
    return !ctx.extensionSettings.disabledExtensions?.includes(ADAPTERS[ws].ext);
}

const PROMPT_SOURCES = {
    memory: [i18n('Memory graph'), 'schemaIterSystemPrompt', i18n('"Schema iteration system prompt" in Memory Graph settings')],
    orch: [i18n('Orchestration'), 'requestSystemPrompt', i18n('"AI iteration system prompt" in Orchestrator settings (general part; the workbench adds its own tool notes)')],
    preset: [i18n('Preset Assistant'), 'iterBaseSystemPrompt', i18n('"Iteration base prompt" in Preset Assistant settings')],
    card: [i18n('Character Assistant'), 'editorIterationSystemPrompt', i18n('"Edit iteration prompt" in Character Assistant settings')],
    world: [i18n('Character Assistant'), 'editorIterationSystemPrompt', i18n('"Edit iteration prompt" in Character Assistant settings (Luker has no separate world book prompt; the workbench offers only world book tools and lists the editable books)')],
};

/** Which Luker prompt a workbench uses, and whether the user customised it. */
export async function promptInfo(ws) {
    if (!adapterEnabled(ws)) return { from: i18n('That extension is disabled'), custom: false, text: '' };
    const [, key, where] = PROMPT_SOURCES[ws];
    const live = ws === 'orch' ? { mode: 'spec', profile: {} } : ws === 'world' ? { lorebooks: {} } : null;
    const text = await ADAPTERS[ws].prompt(live);
    const plugin = { memory: 'memory_graph', orch: 'orchestrator', preset: 'completion_preset_assistant', card: 'character_editor_assistant', world: 'character_editor_assistant' }[ws];
    const stored = String(getContext().extensionSettings?.[plugin]?.[key] || '').trim();
    let custom = false;
    if (ws === 'orch') custom = (await orchBasePrompt()).custom;
    else if (ws === 'memory') custom = Boolean(stored) && stored !== LEGACY_SCHEMA_ITER_SYSTEM_PROMPT.trim();
    else if (ws === 'preset') custom = Boolean(stored) && stored !== String((await cpaPrompts()).buildBaseSystemPrompt()).trim();
    else if (ws === 'card' || ws === 'world') custom = Boolean(stored) && stored !== String((await ceaStudio()).DEFAULT_SYSTEM_PROMPT).trim();
    return { from: i18nFormat('Built into Luker · ${0}', where), custom, text };
}

export async function adapterScopes() {
    const ctx = getContext();
    const out = {};
    for (const [k, a] of Object.entries(ADAPTERS)) {
        if (!adapterEnabled(k, ctx)) { out[k] = { global: false, character: false, disabled: true }; continue; }
        try { out[k] = await a.scopes(ctx); } catch { out[k] = { global: false, character: false }; }
    }
    return out;
}

/** The facade AI iteration uses (preview supplies the same shape). */
export const iterate = {
    scopes: adapterScopes,
    load: (ws, scope) => ADAPTERS[ws].load(scope),
    async systemPrompt(ws, scope, live, { wrapper = '' } = {}) {
        const own = await ADAPTERS[ws].prompt(live, scope);
        return [wrapper, own].filter(Boolean).join('\n\n');
    },
    tools: (ws, live) => ADAPTERS[ws].tools(live),
    isRead: (ws, name) => ADAPTERS[ws].isRead(name),
    runRead: (ws, call, live) => ADAPTERS[ws].runRead(call, live),
    runEdit: (ws, call, live) => ADAPTERS[ws].runEdit(call, live),
    units: (ws, live) => ADAPTERS[ws].units(live),
    rebuild: (ws, base, ai, keys) => ADAPTERS[ws].rebuild(base, ai, keys),
    commit: (ws, target, base, next, keys) => ADAPTERS[ws].commit(target, base, next, keys),
    async lastReply() {
        const chat = getContext().chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system && m.mes) return `（第 ${i} 楼，${m.name || i18n('Character')}）\n${String(m.mes).slice(0, 4000)}`;
        }
        return '';
    },
};
