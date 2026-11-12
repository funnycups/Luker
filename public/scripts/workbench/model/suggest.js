// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Suggestions: fixed local rules over a snapshot of core Luker data plus any
// registered SuggestRuleProvider rules. No AI, no network.

import { i18n, i18nFormat } from '../i18n.js';

export const RULES = [
    { id: 'preset.dup', tone: 'preset', name: i18n('Duplicate preset entries'), when: i18n('Two enabled entries are over 80% the same'), defaultOn: false },
    { id: 'card.pending', tone: 'card', name: i18n('Unconfirmed character card changes'), when: i18n('An AI chat has changes neither applied nor discarded'), defaultOn: true },
];

const CHECKS = {
    'preset.dup'(snap) {
        const prompts = (snap.preset?.prompts || []).filter(p => p.enabled && String(p.text || '').trim().length >= 20);
        for (let i = 0; i < prompts.length; i++) {
            for (let j = i + 1; j < prompts.length; j++) {
                const sim = similarity(prompts[i].text, prompts[j].text);
                if (sim >= 0.8) {
                    return {
                        text: i18nFormat('Preset entries "${0}" and "${1}" are nearly the same', prompts[i].name, prompts[j].name),
                        why: i18nFormat('Both are on and ${0}% the same, so the model reads it twice.', Math.round(sim * 100)),
                        source: i18nFormat('Based on preset "${0}"', snap.preset.name),
                        sig: `${prompts[i].id}|${prompts[j].id}`,
                        actions: [{ kind: 'ai', ws: 'preset', label: i18n('Have the AI look'), prompt: i18nFormat('Preset entries "${0}" and "${1}" are nearly the same. Merge them or remove the duplicate parts.', prompts[i].name, prompts[j].name) }],
                    };
                }
            }
        }
        return null;
    },
    'card.pending'(snap) {
        const c = snap.card;
        if (!c || !(c.pending > 0)) return null;
        return {
            text: i18nFormat('${0} character card changes are waiting for you', c.pending),
            why: i18nFormat('"${0}" has ${1} changes neither applied nor discarded.', c.sessionTitle || i18n('AI chat'), c.pending),
            source: i18n('Based on workbench AI chats'),
            sig: `${c.pending}`,
            actions: [{ kind: 'session', sessionId: c.sessionId, label: i18n('Go review'), primary: true }],
        };
    },
};

/** Character-bigram Dice similarity (0..1); good enough for CJK and Latin. */
export function similarity(a, b) {
    const grams = (text) => {
        const s = String(text || '').replace(/\s+/g, '');
        const m = new Map();
        for (let i = 0; i < s.length - 1; i++) {
            const g = s.slice(i, i + 2);
            m.set(g, (m.get(g) || 0) + 1);
        }
        return m;
    };
    const ga = grams(a);
    const gb = grams(b);
    let total = 0;
    let shared = 0;
    for (const n of ga.values()) total += n;
    for (const n of gb.values()) total += n;
    for (const [g, n] of ga) shared += Math.min(n, gb.get(g) || 0);
    return total ? (2 * shared) / total : 0;
}

/**
 * Returns core rules merged with rules registered by SuggestRuleProviders.
 * @param {Array<{ id: string, rules?: Array<object> }>} [providers]
 */
export function listRules(providers = []) {
    const out = RULES.map(r => ({ ...r }));
    const seen = new Set(out.map(r => r.id));
    for (const provider of Array.isArray(providers) ? providers : []) {
        for (const rule of Array.isArray(provider?.rules) ? provider.rules : []) {
            if (!rule?.id || seen.has(rule.id)) continue;
            seen.add(rule.id);
            out.push({
                id: rule.id,
                tone: rule.tone || provider.tone || provider.id || 'other',
                name: rule.name || rule.id,
                when: rule.when || '',
                defaultOn: rule.defaultOn !== false,
                check: typeof rule.check === 'function' ? rule.check : null,
            });
        }
    }
    return out;
}

/**
 * @param {object} snap
 * @param {{ enabled?: Record<string, boolean>, dismissed?: Record<string, string>, providers?: Array<object> }} [prefs]
 * @returns {{ id: string, tone: string, name: string, text: string, why: string, source: string, sig: string, actions: any[] }[]}
 */
export function runRules(snap, { enabled = {}, dismissed = {}, providers = [] } = {}) {
    const out = [];
    const seen = new Set();
    const allRules = listRules(providers);

    for (const rule of allRules) {
        const on = enabled[rule.id] ?? rule.defaultOn ?? true;
        if (!on) continue;
        const checker = typeof rule.check === 'function' ? rule.check : CHECKS[rule.id];
        if (typeof checker !== 'function') continue;
        let found = null;
        try { found = checker(snap || {}); } catch { found = null; }
        if (!found) continue;
        if (dismissed[rule.id] && dismissed[rule.id] === found.sig) continue;
        seen.add(rule.id);
        out.push({ id: rule.id, tone: rule.tone, name: rule.name, ...found });
    }

    for (const provider of Array.isArray(providers) ? providers : []) {
        if (typeof provider?.evaluate !== 'function') continue;
        let items = [];
        try { items = provider.evaluate(snap || {}, { enabled, dismissed }) || []; } catch { items = []; }
        for (const item of Array.isArray(items) ? items : []) {
            if (!item?.id || seen.has(item.id)) continue;
            const on = enabled[item.id] ?? item.defaultOn ?? true;
            if (!on) continue;
            if (dismissed[item.id] && dismissed[item.id] === item.sig) continue;
            seen.add(item.id);
            out.push(item);
        }
    }

    // Things waiting on the user first.
    return out.sort((a, b) => Number(b.id === 'card.pending') - Number(a.id === 'card.pending'));
}
