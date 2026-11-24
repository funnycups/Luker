// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workbench AskProvider & SuggestRuleProvider definitions for Orchestrator.

import { i18n, i18nFormat, modeInfo } from './i18n.js';
import { buildFlow } from './model/profile.js';
import { buildRunView, displayStatus, formatDuration } from './model/run.js';

const SLOW_RUN_MS = 25000; // cap-ok: UX threshold flagging slow multi-agent turns for optional user review
const NOTES_NAMESPACE = 'luker_orch_loop_notes';

function activeChatId(ctx) {
    if (!ctx) return '';
    const id = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
    return id ? String(id).trim() : '';
}

function serializePreviewValue(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function sectionPreview(sec) {
    if (!sec || typeof sec !== 'object') return '';
    const body = typeof sec.body === 'string' ? sec.body.trim() : '';
    const meta = sec.meta && typeof sec.meta === 'object' ? sec.meta : null;
    const err = meta?.err ? String(meta.err).trim() : '';
    const code = meta?.code ? String(meta.code).trim() : '';
    const formattedErr = err ? (code ? `[${code}] ${err}` : err) : '';
    if (body) {
        if (formattedErr && !body.includes(err)) {
            return `${formattedErr}: ${body}`.slice(0, 320); // cap-ok: section body preview cap
        }
        return body.slice(0, 320); // cap-ok: section body preview cap
    }
    if (formattedErr) return formattedErr.slice(0, 320); // cap-ok: section error preview cap
    if (meta?.output !== undefined && meta?.output !== null) {
        return serializePreviewValue(meta.output).slice(0, 320); // cap-ok: section output preview cap
    }
    if (meta?.args !== undefined && meta?.args !== null) {
        return serializePreviewValue(meta.args).slice(0, 320); // cap-ok: section args preview cap
    }
    return '';
}

function findLatestOrchRun(ctx) {
    const rec = ctx?.runPanel?.getRunRecorder?.();
    const allRuns = Array.isArray(rec?.history?.()) ? rec.history() : [];
    const chatId = activeChatId(ctx);
    return allRuns.find(r =>
        r && (r.source || 'orchestrator') === 'orchestrator'
        && !r.quiet
        && (!chatId || !r.chatId || r.chatId === chatId),
    ) || null;
}

function normalizeReadOnlyNotes(rawEntries) {
    if (!Array.isArray(rawEntries)) return [];
    const out = [];
    for (const entry of rawEntries) {
        if (typeof entry === 'string') {
            out.push({ id: '', status: 'open', text: entry });
        } else if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
            const normalized = {
                id: typeof entry.id === 'string' ? entry.id : '',
                status: typeof entry.status === 'string' && entry.status ? entry.status : 'open',
                text: entry.text,
            };
            if (typeof entry.closure_reason === 'string' && entry.closure_reason) {
                normalized.closure_reason = entry.closure_reason;
            }
            out.push(normalized);
        }
    }
    return out;
}

function resolveMode(settings) {
    const m = String(settings?.executionMode || 'spec').trim().toLowerCase();
    return ['spec', 'single', 'agenda', 'loop', 'director'].includes(m) ? m : 'spec';
}

function resolveProfileSummary(ctx, settings, deps = {}) {
    const mode = resolveMode(settings);
    if (mode === 'single') {
        return {
            mode,
            scope: 'global',
            presetName: '',
            profile: {
                spec: { stages: [{ id: 'single', mode: 'serial', nodes: ['single_agent'] }] },
                presets: { single_agent: { systemPrompt: settings.singleAgentSystemPrompt, userPromptTemplate: settings.singleAgentUserPromptTemplate } },
            },
        };
    }
    const avatar = !ctx?.groupId ? String(ctx?.characters?.[ctx?.characterId]?.avatar || '').trim() : '';
    let scope = 'global';
    if (avatar && typeof deps.getRuntimePresetScope === 'function') {
        scope = deps.getRuntimePresetScope(ctx, avatar, mode) || 'global';
    } else if (avatar && ctx?.characters?.[ctx?.characterId]?.data?.extensions?.orchestrator?.activePresetIds?.[mode]) {
        scope = 'character';
    }
    const active = typeof deps.getActivePreset === 'function'
        ? deps.getActivePreset(settings, mode, { scope, context: ctx, avatar })
        : null;
    const entry = active?.state || null;
    return {
        mode,
        scope,
        presetName: String(entry?.name || ''),
        profile: entry || {},
    };
}

