// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Everything the workbench reads from (and writes to) Luker. The pages only
// see plain objects from here. Memory graph and orchestrator data degrades to
// null when the user has disabled those extensions.

import { itemizedParams, itemizedPrompts } from '../../itemized-prompts.js';
import { getFrontendLogsSnapshot } from '../../frontend-log-manager.js';
import { requestToolCallsWithRetry } from '../../iteration-library/runner.js';
import { getChatCompletionConnectionProfiles } from '../connection-manager/profile-resolver.js';
import { HISTORY_KEY as ORCH_LENS_HISTORY } from '../orchestrator/lens/model/recorder.js';
import { accountLocalStorage } from '../lens-shared/current-account.js';
import { i18n, i18nFormat } from './i18n.js';
import { askSystemPrompt } from './model/ask.js';
import { buildBudget } from './model/budget.js';
import { SourceError } from './model/errors.js';
import { commitFields, saveSettingsChecked } from './model/patch.js';
import { attribute, describeRequest, finishOverview, redactReaders } from './model/requests.js';
import { createSessionStore } from './model/sessions.js';
import { hasTextCalls, salvageTextCalls } from './model/textcalls.js';
import { iterate, promptInfo as iteratePromptInfo } from './source-iterate.js';

export { iterate };

const SETTINGS_KEY = 'luker_workbench';
const MAX_ORCH_RUNS = 20;

// Loaded on demand: the modules of a disabled extension must not be evaluated.
const memoryMain = () => import('../memory-graph/main.js');
const memoryRead = () => import('../memory-graph/read-api.js');
const memoryOverrides = () => import('../memory-graph/character-overrides.js');

export { SourceError };

export const getContext = () => Luker.getContext();

/** The one session store for this window, in the signed-in account's storage. */
export function createSessions(ctx = getContext()) {
    return createSessionStore(ctx.accountStorage);
}

/** Where change history is kept: this browser, per signed-in account. */
export const historyStorage = () => accountLocalStorage();

/** Current character (null in group chats or when none is open). */
export function currentCharacter(ctx = getContext()) {
    if (ctx.groupId) return null;
    const c = ctx.characters?.[ctx.characterId];
    return c?.avatar ? { avatar: String(c.avatar), name: String(c.name || c.data?.name || ''), index: Number(ctx.characterId) } : null;
}

function chatInfo(ctx) {
    const chatId = ctx.getCurrentChatId();
    const character = currentCharacter(ctx);
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    let label = '';
    if (ctx.groupId) label = (ctx.groups || []).find(g => String(g.id) === String(ctx.groupId))?.name || i18n('Group chat');
    else label = character?.name || '';
    return { chatId: chatId ? String(chatId) : '', label, character, floors: chat.length, group: Boolean(ctx.groupId) };
}

// ---------------------------------------------------------------------------
// Settings (follow the account: extensionSettings.luker_workbench)
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
    ai: {
        default: { connection: '', preset: '' },
        memory: { connection: '', preset: '' },
        orch: { connection: '', preset: '' },
        preset: { connection: '', preset: '' },
        card: { connection: '', preset: '' },
        world: { connection: '', preset: '' },
        ask: { connection: '', preset: '' },
    },
    builtinPrompt: true,
    reviewChanges: true,
    rules: {},
    dismissed: {},
    ask: { sources: { inspector: true, frontLogs: true, serverLogs: true, content: true, plugins: true }, floors: 2, previewBeforeSend: false, redact: true },
    hotkey: 'alt+w',
    pill: true,
};

function merge(base, extra) {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return structuredClone(base);
    const out = structuredClone(base);
    for (const [k, v] of Object.entries(extra)) {
        out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
    }
    return out;
}

export function readSettings(ctx = getContext()) {
    return merge(DEFAULT_SETTINGS, ctx.extensionSettings?.[SETTINGS_KEY]);
}

