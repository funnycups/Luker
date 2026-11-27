// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workbench AskProvider & SuggestRuleProvider definitions for Memory Graph.

import { formatTokens } from '../../../lens-shared/util.js';
import { dateLocale, i18n, i18nFormat } from './i18n.js';
import { readEntries } from './token-stats.js';

const HORIZON_KEY = 'persistentInjectionMaxSeqDistance';
export const HORIZON_SUGGESTED = 100;

function median(list) {
    const v = list.filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!v.length) return 0;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function chatFloors(ctx) {
    return Array.isArray(ctx?.chat) ? ctx.chat.length : 0;
}

function activeChatId(ctx) {
    if (!ctx) return '';
    const id = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
    return id ? String(id) : '';
}

function serializeFieldMap(record) {
    if (!record || typeof record !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(record)) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'string') {
            out[k] = v;
        } else {
            try {
                out[k] = JSON.stringify(v);
            } catch {
                out[k] = String(v);
            }
        }
    }
    return out;
}

function nodeRecencyKey(node) {
    const end = node?.floor_range?.end;
    if (typeof end === 'number' && Number.isFinite(end)) return end;
    const seq = node?.seq_to;
    if (typeof seq === 'number' && Number.isFinite(seq)) return seq;
    return -1;
}

export async function buildMemorySnapshot(ctx, deps = {}) {
    const mg = ctx?.getExtensionApi?.('memory-graph');
    if (!mg) return null;

    const {
        getSettings = null,
        ensureMemoryStoreLoaded = null,
        getMemoryGraphReadApi = null,
    } = deps;

    const out = {
        installed: true,
        enabled: false,
        nodes: 0,
        events: 0,
        unmerged: 0,
        countsByType: {},
        core: 0,
        focus: 0,
        coreHistory: [],
        compression: false,
        threshold: 0,
        maxSeqDistance: null,
        recallMethod: '',
        recallEnabled: true,
        autoExtractionEnabled: true,
        updateEvery: null,
        floors: chatFloors(ctx),
        types: 0,
        scope: 'global',
    };

    const settings = typeof getSettings === 'function' ? getSettings() : {};
    out.enabled = Boolean(settings?.enabled);
    out.recallMethod = String(settings?.recallMethod || '');
    out.recallEnabled = settings?.recallEnabled !== false;
    out.autoExtractionEnabled = settings?.autoExtractionEnabled !== false;
    const adv = mg.getAdvancedScopeInfo?.(ctx, settings);
    if (adv) {
        out.maxSeqDistance = Number(adv?.settings?.[HORIZON_KEY] ?? settings?.[HORIZON_KEY] ?? 0);
        out.scope = adv?.scope || 'global';
    }
    const rawUpdateEvery = adv?.settings?.updateEvery ?? settings?.updateEvery;
    if (rawUpdateEvery !== null && rawUpdateEvery !== undefined && rawUpdateEvery !== '' && Number.isFinite(Number(rawUpdateEvery))) {
        out.updateEvery = Number(rawUpdateEvery);
    }
    const schemaInfo = mg.getSchemaScopeInfo?.(ctx, settings);
    if (schemaInfo) {
        const schema = Array.isArray(schemaInfo.schema) ? schemaInfo.schema : [];
        const event = schema.find(s => String(s?.id) === 'event');
        out.compression = String(event?.compression?.mode || '') === 'hierarchical';
        out.threshold = Number(event?.compression?.threshold) || 0;
        out.types = schema.length;
    }

    if (activeChatId(ctx) && typeof ensureMemoryStoreLoaded === 'function' && typeof getMemoryGraphReadApi === 'function') {
        const store = await ensureMemoryStoreLoaded(ctx);
        const read = store ? getMemoryGraphReadApi(store, ctx) : null;
        const nodes = read?.listNodes?.({ activeOnly: false }) || [];
        out.nodes = nodes.length;
        const countsByType = {};
        for (const node of nodes) {
            const typeId = String(node?.type || 'unknown');
            if (!countsByType[typeId]) countsByType[typeId] = { total: 0, active: 0, archived: 0 };
            countsByType[typeId].total++;
            if (node?.archived) countsByType[typeId].archived++;
            else countsByType[typeId].active++;
        }
        out.countsByType = countsByType;
        const events = nodes.filter(node => node?.type === 'event' && !node.archived);
        out.events = events.length;
        out.unmerged = events.filter(node => !(Number(node.semantic_depth) > 0) && !node.parent_id).length;
    }

    const proj = typeof mg.getLastRecallProjection === 'function'
        ? await mg.getLastRecallProjection(ctx)
        : null;
    if (proj?.blocks) {
        const count = (text) => typeof ctx.getTokenCountAsync === 'function'
            ? ctx.getTokenCountAsync(String(text || ''))
            : Promise.resolve(Math.round(String(text || '').length / 4));
        const [core, focus] = await Promise.all([
            count(proj.blocks.corePacket),
            count(proj.blocks.focusPacket),
        ]);
        out.core = Number(core) || 0;
        out.focus = Number(focus) || 0;
        out.recallAt = proj.at;
    }

    const log = readEntries(ctx);
    if (Array.isArray(log) && log.length) {
        out.coreHistory = log.slice(-30).map(e => Number(e.core) || 0);
    }
    return out;
}

