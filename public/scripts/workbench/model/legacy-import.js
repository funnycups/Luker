// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Imports conversation history once per target and scope. Executable legacy
// drafts are excluded; failed reads leave the import unacknowledged.
// Full session bodies are stored in `workbench_session_<id>` and lightweight
// summaries in `workbench_sessions`. Migrated legacy settings buckets are
// pruned only after confirmed persistence.

import { i18n, i18nFormat } from '../i18n.js';
import { SourceError } from './errors.js';
import { saveSettingsChecked } from './patch.js';
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

const LEGACY_SETTINGS = {
    orch: { plugin: 'orchestrator', key: 'iterStudioV2', scopes: new Set(['global', 'character']) },
    card: { plugin: 'character_editor_assistant', key: 'unified_cea_editor_sessions', scopes: new Set(['character']) },
    memory: { plugin: 'memory_graph', key: 'iterStudioV2Schema', scopes: new Set(['global']) },
};

function readLegacySettings(ctx, targetId, scope, avatar, mode) {
    const sessions = [];
    const plans = [];
    const legacySettingsSessions = [];
    const legacySettingsPlans = [];
    const invalid = source => new SourceError('source', i18nFormat('Legacy state "${0}" has an invalid session collection.', source));
    const collect = (plugin, key, paths, { isLegacySettings = false } = {}) => {
        const root = ctx.extensionSettings?.[plugin];
        const bucket = root?.[key];
        if (bucket === undefined) return;
        if (bucket !== null && (typeof bucket !== 'object' || Array.isArray(bucket))) throw invalid(`${plugin}.${key}`);
        const owned = paths.filter(path => path.reduce((value, part) => value?.[part], bucket) !== undefined);
        for (const path of owned) {
            const value = path.reduce((value, part) => value?.[part], bucket);
            const extracted = extractSessionObjects(value, { mode, source: [plugin, key, ...path].join('.') });
            if (isLegacySettings) legacySettingsSessions.push(...extracted);
            else sessions.push(...extracted);
        }
        if (owned.length) {
            const plan = { root, key, paths: owned, source: `${plugin}.${key}` };
            if (isLegacySettings) legacySettingsPlans.push(plan);
            else plans.push(plan);
        }
    };
    const global = LEGACY_NAMESPACES[targetId]?.global;
    if (scope === 'global' && global) {
        collect(global.plugin, global.key, targetId === 'orch' && mode ? [[mode]] : [[]]);
    }
    const format = LEGACY_SETTINGS[targetId];
    if (format && format.scopes.has(scope)) {
        const bucket = ctx.extensionSettings?.[format.plugin]?.[format.key];
        if (bucket !== undefined) {
            if (bucket !== null && (typeof bucket !== 'object' || Array.isArray(bucket))) throw invalid(`${format.plugin}.${format.key}`);
            if (targetId === 'orch') {
                const paths = [];
                const scopeKey = scope === 'global' ? 'global' : `character_${avatar}`;
                for (const [name, scopes] of Object.entries(bucket || {})) {
                    if (mode && name !== mode) continue;
                    if (scopes !== null && (typeof scopes !== 'object' || Array.isArray(scopes))) throw invalid(`${format.plugin}.${format.key}.${name}`);
                    paths.push(!scopes || !Object.keys(scopes).length ? [name] : [name, scopeKey]);
                }
                collect(format.plugin, format.key, bucket && Object.keys(bucket).length ? paths : [[]], { isLegacySettings: true });
            } else if (targetId === 'card' && scope === 'character') {
                collect(format.plugin, format.key, bucket && Object.keys(bucket).length ? [[`char_${avatar}`]] : [[]], { isLegacySettings: true });
            } else if (targetId === 'memory' && scope === 'global') {
                collect(format.plugin, format.key, [[]], { isLegacySettings: true });
            }
        }
    }
    return {
        sessions,
        plans,
        legacySettingsSessions,
        legacySettingsPlans,
    };
}

function withoutLegacyPath(bucket, path) {
    if (!path.length) return undefined;
    const [key, ...rest] = path;
    if (bucket == null || !Object.hasOwn(bucket, key)) return bucket;
    const next = { ...bucket };
    const child = withoutLegacyPath(bucket[key], rest);
    if (child === undefined) delete next[key];
    else next[key] = child;
    return Object.keys(next).length ? next : undefined;
}

async function pruneLegacySettings(ctx, plans) {
    const writes = [];
    for (const { root, key, paths } of plans) {
        const previous = root[key];
        const next = paths.reduce(withoutLegacyPath, previous);
        if (previous === next) continue;
        if (next === undefined) delete root[key];
        else root[key] = next;
        writes.push({ root, key, previous, next });
    }
    if (!writes.length) return;
    try {
        await saveSettingsChecked(ctx);
    } catch (error) {
        for (const { root, key, previous, next } of writes) {
            if (root[key] === next) root[key] = previous;
        }
        throw new SourceError('storage-error', i18nFormat(
            'Imported conversations are saved. Could not confirm cleanup of "${0}": ${1}',
            plans.map(plan => plan.source).join(', '),
            String(error?.message || error),
        ));
    }
}