export async function buildOrchSnapshot(ctx, deps = {}) {
    const settings = deps.getSettings?.() || ctx?.extensionSettings?.orchestrator;
    if (!settings || typeof settings !== 'object') return null;

    const { mode, scope, presetName, profile } = resolveProfileSummary(ctx, settings, deps);
    const flow = buildFlow(profile, { mode, source: scope, presetName, settings });
    const agents = Object.keys(flow?.agents || {}).length;
    const capsule = typeof deps.getLatestOrchestrationEntry === 'function'
        ? deps.getLatestOrchestrationEntry(ctx)
        : null;

    const latest = findLatestOrchRun(ctx);
    const latestView = latest ? buildRunView(latest, Object.keys(flow?.agents || {})) : null;

    return {
        installed: true,
        enabled: Boolean(settings.enabled),
        mode,
        scope,
        presetName,
        agents,
        hasCapsule: Boolean(capsule?.injectedText),
        capsuleFloor: capsule?.anchorPlayableFloor || 0,
        lastRun: latestView ? {
            runId: latestView.runId,
            status: displayStatus(latest.status, latest.error),
            duration: latestView.duration,
            tokens: latestView.tokens,
            error: latestView.error || '',
            lanes: latestView.lanes.length,
        } : null,
    };
}

export function createOrchAskProvider(getCtx = () => globalThis.Luker?.getContext?.(), deps = {}) {
    return {
        id: 'orch',
        get label() { return i18n('Orchestration'); },
        tone: 'orch',
        icon: 'orch',
        get overviewKey() { return i18n('Orchestration'); },
        order: 20,
        getSnapshot: (ctx) => buildOrchSnapshot(ctx || getCtx(), deps),
        async getOverview(ctx) {
            const snap = await buildOrchSnapshot(ctx || getCtx(), deps);
            if (!snap) return i18n('Not present');
            return {
                [i18n('Enabled')]: snap.enabled,
                [i18n('Mode')]: snap.mode,
                [i18n('Scope')]: snap.scope,
                [i18n('Preset')]: snap.presetName || '—',
                [i18n('Last run duration')]: snap.lastRun ? formatDuration(snap.lastRun.duration) : '—',
            };
        },
        getSideInfo(pSnap) {
            return {
                label: i18n('Orchestration'),
                countText: pSnap ? (pSnap.enabled ? modeInfo(pSnap.mode).label : i18n('Off')) : i18n('Not present'),
                status: pSnap ? (pSnap.enabled ? 'ok' : 'off') : 'warn',
            };
        },
        renderHomeCard(pSnap, { status, askBtn, wsBtn, workspace }) {
            return {
                tone: 'orch',
                iconName: 'orch',
                name: i18n('Orchestration'),
                by: pSnap
                    ? (pSnap.enabled
                        ? `${modeInfo(pSnap.mode).label}${pSnap.presetName ? ` · ${pSnap.presetName}` : ''}`
                        : i18n('Off'))
                    : i18n('Not installed'),
                pill: status('orch', Boolean(pSnap)),
                stats: pSnap ? [
                    [i18n('Agents'), String(pSnap.agents)],
                    pSnap.lastRun ? [i18n('Last run'), formatDuration(pSnap.lastRun.duration)] : null,
                ] : [],
                acts: [
                    pSnap ? askBtn('orch') : null,
                    workspace ? wsBtn(workspace) : null,
                ],
            };
        },
        tools: [{
            type: 'function',
            function: {
                name: 'wb_read_orch',
                description: 'Orchestrator: current execution mode, active profile summary, latest injected capsule, latest run timeline with per-agent output/errors, or current chat plot notes.',
                parameters: {
                    type: 'object',
                    properties: {
                        part: { type: 'string', enum: ['summary', 'profile', 'capsule', 'last_run', 'notes'], description: 'Default summary.' },
                    },
                    additionalProperties: false,
                },
            },
        }],
        readers: {
            wb_read_orch: async ({ part = 'summary' } = {}, ctx) => {
                const c = ctx || getCtx();
                const settings = deps.getSettings?.() || c?.extensionSettings?.orchestrator;
                if (!settings) return { error: i18n('Orchestrator is not installed') };
                if (part === 'capsule') {
                    const entry = deps.getLatestOrchestrationEntry?.(c);
                    return entry ? { floor: entry.anchorPlayableFloor, text: entry.injectedText } : { empty: true };
                }
                if (part === 'profile') {
                    return resolveProfileSummary(c, settings, deps);
                }
                if (part === 'notes') {
                    if (!activeChatId(c) || typeof c?.readFloorStateSnapshot !== 'function') {
                        return { available: false, notes: [] };
                    }
                    try {
                        const snap = await c.readFloorStateSnapshot({ namespace: NOTES_NAMESPACE });
                        if (!snap || snap.ok === false) {
                            return {
                                available: false,
                                ...(snap?.reason ? { reason: snap.reason } : {}),
                                ...(snap?.hint ? { error: snap.hint } : {}),
                                notes: [],
                            };
                        }
                        const list = normalizeReadOnlyNotes(snap.state?.entries);
                        return {
                            total: list.length,
                            openCount: list.filter(n => n.status !== 'closed').length,
                            notes: list.slice(-40).map(n => ({ // cap-ok: return at most the latest 40 orchestration notes
                                id: n.id,
                                status: n.status,
                                text: n.text.slice(0, 400), // cap-ok: per-note preview cap
                                ...(n.closure_reason ? { closureReason: n.closure_reason.slice(0, 200) } : {}), // cap-ok: closure reason preview cap
                            })),
                        };
                    } catch (err) {
                        return { available: false, error: String(err?.message || err), notes: [] };
                    }
                }
                if (part === 'last_run') {
                    const latest = findLatestOrchRun(c);
                    if (!latest) return { empty: true };
                    const { mode, scope, presetName, profile } = resolveProfileSummary(c, settings, deps);
                    const flow = buildFlow(profile, { mode, source: scope, presetName, settings });
                    const knownAgentIds = Object.keys(flow?.agents || {});
                    const view = buildRunView(latest, knownAgentIds);
                    return {
                        runId: view.runId,
                        mode: view.mode,
                        floor: view.floor,
                        status: view.status,
                        duration: view.duration,
                        tokens: view.tokens,
                        error: view.error,
                        lanes: view.lanes.map(l => ({
                            agentId: l.agentId,
                            segments: l.segments.map(s => ({
                                key: s.key,
                                status: s.status,
                                duration: s.duration,
                                sections: (s.sections || []).slice(0, 6).map(sec => ({ // cap-ok: at most 6 section summaries per segment
                                    kind: sec?.kind || '',
                                    title: sec?.title || '',
                                    status: sec?.status || '',
                                    preview: sectionPreview(sec),
                                })),
                            })),
                        })),
                        finalText: view.finalText,
                    };
                }
                return buildOrchSnapshot(c, deps);
            },
        },
    };
}