export function createMemoryAskProvider(getCtx, deps = {}) {
    return {
        id: 'memory',
        get label() { return i18n('Memory graph'); },
        tone: 'memory',
        icon: 'memory',
        get overviewKey() { return i18n('Memory graph'); },
        order: 10,
        getSnapshot: (ctx) => buildMemorySnapshot(ctx || getCtx(), deps),
        async getOverview(ctx) {
            const snap = await buildMemorySnapshot(ctx || getCtx(), deps);
            if (!snap) return i18n('Not present');
            return {
                [i18n('Nodes')]: snap.nodes,
                [i18n('Always on')]: snap.core,
                [i18n('Recalled this time')]: snap.focus,
            };
        },
        getSideInfo(pSnap) {
            return {
                label: i18n('Memory graph'),
                countText: pSnap ? i18nFormat('${0} nodes', pSnap.nodes) : i18n('Not present'),
                status: pSnap ? 'ok' : 'warn',
            };
        },
        renderHomeCard(pSnap, { status, askBtn, wsBtn, workspace }) {
            return {
                tone: 'memory',
                iconName: 'memory',
                name: i18n('Memory graph'),
                by: pSnap
                    ? (pSnap.scope === 'character' ? i18n('Settings for this character only') : i18n('Global settings'))
                    : i18n('Memory graph not found'),
                pill: status('memory', Boolean(pSnap)),
                stats: pSnap ? [
                    [i18n('Nodes'), String(pSnap.nodes)],
                    [i18n('Always on'), formatTokens(pSnap.core)],
                    pSnap.focus ? [i18n('Recalled this time'), formatTokens(pSnap.focus)] : null,
                ] : [],
                acts: [
                    pSnap ? askBtn('memory') : null,
                    workspace ? wsBtn(workspace) : null,
                ],
            };
        },
        tools: [{
            type: 'function',
            function: {
                name: 'wb_read_memory',
                description: 'Memory graph: inspect summary & counts per type, last injected core/focus text, schema definitions, or search/list memory nodes by keyword or type to diagnose forgotten facts.',
                parameters: {
                    type: 'object',
                    properties: {
                        part: {
                            type: 'string',
                            enum: ['summary', 'core', 'focus', 'search', 'nodes', 'schema'],
                            description: 'Default summary. Use search/nodes to find specific memory entries or schema to inspect memory types and compression rules.',
                        },
                        query: { type: 'string', description: 'Keyword to match against node id, type, title, or fields (used with search/nodes).' },
                        type: { type: 'string', description: 'Optional node type id filter (used with search, nodes, or schema).' },
                        include_archived: { type: 'boolean', description: 'Include archived nodes when searching/listing (default true).' },
                        limit: { type: 'integer', description: 'Optional max number of nodes to return.' },
                    },
                    additionalProperties: false,
                },
            },
        }],
        readers: {
            wb_read_memory: async ({ part = 'summary', query = '', type = '', include_archived = true, limit = null } = {}, ctx) => {
                const c = ctx || getCtx();
                const mg = c?.getExtensionApi?.('memory-graph');
                if (!mg) return { error: i18n('No memory graph') };
                if (part === 'core' || part === 'focus') {
                    const proj = await mg.getLastRecallProjection?.(c);
                    return part === 'core'
                        ? String(proj?.blocks?.corePacket || i18n('(empty)'))
                        : String(proj?.blocks?.focusPacket || i18n('(empty)'));
                }
                if (part === 'schema') {
                    const settings = typeof deps.getSettings === 'function' ? deps.getSettings() : {};
                    const schemaInfo = mg.getSchemaScopeInfo?.(c, settings);
                    const rawSchema = Array.isArray(schemaInfo?.schema)
                        ? schemaInfo.schema
                        : (typeof deps.getEffectiveNodeTypeSchema === 'function' ? deps.getEffectiveNodeTypeSchema(c, settings) : []);
                    const schemaList = Array.isArray(rawSchema) ? rawSchema : [];
                    const typeNeedle = String(type || '').trim().toLowerCase();
                    const filtered = typeNeedle
                        ? schemaList.filter(t => String(t?.id || '').toLowerCase() === typeNeedle)
                        : schemaList;
                    return {
                        scope: schemaInfo?.scope || 'global',
                        types: filtered.map(t => ({
                            id: t?.id,
                            label: t?.label || t?.name || t?.id,
                            extractHint: String(t?.extractHint || ''),
                            extractionInstructions: String(t?.extractionInstructions || ''),
                            alwaysInject: Boolean(t?.alwaysInject ?? t?.persistent),
                            tableColumns: Array.isArray(t?.tableColumns) ? t.tableColumns.filter(Boolean).map(String) : [],
                            columnHints: t?.columnHints && typeof t.columnHints === 'object' ? { ...t.columnHints } : {},
                            compression: t?.compression && typeof t.compression === 'object'
                                ? { ...t.compression }
                                : null,
                        })),
                    };
                }
                if (part === 'search' || part === 'nodes') {
                    if (!activeChatId(c) || typeof deps.ensureMemoryStoreLoaded !== 'function' || typeof deps.getMemoryGraphReadApi !== 'function') {
                        return { error: 'No open chat or memory store is unreadable', nodes: [] };
                    }
                    const store = await deps.ensureMemoryStoreLoaded(c);
                    const read = store ? deps.getMemoryGraphReadApi(store, c) : null;
                    const allNodes = read?.listNodes?.({ activeOnly: !include_archived }) || [];
                    const needle = String(query || '').trim().toLowerCase();
                    const typeNeedle = String(type || '').trim().toLowerCase();
                    const maxItems = (limit !== null && limit !== undefined && limit !== '' && typeof limit !== 'boolean' && Number.isFinite(Number(limit)) && Number(limit) > 0)
                        ? Math.floor(Number(limit))
                        : Infinity;
                    const matched = allNodes.filter(node => {
                        if (!node || typeof node !== 'object') return false;
                        if (typeNeedle && String(node.type || '').toLowerCase() !== typeNeedle) return false;
                        if (!needle) return true;
                        let fieldsText = '';
                        if (node.fields && typeof node.fields === 'object') {
                            try { fieldsText = JSON.stringify(node.fields); } catch { fieldsText = ''; }
                        }
                        const hay = [
                            node.id,
                            node.type,
                            node.title,
                            fieldsText,
                        ].filter(Boolean).join(' ').toLowerCase();
                        return hay.includes(needle);
                    });
                    // Sort descending by floor range end / node seq watermark so newest nodes appear first.
                    matched.sort((a, b) => nodeRecencyKey(b) - nodeRecencyKey(a));
                    const picked = Number.isFinite(maxItems) ? matched.slice(0, maxItems) : matched;
                    return {
                        totalInGraph: allNodes.length,
                        matched: matched.length,
                        nodes: picked.map(n => {
                            const fields = serializeFieldMap(n.fields);
                            const rawSummary = n?.fields?.summary ?? n?.fields?.note ?? '';
                            const summary = typeof rawSummary === 'string' ? rawSummary : String(rawSummary);
                            return {
                                id: n.id,
                                type: n.type,
                                level: n.level || 'episodic',
                                title: n.title || '',
                                fields,
                                summary,
                                seqTo: (Number.isFinite(n.seq_to) && n.seq_to >= 0) ? n.seq_to : null,
                                floorRange: n.floor_range || null,
                                archived: Boolean(n.archived),
                                parentId: n.parent_id || null,
                                depth: Number(n.semantic_depth || 0),
                                semanticRollup: Boolean(n.semantic_rollup),
                            };
                        }),
                    };
                }
                const proj = await mg.getLastRecallProjection?.(c);
                const snap = await buildMemorySnapshot(c, deps);
                return { ...snap, lastRecall: proj?.at ? new Date(proj.at).toLocaleString(dateLocale(c)) : i18n('Not recalled yet') };
            },
        },
    };
}