function extractSessionObjects(rawState, { mode = null, source = '' } = {}) {
    if (rawState == null) return [];
    const invalid = () => new SourceError('source', i18nFormat('Legacy state "${0}" has an invalid session collection.', source));
    if (typeof rawState !== 'object') throw invalid();
    const bag = 'sessions' in rawState ? rawState.sessions : rawState;
    if (!bag || typeof bag !== 'object') throw invalid();
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
    if (!messages.length && raw.messages.length) return null;

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

/** Read legacy histories without converting failed reads into empty imports. */
export async function readLegacySessions({ ctx, targetId, scope, avatar = '', target = null, mode = null } = {}) {
    const spec = LEGACY_NAMESPACES[targetId];
    if (!ctx || !spec) return [];
    const results = [];

    const readNamespace = async (namespace, read) => {
        const result = await read();
        if (!result?.ok) {
            throw new SourceError('storage-error', i18nFormat(
                'Legacy state "${0}" could not be read: ${1}',
                namespace,
                result?.hint || result?.reason || i18n('Invalid state response'),
            ));
        }
        return extractSessionObjects(result.state, { mode, source: namespace });
    };
    if (scope === 'character' && Array.isArray(spec.character)) {
        const charAvatar = String(avatar || ctx.characters?.[ctx.characterId]?.avatar || '').trim();
        if (!charAvatar || typeof ctx.getCharacterState !== 'function') return [];
        for (const ns of spec.character) {
            results.push(...await readNamespace(ns, () => ctx.getCharacterState(charAvatar, ns)));
        }
    } else if (scope === 'chat' && Array.isArray(spec.chat)) {
        if (typeof ctx.getChatState !== 'function') return [];
        const opts = target ? { target } : {};
        for (const ns of spec.chat) {
            results.push(...await readNamespace(ns, () => ctx.getChatState(ns, opts)));
        }
    } else if (scope === 'preset' && Array.isArray(spec.preset)) {
        if (typeof ctx.presets?.state?.get !== 'function') return [];
        const opts = target ? { target } : { collection: 'openai' };
        for (const ns of spec.preset) {
            results.push(...await readNamespace(ns, () => ctx.presets.state.get(ns, opts)));
        }
    } else if (scope === 'global' && spec.global) {
        const bucket = ctx.extensionSettings?.[spec.global.plugin]?.[spec.global.key];
        results.push(...extractSessionObjects(bucket, { mode, source: spec.global.key }));
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

/** Checks whether any legacy global iteration session bucket still sits in extensionSettings. */
export function hasLegacyGlobalSettingsSessions(ctx, targetId = null) {
    const targets = targetId ? [targetId] : ['memory', 'orch'];
    for (const id of targets) {
        const globalSpec = LEGACY_NAMESPACES[id]?.global;
        if (globalSpec) {
            const pluginRoot = ctx?.extensionSettings?.[globalSpec.plugin];
            if (isPlainObject(pluginRoot) && Object.hasOwn(pluginRoot, globalSpec.key) && pluginRoot[globalSpec.key] !== undefined) {
                return true;
            }
        }
        const settingsSpec = LEGACY_SETTINGS[id];
        if (settingsSpec?.scopes.has('global')) {
            const pluginRoot = ctx?.extensionSettings?.[settingsSpec.plugin];
            if (!isPlainObject(pluginRoot) || !Object.hasOwn(pluginRoot, settingsSpec.key) || pluginRoot[settingsSpec.key] === undefined) continue;
            const bucket = pluginRoot[settingsSpec.key];
            if (id !== 'orch') {
                return true;
            }
            if (!isPlainObject(bucket) || Object.keys(bucket).length === 0) {
                return true;
            }
            for (const scopes of Object.values(bucket)) {
                if (!isPlainObject(scopes) || Object.keys(scopes).length === 0 || (Object.hasOwn(scopes, 'global') && scopes.global !== undefined)) {
                    return true;
                }
            }
        }
    }
    return false;
}

/** Checks whether any legacy settings session bucket for (targetId, scope, avatar) still sits in extensionSettings. */
export function hasLegacySettingsSessions(ctx, targetId, scope = 'global', avatar = '') {
    if (!ctx || !targetId) return false;
    const effectiveScope = String(scope || 'global').toLowerCase();
    if (effectiveScope === 'global') {
        return hasLegacyGlobalSettingsSessions(ctx, targetId);
    }
    if (effectiveScope !== 'character') return false;
    const settingsSpec = LEGACY_SETTINGS[targetId];
    if (!settingsSpec?.scopes.has('character')) return false;
    const pluginRoot = ctx?.extensionSettings?.[settingsSpec.plugin];
    if (!isPlainObject(pluginRoot) || !Object.hasOwn(pluginRoot, settingsSpec.key) || pluginRoot[settingsSpec.key] === undefined) {
        return false;
    }
    const bucket = pluginRoot[settingsSpec.key];
    if (!isPlainObject(bucket) || Object.keys(bucket).length === 0) {
        return true;
    }
    if (targetId === 'card') {
        const key = `char_${avatar}`;
        return Boolean(avatar && Object.hasOwn(bucket, key) && bucket[key] !== undefined);
    }
    if (targetId === 'orch') {
        const scopeKey = `character_${avatar}`;
        for (const scopes of Object.values(bucket)) {
            if (!isPlainObject(scopes) || Object.keys(scopes).length === 0) {
                return true;
            }
            if (avatar && Object.hasOwn(scopes, scopeKey) && scopes[scopeKey] !== undefined) {
                return true;
            }
        }
        return false;
    }
    return false;
}

/**
 * Lazily imports legacy iter-studio sessions for (targetId, scope) at most once,
 * storing full session bodies in `workbench_session_<id>` and lightweight
 * summaries plus `legacyImported[targetId]` in `workbench_sessions`.
 * Existing workbench sessions are preserved. Failed reads and invalid histories
 * leave the import marker unchanged; legacy settings buckets are pruned only
 * after confirmed persistence.
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
            throw new SourceError('storage-error', i18nFormat('Legacy state "${0}" could not be read: ${1}', SESSIONS_NAMESPACE, String(detail)));
        }
        currentState = isPlainObject(currentRes.state) ? currentRes.state : {};
    }

    const settingsSource = readLegacySettings(ctx, targetId, effectiveScope, effectiveOpts.avatar || access.avatar || '', mode);
    const markerKey = mode ? `${targetId}:${mode}` : targetId;
    const legacyImportedMap = isPlainObject(currentState.legacyImported) ? currentState.legacyImported : {};
    const legacySettingsImportedMap = isPlainObject(currentState.legacyImportedSettings) ? currentState.legacyImportedSettings : {};
    const alreadyImportedNamespaces = Boolean(legacyImportedMap[markerKey] || legacyImportedMap[targetId]);
    const alreadyImportedSettings = Boolean(legacySettingsImportedMap[markerKey] || legacySettingsImportedMap[targetId]);
    const hasUnimportedLegacySettings = settingsSource.legacySettingsPlans.length > 0 && !alreadyImportedSettings;

    if (alreadyImportedNamespaces && !hasUnimportedLegacySettings) {
        const plansToPrune = [...settingsSource.plans, ...settingsSource.legacySettingsPlans];
        if (plansToPrune.length) {
            await pruneLegacySettings(ctx, plansToPrune);
        }
        return { imported: [], alreadyImported: true };
    }

    const namespaced = (alreadyImportedNamespaces || effectiveScope === 'global')
        ? []
        : await readLegacySessions({
            ctx,
            targetId,
            scope: effectiveScope,
            avatar: effectiveOpts.avatar || access.avatar || '',
            target: effectiveOpts.target || access.target || null,
            mode,
        });
    const rawSessions = [
        ...namespaced,
        ...(alreadyImportedNamespaces ? [] : settingsSource.sessions),
        ...(alreadyImportedSettings ? [] : settingsSource.legacySettingsSessions),
    ];

    for (const raw of rawSessions) {
        if (!Array.isArray(raw.messages)) {
            throw new SourceError('source', i18nFormat('Legacy session "${0}" has invalid messages.', String(raw.id || '')));
        }
    }
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
    let alreadyImported = false;
    const writeRes = await access.update(SESSIONS_NAMESPACE, (current) => {
        added = [];
        alreadyImported = false;
        const base = isPlainObject(current) ? clone(current) : {};
        const baseImported = isPlainObject(base.legacyImported) ? base.legacyImported : {};
        const baseSettingsImported = isPlainObject(base.legacyImportedSettings) ? base.legacyImportedSettings : {};
        const nsDone = Boolean(baseImported[markerKey] || baseImported[targetId]);
        const settingsDone = Boolean(baseSettingsImported[markerKey] || baseSettingsImported[targetId]);
        const needsSettingsMark = settingsSource.legacySettingsPlans.length > 0 && !settingsDone;
        if (nsDone && !needsSettingsMark) {
            alreadyImported = true;
            return null;
        }
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
        const now = Date.now();
        return {
            ...base,
            version: SESSIONS_INDEX_VERSION,
            sessions: [...existing, ...fresh.map(toSessionSummary)],
            legacyImported: {
                ...baseImported,
                [markerKey]: baseImported[markerKey] || now,
            },
            ...(needsSettingsMark || !settingsDone ? {
                legacyImportedSettings: {
                    ...baseSettingsImported,
                    [markerKey]: baseSettingsImported[markerKey] || now,
                },
            } : {}),
        };
    });
    if (!writeRes?.ok) {
        const detail = writeRes?.hint || writeRes?.reason || 'workbench_sessions update failed';
        console.warn('[workbench/legacy-import] workbench_sessions update failed:', detail);
        throw new SourceError('storage-error', i18nFormat('Could not confirm conversation import into "${0}": ${1}', SESSIONS_NAMESPACE, String(detail)));
    }

    const plansToPrune = [...settingsSource.plans, ...settingsSource.legacySettingsPlans];
    await pruneLegacySettings(ctx, plansToPrune);
    return { imported: added, alreadyImported };
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
