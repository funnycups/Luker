// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Everything the workbench reads from (and writes to) Luker core via
// Luker.getContext() and registered platform providers (AskProvider,
// SuggestRuleProvider, IterateTarget). Zero direct extension imports.

import { getFrontendLogsSnapshot } from '../frontend-log-manager.js';
import { accountLocalStorage } from '../lens-shared/current-account.js';
import { i18n, i18nFormat } from './i18n.js';
import { askSystemPrompt } from './model/ask.js';
import { buildBudget } from './model/budget.js';
import { SourceError } from './model/errors.js';
import { attribute, describeRequest, finishOverview, redactReaders } from './model/requests.js';
import { resolveAiRow } from './model/ai-source.js';
import { createSessionStore } from './model/sessions.js';
import { runRules } from './model/suggest.js';
import { hasTextCalls, salvageTextCalls } from './model/textcalls.js';
import { defaultRegistry } from './registry.js';

const SETTINGS_KEY = 'workbench';
const LEGACY_SETTINGS_KEY = 'luker_workbench';

export { SourceError };

export const getContext = () => globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;

/** State-backed session store (routed by scope). */
export function createSessions(ctx = null) {
    return createSessionStore(ctx ? () => ctx : () => getContext());
}

/** Where change history is kept: this browser, per signed-in account. */
export const historyStorage = () => accountLocalStorage();

/** Current character (null in group chats or when none is open). */
export function currentCharacter(ctx = getContext()) {
    if (!ctx || ctx.groupId) return null;
    const c = ctx.characters?.[ctx.characterId];
    return c?.avatar ? { avatar: String(c.avatar), name: String(c.name || c.data?.name || ''), index: Number(ctx.characterId) } : null;
}

function validChatTarget(t) {
    if (!t || typeof t !== 'object') return null;
    if (t.is_group === true && typeof t.id === 'string' && t.id) return { is_group: true, id: t.id };
    if (t.is_group !== true && typeof t.avatar_url === 'string' && t.avatar_url && typeof t.file_name === 'string' && t.file_name) {
        return {
            is_group: false,
            avatar_url: t.avatar_url,
            file_name: t.file_name,
            ...(typeof t.char_name === 'string' && t.char_name ? { char_name: t.char_name } : {}),
        };
    }
    return null;
}

function chatInfo(ctx) {
    const chatId = ctx.getCurrentChatId?.();
    const character = currentCharacter(ctx);
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    let label = '';
    if (ctx.groupId) label = (ctx.groups || []).find(g => String(g.id) === String(ctx.groupId))?.name || i18n('Group chat');
    else label = character?.name || '';
    const resolvedTarget = validChatTarget(ctx.resolveChatStateTarget?.());
    const target = resolvedTarget || (ctx.groupId && chatId
        ? { is_group: true, id: String(chatId) }
        : (character?.avatar && chatId ? { is_group: false, avatar_url: character.avatar, file_name: String(chatId) } : null));
    return { chatId: chatId ? String(chatId) : '', label, character, floors: chat.length, group: Boolean(ctx.groupId), target };
}

// ---------------------------------------------------------------------------
// Settings (follow the account: extensionSettings.workbench)
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
    ai: {
        default: { connection: '', preset: '' },
        ask: { connection: '', preset: '' },
        memory: { connection: '', preset: '' },
        orch: { connection: '', preset: '' },
        preset: { connection: '', preset: '' },
        card: { connection: '', preset: '' },
        world: { connection: '', preset: '' },
    },
    builtinPrompt: true,
    reviewChanges: true,
    rules: {},
    dismissed: {},
    ask: {
        sources: { inspector: true, frontLogs: true, serverLogs: true, content: true, plugins: true },
        floors: 2,
        previewBeforeSend: false,
        redact: true,
    },
    hotkey: 'alt+w',
    pill: true,
    defaultSize: 'small',
};

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function merge(base, extra) {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return clone(base);
    const out = clone(base);
    for (const [k, v] of Object.entries(extra)) {
        out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
    }
    return out;
}

export function readSettings(ctx = getContext()) {
    const ext = ctx?.extensionSettings || {};
    return merge(DEFAULT_SETTINGS, ext[SETTINGS_KEY] ?? ext[LEGACY_SETTINGS_KEY]);
}

