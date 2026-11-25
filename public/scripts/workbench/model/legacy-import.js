// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Best-effort lazy importer for legacy iter-studio conversation histories.
// Reads readable { id, title, updatedAt, messages } from legacy character,
// chat, preset sidecars and global settings buckets once per (targetId, scope),
// writing per-session bodies into `workbench_session_<id>` and lightweight
// summaries into `workbench_sessions`, preserving existing workbench sessions
// and cleaning up migrated legacy global buckets from `extension_settings`.

import { i18n } from '../i18n.js';
import { SourceError } from './errors.js';
import {
    SESSIONS_NAMESPACE,
    SESSIONS_INDEX_VERSION,
    sessionBodyNamespace,
    toSessionSummary,
    titleFrom,
} from './sessions.js';
import { isReplayableIterationMessage } from '../../iteration-library/iter-message-filter.js';

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const LEGACY_NAMESPACES = {
    memory: {
        character: ['memory_graph_schema_iter_history'],
        global: { plugin: 'memory_graph', key: 'schema_iter_global_sessions' },
        chat: ['memory_graph__graph_iter'],
    },
    graph: {
        chat: ['memory_graph__graph_iter'],
    },
    'memory-graph': {
        chat: ['memory_graph__graph_iter'],
    },
    memory_graph: {
        chat: ['memory_graph__graph_iter'],
    },
    orch: {
        character: ['orchestrator_iter_studio_history'],
        global: { plugin: 'orchestrator', key: 'iter_studio_global_sessions' },
    },
    preset: {
        preset: ['completion_preset_assistant_session'],
    },
    card: {
        character: ['character_editor_assistant_iter_sessions', 'character_editor_assistant_sessions'],
    },
};

function extractSessionObjects(rawState, { mode = null } = {}) {
    if (!rawState || typeof rawState !== 'object') return [];
    const bag = 'sessions' in rawState ? rawState.sessions : rawState;
    if (!bag || typeof bag !== 'object') return [];
    if (Array.isArray(bag)) {
        return bag.filter(s => s && typeof s === 'object' && !Array.isArray(s));
    }
    const values = Object.values(bag);
    // Orchestrator global bucket may be nested as { [mode]: { [id]: session } }.
    const looksNestedByMode = values.some(v =>
        v && typeof v === 'object' && !Array.isArray(v) && !Array.isArray(v.messages) && !v.id &&
        Object.values(v).some(inner => inner && typeof inner === 'object' && (Array.isArray(inner.messages) || inner.id)),
    );
    if (looksNestedByMode) {
        const out = [];
        for (const [m, group] of Object.entries(bag)) {
            if (mode && m !== mode) continue;
            if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
            for (const s of Object.values(group)) {
                if (s && typeof s === 'object' && !Array.isArray(s)) out.push(s);
            }
        }
        return out;
    }
    return values.filter(s => s && typeof s === 'object' && !Array.isArray(s));
}

function normalizeToolCalls(raw) {
    const list = Array.isArray(raw.toolCalls) && raw.toolCalls.length > 0
        ? clone(raw.toolCalls)
        : (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0 ? clone(raw.tool_calls) : null);
    if (!list) return null;
    if (Array.isArray(raw.toolResults) && raw.toolResults.length > 0) {
        const byId = new Map(raw.toolResults.map(r => [String(r?.tool_call_id || r?.id || ''), r]));
        for (const tc of list) {
            const matched = byId.get(String(tc?.id || ''));
            if (matched && tc.result === undefined && tc.error === undefined) {
                tc.result = clone(matched.content ?? matched.result);
            }
        }
    }
    return list;
}

/**
 * Extracts only readable conversation fields from a legacy message,
 * dropping auto-continue fillers, tool messages, and stale edit/draft blobs.
 */
export function normalizeLegacyMessage(raw, fallbackAt = Date.now()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!isReplayableIterationMessage(raw)) return null;
    const role = String(raw.role || '').toLowerCase();
    const content = typeof raw.content === 'string' ? raw.content : String(raw.content ?? '');
    const out = {
        ...(typeof raw.id === 'string' && raw.id ? { id: raw.id } : {}),
        role,
        content,
        ...(Number.isFinite(Number(raw.at)) ? { at: Number(raw.at) } : { at: Number(fallbackAt) || Date.now() }),
    };
    if (role === 'assistant') {
        if (typeof raw.reasoning === 'string' && raw.reasoning) {
            out.reasoning = raw.reasoning;
        }
        const toolCalls = normalizeToolCalls(raw);
        if (toolCalls) out.toolCalls = toolCalls;
    }
    return out;
}

