// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Everything the workbench reads from (and writes to) Luker core via
// Luker.getContext() and registered platform providers (AskProvider,
// SuggestRuleProvider, IterateTarget). Zero direct extension imports.

import { getFrontendLogsSnapshot } from '../frontend-log-manager.js';
import { accountLocalStorage } from '../lens-shared/current-account.js';
import { describeToolChoice, normalizeRequestId, normalizeWireTools } from '../request-inspector-tools.js';
import { joinReasoningDetailsText } from '../util/reasoning-details.js';
import { i18n, i18nFormat } from './i18n.js';
import { askSystemPrompt } from './model/ask.js';
import { buildBudget } from './model/budget.js';
import { SourceError } from './model/errors.js';
import { searchLukerDocs } from './model/luker-docs.js';
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
export async function aiRequest(role, { messages, tools = [], signal = null, activity = undefined }) {
    const ctx = getContext();
    if (!ctx) throw new SourceError('unavailable', 'Luker context is unavailable');
    if (!tools.length) throw new SourceError('bad-call', i18n('An AI call needs at least one tool'));
    const runnerFn = ctx.iterationLibrary?.runner?.requestToolCallsWithRetry
        || (await import('../iteration-library/runner.js')).requestToolCallsWithRetry;
    const isAsk = role === 'ask';
    const result = await runnerFn(ctx, { toolCallRetryMax: 2 }, {
        taskMessages: messages,
        runtimeWorldInfo: null,
        ...aiTarget(role),
        tools,
        allowedNames: new Set(tools.map(t => t?.function?.name).filter(Boolean)),
        abortSignal: signal,
        includeAssistantText: true,
        allowNoToolCalls: true,
        // 「问问」属于纯诊断问答，不塞入角色卡与角色扮演预设外壳，避免指令冲突与 token 浪费。
        ...(isAsk ? { includeCharacterCard: false, bypassPresetEnvelope: true } : {}),
        ...(activity !== undefined ? { activity } : {}),
    });
    const calls = (Array.isArray(result?.toolCalls) ? result.toolCalls : []).map((c, i) => {
        const sig = c?.raw?.signature || c?.raw?.thoughtSignature;
        return {
            id: String(c?.id || `wb_${Date.now().toString(36)}_${i}`),
            name: String(c?.name || ''),
            args: c?.args && typeof c.args === 'object' ? c.args : {},
            ...(sig ? { signature: sig } : {}),
            ...(c?.raw?.extra_content ? { extra_content: c.raw.extra_content } : {}),
        };
    });
    const reasoning = typeof result?.reasoning === 'string' && result.reasoning.length > 0 ? result.reasoning : '';
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
    await aiRequest(role, {
        messages: [{ role: 'system', content: '这是连接测试。调用 wb_ok 工具一次，不要输出别的。' }, { role: 'user', content: '测试连接' }],
        tools,
        activity: false,
    });
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
    const safeId = normalizeRequestId(id);
    if (!safeId) throw new SourceError('inspector', i18n('Invalid request ID'));
    const ctx = getContext();
    const res = await fetch(`/api/request-inspector/${encodeURIComponent(safeId)}`, { headers: ctx?.getRequestHeaders?.() || {} });
    if (!res.ok) throw new SourceError('inspector', i18nFormat('This request is unreadable (HTTP ${0})', res.status));
    const data = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new SourceError('inspector', i18n('This request returned an invalid response'));
    }
    return data;
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