export function writeSettings(next, ctx = getContext()) {
    ctx.extensionSettings[SETTINGS_KEY] = structuredClone(next);
    ctx.saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// Orchestrator runs come from the history the Orchestra Lens recorder keeps.
// ---------------------------------------------------------------------------

/** One finished run → { at, durationMs, status, agents: [{ id, label, durationMs, error }] }. */
export function summarizeOrchRun(run) {
    if (!run) return null;
    const agents = new Map();
    for (const round of run.rounds || []) {
        const sections = round.sections || [];
        const byNode = sections.filter(s => /^node-/.test(String(s.id)));
        const units = byNode.length ? byNode.map(s => ({ id: String(s.id).replace(/^node-/, ''), label: s.title, status: s.status, body: s.body, start: s.meta?.startedAt, end: s.meta?.endedAt }))
            : [{ id: String(round.id).replace(/-\d+$/, '').replace(/^(node|sub|agent|main)-/, ''), label: round.label, status: round.status, body: '', start: round.startedAt, end: round.endedAt }];
        for (const u of units) {
            const entry = agents.get(u.id) || { id: u.id, label: String(u.label || u.id).replace(/\s*[#·].*$/, ''), durationMs: 0, error: '' };
            const start = Number(u.start ?? round.startedAt);
            const end = Number(u.end ?? round.endedAt);
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) entry.durationMs += end - start;
            if (u.status === 'failed') entry.error ||= String(u.body || i18n('Failed')).slice(-300);
            agents.set(u.id, entry);
        }
    }
    const start = Number(run.startedAt);
    const end = Number(run.endedAt);
    return {
        at: Number(run.startedAtWall) || Date.now(),
        durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0,
        status: String(run.status || ''),
        error: run.error ? String(run.error) : '',
        agents: [...agents.values()],
    };
}

function orchRuns() {
    let lens = null;
    try { lens = JSON.parse(accountLocalStorage().getItem(ORCH_LENS_HISTORY) || 'null'); } catch { lens = null; }
    if (!Array.isArray(lens)) return [];
    return lens.filter(r => (r.source || 'orchestrator') === 'orchestrator' && !r.quiet).slice(0, MAX_ORCH_RUNS).reverse().map(summarizeOrchRun).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Snapshot for the overview + suggestions
// ---------------------------------------------------------------------------

async function memoryPart(ctx, chat) {
    const mg = ctx.getExtensionApi('memory-graph');
    if (!mg) return null;
    const [main, read] = await Promise.all([memoryMain(), memoryRead()]);
    const out = { installed: true, nodes: 0, events: 0, unmerged: 0, core: 0, focus: 0, coreHistory: [], compression: false, threshold: 0, maxSeqDistance: null, floors: chat.floors, structure: '', scope: 'global' };
    try {
        const settings = main.getSettings();
        const adv = mg.getAdvancedScopeInfo(ctx, settings);
        out.maxSeqDistance = Number(adv?.settings?.persistentInjectionMaxSeqDistance ?? settings?.persistentInjectionMaxSeqDistance ?? 0);
        out.scope = adv?.scope || 'global';
        const schemaInfo = mg.getSchemaScopeInfo(ctx, settings);
        const event = (schemaInfo?.schema || []).find(s => String(s?.id) === 'event');
        out.compression = String(event?.compression?.mode || '') === 'hierarchical';
        out.threshold = Number(event?.compression?.threshold) || 0;
        out.types = (schemaInfo?.schema || []).length;
    } catch { /* settings unavailable */ }
    try {
        if (chat.chatId) {
            const store = await main.ensureMemoryStoreLoaded(ctx);
            const api = store ? read.getMemoryGraphReadApi(store, ctx) : null;
            const nodes = api?.listNodes({ activeOnly: false }) || [];
            out.nodes = nodes.length;
            const events = nodes.filter(node => node?.type === 'event' && !node.archived);
            out.events = events.length;
            // Leaves with no rollup above them are what still injects one by one.
            out.unmerged = events.filter(node => !(Number(node.semanticDepth) > 0) && !node.parentId).length;
        }
    } catch { /* store not ready */ }
    try {
        const proj = await mg.getLastRecallProjection(ctx);
        if (proj?.blocks) {
            const count = (text) => ctx.getTokenCountAsync(String(text || ''));
            [out.core, out.focus] = await Promise.all([count(proj.blocks.corePacket), count(proj.blocks.focusPacket)]);
            out.recallAt = proj.at;
        }
    } catch { /* no recall yet */ }
    // Memory Lens records one entry per generation in the chat metadata.
    const log = ctx.chatMetadata?.memory_lens_tokens?.entries;
    if (Array.isArray(log)) out.coreHistory = log.slice(-30).map(e => Number(e.core) || 0);
    return out;
}

async function budgetPart(memoryTokens) {
    const list = itemizedPrompts;
    if (!Array.isArray(list) || !list.length) return null;
    const idx = list.length - 1;
    try {
        const params = await itemizedParams(list, idx, list[idx]?.mesId);
        return buildBudget(params, { memory: memoryTokens });
    } catch {
        return null;
    }
}

function presetPart(ctx) {
    try {
        const live = ctx.presets.getLive('openai');
        const body = live?.body || {};
        const order = (body.prompt_order || []).find(o => Number(o.character_id) === 100001) || (body.prompt_order || [])[0];
        const enabledIds = new Set((order?.order || []).filter(o => o.enabled).map(o => o.identifier));
        const prompts = (body.prompts || []).filter(p => p && !p.marker).map(p => ({ id: p.identifier, name: p.name || p.identifier, text: String(p.content || ''), enabled: enabledIds.has(p.identifier) }));
        return { name: live?.ref?.name || ctx.chatCompletionSettings?.preset_settings_openai || '', prompts, enabled: prompts.filter(p => p.enabled).length };
    } catch {
        return null;
    }
}

function cardPart(ctx, chat) {
    const c = chat.character;
    if (!c) return { name: '', pending: 0 };
    const full = ctx.characters?.[c.index] || {};
    const books = new Set();
    const main = full.data?.extensions?.world;
    if (main) books.add(String(main));
    for (const extra of ctx.chatMetadata?.world_info ? [ctx.chatMetadata.world_info] : []) books.add(String(extra));
    return { name: c.name, avatar: c.avatar, books: [...books], pending: 0 };
}

function worldPart(ctx, card) {
    let global = [];
    try { global = [...(ctx.chatWorldInfo?.globalSelection || [])].map(String).filter(Boolean); } catch { global = []; }
    return { global, character: card?.books || [] };
}

function orchPart(ctx) {
    if (!ctx.getExtensionApi('orchestrator')) return null;
    const s = ctx.extensionSettings.orchestrator;
    if (!s) return null;
    const runs = orchRuns();
    const last = runs[runs.length - 1] || null;
    return { enabled: Boolean(s.enabled), mode: String(s.executionMode || ''), runs, last };
}

export function connectionName(ctx = getContext()) {
    try {
        const sel = document.getElementById('connection_profiles');
        const text = sel?.selectedOptions?.[0]?.textContent?.trim();
        if (text && sel.value) return text;
    } catch { /* no DOM */ }
    return String(ctx.chatCompletionSettings?.chat_completion_source || '');
}

/**
 * @returns {Promise<{ chat, memory, budget, preset, card, world, orch, connection, at }>}
 */
export async function loadSnapshot() {
    const ctx = getContext();
    const chat = chatInfo(ctx);
    const memory = await memoryPart(ctx, chat).catch(() => null);
    const budget = await budgetPart(memory?.core || 0);
    if (budget && memory) budget.memoryHistory = memory.coreHistory;
    const card = cardPart(ctx, chat);
    return {
        chat,
        memory,
        budget,
        preset: presetPart(ctx),
        card,
        world: worldPart(ctx, card),
        orch: orchPart(ctx),
        connection: connectionName(ctx),
        lenses: { memory: Boolean(ctx.getExtensionApi('memory-graph')), orch: Boolean(ctx.getExtensionApi('orchestrator')) },
        at: Date.now(),
    };
}

// ---------------------------------------------------------------------------
// Quick actions from suggestions
// ---------------------------------------------------------------------------

const HORIZON_KEY = 'persistentInjectionMaxSeqDistance';

/**
 * Sets memory-graph's max lookback floors in the scope active right now, and
 * keeps that scope for the undo.
 * @returns {Promise<{ before: number, scope: string, avatar?: string, undo: () => Promise<void> }>}
 */
export async function setMemoryHorizon(value) {
    const ctx = getContext();
    const mg = ctx.getExtensionApi('memory-graph');
    const settings = mg ? (await memoryMain()).getSettings() : null;
    if (!mg || !settings) throw new SourceError('unsupported', i18n('Memory graph settings could not be read'));
    const adv = mg.getAdvancedScopeInfo(ctx, settings);
    const before = Number(adv?.settings?.[HORIZON_KEY] ?? settings[HORIZON_KEY] ?? 0);
    const character = adv?.scope === 'character' && adv.avatar ? String(adv.avatar) : '';
    const overrides = character ? await memoryOverrides() : null;
    const wrap = (current) => new Map([['horizon', { key: 'horizon', fields: { value: current } }]]);
    const store = character ? {
        read() {
            const ctx = getContext();
            if (!(ctx.characters || []).some(c => c?.avatar === character)) throw new SourceError('target-gone', i18n('The character card this change was made to no longer exists'));
            return overrides.getCharacterAdvancedOverrideByAvatar(ctx, character) || {};
        },
        async save(next) {
            const patch = next === undefined ? { unset: [HORIZON_KEY] } : { set: { [HORIZON_KEY]: next } };
            if (!await overrides.persistCharacterAdvancedOverridePatch(getContext(), character, patch)) throw new SourceError('write-failed', i18n('Failed to write to the character card'));
        },
    } : {
        read: () => settings,
        async save(next) {
            const previous = settings[HORIZON_KEY];
            settings[HORIZON_KEY] = next;
            try { await saveSettingsChecked(getContext()); } catch (err) { settings[HORIZON_KEY] = previous; throw err; }
        },
    };
    const current = (await store.read())[HORIZON_KEY];
    const handle = await commitFields({
        read: store.read,
        units: (data) => wrap(data[HORIZON_KEY]),
        apply: (data, ops) => ops[0].changes[0].after,
        write: (next) => store.save(next),
    }, [{ key: 'horizon', kind: 'change', changes: [{ field: 'value', before: current, after: value }] }]);
    return { before, scope: character ? 'character' : 'global', avatar: character || undefined, undo: handle.undo };
}

/** Subscribes to the Luker events that should refresh the window. */
export function subscribe(onChange) {
    const ctx = getContext();
    const offs = ['CHAT_CHANGED', 'GENERATION_ENDED', 'MESSAGE_DELETED', 'SETTINGS_UPDATED', 'ITEMIZED_PROMPTS_SAVED', 'OAI_PRESET_CHANGED_AFTER', 'CHARACTER_EDITED'].map((name) => {
        const type = ctx.eventTypes[name];
        const handler = () => onChange(name);
        ctx.eventSource.on(type, handler);
        return () => ctx.eventSource.removeListener(type, handler);
    });
    return () => { for (const off of offs.splice(0)) off(); };
}

export async function openLens(which) {
    if (which === 'memory') (await import('../memory-graph/lens/index.js')).openMemoryLens();
    if (which === 'orch') (await import('../orchestrator/lens/index.js')).openOrchestraLens();
}

// ---------------------------------------------------------------------------
// AI connections (shared by Ask and AI iteration)
// ---------------------------------------------------------------------------

// Each workbench's own plugin already has an "iteration AI" connection + preset;
// a row left on "follow" uses that first, then the workbench default.
const NATIVE_AI = { memory: 'memory_graph', orch: 'orchestrator', preset: 'completion_preset_assistant', card: 'character_editor_assistant', world: 'character_editor_assistant' };
export const BUNDLED_PRESETS = ['plugin-only', 'agent-director', 'agent-non-director'];

function nativeAi(role, ctx = getContext()) {
    const s = ctx.extensionSettings?.[NATIVE_AI[role]];
    return s ? { connection: String(s.requestApiPresetName || '').trim(), preset: String(s.requestLlmPresetName || '').trim() } : { connection: '', preset: '' };
}

/** Connection profiles and chat-completion presets the user can pick. */
export async function listAiChoices() {
    const ctx = getContext();
    const connections = getChatCompletionConnectionProfiles().map(p => String(p?.name || '')).filter(Boolean);
    let presets = [];
    try {
        const names = ctx.getPresetManager('openai')?.getAllPresets();
        presets = Array.isArray(names) ? [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))] : [];
    } catch { presets = []; }
    const native = Object.fromEntries(Object.keys(NATIVE_AI).map(role => [role, nativeAi(role, ctx)]));
    return { connections: [...new Set(connections)], presets, native, hasPluginOnly: presets.includes('plugin-only') };
}

/** Imports one of Luker's bundled presets (public/presets/<name>.json) the same way its "?" help popup does. */
export async function importBundledPreset(name = 'plugin-only') {
    if (!BUNDLED_PRESETS.includes(name)) throw new SourceError('bad-name', i18n('Unrecognized preset'));
    const manager = getContext().getPresetManager('openai');
    if (!manager) throw new SourceError('unsupported', i18n('Preset manager unavailable'));
    const res = await fetch(`/presets/${name}.json`);
    if (!res.ok) throw new SourceError('download', i18nFormat('Failed to download "${0}" (HTTP ${1})', name, res.status));
    const data = await res.json();
    if (data && typeof data === 'object') data.name = name;
    await manager.savePreset(name, data);
    return name;
}

/** Effective { apiPresetName, llmPresetName } for a role ('ask' | 'memory' | 'orch' | 'preset' | 'card'). */
function hasPreset(name) {
    try { return (getContext().getPresetManager('openai')?.getAllPresets() || []).map(n => String(n).trim()).includes(name); } catch { return false; }
}

/** Default generation preset when none is picked: Luker's plugin-only if installed. */
export function defaultPreset(settings = readSettings()) {
    const picked = String(settings.ai?.default?.preset || '').trim();
    if (picked) return picked;
    return hasPreset('plugin-only') ? 'plugin-only' : '';
}

export function aiTarget(role, settings = readSettings()) {
    const own = settings.ai?.[role] || {};
    const def = settings.ai?.default || {};
    const nat = NATIVE_AI[role] ? nativeAi(role) : { connection: '', preset: '' };
    return {
        apiPresetName: String(own.connection || nat.connection || def.connection || '').trim(),
        llmPresetName: String(own.preset || nat.preset || defaultPreset(settings) || '').trim(),
    };
}

/** System prompt each role uses, for the settings page: { from, custom, text }. */
export async function promptInfo(role) {
    if (role === 'ask') {
        return { from: i18n('Workbench built-in'), custom: false, text: askSystemPrompt() };
    }
    return iteratePromptInfo(role);
}

/**
 * One model call with tools. `messages` are OpenAI-style; tool results go
 * back as { role: 'tool', tool_call_id, content }.
 * @returns {Promise<{ text: string, calls: { id, name, args }[] }>}
 */
export async function aiRequest(role, { messages, tools = [], signal = null }) {
    const ctx = getContext();
    if (!tools.length) throw new SourceError('bad-call', i18n('An AI call needs at least one tool'));
    const result = await requestToolCallsWithRetry(ctx, { toolCallRetryMax: 2 }, {
        taskMessages: messages,
        runtimeWorldInfo: null,
        ...aiTarget(role),
        tools,
        allowedNames: new Set(tools.map(t => t?.function?.name).filter(Boolean)),
        abortSignal: signal,
        includeAssistantText: true,
        allowNoToolCalls: true,
    });
    const calls = (Array.isArray(result?.toolCalls) ? result.toolCalls : []).map((c, i) => ({
        id: String(c?.id || `wb_${Date.now().toString(36)}_${i}`),
        name: String(c?.name || ''),
        args: c?.args && typeof c.args === 'object' ? c.args : {},
    }));
    const text = String(result?.assistantText || result?.text || '').trim();
    // Plain-text tool protocol Luker could not parse (broken JSON inside
    // <args_json>): recover the calls instead of showing raw XML.
    if (hasTextCalls(text)) {
        const salvaged = salvageTextCalls(text, tools.map(t => t?.function?.name).filter(Boolean));
        return { text: salvaged.text, calls: calls.length ? calls : salvaged.calls };
    }
    return { text, calls };
}

/** Quick connectivity test for a role. */
export async function aiTest(role) {
    const started = Date.now();
    const tools = [{ type: 'function', function: { name: 'wb_ok', description: 'Call this once to confirm the connection works.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }];
    await aiRequest(role, { messages: [{ role: 'system', content: '这是连接测试。调用 wb_ok 工具一次，不要输出别的。' }, { role: 'user', content: '测试连接' }], tools });
    return Date.now() - started;
}

// ---------------------------------------------------------------------------
// Ask: read-only readers (one per AI tool) + the overview sent first
// ---------------------------------------------------------------------------

async function inspectorList() {
    const res = await fetch('/api/request-inspector/list', { headers: getContext().getRequestHeaders() });
    if (!res.ok) throw new SourceError('inspector', i18nFormat('Request inspector unreadable (HTTP ${0})', res.status));
    const list = await res.json();
    return Array.isArray(list) ? list : [];
}

export async function inspectorDetail(id) {
    const res = await fetch(`/api/request-inspector/${encodeURIComponent(id)}`, { headers: getContext().getRequestHeaders() });
    if (!res.ok) throw new SourceError('inspector', i18nFormat('This request is unreadable (HTTP ${0})', res.status));
    return res.json();
}

/** Request list, newest first, with a guessed source. */
export async function listRequests({ limit = 60 } = {}) {
    const list = (await inspectorList()).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    return list.map(e => ({ ...e, attr: attribute(e) }));
}

export function frontendLogs({ limit = 60, level = 'all', search = '' } = {}) {
    const levels = level === 'error' ? ['error'] : level === 'warn' ? ['warn', 'error'] : null;
    const needle = String(search || '').toLowerCase();
    const all = getFrontendLogsSnapshot({ limit: 3000 }).entries || [];
    return all
        .filter(e => !levels || levels.includes(String(e.level)))
        .filter(e => !needle || String(e.message || '').toLowerCase().includes(needle))
        .slice(-Math.max(1, Math.min(200, limit)))
        .map(e => ({ time: new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false }), level: e.level, source: e.source, message: String(e.message || '').slice(0, 800) }));
}

export function frontendLogCount() {
    return getFrontendLogsSnapshot({ limit: 3000 }).entries?.length ?? null;
}

/** Whether Luker's frontend debug logging switch is on (API request logs are only kept then). */
export function debugLoggingOn() {
    const box = document.getElementById('frontend_debug_logging');
    if (box) return Boolean(box.checked);
    return null;
}

/** Turns the switch on through Luker's own control, so it is saved like a user click. */
export function enableDebugLogging() {
    const box = document.getElementById('frontend_debug_logging');
    if (!box) throw new SourceError('logs', i18n('The "Frontend debug logging" switch was not found; turn it on in User Settings'));
    if (!box.checked) {
        box.checked = true;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
}

export async function serverLogs({ limit = 60, search = '' } = {}) {
    const res = await fetch('/api/users/logs/get', {
        method: 'POST',
        headers: getContext().getRequestHeaders(),
        body: JSON.stringify({ limit: Math.max(1, Math.min(200, limit)), searchTerm: String(search || '') }),
    });
    if (res.status === 403 || res.status === 401) throw new SourceError('logs', i18n('Server logs need admin rights'));
    if (!res.ok) throw new SourceError('logs', i18nFormat('Server logs unreadable (HTTP ${0})', res.status));
    const data = await res.json();
    const entries = Array.isArray(data?.entries) ? data.entries : Array.isArray(data) ? data : [];
    return entries.map(e => ({ time: new Date(Number(e.timestamp) || Date.now()).toLocaleTimeString('zh-CN', { hour12: false }), level: e.level, message: String(e.message || '').slice(0, 800) }));
}

function chatMessages({ from, to } = {}) {
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    const last = chat.length - 1;
    const start = Number.isFinite(Number(from)) ? Math.max(0, Number(from)) : Math.max(0, last - 3);
    const end = Number.isFinite(Number(to)) ? Math.min(last, Number(to)) : Math.min(last, start + 5);
    const out = [];
    for (let i = start; i <= end && i <= last; i++) {
        const m = chat[i];
        if (!m) continue;
        out.push({ floor: i, who: m.is_user ? '用户' : m.is_system ? '系统' : (m.name || i18n('Character')), text: String(m.mes || '').slice(0, 4000), model: m.extra?.model || '' });
    }
    return { total: chat.length, messages: out };
}

function characterFields({ fields } = {}) {
    const ctx = getContext();
    const c = currentCharacter(ctx);
    if (!c) return { error: '未选择角色卡（或在群聊里）' };
    const full = ctx.characters[c.index] || {};
    const data = full.data || {};
    const all = {
        name: full.name,
        description: full.description ?? data.description,
        personality: full.personality ?? data.personality,
        scenario: full.scenario ?? data.scenario,
        first_mes: full.first_mes ?? data.first_mes,
        mes_example: full.mes_example ?? data.mes_example,
        creator_notes: data.creator_notes,
        system_prompt: data.system_prompt,
        post_history_instructions: data.post_history_instructions,
        world: data.extensions?.world || '',
    };
    const want = Array.isArray(fields) && fields.length ? fields : Object.keys(all);
    return Object.fromEntries(want.filter(k => k in all).map(k => [k, String(all[k] ?? '').slice(0, 6000)]));
}

export async function boundBooks(ctx = getContext()) {
    const names = new Set();
    const c = currentCharacter(ctx);
    if (c) {
        const full = ctx.characters[c.index];
        if (full?.data?.extensions?.world) names.add(String(full.data.extensions.world));
        try { for (const n of ctx.getCharaAuxWorlds(full?.avatar?.replace(/\.[^.]+$/, '')) || []) names.add(String(n)); } catch { /* ignore */ }
    }
    try { for (const n of ctx.chatWorldInfo.getNames() || []) names.add(String(n)); } catch { /* ignore */ }
    try { for (const n of ctx.chatWorldInfo?.globalSelection || []) names.add(String(n)); } catch { /* ignore */ }
    return [...names].filter(Boolean);
}

async function worldInfo({ search = '' } = {}) {
    const ctx = getContext();
    const books = await boundBooks(ctx);
    const needle = String(search || '').toLowerCase();
    const out = [];
    for (const name of books) {
        let data = null;
        try { data = await ctx.loadWorldInfo(name); } catch { data = null; }
        const entries = Object.values(data?.entries || {});
        for (const e of entries) {
            const keys = [...(e.key || []), ...(e.keysecondary || [])].map(String);
            const hay = `${keys.join(' ')} ${e.comment || ''} ${e.content || ''}`.toLowerCase();
            if (needle && !hay.includes(needle)) continue;
            out.push({ book: name, title: e.comment || keys[0] || `#${e.uid}`, keys, enabled: !e.disable, constant: Boolean(e.constant), content: needle ? String(e.content || '').slice(0, 1500) : undefined });
            if (out.length >= 60) break;
        }
    }
    return { books, entries: out };
}

function presetDetail({ entry = '' } = {}) {
    const ctx = getContext();
    const live = ctx.presets.getLive('openai');
    const body = live?.body || {};
    const order = (body.prompt_order || []).find(o => Number(o.character_id) === 100001) || (body.prompt_order || [])[0];
    const byId = new Map((body.prompts || []).map(p => [p.identifier, p]));
    const items = (order?.order || []).map(o => ({ ...byId.get(o.identifier), enabled: o.enabled })).filter(p => p.identifier);
    if (entry) {
        const hit = items.find(p => p.name === entry || p.identifier === entry);
        return hit ? { name: hit.name, enabled: hit.enabled, role: hit.role, content: String(hit.content || '').slice(0, 8000) } : { error: `没有叫「${entry}」的条目` };
    }
    return {
        name: live?.ref?.name || '',
        settings: { temperature: body.temperature, max_context: body.openai_max_context, max_tokens: body.openai_max_tokens, stream: body.stream_openai },
        entries: items.map(p => ({ name: p.name || p.identifier, enabled: p.enabled, marker: Boolean(p.marker), preview: p.marker ? '（系统占位：角色卡 / 世界书 / 聊天等）' : String(p.content || '').slice(0, 120) })),
    };
}

async function memoryDetail({ part = 'summary' } = {}) {
    const ctx = getContext();
    const mg = ctx.getExtensionApi('memory-graph');
    if (!mg) return { error: '没有记忆图' };
    const proj = await mg.getLastRecallProjection(ctx);
    if (part === 'core') return String(proj?.blocks?.corePacket || i18n('(empty)'));
    if (part === 'focus') return String(proj?.blocks?.focusPacket || i18n('(empty)'));
    const snap = await memoryPart(ctx, chatInfo(ctx));
    return { ...snap, lastRecall: proj?.at ? new Date(proj.at).toLocaleString('zh-CN') : '还没召回过' };
}

/** Reader functions keyed by tool name (see model/ask.js). */
export function askReaders({ redactText = true, suggestions = () => [] } = {}) {
    return redactReaders({
        async wb_list_requests({ limit = 20, only_errors = false } = {}) {
            const list = await listRequests({ limit: 200 });
            const pick = list.filter(e => !only_errors || e.status === 'error' || e.error).slice(0, Math.max(1, Math.min(60, limit)));
            return pick.map(e => describeRequest(e, e.attr));
        },
        async wb_read_request({ id, part = 'both' } = {}) {
            const d = await inspectorDetail(id);
            const msgs = (d.fullMessages || []).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 3000) : JSON.stringify(m.content).slice(0, 3000) }));
            const out = { id: d.id, model: d.model, status: d.status, httpStatus: d.httpStatus, error: d.error, durationMs: d.durationMs, usage: d.usage, finishReason: d.finishReason };
            if (part !== 'reply') out.messages = msgs;
            if (part !== 'messages') out.reply = String(d.responseText || '').slice(0, 6000);
            return out;
        },
        wb_read_frontend_logs: async (args) => frontendLogs(args),
        wb_read_server_logs: async (args) => serverLogs(args),
        wb_read_chat: async (args) => chatMessages(args),
        wb_read_character: async (args) => characterFields(args),
        wb_read_world_info: async (args) => worldInfo(args),
        wb_read_preset: async (args) => presetDetail(args),
        async wb_read_last_prompt() {
            const snap = await loadSnapshot();
            return snap.budget || { error: '还没有提示词数据（要先生成一次回复，且是对话补全接口）' };
        },
        wb_read_memory: async (args) => memoryDetail(args),
        async wb_read_orchestrator() {
            const o = orchPart(getContext());
            return o ? { enabled: o.enabled, mode: o.mode, runs: o.runs.slice(-8) } : { error: '没有编排' };
        },
        wb_read_suggestions: async () => suggestions().map(s => ({ text: s.text, why: s.why })),
    }, redactText);
}