function messagesToTurns(messages, fallbackAt) {
    const turns = [];
    for (const m of messages) {
        const at = Number(m.at) || fallbackAt;
        if (m.role === 'user') {
            if (!m.content.trim()) continue;
            turns.push({ role: 'user', text: m.content, at });
        } else if (m.role === 'assistant') {
            turns.push({
                role: 'ai',
                text: m.content,
                ...(m.reasoning ? { reasoning: m.reasoning } : {}),
                ...(m.toolCalls ? { toolCalls: clone(m.toolCalls), reads: m.toolCalls.length } : {}),
                at,
            });
        }
    }
    return turns;
}

/**
 * Converts one raw legacy session object into a clean workbench iterate session.
 * Returns null if corrupt or lacking readable conversation messages.
 */
export function normalizeLegacySession(raw, { targetId, scope, scopeName = '' } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!Array.isArray(raw.messages)) return null;
    const updatedAt = Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now();
    const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : updatedAt;
    const messages = raw.messages.map(m => normalizeLegacyMessage(m, updatedAt)).filter(Boolean);
    if (!messages.length) return null;

    const firstUser = messages.find(m => m.role === 'user')?.content || '';
    const legacyId = String(raw.id || `leg_${updatedAt.toString(36)}_${Math.random().toString(36).slice(2, 6)}`);
    const rawTitle = typeof raw.title === 'string' ? raw.title.trim() : '';
    const title = rawTitle || (firstUser ? titleFrom(firstUser) : i18n('Imported conversation'));
    const turns = messagesToTurns(messages, updatedAt);

    return {
        id: `legacy_${targetId}_${legacyId}`,
        legacyId,
        kind: 'iterate',
        ws: String(targetId || ''),
        scope: String(scope || 'global'),
        scopeName: String(scopeName || ''),
        title,
        createdAt,
        updatedAt,
        pendingCount: 0,
        messages,
        turns,
        importedFromLegacy: true,
    };
}

/**
 * Best-effort read of raw legacy sessions for a (targetId, scope).
 * Never throws; logs warnings and returns [] on missing/corrupt/error reads.
 */
export async function readLegacySessions({ ctx, targetId, scope, avatar = '', target = null, mode = null } = {}) {
    const spec = LEGACY_NAMESPACES[targetId];
    if (!ctx || !spec) return [];
    const results = [];

    try {
        if (scope === 'character' && Array.isArray(spec.character)) {
            const charAvatar = String(avatar || ctx.characters?.[ctx.characterId]?.avatar || '').trim();
            if (!charAvatar || typeof ctx.getCharacterState !== 'function') return [];
            for (const ns of spec.character) {
                try {
                    const res = await ctx.getCharacterState(charAvatar, ns);
                    if (!res?.ok) {
                        console.warn(`[workbench/legacy-import] character sidecar read failed (${ns}):`, res?.hint || res?.reason || 'unknown');
                        continue;
                    }
                    if (res.state) results.push(...extractSessionObjects(res.state, { mode }));
                } catch (err) {
                    console.warn(`[workbench/legacy-import] character sidecar read threw (${ns}):`, err);
                }
            }
        } else if (scope === 'chat' && Array.isArray(spec.chat)) {
            if (typeof ctx.getChatState !== 'function') return [];
            const opts = target ? { target } : {};
            for (const ns of spec.chat) {
                try {
                    const res = await ctx.getChatState(ns, opts);
                    if (!res?.ok) {
                        console.warn(`[workbench/legacy-import] chat sidecar read failed (${ns}):`, res?.hint || res?.reason || 'unknown');
                        continue;
                    }
                    if (res.state) results.push(...extractSessionObjects(res.state, { mode }));
                } catch (err) {
                    console.warn(`[workbench/legacy-import] chat sidecar read threw (${ns}):`, err);
                }
            }
        } else if (scope === 'preset' && Array.isArray(spec.preset)) {
            if (typeof ctx.presets?.state?.get !== 'function') return [];
            const opts = target ? { target } : { collection: 'openai' };
            for (const ns of spec.preset) {
                try {
                    const res = await ctx.presets.state.get(ns, opts);
                    if (!res?.ok) {
                        console.warn(`[workbench/legacy-import] preset sidecar read failed (${ns}):`, res?.hint || res?.reason || 'unknown');
                        continue;
                    }
                    if (res.state) results.push(...extractSessionObjects(res.state, { mode }));
                } catch (err) {
                    console.warn(`[workbench/legacy-import] preset sidecar read threw (${ns}):`, err);
                }
            }
        } else if (scope === 'global' && spec.global) {
            const bucket = ctx.extensionSettings?.[spec.global.plugin]?.[spec.global.key];
            if (bucket && typeof bucket === 'object') {
                results.push(...extractSessionObjects(bucket, { mode }));
            }
        }
    } catch (err) {
        console.warn('[workbench/legacy-import] readLegacySessions failed:', err);
        return [];
    }

    return results;
}