export function writeSettings(next, ctx = getContext()) {
    if (!ctx?.extensionSettings) return;
    ctx.extensionSettings[SETTINGS_KEY] = clone(next);
    ctx.saveSettingsDebounced?.();
}

// ---------------------------------------------------------------------------
// Snapshot for the overview + suggestions
// ---------------------------------------------------------------------------

async function budgetPart(memoryTokens = 0) {
    try {
        const { itemizedParams, itemizedPrompts } = await import('../itemized-prompts.js');
        if (!Array.isArray(itemizedPrompts) || !itemizedPrompts.length) return null;
        const idx = itemizedPrompts.length - 1;
        const params = await itemizedParams(itemizedPrompts, idx, itemizedPrompts[idx]?.mesId);
        return buildBudget(params, { memory: memoryTokens });
    } catch {
        return null;
    }
}

function presetPart(ctx) {
    try {
        const live = ctx.presets?.getLive?.('openai');
        const body = live?.body || {};
        const order = (body.prompt_order || []).find(o => Number(o.character_id) === 100001) || (body.prompt_order || [])[0];
        const enabledIds = new Set((order?.order || []).filter(o => o.enabled).map(o => o.identifier));
        const prompts = (body.prompts || [])
            .filter(p => p && !p.marker)
            .map(p => ({ id: p.identifier, name: p.name || p.identifier, text: String(p.content || ''), enabled: enabledIds.has(p.identifier) }));
        return {
            name: live?.ref?.name || ctx.chatCompletionSettings?.preset_settings_openai || '',
            ref: live?.ref ? clone(live.ref) : null,
            prompts,
            enabled: prompts.filter(p => p.enabled).length,
        };
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

export function connectionName(ctx = getContext()) {
    try {
        const sel = typeof document !== 'undefined' ? document.getElementById('connection_profiles') : null;
        const text = sel?.selectedOptions?.[0]?.textContent?.trim();
        if (text && sel.value) return text;
    } catch { /* no DOM */ }
    return String(ctx?.chatCompletionSettings?.chat_completion_source || '');
}

async function collectProviderSnapshots(ctx, registry = defaultRegistry) {
    const providers = {};
    let memory = null;
    let orch = null;
    let memoryTokens = 0;

    for (const p of registry.getAskProviders()) {
        if (typeof p.getSnapshot !== 'function') continue;
        try {
            const snap = await p.getSnapshot(ctx);
            if (!snap) continue;
            providers[p.id] = snap;
            if (Number.isFinite(Number(snap.core))) memoryTokens += Number(snap.core);
            if (p.id === 'memory' || p.id === 'memory-graph') memory = snap;
            if (p.id === 'orch' || p.id === 'orchestrator') orch = snap;
        } catch (err) {
            console.warn(`[workbench] AskProvider snapshot failed for "${p.id}":`, err);
        }
    }
    return { providers, memory, orch, memoryTokens };
}

/**
 * @returns {Promise<{ chat, providers, memory, orch, budget, preset, card, world, connection, at } | null>}
 */
export async function loadSnapshot(registry = defaultRegistry) {
    const ctx = getContext();
    if (!ctx || !Array.isArray(ctx.chat) || !Array.isArray(ctx.characters)) return null;
    const chat = chatInfo(ctx);
    const { providers, memory, orch, memoryTokens } = await collectProviderSnapshots(ctx, registry);
    const budget = chat.chatId && chat.floors > 0 ? await budgetPart(memoryTokens) : null;
    if (budget && memory?.coreHistory) budget.memoryHistory = memory.coreHistory;
    const card = cardPart(ctx, chat);
    return {
        chat,
        providers,
        memory,
        orch,
        budget,
        preset: presetPart(ctx),
        card,
        world: worldPart(ctx, card),
        connection: connectionName(ctx),
        at: Date.now(),
    };
}

/** Subscribes to the Luker events that should refresh the window. */
export function subscribe(onChange) {
    const ctx = getContext();
    if (!ctx?.eventSource || !ctx?.eventTypes) return () => {};
    const names = ['CHAT_CHANGED', 'GENERATION_ENDED', 'MESSAGE_DELETED', 'SETTINGS_UPDATED', 'ITEMIZED_PROMPTS_SAVED', 'OAI_PRESET_CHANGED_AFTER', 'CHARACTER_EDITED'];
    const offs = [];
    for (const name of names) {
        const type = ctx.eventTypes[name];
        if (!type) continue;
        const handler = () => onChange(name);
        ctx.eventSource.on(type, handler);
        offs.push(() => ctx.eventSource.removeListener?.(type, handler) ?? ctx.eventSource.off?.(type, handler));
    }
    return () => { for (const off of offs.splice(0)) off(); };
}

// ---------------------------------------------------------------------------
// AI connections (shared by Ask and AI iteration)
// ---------------------------------------------------------------------------

export async function listAiChoices(registry = defaultRegistry) {
    const ctx = getContext();
    const errors = {};
    let connections = [];
    let presets = [];

    try {
        const profiles = ctx?.connectionProfiles?.list?.() || [];
        connections = [...new Set(profiles.map(p => String(p?.name || '').trim()).filter(Boolean))];
    } catch (err) {
        errors.connections = String(err?.message || err);
        connections = [];
    }

    try {
        const refs = ctx?.presets?.list?.('openai');
        if (Array.isArray(refs) && refs.length) {
            presets = [...new Set(refs.map(r => String(r?.name || r || '').trim()).filter(Boolean))];
        } else {
            const names = ctx?.getPresetManager?.('openai')?.getAllPresets?.();
            presets = Array.isArray(names) ? [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))] : [];
        }
    } catch (err) {
        errors.presets = String(err?.message || err);
        presets = [];
    }

    const native = {};
    for (const p of [...registry.getAskProviders(), ...registry.getIterateTargets()]) {
        if (typeof p.getNativeAi === 'function') {
            try {
                const info = p.getNativeAi(ctx);
                if (info) native[p.id] = { connection: String(info.connection || '').trim(), preset: String(info.preset || '').trim() };
            } catch { /* ignore */ }
        }
    }

    return {
        connections,
        presets,
        native,
        hasPluginOnly: presets.includes('plugin-only'),
        errors,
    };
}