export function createOrchSuggestRuleProvider() {
    return {
        id: 'orch',
        tone: 'orch',
        rules: [
            {
                id: 'orch.failedRun',
                tone: 'orch',
                get name() { return i18n('Latest orchestration run failed'); },
                get when() { return i18n('The most recent orchestration run ended with an error'); },
                defaultOn: true,
                check(snap) {
                    const o = snap?.orch || snap?.providers?.orch;
                    if (!o?.enabled || !o?.lastRun) return null;
                    if (o.lastRun.status !== 'error' && o.lastRun.status !== 'failed') return null;
                    return {
                        text: i18n('The latest orchestration run failed'),
                        why: o.lastRun.error || i18n('One or more agents errored during the run.'),
                        source: i18n('Based on orchestrator run records'),
                        sig: String(o.lastRun.runId || 'failed'),
                        actions: [{ kind: 'ai', ws: 'orch', label: i18n('Have the AI look'), prompt: i18nFormat('Diagnose why orchestration run ${0} failed and fix the problem.', o.lastRun.runId) }],
                    };
                },
            },
            {
                id: 'orch.slowRun',
                tone: 'orch',
                get name() { return i18n('Slow orchestration run'); },
                get when() { return i18n('The most recent orchestration run took more than 25 seconds'); },
                defaultOn: true,
                check(snap) {
                    const o = snap?.orch || snap?.providers?.orch;
                    if (!o?.enabled || !o?.lastRun || !(o.lastRun.duration > SLOW_RUN_MS)) return null;
                    return {
                        text: i18nFormat('The latest orchestration run took ${0}', formatDuration(o.lastRun.duration)),
                        why: i18n('Consider checking which agent took the longest or switching slower agents to a faster connection.'),
                        source: i18n('Based on orchestrator run records'),
                        sig: String(Math.round(o.lastRun.duration / 5000)),
                        actions: [{ kind: 'ai', ws: 'orch', label: i18n('Have the AI look'), prompt: i18nFormat('Orchestration run ${0} took ${1}. Inspect which agent was slow and suggest optimizations.', o.lastRun.runId, formatDuration(o.lastRun.duration)) }],
                    };
                },
            },
        ],
    };
}