function resolveStateBucketAccess(ctx, scopeOpts = {}) {
    if (!ctx) return null;
    const scope = String(scopeOpts?.scope || 'global').trim().toLowerCase();
    if (scope === 'global') {
        if (typeof ctx.getGlobalState !== 'function' || typeof ctx.updateGlobalState !== 'function') return null;
        return {
            read: (ns = SESSIONS_NAMESPACE) => ctx.getGlobalState(ns),
            update: (ns, updater) => ctx.updateGlobalState(ns, updater),
        };
    }
    if (scope === 'character') {
        const avatar = String(scopeOpts?.avatar || ctx.characters?.[ctx.characterId]?.avatar || '').trim();
        if (!avatar || typeof ctx.getCharacterState !== 'function' || typeof ctx.updateCharacterState !== 'function') return null;
        return {
            avatar,
            read: (ns = SESSIONS_NAMESPACE) => ctx.getCharacterState(avatar, ns),
            update: (ns, updater) => ctx.updateCharacterState(avatar, ns, updater),
        };
    }
    if (scope === 'preset') {
        if (typeof ctx.presets?.state?.get !== 'function' || typeof ctx.presets?.state?.update !== 'function') return null;
        const target = scopeOpts?.target ?? null;
        const opts = target ? { target } : { collection: scopeOpts?.collection ?? 'openai' };
        return {
            target,
            read: (ns = SESSIONS_NAMESPACE) => ctx.presets.state.get(ns, opts),
            update: (ns, updater) => ctx.presets.state.update(ns, updater, opts),
        };
    }
    if (scope === 'chat') {
        if (typeof ctx.getChatState !== 'function' || typeof ctx.updateChatState !== 'function') return null;
        const target = scopeOpts?.target ?? null;
        const opts = target ? { target } : {};
        return {
            target,
            read: (ns = SESSIONS_NAMESPACE) => ctx.getChatState(ns, opts),
            update: (ns, updater) => ctx.updateChatState(ns, updater, opts),
        };
    }
    return null;
}

/**
 * Removes an already-migrated legacy global session bucket from extensionSettings
 * so settings.json stops carrying multi-MB legacy iteration histories across reloads.
 */
function purgeLegacyGlobalBucket(ctx, targetId) {
    const spec = LEGACY_NAMESPACES[targetId]?.global;
    if (!spec) return false;
    const pluginRoot = ctx?.extensionSettings?.[spec.plugin];
    if (!isPlainObject(pluginRoot) || !Object.hasOwn(pluginRoot, spec.key)) {
        return false;
    }
    delete pluginRoot[spec.key];
    try {
        ctx.saveSettingsDebounced?.();
    } catch (err) {
        console.warn('[workbench/legacy-import] saveSettingsDebounced failed after purging legacy bucket:', err);
    }
    return true;
}

/** Checks whether any legacy global iteration session bucket still sits in extensionSettings. */
export function hasLegacyGlobalSettingsSessions(ctx, targetId = null) {
    const targets = targetId ? [targetId] : ['memory', 'orch'];
    for (const id of targets) {
        const spec = LEGACY_NAMESPACES[id]?.global;
        if (!spec) continue;
        const pluginRoot = ctx?.extensionSettings?.[spec.plugin];
        if (isPlainObject(pluginRoot) && Object.hasOwn(pluginRoot, spec.key)) {
            return true;
        }
    }
    return false;
}

/**
 * Lazily imports legacy iter-studio sessions for (targetId, scope) at most once,
 * storing full session bodies in `workbench_session_<id>` and lightweight
 * summaries plus `legacyImported[targetId]` in `workbench_sessions`.
 * For global scope, deletes the migrated bucket from `extensionSettings` once
 * persistence in GlobalState is confirmed.
 */