function hasPreset(name) {
    const ctx = getContext();
    try {
        const refs = ctx?.presets?.list?.('openai');
        if (Array.isArray(refs) && refs.some(r => String(r?.name || r || '').trim() === name)) return true;
        return (ctx?.getPresetManager?.('openai')?.getAllPresets?.() || []).map(n => String(n).trim()).includes(name);
    } catch {
        return false;
    }
}

/** Default generation preset when none is picked: Luker's plugin-only if installed. */
export function aiTarget(role, settings = readSettings(), registry = defaultRegistry) {
    const own = settings.ai?.[role] || {};
    const def = settings.ai?.default || {};
    let nat = { connection: '', preset: '' };
    const ctx = getContext();
    for (const p of [...registry.getIterateTargets(), ...registry.getAskProviders()]) {
        if (p.id === role && typeof p.getNativeAi === 'function') {
            try { nat = p.getNativeAi(ctx) || nat; } catch { /* ignore */ }
            break;
        }
    }
    const resolved = resolveAiRow({
        own,
        native: nat,
        shared: def,
        fallbackConnection: { scope: 'current' },
        fallbackPreset: hasPreset('plugin-only')
            ? { scope: 'shared', value: 'plugin-only', implicit: true }
            : { scope: 'current' },
    });
    return {
        apiPresetName: resolved.connection?.value || '',
        llmPresetName: resolved.preset?.value || '',
    };
}

/** System prompt each role uses, for the settings page: { from, custom, text }. */
export async function promptInfo(role, registry = defaultRegistry) {
    if (role === 'ask') {
        return { from: i18n('Workbench built-in'), custom: false, text: askSystemPrompt() };
    }
    const ctx = getContext();
    for (const entry of [...registry.getIterateTargets(), ...registry.getAskProviders()]) {
        if (entry.id === role && typeof entry.promptInfo === 'function') {
            return entry.promptInfo(ctx);
        }
    }
    return { from: i18n('Not available yet'), custom: false, text: '' };
}

/**
 * One model call with tools.
 * @returns {Promise<{ text: string, calls: { id: string, name: string, args: object }[], reasoning?: string, reasoningBlocks?: any[], reasoningDetails?: any[] }>}
 */
