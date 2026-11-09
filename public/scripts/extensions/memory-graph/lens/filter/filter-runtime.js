// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keeps the tag filter regex scripts registered with Luker's regex engine.
// Started from index.js (works while the lens is closed). Scripts are
// runtime-only: never written to the user's regex list, and scoped to the
// plugin request lane so they only touch text going into plugin requests
// (not plugin replies, not the main prompt).
//
// Also reproduces what memory-graph really reads for one floor, so the
// preview / AI diagnosis see the same text: whitespace collapsed (memory-graph's
// normalizeText), then the plugin lane with the user's own regex rules,
// then ours (runtime scripts always run last).

import { getRegexScripts, getScriptsByType, registerRegexProvider, SCRIPT_TYPES } from '../../../regex/engine.js';
import { i18n } from '../i18n.js';
import { buildScripts, applyScripts, compileFind, requestLaneScope, AI_OUTPUT } from './tag-filter.js';

const OWNER = 'memory-lens-tag-filter';
const SETTINGS_KEY = 'memory_lens';
export const FILTER_CHANGED_EVENT = 'memory-lens:tagfilter';

let registration = null;
let scripts = [];
let mirror = true;
let override = null; // preview: scripts to serve instead of the saved ones

const MIRROR_PREFIX = 'memory-lens-tagfilter-mirror-';
const mirrorNamePrefix = () => i18n('Memory Lens · Reused · ');

/** Settings shape: { enabled, active, presets: [{ id, name, black, white }] } */
export function readFilterSettings(ctx) {
    const all = ctx?.extensionSettings || {};
    const raw = all[SETTINGS_KEY]?.tagFilter;
    const presets = Array.isArray(raw?.presets) ? raw.presets.filter(p => p && p.id) : [];
    if (!presets.length) presets.push({ id: 'default', name: i18n('Default profile'), black: '', white: '' });
    const active = presets.some(p => p.id === raw?.active) ? raw.active : presets[0].id;
    // mirrorPrompt: also run the user's prompt-only rules (e.g. a preset's
    // thinking remover) where memory-graph reads. On unless turned off.
    return { enabled: Boolean(raw?.enabled), active, presets, mirrorPrompt: raw?.mirrorPrompt !== false };
}

export function activePlan(settings) {
    const preset = settings.presets.find(p => p.id === settings.active) || settings.presets[0];
    return { enabled: settings.enabled, black: preset?.black || '', white: preset?.white || '', mirrorPrompt: settings.mirrorPrompt !== false };
}

export function writeFilterSettings(ctx, settings) {
    const all = ctx.extensionSettings;
    all[SETTINGS_KEY] ||= {};
    all[SETTINGS_KEY].tagFilter = structuredClone(settings);
    ctx.saveSettingsDebounced?.();
    globalThis.dispatchEvent?.(new CustomEvent(FILTER_CHANGED_EVENT));
}

export function startTagFilter(getCtx) {
    // Callback provider: evaluated on every regex pass, so mirrored rules
    // follow the user's preset / character switches, and the preview can
    // swap in unsaved scripts without firing change events.
    registration = registerRegexProvider(OWNER, () => {
        if (override) return override.map(s => ({ ...s }));
        const plan = activePlan(readFilterSettings(getCtx()));
        return [...(plan.enabled && mirror ? mirroredRules() : []), ...scripts.map(s => ({ ...s }))];
    });
    if (!registration) throw new Error('could not register regex provider');
    const sync = () => {
        try {
            const plan = activePlan(readFilterSettings(getCtx()));
            scripts = buildScripts(plan);
            mirror = plan.mirrorPrompt;
        } catch (err) { scripts = []; console.warn('[memory-graph/lens] tag filter sync failed', err); }
        registration.refresh?.();
    };
    sync();
    globalThis.addEventListener?.(FILTER_CHANGED_EVENT, sync);
    return () => {
        globalThis.removeEventListener?.(FILTER_CHANGED_EVENT, sync);
        registration?.unregister();
        registration = null;
    };
}

/**
 * The user's prompt-only rules on AI replies (global / preset / character,
 * only the ones Luker currently allows), copied onto the plugin lane.
 * Depth limits are kept (memory-graph reads with each floor's real depth).
 * Skipped: rules that wipe the whole text (they hide old floors to save
 * context; mirrored they would blank memory-graph's view of older turns),
 * plugin / display-only rules, disabled rules.
 */