export async function importLegacySessionsOnce({
    ctx,
    targetId,
    scope,
    scopeOpts = null,
    scopeName = '',
    mode = null,
    prefetchedState = undefined,
} = {}) {
    const effectiveOpts = scopeOpts || { scope: scope || 'global' };
    const effectiveScope = String(effectiveOpts.scope || scope || 'global').toLowerCase();
    const access = resolveStateBucketAccess(ctx, effectiveOpts);
    if (!access) {
        return { imported: [], alreadyImported: false };
    }

    let currentState;
    if (prefetchedState !== undefined) {
        currentState = isPlainObject(prefetchedState) ? prefetchedState : {};
    } else {
        let currentRes;
        try {
            currentRes = await access.read(SESSIONS_NAMESPACE);
        } catch (err) {
            console.warn('[workbench/legacy-import] workbench_sessions read failed:', err);
            throw err;
        }
        if (!currentRes?.ok) {
            const detail = currentRes?.hint || currentRes?.reason || 'workbench_sessions read failed';
            console.warn('[workbench/legacy-import] workbench_sessions read failed:', detail);
            throw new SourceError('storage-error', String(detail));
        }
        currentState = isPlainObject(currentRes.state) ? currentRes.state : {};
    }

    if (currentState.legacyImported?.[targetId]) {
        if (effectiveScope === 'global') {
            purgeLegacyGlobalBucket(ctx, targetId);
        }
        return { imported: [], alreadyImported: true };
    }

    const rawSessions = await readLegacySessions({
        ctx,
        targetId,
        scope: effectiveScope,
        avatar: effectiveOpts.avatar || access.avatar || '',
        target: effectiveOpts.target || access.target || null,
        mode,
    });

    const normalized = rawSessions
        .map(raw => normalizeLegacySession(raw, { targetId, scope: effectiveScope, scopeName }))
        .filter(Boolean);

    const existingBefore = Array.isArray(currentState.sessions) ? currentState.sessions : [];
    const preSeenIds = new Set(existingBefore.map(s => s?.id).filter(Boolean));
    const preSeenScoped = new Set(
        existingBefore.filter(s => s?.ws && s?.legacyId).map(s => `${s.ws}:${s.legacyId}`),
    );
    const deduped = [];
    for (const s of normalized) {
        const scopedKey = s?.ws && s?.legacyId ? `${s.ws}:${s.legacyId}` : '';
        if ((s?.id && preSeenIds.has(s.id)) || (scopedKey && preSeenScoped.has(scopedKey))) {
            continue;
        }
        if (s?.id) preSeenIds.add(s.id);
        if (scopedKey) preSeenScoped.add(scopedKey);
        deduped.push(s);
    }

    // Persist full session bodies first so the index never references a missing body.
    for (const session of deduped) {
        const bodyNs = sessionBodyNamespace(session.id);
        const bodyRes = await access.update(bodyNs, (existing) => {
            if (isPlainObject(existing) && existing.id === session.id && Array.isArray(existing.turns)) {
                return null;
            }
            return session;
        });
        if (!bodyRes?.ok) {
            const detail = bodyRes?.hint || bodyRes?.reason || 'workbench_session body write failed';
            console.warn('[workbench/legacy-import] session body write failed:', detail);
            throw new SourceError('storage-error', String(detail));
        }
    }

    let added = [];
    const writeRes = await access.update(SESSIONS_NAMESPACE, (current) => {
        const base = isPlainObject(current) ? clone(current) : {};
        if (base.legacyImported?.[targetId]) return null;
        const existing = Array.isArray(base.sessions) ? base.sessions : [];
        const seenIds = new Set(existing.map(s => s?.id).filter(Boolean));
        const seenScopedLegacy = new Set(
            existing.filter(s => s?.ws && s?.legacyId).map(s => `${s.ws}:${s.legacyId}`),
        );
        const fresh = deduped.filter((s) => {
            const scopedKey = s?.ws && s?.legacyId ? `${s.ws}:${s.legacyId}` : '';
            if ((s?.id && seenIds.has(s.id)) || (scopedKey && seenScopedLegacy.has(scopedKey))) {
                return false;
            }
            if (s?.id) seenIds.add(s.id);
            if (scopedKey) seenScopedLegacy.add(scopedKey);
            return true;
        });
        added = fresh;
        return {
            ...base,
            version: SESSIONS_INDEX_VERSION,
            sessions: [...existing, ...fresh.map(toSessionSummary)],
            legacyImported: {
                ...(isPlainObject(base.legacyImported) ? base.legacyImported : {}),
                [targetId]: Date.now(),
            },
        };
    });
    if (!writeRes?.ok) {
        const detail = writeRes?.hint || writeRes?.reason || 'workbench_sessions update failed';
        console.warn('[workbench/legacy-import] workbench_sessions update failed:', detail);
        throw new SourceError('storage-error', String(detail));
    }

    if (effectiveScope === 'global') {
        purgeLegacyGlobalBucket(ctx, targetId);
    }

    return { imported: added, alreadyImported: false };
}

/**
 * One-shot startup migration for users who still have legacy global iteration
 * sessions inside extensionSettings (settings.json). Does zero async I/O when
 * neither legacy key exists.
 */
export async function cleanupLegacyGlobalSettingsSessions(ctx) {
    if (!ctx || !hasLegacyGlobalSettingsSessions(ctx)) {
        return { cleaned: [] };
    }
    const cleaned = [];
    for (const targetId of ['memory', 'orch']) {
        if (!hasLegacyGlobalSettingsSessions(ctx, targetId)) continue;
        try {
            await importLegacySessionsOnce({
                ctx,
                targetId,
                scope: 'global',
                scopeOpts: { scope: 'global' },
                scopeName: i18n('Global'),
            });
            cleaned.push(targetId);
        } catch (err) {
            console.warn(`[workbench/legacy-import] startup global cleanup failed for ${targetId}:`, err);
        }
    }
    return { cleaned };
}