/** Compact overview sent with every question. */
export async function askOverview({ inspector = true, redactText = true } = {}) {
    const snap = await loadSnapshot();
    let requests = [];
    if (inspector) {
        try {
            requests = (await listRequests({ limit: 8 })).map(e => describeRequest(e, e.attr));
        } catch { requests = i18n('Unreadable'); }
    }
    return finishOverview({
        聊天: snap.chat.label ? `${snap.chat.label}，${snap.chat.floors} 楼` : '没有打开聊天',
        角色卡: snap.card?.name || i18n('None selected'),
        预设: snap.preset?.name || '',
        连接: snap.connection,
        提示词: snap.budget ? Object.fromEntries([['合计', snap.budget.total], ['上限', snap.budget.max], ...snap.budget.parts.map(p => [p.label, p.tokens])]) : '没有数据',
        记忆图: snap.memory ? { 节点: snap.memory.nodes, 常驻注入: snap.memory.core, 本次召回: snap.memory.focus } : i18n('Not present'),
        编排: snap.orch ? { 开启: snap.orch.enabled, 模式: snap.orch.mode, 最近运行: snap.orch.runs.length } : i18n('Not present'),
        最近的请求: requests,
        调试日志开关: debugLoggingOn() === null ? '未知' : debugLoggingOn() ? '开' : '关',
    }, { inspector, redactText });
}