export function mirroredRules() {
    const out = [];
    for (const type of Object.values(SCRIPT_TYPES)) {
        let list = [];
        // getScriptsByType never calls runtime providers (no recursion).
        try { list = getScriptsByType(type, { allowedOnly: true }) || []; } catch { list = []; }
        for (const s of list) {
            if (!isPromptRule(s)) continue;
            const { pluginOnly: _legacy, pluginLanes: _lanes, ...rest } = s;
            out.push({ ...rest, id: `${MIRROR_PREFIX}${s.id || out.length}`, scriptName: `${mirrorNamePrefix()}${String(s.scriptName || '').trim() || i18n('Unnamed')}`, placement: [AI_OUTPUT], ...requestLaneScope() });
        }
    }
    return out;
}

export function isPromptRule(s) {
    if (!s || s.disabled || !s.promptOnly || hasPluginScope(s) || s.markdownOnly) return false;
    if (!Array.isArray(s.placement) || !s.placement.includes(AI_OUTPUT)) return false;
    return !isWipeRule(s);
}

/** Any plugin lane at all (legacy `pluginOnly` or `pluginLanes`). */
const hasPluginScope = (s) => Boolean(s?.pluginOnly) || (Array.isArray(s?.pluginLanes) && s.pluginLanes.length > 0);

/** On the request lane, i.e. where memory-graph reads floors. */
function onRequestLane(s) {
    if (Array.isArray(s?.pluginLanes)) return s.pluginLanes.includes('request');
    return Boolean(s?.pluginOnly);
}

// Mixed CJK and Latin sample.
const PROBE = '\u96e8\u505c\u4e86\u3002\nShe opened the door 123.';
/** A rule that turns plain text into nothing (e.g. /[\s\S]*\/ → ''). */
export function isWipeRule(s) {
    const re = compileFind(s?.findRegex);
    if (!re) return false;
    try { return !PROBE.replace(re, String(s.replaceString ?? '')).trim(); } catch { return false; }
}

const isOurs = (s) => String(s?.id || '').startsWith('memory-lens-tagfilter') || s?.__runtime_owner === OWNER;
const onPluginLane = (s) => s && !s.disabled && onRequestLane(s) && Array.isArray(s.placement) && s.placement.includes(AI_OUTPUT);

/**
 * Is the filter really registered, and which of the user's own rules also
 * run where memory-graph reads?
 */
export function filterStatus() {
    if (!registration) return { registered: false, active: 0, mirrored: [], userRules: [] };
    let all = [];
    try { all = getRegexScripts({ allowedOnly: true }) || []; } catch { all = []; }
    return {
        registered: true,
        active: all.filter(s => isOurs(s) && !s.disabled && !String(s.id).startsWith(MIRROR_PREFIX)).length,
        mirrored: all.filter(s => String(s.id || '').startsWith(MIRROR_PREFIX)).map(s => String(s.scriptName || '').replace(mirrorNamePrefix(), '')),
        userRules: all.filter(s => !isOurs(s) && onPluginLane(s)).map(s => String(s.scriptName || '').trim()).filter(Boolean),
    };
}

/** memory-graph's normalizeText. */
export const collapse = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** Depth from the chat end, skipping system rows (Luker's computeDepthsFromEnd). */
export function depthOf(chat, index) {
    let cursor = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i] || chat[i].is_system) continue;
        if (i === index) return cursor;
        cursor++;
    }
    return undefined;
}

/**
 * What memory-graph reads for one AI reply, before and after `plan`,
 * run through Luker's real regex engine.
 *   before: whitespace collapsed + the user's own plugin-only rules
 *   after:  the same + mirrored prompt-only rules (if on) + the tag filter
 * @returns {{ before: string, after: string, real: boolean }}
 *   real: false when the engine was not reachable (local fallback).
 */
export function previewFloor(ctx, index, plan) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const text = collapse(chat[index]?.mes);
    const apply = ctx?.regex?.applyRegex;
    const planScripts = buildScripts({ ...plan, enabled: true });
    if (typeof apply !== 'function' || !registration || !text) {
        return { before: text, after: planScripts.length ? applyScripts(text, planScripts) : text, real: false };
    }
    const run = (served) => {
        override = served;
        try {
            return apply(text, ctx.regex.placement?.AI_OUTPUT ?? AI_OUTPUT, { isPluginInput: true, depth: depthOf(chat, index) });
        } finally {
            override = null;
        }
    };
    try {
        const before = run([]);
        const after = run([...(plan.mirrorPrompt !== false ? mirroredRules() : []), ...planScripts]);
        return { before, after, real: true };
    } catch {
        return { before: text, after: planScripts.length ? applyScripts(text, planScripts) : text, real: false };
    }
}