export async function aiRequest(role, { messages, tools = [], signal = null }) {
    const ctx = getContext();
    if (!ctx) throw new SourceError('unavailable', 'Luker context is unavailable');
    if (!tools.length) throw new SourceError('bad-call', i18n('An AI call needs at least one tool'));
    const runnerFn = ctx.iterationLibrary?.runner?.requestToolCallsWithRetry
        || (await import('../iteration-library/runner.js')).requestToolCallsWithRetry;
    const result = await runnerFn(ctx, { toolCallRetryMax: 2 }, {
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
    const reasoning = String(result?.reasoning || '').trim();
    const reasoningBlocks = Array.isArray(result?.reasoningBlocks) && result.reasoningBlocks.length ? result.reasoningBlocks : undefined;
    const reasoningDetails = Array.isArray(result?.reasoningDetails) && result.reasoningDetails.length ? result.reasoningDetails : undefined;
    const reasoningMeta = {
        ...(reasoning ? { reasoning } : {}),
        ...(reasoningBlocks ? { reasoningBlocks } : {}),
        ...(reasoningDetails ? { reasoningDetails } : {}),
    };
    const text = String(result?.assistantText || result?.text || '').trim();
    if (hasTextCalls(text)) {
        const salvaged = salvageTextCalls(text, tools.map(t => t?.function?.name).filter(Boolean));
        return { text: salvaged.text, calls: calls.length ? calls : salvaged.calls, ...reasoningMeta };
    }
    return { text, calls, ...reasoningMeta };
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
    const ctx = getContext();
    const res = await fetch('/api/request-inspector/list', { headers: ctx?.getRequestHeaders?.() || {} });
    if (!res.ok) throw new SourceError('inspector', i18nFormat('Request inspector unreadable (HTTP ${0})', res.status));
    const list = await res.json();
    return Array.isArray(list) ? list : [];
}

export async function inspectorDetail(id) {
    const ctx = getContext();
    const res = await fetch(`/api/request-inspector/${encodeURIComponent(id)}`, { headers: ctx?.getRequestHeaders?.() || {} });
    if (!res.ok) throw new SourceError('inspector', i18nFormat('This request is unreadable (HTTP ${0})', res.status));
    return res.json();
}

/** Request list, newest first, with a guessed source. */
export async function listRequests({ limit = 60 } = {}) {
    const list = (await inspectorList()).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit); // cap-ok: default page limit matching wb_list_requests schema when caller omits limit
    return list.map(e => ({ ...e, attr: attribute(e) }));
}

export function frontendLogs({ limit = 60, level = 'all', search = '' } = {}) {
    const levels = level === 'error' ? ['error'] : level === 'warn' ? ['warn', 'error'] : null;
    const needle = String(search || '').toLowerCase();
    const all = getFrontendLogsSnapshot({ limit: 3000 }).entries || []; // cap-ok: snapshot read upper bound before filtering; output rows are bounded to 200 below
    return all
        .filter(e => !levels || levels.includes(String(e.level)))
        .filter(e => !needle || String(e.message || '').toLowerCase().includes(needle))
        .slice(-Math.max(1, Math.min(200, limit))) // cap-ok: matches Ask tool schema limit to keep response within LLM context window
        .map(e => ({
            time: new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false }),
            level: e.level,
            source: e.source,
            message: String(e.message || '').slice(0, 800), // cap-ok: per-log-line bound so one verbose stack dump does not consume the MAX_TOOL_CHARS budget
        }));
}

export function frontendLogCount() {
    return getFrontendLogsSnapshot({ limit: 3000 }).entries?.length ?? null; // cap-ok: matches frontendLogs snapshot read upper bound
}

/** Whether Luker's frontend debug logging switch is on. */
export function debugLoggingOn() {
    if (typeof document === 'undefined') return null;
    const box = document.getElementById('frontend_debug_logging');
    if (box) return Boolean(box.checked);
    return null;
}