function chatMessages({ from, to, floors, search = '' } = {}) {
    const ctx = getContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    if (!chat.length) return { total: 0, messages: [] };
    const last = chat.length - 1;
    const configured = floors !== undefined ? floors : readSettings(ctx).ask?.floors;
    const isAll = configured === 'all';
    const hasNumericFloor = configured !== null && configured !== undefined && configured !== '' && Number.isFinite(Number(configured));
    const numFloors = isAll ? null : Math.max(0, hasNumericFloor ? Number(configured) : 2);
    const maxSpan = isAll ? chat.length : (numFloors === 0 ? 1 : numFloors * 2 + 1);

    const formatFloor = (i) => {
        const m = chat[i];
        if (!m) return null;
        const swipesCount = Array.isArray(m.swipes) ? m.swipes.length : 0;
        const varOpsCount = Array.isArray(m.extra?.var_ops) ? m.extra.var_ops.length : 0;
        return {
            floor: i,
            who: m.is_user ? '用户' : m.is_system ? '系统' : (m.name || i18n('Character')),
            text: String(m.mes || '').slice(0, 4000), // cap-ok: 单楼层文本上限，避免单条超长回复占满单次工具预算
            model: m.extra?.model || '',
            ...(swipesCount > 1 ? { swipes: swipesCount, swipeId: Number(m.swipe_id || 0) } : {}),
            ...(varOpsCount > 0 ? { varOpsCount } : {}),
            ...(m.extra?.reasoning ? { hasReasoning: true } : {}),
        };
    };

    const needle = String(search || '').trim().toLowerCase();
    if (needle) {
        const hits = [];
        for (let i = 0; i <= last; i++) {
            const m = chat[i];
            if (!m) continue;
            const text = String(m.mes || '');
            if (text.toLowerCase().includes(needle)) hits.push(i);
        }
        const cappedBySetting = !isAll && hits.length > maxSpan;
        const picked = cappedBySetting ? hits.slice(-maxSpan) : hits;
        return {
            total: chat.length,
            search: String(search).trim(),
            totalMatches: hits.length,
            matchedFloors: hits.slice(-30), // cap-ok: 最多返回最近 30 个命中楼层号索引，方便模型分段翻阅
            maxSpan,
            cappedBySetting,
            ...(cappedBySetting ? { hint: `当前设置限制每次最多读取 ${maxSpan} 楼；可不带 search 指定 from/to 分段读取其余命中楼层，或在设置中调大「聊天原文最多带几楼」。` } : {}),
            messages: picked.map(formatFloor).filter(Boolean),
        };
    }

    let start;
    let end;
    let cappedBySetting = false;
    if (Number.isFinite(Number(from)) || Number.isFinite(Number(to))) {
        start = Number.isFinite(Number(from)) ? Math.max(0, Number(from)) : Math.max(0, Number(to) - maxSpan + 1);
        end = Number.isFinite(Number(to)) ? Math.min(last, Number(to)) : Math.min(last, start + maxSpan - 1);
        if (!isAll && end - start + 1 > maxSpan) {
            end = Math.min(last, start + maxSpan - 1);
            cappedBySetting = true;
        }
    } else {
        start = isAll ? 0 : Math.max(0, last - maxSpan + 1);
        end = last;
        cappedBySetting = !isAll && chat.length > maxSpan;
    }

    const out = [];
    for (let i = start; i <= end && i <= last; i++) {
        const row = formatFloor(i);
        if (row) out.push(row);
    }
    return {
        total: chat.length,
        returnedRange: out.length ? [out[0].floor, out[out.length - 1].floor] : [],
        maxSpan,
        cappedBySetting,
        ...(cappedBySetting ? { hint: `当前设置限制单次最多读取 ${maxSpan} 楼（已返回 ${start}–${end} 楼）；如需查更早内容可传 search 或分段传 from/to。` } : {}),
        messages: out,
    };
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

async function worldInfo({ search = '', book = '', only_enabled = false, offset = 0 } = {}) {
    const ctx = getContext();
    const books = await boundBooks(ctx);
    const bookNeedle = String(book || '').trim().toLowerCase();
    const targetBooks = bookNeedle ? books.filter(b => b.toLowerCase().includes(bookNeedle)) : books;
    const needle = String(search || '').trim().toLowerCase();
    const skip = Math.max(0, Math.floor(Number(offset) || 0));
    const maxEntries = 60; // cap-ok: 单次最多返回 60 条世界书条目元数据/正文，配合 offset 支持分页
    const out = [];
    const errors = [];
    let totalMatched = 0;
    let truncated = false;
    for (const name of targetBooks) {
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
            const enabled = !e.disable;
            if (only_enabled && !enabled) continue;
            const keys = [...(e.key || []), ...(e.keysecondary || [])].map(String);
            const hay = `${keys.join(' ')} ${e.comment || ''} ${e.content || ''}`.toLowerCase();
            if (needle && !hay.includes(needle)) continue;
            totalMatched++;
            if (totalMatched <= skip) continue;
            if (out.length >= maxEntries) {
                truncated = true;
                continue;
            }
            out.push({
                book: name,
                uid: e.uid,
                title: e.comment || keys[0] || `#${e.uid}`,
                keys,
                enabled,
                constant: Boolean(e.constant),
                position: e.position ?? null,
                depth: e.depth ?? null,
                order: e.order ?? null,
                probability: e.useProbability ? (e.probability ?? 100) : 100,
                content: needle ? String(e.content || '') : undefined,
            });
        }
    }
    return {
        books,
        totalMatched,
        ...(skip ? { offset: skip } : {}),
        ...(truncated ? { truncated: true } : {}),
        entries: out,
        ...(errors.length ? { errors } : {}),
    };
}