export function createMemorySuggestRuleProvider(getCtx = () => globalThis.Luker?.getContext?.(), deps = {}) {
    async function applyHorizon(wbApp, value) {
        const ctx = getCtx();
        const mg = ctx?.getExtensionApi?.('memory-graph');
        const settings = deps.getSettings?.();
        if (!mg || !settings) throw new Error(i18n('Memory graph settings could not be read'));
        const adv = mg.getAdvancedScopeInfo?.(ctx, settings);
        const before = Number(adv?.settings?.[HORIZON_KEY] ?? settings?.[HORIZON_KEY] ?? 0);
        const isChar = adv?.scope === 'character' && Boolean(adv.avatar);
        const avatar = isChar ? String(adv.avatar) : '';
        const prevRaw = isChar ? deps.getCharacterAdvancedOverrideByAvatar?.(ctx, avatar)?.[HORIZON_KEY] : settings[HORIZON_KEY];

        const writeValue = async (nextVal) => {
            if (isChar) {
                const patch = nextVal === undefined ? { unset: [HORIZON_KEY] } : { set: { [HORIZON_KEY]: nextVal } };
                const ok = await deps.persistCharacterAdvancedOverridePatch?.(ctx, avatar, patch);
                if (!ok) throw new Error(i18n('Failed to write to the character card'));
            } else {
                const prev = settings[HORIZON_KEY];
                settings[HORIZON_KEY] = nextVal;
                try {
                    await ctx.workbench?.saveSettingsChecked?.(ctx);
                } catch (err) {
                    settings[HORIZON_KEY] = prev;
                    throw err;
                }
            }
            deps.invalidateLatestRecallSnapshot?.();
        };

        await writeValue(value);
        const historyId = wbApp.history?.record?.({
            ws: 'memory',
            title: i18nFormat('Max lookback floors for always-on injection ${0} → ${1}', before || i18n('No limit'), value),
            lines: [isChar ? i18n('Changed the settings for this character only') : i18n('Changed the global settings')],
            from: i18n('Suggestions'),
            undo: () => writeValue(prevRaw),
        });
        wbApp.toast?.(i18nFormat('Set to ${0}', value), {
            action: historyId ? i18n('Undo') : '',
            onAction: historyId ? async () => {
                try {
                    await wbApp.history.undo(historyId);
                    wbApp.reload?.();
                } catch (err) {
                    wbApp.toast?.(i18nFormat('Could not undo: ${0}', err?.message || err), { error: true });
                }
            } : null,
        });
        wbApp.reload?.();
    }

    return {
        id: 'memory',
        tone: 'memory',
        rules: [
            {
                id: 'memory.coreHigh',
                tone: 'memory',
                get name() { return i18n('High always-on injection'); },
                get when() { return i18n('Always-on injection is over 1.5x the usual for this chat, or over 20% of the context'); },
                defaultOn: true,
                check(snap) {
                    const m = snap?.memory || snap?.providers?.memory;
                    if (!m || !(m.core > 0)) return null;
                    const typical = median(m.coreHistory || []);
                    const max = snap?.budget?.max || 0;
                    const ratio = typical >= 200 && (m.coreHistory || []).length >= 5 ? m.core / typical : 0;
                    const share = max ? m.core / max : 0;
                    if (ratio < 1.5 && share < 0.2) return null;
                    const reasons = [];
                    if (ratio >= 1.5) {
                        reasons.push(i18nFormat('Always-on injection is ${0} this time. This chat usually has about ${1}, so it is ${2}x higher.', formatTokens(m.core), formatTokens(typical), ratio.toFixed(1)));
                    }
                    if (share >= 0.2) {
                        reasons.push(i18nFormat('It takes ${0}% of the ${1} context limit.', Math.round(share * 100), formatTokens(max)));
                    }
                    return {
                        text: i18nFormat('Memory graph always-on injection is ${0}, ${1}', formatTokens(m.core), ratio >= 1.5 ? i18nFormat('${0}x the usual', ratio.toFixed(1)) : i18nFormat('${0}% of the context', Math.round(share * 100))),
                        why: reasons.join(''),
                        source: i18n('Based on the memory graph\'s injection and token records'),
                        sig: `${Math.round(m.core / 500)}`,
                        actions: [{ kind: 'ask', label: i18n('See which ones'), question: i18n('Why is memory graph always-on injection so high? Which types and entries take it up?') }],
                    };
                },
            },
            {
                id: 'memory.unmerged',
                tone: 'memory',
                get name() { return i18n('Unmerged events piling up'); },
                get when() { return i18n('More than 50 unmerged events'); },
                defaultOn: true,
                check(snap) {
                    const m = snap?.memory || snap?.providers?.memory;
                    if (!m || !(m.unmerged > 50)) return null;
                    const why = i18nFormat('${0} events in total, ${1} are not merged into summaries and are all injected.', m.events, m.unmerged)
                        + (m.compression
                            ? (m.threshold ? i18nFormat('"Auto-merge into summaries" is on, merging at ${0}.', m.threshold) : i18n('"Auto-merge into summaries" is on.'))
                            : i18n('"Auto-merge into summaries" is off.'));
                    return {
                        text: i18nFormat('${0} events are not merged into summaries', m.unmerged),
                        why,
                        source: i18n('Based on memory graph data and structure'),
                        sig: `${Math.round(m.unmerged / 20)}`,
                        actions: [{ kind: 'ai', ws: 'memory', label: i18n('Have the AI look'), prompt: i18nFormat('${0} events are not merged and always-on injection is high. Check how the merge settings and description of "Event" should be adjusted.', m.unmerged) }],
                    };
                },
            },
            {
                id: 'memory.horizon',
                tone: 'memory',
                get name() { return i18n('Unlimited always-on lookback'); },
                get when() { return i18n('"Max lookback floors for always-on injection" is 0 and the chat is over 200 floors'); },
                defaultOn: true,
                check(snap) {
                    const m = snap?.memory || snap?.providers?.memory;
                    if (!m || m.maxSeqDistance !== 0 || !(m.floors > 200)) return null;
                    return {
                        text: i18n('"Max lookback floors for always-on injection" is unlimited'),
                        why: i18nFormat('The chat has ${0} floors and this is 0 (unlimited), so very old content stays injected. Set it to ${1} and older content is recalled only when needed.', m.floors, HORIZON_SUGGESTED),
                        source: i18n('Based on memory graph settings'),
                        sig: 'on',
                        actions: [{ label: i18nFormat('Set to ${0} floors', HORIZON_SUGGESTED), run: (wbApp) => applyHorizon(wbApp, HORIZON_SUGGESTED) }],
                    };
                },
            },
        ],
    };
}