/** Turns the switch on through Luker's own control, so it is saved like a user click. */
export function enableDebugLogging() {
    const box = typeof document !== 'undefined' ? document.getElementById('frontend_debug_logging') : null;
    if (!box) throw new SourceError('logs', i18n('The "Frontend debug logging" switch was not found — turn it on in User Settings'));
    if (!box.checked) {
        box.checked = true;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
}

export async function serverLogs({ limit = 60, search = '' } = {}) {
    const ctx = getContext();
    const res = await fetch('/api/users/logs/get', {
        method: 'POST',
        headers: ctx?.getRequestHeaders?.() || {},
        body: JSON.stringify({ limit: Math.max(1, Math.min(200, limit)), searchTerm: String(search || '') }), // cap-ok: matches Ask tool schema limit to keep response within LLM context window
    });
    if (res.status === 403 || res.status === 401) throw new SourceError('logs', i18n('Server logs need admin rights'));
    if (!res.ok) throw new SourceError('logs', i18nFormat('Server logs unreadable (HTTP ${0})', res.status));
    const data = await res.json();
    const entries = Array.isArray(data?.entries) ? data.entries : Array.isArray(data) ? data : [];
    return entries.map(e => ({
        time: new Date(Number(e.timestamp) || Date.now()).toLocaleTimeString('zh-CN', { hour12: false }),
        level: e.level,
        message: String(e.message || '').slice(0, 800), // cap-ok: per-log-line bound so one verbose server log does not consume the MAX_TOOL_CHARS budget
    }));
}

function chatMessages({ from, to, floors } = {}) {
    const ctx = getContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    if (!chat.length) return { total: 0, messages: [] };
    const last = chat.length - 1;
    const configured = floors !== undefined ? floors : readSettings(ctx).ask?.floors;
    const isAll = configured === 'all';
    const hasNumericFloor = configured !== null && configured !== undefined && configured !== '' && Number.isFinite(Number(configured));
    const numFloors = isAll ? null : Math.max(0, hasNumericFloor ? Number(configured) : 2);
    const maxSpan = isAll ? chat.length : (numFloors === 0 ? 1 : numFloors * 2 + 1);

    let start;
    let end;
    if (Number.isFinite(Number(from)) || Number.isFinite(Number(to))) {
        start = Number.isFinite(Number(from)) ? Math.max(0, Number(from)) : Math.max(0, Number(to) - maxSpan + 1);
        end = Number.isFinite(Number(to)) ? Math.min(last, Number(to)) : Math.min(last, start + maxSpan - 1);
        if (!isAll && end - start + 1 > maxSpan) {
            end = Math.min(last, start + maxSpan - 1);
        }
    } else {
        start = isAll ? 0 : Math.max(0, last - maxSpan + 1);
        end = last;
    }

    const out = [];
    for (let i = start; i <= end && i <= last; i++) {
        const m = chat[i];
        if (!m) continue;
        out.push({
            floor: i,
            who: m.is_user ? '用户' : m.is_system ? '系统' : (m.name || i18n('Character')),
            text: String(m.mes || '').slice(0, 4000), // cap-ok: per-floor message bound so one long reply does not crowd out neighboring floors within MAX_TOOL_CHARS
            model: m.extra?.model || '',
        });
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
    return Object.fromEntries(want.filter(k => k in all).map(k => [k, String(all[k] ?? '')]));
}

export async function boundBooks(ctx = getContext()) {
    if (!ctx) return [];
    const names = new Set();
    const c = currentCharacter(ctx);
    if (c) {
        const full = ctx.characters[c.index];
        if (full?.data?.extensions?.world) names.add(String(full.data.extensions.world));
        try { for (const n of ctx.getCharaAuxWorlds?.(full?.avatar?.replace(/\.[^.]+$/, '')) || []) names.add(String(n)); } catch { /* ignore */ }
    }
    try { for (const n of ctx.chatWorldInfo?.getNames?.() || []) names.add(String(n)); } catch { /* ignore */ }
    try { for (const n of ctx.chatWorldInfo?.globalSelection || []) names.add(String(n)); } catch { /* ignore */ }
    return [...names].filter(Boolean);
}

async function worldInfo({ search = '' } = {}) {
    const ctx = getContext();
    const books = await boundBooks(ctx);
    const needle = String(search || '').toLowerCase();
    const out = [];
    const errors = [];
    outer: for (const name of books) {
        let data = null;
        try {
            data = await ctx.loadWorldInfo?.(name);
        } catch (err) {
            console.warn(`[workbench] failed to load world book "${name}":`, err);
            errors.push({ book: name, error: String(err?.message || err) });
            continue;
        }
        const entries = Object.values(data?.entries || {});
        for (const e of entries) {
            const keys = [...(e.key || []), ...(e.keysecondary || [])].map(String);
            const hay = `${keys.join(' ')} ${e.comment || ''} ${e.content || ''}`.toLowerCase();
            if (needle && !hay.includes(needle)) continue;
            out.push({
                book: name,
                title: e.comment || keys[0] || `#${e.uid}`,
                keys,
                enabled: !e.disable,
                constant: Boolean(e.constant),
                content: needle ? String(e.content || '') : undefined,
            });
            if (out.length >= 60) break outer; // cap-ok: bounds world-info entry list before JSON serialization and MAX_TOOL_CHARS clipping
        }
    }
    return errors.length ? { books, entries: out, errors } : { books, entries: out };
}

function presetDetail({ entry = '' } = {}) {
    const ctx = getContext();
    const live = ctx?.presets?.getLive?.('openai');
    const body = live?.body || {};
    const order = (body.prompt_order || []).find(o => Number(o.character_id) === 100001) || (body.prompt_order || [])[0];
    const byId = new Map((body.prompts || []).map(p => [p.identifier, p]));
    const items = (order?.order || []).map(o => ({ ...byId.get(o.identifier), enabled: o.enabled })).filter(p => p.identifier);
    if (entry) {
        const hit = items.find(p => p.name === entry || p.identifier === entry);
        return hit ? { name: hit.name, enabled: hit.enabled, role: hit.role, content: String(hit.content || '') } : { error: `没有叫「${entry}」的条目` };
    }
    return {
        name: live?.ref?.name || '',
        settings: { temperature: body.temperature, max_context: body.openai_max_context, max_tokens: body.openai_max_tokens, stream: body.stream_openai },
        entries: items.map(p => ({
            name: p.name || p.identifier,
            enabled: p.enabled,
            marker: Boolean(p.marker),
            preview: p.marker ? '（系统占位：角色卡 / 世界书 / 聊天等）' : String(p.content || '').slice(0, 120), // cap-ok: short entry preview when listing all preset entries; full entry is read via entry param
        })),
    };
}

export function askToolsForProviders(registry = defaultRegistry) {
    const tools = [];
    for (const p of registry.getAskProviders()) {
        for (const t of Array.isArray(p.tools) ? p.tools : []) {
            tools.push(t);
        }
    }
    return tools;
}

/** Reader functions keyed by tool name (see model/ask.js), gated by `sources`. */
export function askReaders({ redactText = true, suggestions = () => [], sources = null, registry = defaultRegistry } = {}) {
    const on = (key) => !sources || sources[key] !== false;
    const readers = {};

    if (on('inspector')) {
        readers.wb_list_requests = async ({ limit = 20, only_errors = false } = {}) => {
            const list = await listRequests({ limit: 200 });
            const pick = list.filter(e => !only_errors || e.status === 'error' || e.error).slice(0, Math.max(1, Math.min(60, limit))); // cap-ok: matches Ask tool schema limit to keep response within LLM context window
            return pick.map(e => describeRequest(e, e.attr));
        };
        readers.wb_read_request = async ({ id, part = 'both' } = {}) => {
            const d = await inspectorDetail(id);
            const msgs = (d.fullMessages || []).map(m => ({
                role: m.role,
                // cap-ok: per-message bound in request inspector dump so later messages and reply remain visible within MAX_TOOL_CHARS
                content: typeof m.content === 'string' ? m.content.slice(0, 3000) : JSON.stringify(m.content).slice(0, 3000),
            }));
            const out = { id: d.id, model: d.model, status: d.status, httpStatus: d.httpStatus, error: d.error, durationMs: d.durationMs, usage: d.usage, finishReason: d.finishReason };
            if (part !== 'reply') out.messages = msgs;
            if (part !== 'messages') out.reply = String(d.responseText || '').slice(0, 6000); // cap-ok: bounds responseText alongside messages within MAX_TOOL_CHARS
            return out;
        };
    }

    if (on('frontLogs')) {
        readers.wb_read_frontend_logs = async (args) => frontendLogs(args);
    }

    if (on('serverLogs')) {
        readers.wb_read_server_logs = async (args) => serverLogs(args);
    }

    if (on('content')) {
        readers.wb_read_chat = async (args) => chatMessages(args);
        readers.wb_read_character = async (args) => characterFields(args);
        readers.wb_read_world_info = async (args) => worldInfo(args);
        readers.wb_read_preset = async (args) => presetDetail(args);
        readers.wb_read_last_prompt = async () => {
            const snap = await loadSnapshot(registry);
            return snap?.budget || { error: '还没有提示词数据（要先生成一次回复，且是对话补全接口）' };
        };
    }

    if (on('plugins')) {
        readers.wb_read_suggestions = async () => suggestions().map(s => ({ text: s.text, why: s.why }));
        const ctx = getContext();
        for (const p of registry.getAskProviders()) {
            if (p.readers && typeof p.readers === 'object') {
                for (const [toolName, fn] of Object.entries(p.readers)) {
                    if (typeof fn === 'function') {
                        readers[toolName] = (args) => fn(args, ctx);
                    }
                }
            }
        }
    }

    return redactReaders(readers, redactText);
}

/** Compact overview sent with every question, filtered by `sources` & redaction. */
export async function askOverview({
    sources = null,
    inspector,
    frontLogs,
    content,
    plugins,
    redactText = true,
    registry = defaultRegistry,
} = {}) {
    const src = sources && typeof sources === 'object' ? sources : {};
    const allow = (key, explicit) => (explicit !== undefined ? explicit !== false : src[key] !== false);
    const effectiveSources = {
        inspector: allow('inspector', inspector),
        frontLogs: allow('frontLogs', frontLogs),
        content: allow('content', content),
        plugins: allow('plugins', plugins),
    };

    const ctx = getContext();
    const raw = {};
    const pluginKeys = [];

    if (effectiveSources.content && ctx) {
        const chat = chatInfo(ctx);
        const card = cardPart(ctx, chat);
        const preset = presetPart(ctx);
        let memoryTokens = 0;
        if (effectiveSources.plugins) {
            const { memoryTokens: mTok } = await collectProviderSnapshots(ctx, registry);
            memoryTokens = mTok;
        }
        const budget = chat.chatId && chat.floors > 0 ? await budgetPart(memoryTokens) : null;
        raw.聊天 = chat.label ? `${chat.label}，${chat.floors} 楼` : '没有打开聊天';
        raw.角色卡 = card?.name || i18n('None selected');
        raw.预设 = preset?.name || '';
        raw.连接 = connectionName(ctx);
        raw.提示词 = budget
            ? Object.fromEntries([['合计', budget.total], ['上限', budget.max], ...budget.parts.map(p => [p.label, p.tokens])])
            : '没有数据';
    }

    if (effectiveSources.plugins && ctx) {
        for (const p of registry.getAskProviders()) {
            if (typeof p.getOverview !== 'function') continue;
            const key = String(p.overviewKey || p.label || p.id);
            pluginKeys.push(key);
            try {
                const value = await p.getOverview(ctx);
                if (value !== undefined && value !== null) raw[key] = value;
            } catch {
                raw[key] = i18n('Unreadable');
            }
        }
    }

    if (effectiveSources.inspector) {
        try {
            raw.最近的请求 = (await listRequests({ limit: 8 })).map(e => describeRequest(e, e.attr));
        } catch {
            raw.最近的请求 = i18n('Unreadable');
        }
    }

    if (effectiveSources.frontLogs) {
        const debug = debugLoggingOn();
        raw.调试日志开关 = debug === null ? '未知' : debug ? '开' : '关';
    }

    return finishOverview(raw, {
        sources: effectiveSources,
        pluginKeys,
        redactText,
    });
}

/** Latest non-user, non-system reply in the active chat. */
export function lastReply(ctx = getContext()) {
    const chat = ctx?.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system && m.mes) {
            return `（第 ${i} 楼，${m.name || i18n('Character')}）\n${String(m.mes)}`;
        }
    }
    return '';
}

/** Creates the source object wired into `mountWorkbench()` by default. */
export function createLukerSource(registry = defaultRegistry) {
    return {
        readSettings: () => readSettings(),
        writeSettings: (next) => writeSettings(next),
        loadSnapshot: () => loadSnapshot(registry),
        subscribe: (onChange) => subscribe(onChange),
        historyStorage: () => historyStorage(),
        createSessions: () => createSessions(),
        runRules: (snap, opts) => runRules(snap, opts),
        listRequests: (opts) => listRequests(opts),
        frontendLogCount: () => frontendLogCount(),
        debugLoggingOn: () => debugLoggingOn(),
        enableDebugLogging: () => enableDebugLogging(),
        askOverview: (opts) => askOverview({ ...opts, registry }),
        askReaders: (opts) => askReaders({ ...opts, registry }),
        askToolsForProviders: () => askToolsForProviders(registry),
        lastReply: () => lastReply(),
        aiRequest: (role, opts) => aiRequest(role, opts),
        aiTest: (role) => aiTest(role),
        listAiChoices: () => listAiChoices(registry),
        promptInfo: (role) => promptInfo(role, registry),
    };
}