/** 读取当前聊天的世界书激活链路追踪快照，用于诊断为何某条目触发或未触发。 */
async function worldInfoTrace({ search = '', only_activated = false, limit = 40 } = {}) {
    const ctx = getContext();
    const snap = await ctx?.chatWorldInfo?.getActivationTrace?.();
    if (!snap || !Array.isArray(snap.entries)) {
        return { available: false, message: '当前环境未提供世界书激活追踪数据' };
    }
    if (!snap.entries.length) {
        return { scopeKey: snap.scopeKey, total: 0, entries: [], message: '当前聊天尚未产生世界书扫描追踪记录（至少生成一次回复后才会记录）' };
    }

    const maxItems = Math.max(1, Math.min(80, Math.floor(Number(limit) || 40))); // cap-ok: 限制单次返回追踪条目数在上下文安全范围内
    const needle = String(search || '').trim().toLowerCase();

    // 尝试批量关联书内条目标题与关键词，便于模型直呼条目名而非仅看 uid。
    const titleIndex = new Map();
    const bookNames = [...new Set(snap.entries.map(e => String(e.world || '')).filter(Boolean))];
    await Promise.all(bookNames.map(async (bookName) => {
        try {
            const data = await ctx.loadWorldInfo?.(bookName);
            for (const entry of Object.values(data?.entries || {})) {
                titleIndex.set(`${bookName}.${entry.uid}`, {
                    title: entry.comment || (entry.key || [])[0] || `#${entry.uid}`,
                    keys: [...(entry.key || []), ...(entry.keysecondary || [])].map(String),
                });
            }
        } catch { /* 单本世界书读取失败不影响追踪摘要 */ }
    }));

    const rows = [];
    for (const item of snap.entries) {
        const realScan = Array.isArray(item.recentScans) && item.recentScans.length ? item.recentScans[0] : null;
        const dryScan = Array.isArray(item.recentDryRunScans) && item.recentDryRunScans.length ? item.recentDryRunScans[0] : null;
        const latest = realScan || dryScan;
        const activated = Boolean(latest?.activated);
        if (only_activated && !activated) continue;

        const meta = titleIndex.get(`${item.world}.${item.uid}`) || {};
        const activation = activated ? (latest?.lastActivation || null) : null;
        const lastActivation = item.lastActivation || item.lastDryRunActivation || null;
        const attempts = Array.isArray(latest?.attempts) ? latest.attempts.slice(0, 6) : []; // cap-ok: 保留最近 6 条尝试原因摘要
        const hay = `${item.world} ${item.uid} ${meta.title || ''} ${(meta.keys || []).join(' ')} ${JSON.stringify(activation || '')} ${JSON.stringify(lastActivation || '')} ${JSON.stringify(attempts)}`.toLowerCase();
        if (needle && !hay.includes(needle)) continue;

        rows.push({
            world: item.world,
            uid: item.uid,
            title: meta.title || `#${item.uid}`,
            keys: meta.keys || [],
            activated,
            dryRunOnly: !realScan && Boolean(dryScan),
            lastActivatedAt: item.lastActivatedAt ? new Date(item.lastActivatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : null,
            activation,
            lastActivation,
            attempts,
        });
    }

    // 激活的条目优先排在前面，其次按世界书与 uid 排序。
    rows.sort((a, b) => Number(b.activated) - Number(a.activated) || a.world.localeCompare(b.world) || a.uid - b.uid);
    return {
        scopeKey: snap.scopeKey,
        totalTracked: snap.entries.length,
        matched: rows.length,
        activatedCount: rows.filter(r => r.activated).length,
        entries: rows.slice(0, maxItems),
    };
}

/** 读取当前聊天变量、可选全局变量与最近带变量操作的楼层日志（Variable Op Log）。 */
function readVariables({ search = '', include_global = false, op_floors = 10 } = {}) {
    const ctx = getContext();
    if (!ctx) return { error: 'Luker 上下文不可用' };
    const needle = String(search || '').trim().toLowerCase();
    const maxOpFloors = Math.max(1, Math.min(30, Math.floor(Number(op_floors) || 10))); // cap-ok: 限制单次返回含变量操作的楼层数

    const filterObject = (obj) => {
        if (!obj || typeof obj !== 'object') return {};
        const entries = Object.entries(obj);
        if (!needle) return Object.fromEntries(entries.slice(0, 80)); // cap-ok: 避免超多变量一次撑爆上下文
        return Object.fromEntries(entries.filter(([k, v]) => {
            const text = `${k} ${typeof v === 'string' ? v : JSON.stringify(v ?? '')}`.toLowerCase();
            return text.includes(needle);
        }));
    };

    const rawLocal = ctx.chatMetadata?.variables && typeof ctx.chatMetadata.variables === 'object'
        ? ctx.chatMetadata.variables
        : {};
    const localKeysTotal = Object.keys(rawLocal).length;
    const localVariables = filterObject(rawLocal);

    const out = {
        localTotalKeys: localKeysTotal,
        localVariables,
    };

    if (include_global) {
        const rawGlobal = ctx.extensionSettings?.variables?.global && typeof ctx.extensionSettings.variables.global === 'object'
            ? ctx.extensionSettings.variables.global
            : {};
        out.globalTotalKeys = Object.keys(rawGlobal).length;
        out.globalVariables = filterObject(rawGlobal);
    }

    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const floorOps = [];
    for (let i = chat.length - 1; i >= 0 && floorOps.length < maxOpFloors; i--) {
        const m = chat[i];
        const ops = Array.isArray(m?.extra?.var_ops) ? m.extra.var_ops : [];
        if (!ops.length) continue;
        const filteredOps = needle
            ? ops.filter(op => `${op?.key || ''} ${op?.path || ''} ${op?.op || ''} ${JSON.stringify(op?.value ?? '')}`.toLowerCase().includes(needle))
            : ops;
        if (needle && !filteredOps.length) continue;
        floorOps.push({
            floor: i,
            who: m.is_user ? '用户' : (m.name || i18n('Character')),
            ops: filteredOps.slice(0, 30), // cap-ok: 单楼层最多展示 30 条变量操作
        });
    }
    out.recentFloorOps = floorOps;
    return out;
}

/** 读取 Luker 生效的正则脚本（全局/角色/预设/插件通道），排查吞字、乱码或状态栏异常。 */
function readRegexScripts({ scope = 'all', search = '', only_enabled = true } = {}) {
    const ctx = getContext();
    if (!ctx?.regex) return { available: false, message: '当前环境未暴露正则接口' };
    const regexDisabled = Array.isArray(ctx.extensionSettings?.disabledExtensions)
        && ctx.extensionSettings.disabledExtensions.includes('regex');
    const types = ctx.regex.SCRIPT_TYPES || { GLOBAL: 0, SCOPED: 1, PRESET: 2 };
    const needle = String(search || '').trim().toLowerCase();
    const scriptKey = (s) => `${String(s?.id || '')}|${String(s?.scriptName || '')}`;

    const buckets = [];
    const pushList = (bucketScope, list, allowedKeys = null) => {
        for (const s of Array.isArray(list) ? list : []) {
            if (!s || typeof s !== 'object') continue;
            if (only_enabled && s.disabled) continue;
            const hay = `${s.scriptName || ''} ${s.findRegex || ''} ${s.replaceString || ''} ${s.__runtime_owner || ''}`.toLowerCase();
            if (needle && !hay.includes(needle)) continue;
            const lanes = typeof ctx.regex.getPluginLanes === 'function'
                ? ctx.regex.getPluginLanes(s)
                : (Array.isArray(s.pluginLanes) ? s.pluginLanes : (s.pluginOnly ? ['request', 'reply'] : []));
            buckets.push({
                scope: bucketScope,
                id: String(s.id || ''),
                name: String(s.scriptName || s.id || '未命名正则'),
                enabled: !s.disabled,
                ...(bucketScope === 'character' || bucketScope === 'preset' ? { allowed: Boolean(allowedKeys?.has(scriptKey(s))) } : {}),
                ...(bucketScope === 'plugin' ? { owner: String(s.__runtime_owner || '') } : {}),
                findRegex: String(s.findRegex || '').slice(0, 300), // cap-ok: 单条正则匹配式预览上限
                replacePreview: String(s.replaceString || '').slice(0, 300), // cap-ok: 单条替换串预览上限
                placement: Array.isArray(s.placement) ? s.placement : [],
                markdownOnly: Boolean(s.markdownOnly),
                promptOnly: Boolean(s.promptOnly),
                minDepth: s.minDepth ?? null,
                maxDepth: s.maxDepth ?? null,
                ...(Array.isArray(lanes) && lanes.length ? { pluginLanes: lanes } : {}),
            });
        }
    };

    try {
        if (scope === 'all' || scope === 'global') pushList('global', ctx.regex.getScriptsByType?.(types.GLOBAL, { allowedOnly: false }));
        if (scope === 'all' || scope === 'character') {
            const scopedAll = ctx.regex.getScriptsByType?.(types.SCOPED, { allowedOnly: false }) || [];
            const scopedAllowed = ctx.regex.getScriptsByType?.(types.SCOPED, { allowedOnly: true }) || [];
            pushList('character', scopedAll, new Set(scopedAllowed.map(scriptKey)));
        }
        if (scope === 'all' || scope === 'preset') {
            const presetAll = ctx.regex.getScriptsByType?.(types.PRESET, { allowedOnly: false }) || [];
            const presetAllowed = ctx.regex.getScriptsByType?.(types.PRESET, { allowedOnly: true }) || [];
            pushList('preset', presetAll, new Set(presetAllowed.map(scriptKey)));
        }
        if (scope === 'all' || scope === 'plugin') {
            const allScripts = ctx.regex.getScripts?.({ allowedOnly: false }) || [];
            const runtimeOnly = allScripts.filter(s => Boolean(s?.__runtime_owner));
            pushList('plugin', runtimeOnly);
        }
    } catch (err) {
        return { regexExtensionEnabled: !regexDisabled, error: String(err?.message || err), scripts: buckets };
    }

    return {
        regexExtensionEnabled: !regexDisabled,
        totalMatched: buckets.length,
        scripts: buckets.slice(0, 80), // cap-ok: 限制单次返回正则脚本条数
    };
}

function parseProfileBool(value) {
    if (typeof value === 'boolean') return value;
    const norm = String(value ?? '').trim().toLowerCase();
    return norm === 'true' || norm === '1' || norm === 'yes' || norm === 'on';
}

/** 读取脱敏后的 Luker 运行环境与功能状态（连接配置、扩展、搜索工具、技能、同步）。 */
async function readLukerEnv({ part = 'summary' } = {}, registry = defaultRegistry, sources = null) {
    const ctx = getContext();
    if (!ctx) return { error: 'Luker 上下文不可用' };
    const contentAllowed = !sources || sources.content !== false;

    const safeConnections = () => {
        const list = ctx.connectionProfiles?.list?.() || [];
        return list.map(p => ({
            name: String(p?.name || ''),
            api: String(p?.api || p?.mode || ''),
            model: String(p?.model || ''),
            proxy: String(p?.proxy || ''),
            plainTextFunctionCalling: parseProfileBool(p?.['function-calling-plain-text']),
            rpmLimit: p?.['rpm-limit'] ?? null,
            requestTimeout: p?.['request-timeout'] ?? null,
            maxRetries: p?.['max-request-retries'] ?? null,
            hasCustomUrl: Boolean(String(p?.['api-url'] || '').trim()),
            hasNetworkProxy: Boolean(String(p?.['network-proxy'] || '').trim()),
        }));
    };

    const safeExtensions = () => {
        const installed = ctx.listExtensionNames?.() || [];
        const disabled = Array.isArray(ctx.extensionSettings?.disabledExtensions)
            ? ctx.extensionSettings.disabledExtensions.map(String)
            : [];
        const disabledSet = new Set(disabled);
        const hookOrder = ctx.extensionSettings?.hook_order?.orderByEvent || null;
        return {
            installedCount: installed.length,
            enabled: installed.filter(n => !disabledSet.has(n)),
            disabled,
            ...(hookOrder && Object.keys(hookOrder).length ? { hookOrder } : {}),
        };
    };

    const safeSearchTools = () => {
        const st = ctx.extensionSettings?.search_tools;
        if (!st || typeof st !== 'object') return { installed: false };
        return {
            installed: true,
            enabled: Boolean(st.enabled),
            preRequestEnabled: Boolean(st.preRequestEnabled),
            provider: String(st.provider || ''),
            lorebookPosition: st.lorebookPosition ?? null,
            lorebookDepth: st.lorebookDepth ?? null,
        };
    };

    const safeSkills = async () => {
        if (typeof ctx.skills?.list !== 'function') return { available: false };
        try {
            const items = await ctx.skills.list({ scope: 'all' });
            const rawList = Array.isArray(items) ? items : [];
            const list = contentAllowed
                ? rawList
                : rawList.filter(s => s?.scope?.kind !== 'character' && s?.scope?.kind !== 'preset');
            return {
                available: true,
                total: list.length,
                skills: list.slice(0, 60).map(s => ({ // cap-ok: 限制技能清单返回条数
                    name: String(s?.name || ''),
                    scope: s?.scope || null,
                    description: String(s?.description || '').slice(0, 160), // cap-ok: 技能简述上限
                })),
            };
        } catch (err) {
            return { available: false, error: String(err?.message || err) };
        }
    };

    const safeSync = async () => {
        try {
            const res = await fetch('/api/sync/v1/status', { headers: ctx.getRequestHeaders?.() || {} });
            if (!res.ok) return { available: false, httpStatus: res.status };
            const data = await res.json();
            const backends = Object.entries(data?.backends || {}).map(([id, b]) => ({
                id,
                kind: b?.kind || b?.type || '',
                label: String(b?.label || ''),
                running: Boolean(b?.running),
                lastSyncAt: b?.lastSync?.at || b?.lastSync?.finishedAt || null,
                lastError: b?.lastSync?.error || '',
                pendingError: typeof b?.pendingError === 'string'
                    ? b.pendingError
                    : String(b?.pendingError?.message || b?.pendingError?.code || ''),
                stalledCount: Array.isArray(b?.lastSync?.stalled) ? b.lastSync.stalled.length : 0,
            }));
            const errors = Array.isArray(data?.errors)
                ? data.errors
                : (data?.errors && typeof data.errors === 'object'
                    ? Object.entries(data.errors).map(([backendId, err]) => ({
                        backendId,
                        ...(err && typeof err === 'object' ? err : { message: String(err) }),
                    }))
                    : []);
            return {
                available: true,
                backendCount: backends.length,
                backends,
                pendingConflicts: Array.isArray(data?.conflicts) ? data.conflicts.length : 0,
                pendingNotices: Array.isArray(data?.notices) ? data.notices.length : 0,
                errors,
            };
        } catch (err) {
            return { available: false, error: String(err?.message || err) };
        }
    };

    if (part === 'connections') {
        if (!contentAllowed) return { error: 'Source disabled: content' };
        return {
            activeConnection: connectionName(ctx),
            mainSource: String(ctx.chatCompletionSettings?.chat_completion_source || ''),
            workbenchAskTarget: aiTarget('ask', readSettings(ctx), registry),
            profiles: safeConnections(),
        };
    }
    if (part === 'extensions') return safeExtensions();
    if (part === 'search_tools') return safeSearchTools();
    if (part === 'skills') return safeSkills();
    if (part === 'sync') return safeSync();

    const ext = safeExtensions();
    const st = safeSearchTools();
    return {
        accountsEnabled: Boolean(ctx.accountsEnabled),
        isMobile: typeof ctx.isMobile === 'function' ? Boolean(ctx.isMobile()) : false,
        locale: typeof ctx.getCurrentLocale === 'function' ? ctx.getCurrentLocale() : '',
        ...(contentAllowed ? {
            activeConnection: connectionName(ctx),
            connectionProfileCount: safeConnections().length,
        } : {}),
        workbenchAskTarget: aiTarget('ask', readSettings(ctx), registry),
        enabledExtensionsCount: ext.enabled.length,
        disabledExtensionsCount: ext.disabled.length,
        searchTools: st,
        registeredAskProviders: registry.getAskProviders().map(p => ({ id: p.id, label: p.label })),
    };
}

function presetDetail({ entry = '' } = {}) {
    const ctx = getContext();
    const live = ctx?.presets?.getLive?.('openai');
    const body = live?.body || {};
    const order = (body.prompt_order || []).find(o => Number(o.character_id) === 100001) || (body.prompt_order || [])[0];
    const byId = new Map((body.prompts || []).map(p => [p.identifier, p]));
    const items = (order?.order || []).map(o => ({ ...byId.get(o.identifier), enabled: o.enabled })).filter(p => p.identifier);
    if (entry) {
        const needle = String(entry).trim();
        const needleLower = needle.toLowerCase();
        let hit = items.find(p => p.name === needle || p.identifier === needle);
        if (!hit) {
            hit = items.find(p => String(p.name || '').toLowerCase() === needleLower || String(p.identifier || '').toLowerCase() === needleLower);
        }
        if (!hit) {
            const fuzzy = items.filter(p => String(p.name || '').toLowerCase().includes(needleLower) || String(p.identifier || '').toLowerCase().includes(needleLower));
            if (fuzzy.length === 1) {
                hit = fuzzy[0];
            } else if (fuzzy.length > 1) {
                return {
                    error: `「${entry}」匹配到多个条目，请指定更精确的名称`,
                    candidates: fuzzy.slice(0, 15).map(p => ({ name: p.name || p.identifier, identifier: p.identifier, enabled: p.enabled })),
                };
            }
        }
        return hit
            ? { name: hit.name, identifier: hit.identifier, enabled: hit.enabled, role: hit.role, injection_position: hit.injection_position ?? null, injection_depth: hit.injection_depth ?? null, content: String(hit.content || '') }
            : { error: `没有叫「${entry}」的条目`, available: items.slice(0, 30).map(p => p.name || p.identifier) };
    }
    const pl = body.extensions?.preset_lorebook;
    let presetLorebook = null;
    if (pl && typeof pl === 'object' && (pl.name || pl.data)) {
        const plName = String(pl.name || '');
        let globalSel = [];
        try { globalSel = [...(ctx?.chatWorldInfo?.globalSelection || [])].map(String); } catch { globalSel = []; }
        presetLorebook = {
            name: plName,
            entryCount: pl.data?.entries && typeof pl.data.entries === 'object' ? Object.keys(pl.data.entries).length : 0,
            activeInGlobal: Boolean(plName && globalSel.includes(plName)),
        };
    }
    return {
        name: live?.ref?.name || '',
        origin: live?.ref?.origin?.kind || 'global',
        settings: {
            temperature: body.temperature ?? body.temp_openai,
            top_p: body.top_p ?? body.top_p_openai,
            top_k: body.top_k ?? body.top_k_openai,
            min_p: body.min_p,
            frequency_penalty: body.frequency_penalty ?? body.freq_pen_openai,
            presence_penalty: body.presence_penalty ?? body.pres_pen_openai,
            repetition_penalty: body.repetition_penalty,
            max_context: body.openai_max_context,
            max_tokens: body.openai_max_tokens,
            stream: body.stream_openai,
            show_thoughts: body.show_thoughts,
            reasoning_effort: body.reasoning_effort,
            function_calling: body.function_calling,
            enable_web_search: body.enable_web_search,
            squash_system_messages: body.squash_system_messages,
            has_assistant_prefill: Boolean(String(body.assistant_prefill || '').trim()),
        },
        ...(presetLorebook ? { presetLorebook } : {}),
        entries: items.map(p => ({
            name: p.name || p.identifier,
            identifier: p.identifier,
            enabled: p.enabled,
            marker: Boolean(p.marker),
            preview: p.marker ? '（系统占位：角色卡 / 世界书 / 聊天等）' : String(p.content || '').slice(0, 120), // cap-ok: 列表模式下的短预览，完整内容通过 entry 参数读取
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

/** 将单条请求消息格式化为适合模型诊断的文本片段。 */
function formatInspectorMessage(m, index, maxChars = 3000) {
    const raw = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
    const truncated = raw.length > maxChars;
    return {
        index,
        role: m?.role || '',
        chars: raw.length,
        content: truncated ? `${raw.slice(0, maxChars)}…` : raw,
        ...(Array.isArray(m?.tool_calls) && m.tool_calls.length
            ? { toolCalls: m.tool_calls.map(tc => tc?.function?.name || tc?.name || '') }
            : {}),
    };
}

/** 从请求检查器记录的 responseParts 中提取可读明文思考内容（跳过加密块与签名）。 */
function extractInspectorReasoningText(detail) {
    const parts = Array.isArray(detail?.responseParts) ? detail.responseParts : [];
    const chunks = [];
    for (const p of parts) {
        if (p?.type !== 'reasoning') continue;
        if ((p.kind === 'text' || p.kind === 'thinking') && typeof p.text === 'string' && p.text) {
            chunks.push(p.text);
        } else if (p.kind === 'details' && Array.isArray(p.details)) {
            const text = joinReasoningDetailsText(p.details);
            if (text) chunks.push(text);
        }
    }
    return chunks.join('\n').trim();
}

/** 从请求检查器记录的 responseParts 中提取模型发出的工具调用摘要。 */
function extractInspectorReplyToolCalls(detail) {
    const parts = Array.isArray(detail?.responseParts) ? detail.responseParts : [];
    const calls = [];
    for (const p of parts) {
        if (p?.type !== 'tool_call') continue;
        const rawArgs = p.args == null ? '' : (typeof p.args === 'string' ? p.args : JSON.stringify(p.args));
        calls.push({
            ...(p.id ? { id: String(p.id) } : {}),
            name: String(p.name || ''),
            argsPreview: rawArgs.slice(0, 600), // cap-ok: 单条回复工具调用参数预览上限
        });
    }
    return calls.slice(0, 30); // cap-ok: 单次回复最多展示 30 条工具调用摘要
}

/** Reader functions keyed by tool name (see model/ask.js), gated by `sources`. */
export function askReaders({ redactText = true, suggestions = () => [], sources = null, registry = defaultRegistry } = {}) {
    const on = (key) => !sources || sources[key] !== false;
    const anySourceOn = on('inspector') || on('frontLogs') || on('serverLogs') || on('content') || on('plugins');
    const readers = {};

    if (on('inspector')) {
        readers.wb_list_requests = async ({ limit = 20, only_errors = false } = {}) => {
            const list = await listRequests({ limit: 200 });
            const pick = list.filter(e => !only_errors || e.status === 'error' || e.error).slice(0, Math.max(1, Math.min(60, limit))); // cap-ok: matches Ask tool schema limit to keep response within LLM context window
            return pick.map(e => describeRequest(e, e.attr));
        };
        readers.wb_read_request = async ({
            id,
            part = 'both',
            tail_messages = 0,
            message_index = null,
            include_reasoning = false,
            include_tools = false,
        } = {}) => {
            const d = await inspectorDetail(id);
            const reqType = d.type || 'chat';
            const out = {
                id: d.id,
                type: reqType,
                source: d.source || '',
                model: d.model,
                status: d.status,
                httpStatus: d.httpStatus,
                error: d.error,
                abortKind: d.abortKind || '',
                durationMs: d.durationMs,
            };
            if (reqType === 'image') {
                if (d.prompt) out.prompt = String(d.prompt).slice(0, 4000); // cap-ok: 生图提示词预览上限
                if (d.negativePrompt) out.negativePrompt = String(d.negativePrompt).slice(0, 2000); // cap-ok: 负向提示词预览上限
                if (d.width != null) out.width = d.width;
                if (d.height != null) out.height = d.height;
                if (d.steps != null) out.steps = d.steps;
                if (d.sampler) out.sampler = d.sampler;
                return out;
            }
            if (reqType === 'embedding') {
                if (d.operation) out.operation = d.operation;
                if (d.routeKind) out.routeKind = d.routeKind;
                if (d.collectionId != null) out.collectionId = d.collectionId;
                if (Array.isArray(d.collectionIds) && d.collectionIds.length) out.collectionIds = d.collectionIds;
                if (d.query) out.query = String(d.query).slice(0, 1000); // cap-ok: 重排查询词上限
                if (d.inputCount != null) out.inputCount = d.inputCount;
                if (d.inputCharTotal != null) out.inputCharTotal = d.inputCharTotal;
                if (Array.isArray(d.inputTexts) && d.inputTexts.length) {
                    out.inputTexts = d.inputTexts.slice(0, 12).map((item, idx) => ({ // cap-ok: 最多展示前 12 条向量输入文本预览
                        index: item?.index ?? idx,
                        text: String(typeof item === 'string' ? item : (item?.text ?? '')).slice(0, 400), // cap-ok: 单条输入文本预览上限
                    }));
                }
                if (d.topK != null) out.topK = d.topK;
                if (d.threshold != null) out.threshold = d.threshold;
                if (d.resultCount != null) out.resultCount = d.resultCount;
                if (d.vectorDim != null) out.vectorDim = d.vectorDim;
                if (Array.isArray(d.hits) && d.hits.length) {
                    out.hits = d.hits.slice(0, 20).map(hit => ({ // cap-ok: 最多展示前 20 条向量命中摘要
                        ...(hit?.collectionId != null ? { collectionId: hit.collectionId } : {}),
                        ...(hit?.index != null ? { index: hit.index } : {}),
                        ...(hit?.hash != null ? { hash: hit.hash } : {}),
                        ...(hit?.score != null ? { score: hit.score } : {}),
                        text: String(hit?.text ?? '').slice(0, 400), // cap-ok: 单条命中文本预览上限
                    }));
                }
                return out;
            }
            const allMsgs = Array.isArray(d.fullMessages) ? d.fullMessages : [];
            out.promptCharLength = d.promptCharLength ?? null;
            out.totalMessages = allMsgs.length;
            out.usage = d.usage;
            out.finishReason = d.finishReason;
            if (part !== 'reply') {
                const hasMessageIndex = message_index !== null
                    && message_index !== undefined
                    && message_index !== ''
                    && typeof message_index !== 'boolean'
                    && Number.isFinite(Number(message_index));
                if (hasMessageIndex) {
                    const idx = Math.floor(Number(message_index));
                    if (idx >= 0 && idx < allMsgs.length) {
                        out.messages = [formatInspectorMessage(allMsgs[idx], idx, 10000)]; // cap-ok: 单条精读放宽至 10000 字
                    } else {
                        out.messages = [];
                        out.messageError = `消息索引 ${idx} 越界（共 ${allMsgs.length} 条，范围 0–${Math.max(0, allMsgs.length - 1)}）`;
                    }
                } else if (Number(tail_messages) > 0) {
                    const tailCount = Math.max(1, Math.min(20, Math.floor(Number(tail_messages)))); // cap-ok: 末尾消息窗口上限 20 条
                    const startIdx = Math.max(0, allMsgs.length - tailCount);
                    out.omittedHeadMessages = startIdx;
                    out.messages = allMsgs.slice(startIdx).map((m, i) => formatInspectorMessage(m, startIdx + i, 2800)); // cap-ok: 末尾模式每条消息上限
                } else {
                    out.messages = allMsgs.map((m, idx) => formatInspectorMessage(m, idx, 3000)); // cap-ok: 常规模式单条消息上限
                }
            }
            if (part !== 'messages') {
                out.reply = String(d.responseText || '').slice(0, 6000); // cap-ok: 回复正文与消息共存时的上限
                const replyToolCalls = extractInspectorReplyToolCalls(d);
                if (replyToolCalls.length) {
                    out.replyToolCalls = replyToolCalls;
                }
            }
            if (include_reasoning) {
                const reasoning = extractInspectorReasoningText(d);
                if (reasoning) {
                    out.reasoning = reasoning.slice(0, 4000); // cap-ok: 思考过程摘要上限
                }
            }
            if (include_tools) {
                const { tools: wireTools, toolChoice } = normalizeWireTools(d.wireRequest);
                if (wireTools.length) {
                    out.tools = wireTools.slice(0, 40).map(t => ({ // cap-ok: 最多展示 40 个工具摘要
                        name: t.name,
                        description: String(t.description || '').slice(0, 120), // cap-ok: 单条工具描述预览上限
                    }));
                }
                const choiceLabel = describeToolChoice(toolChoice);
                if (choiceLabel) out.toolChoice = choiceLabel;
            }
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
        readers.wb_read_world_info_trace = async (args) => worldInfoTrace(args);
        readers.wb_read_preset = async (args) => presetDetail(args);
        readers.wb_read_last_prompt = async () => {
            const snap = await loadSnapshot(registry);
            return snap?.budget || { error: '还没有提示词数据（要先生成一次回复，且是对话补全接口）' };
        };
        readers.wb_read_variables = async (args) => readVariables(args);
        readers.wb_read_regex = async (args) => readRegexScripts(args);
    }

    if (on('plugins')) {
        readers.wb_read_luker_env = async (args) => readLukerEnv(args, registry, sources);
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

    if (anySourceOn && (!sources || sources.docs !== false)) {
        readers.wb_search_luker_docs = async (args) => searchLukerDocs(args);
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
        const books = await boundBooks(ctx);
        let memoryTokens = 0;
        if (effectiveSources.plugins) {
            const { memoryTokens: mTok } = await collectProviderSnapshots(ctx, registry);
            memoryTokens = mTok;
        }
        const budget = chat.chatId && chat.floors > 0 ? await budgetPart(memoryTokens) : null;
        raw.聊天 = chat.label ? `${chat.label}${chat.group ? '（群聊）' : ''}，${chat.floors} 楼` : '没有打开聊天';
        raw.角色卡 = card?.name || i18n('None selected');
        raw.世界书 = books.length ? books : '无绑定';
        raw.预设 = preset?.name || '';
        raw.连接 = connectionName(ctx);
        raw.提示词 = budget
            ? Object.fromEntries([['合计', budget.total], ['上限', budget.max], ...budget.parts.map(p => [p.label, p.tokens])])
            : '没有数据';
        const localVarCount = Object.keys(ctx.chatMetadata?.variables || {}).length;
        const varOpFloors = (Array.isArray(ctx.chat) ? ctx.chat : []).filter(m => Array.isArray(m?.extra?.var_ops) && m.extra.var_ops.length > 0).length;
        if (localVarCount > 0 || varOpFloors > 0) {
            raw.变量 = { 聊天变量数: localVarCount, 含操作日志楼层数: varOpFloors };
        }
        const regexExtensionDisabled = Array.isArray(ctx.extensionSettings?.disabledExtensions)
            && ctx.extensionSettings.disabledExtensions.includes('regex');
        if (regexExtensionDisabled) {
            raw.正则 = '扩展已关闭';
        } else if (ctx.regex?.getScripts) {
            try {
                const enabledRegex = (ctx.regex.getScripts({ allowedOnly: true }) || []).filter(s => s && !s.disabled).length;
                raw.正则 = `启用 ${enabledRegex} 条`;
            } catch { /* 忽略正则读取异常 */ }
        }
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
        const installedExt = ctx.listExtensionNames?.();
        const searchToolsCfg = ctx.extensionSettings?.search_tools;
        const searchOn = Boolean(searchToolsCfg?.enabled || searchToolsCfg?.preRequestEnabled);
        if (Array.isArray(installedExt) && installedExt.length) {
            const disabled = new Set(Array.isArray(ctx.extensionSettings?.disabledExtensions) ? ctx.extensionSettings.disabledExtensions : []);
            raw.环境 = {
                启用扩展数: installedExt.filter(n => !disabled.has(n)).length,
                联网搜索: searchOn ? '开' : '关',
            };
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

/** 打开请求检查器弹窗并定位到指定请求 ID。 */
export async function openRequestInspectorById(requestId = '') {
    const ctx = getContext();
    if (typeof ctx?.openRequestInspector === 'function') {
        return ctx.openRequestInspector(requestId);
    }
    const mod = await import('../request-inspector.js');
    return mod.openRequestInspector?.(requestId);
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
        openRequestInspector: (id) => openRequestInspectorById(id),
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
