// SPDX-License-Identifier: AGPL-3.0-or-later
//
// suggestions: fixed local rules over a snapshot of the four workbenches. No AI,
// no network. Each rule returns at most one suggestion with the numbers it
// was based on (shown under "Why this suggestion") and the actions it offers.
//
// Snapshot shape (every part optional; a missing part skips its rules):
//   memory: { core, coreHistory: number[], events, unmerged, compression: bool,
//             threshold, maxSeqDistance, floors }
//   budget: { total, max }
//   orch:   { runs: [{ at, durationMs, agents: [{ id, label, durationMs, error }] }] }
//   preset: { name, prompts: [{ id, name, text, enabled }] }
//   card:   { name, pending: number, sessionTitle }

import { i18n, i18nFormat } from '../i18n.js';
import { formatTokens } from '../../lens-shared/util.js';

export const RULES = [
    { id: 'memory.coreHigh', tone: 'memory', name: i18n('High always-on injection'), when: i18n('Always-on injection is over 1.5x the usual for this chat, or over 20% of the context'), defaultOn: true },
    { id: 'memory.unmerged', tone: 'memory', name: i18n('Unmerged events piling up'), when: i18n('More than 50 unmerged events'), defaultOn: true },
    { id: 'memory.horizon', tone: 'memory', name: i18n('Unlimited always-on lookback'), when: i18n('"Max lookback floors for always-on injection" is 0 and the chat is over 200 floors'), defaultOn: true },
    { id: 'orch.errors', tone: 'orch', name: i18n('Agent keeps failing'), when: i18n('The same agent failed at least twice in the last 5 runs'), defaultOn: true },
    { id: 'orch.slow', tone: 'orch', name: i18n('Slow agent'), when: i18n('An agent takes over half of the run on average (at least 3 runs)'), defaultOn: true },
    { id: 'preset.dup', tone: 'preset', name: i18n('Duplicate preset entries'), when: i18n('Two enabled entries are over 80% the same'), defaultOn: false },
    { id: 'card.pending', tone: 'card', name: i18n('Unconfirmed character card changes'), when: i18n('An AI chat has changes neither applied nor discarded'), defaultOn: true },
];

export const HORIZON_SUGGESTED = 100;

function median(list) {
    const v = list.filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!v.length) return 0;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const CHECKS = {
    'memory.coreHigh'(snap) {
        const m = snap.memory;
        if (!m || !(m.core > 0)) return null;
        const typical = median(m.coreHistory || []);
        const max = snap.budget?.max || 0;
        const ratio = typical >= 200 && (m.coreHistory || []).length >= 5 ? m.core / typical : 0;
        const share = max ? m.core / max : 0;
        if (ratio < 1.5 && share < 0.2) return null;
        const reasons = [];
        if (ratio >= 1.5) reasons.push(i18nFormat('Always-on injection is ${0} this time; this chat usually has about ${1}, so it is ${2}x higher.', formatTokens(m.core), formatTokens(typical), ratio.toFixed(1)));
        if (share >= 0.2) reasons.push(i18nFormat('It takes ${0}% of the ${1} context limit.', Math.round(share * 100), formatTokens(max)));
        return {
            text: i18nFormat('Memory graph always-on injection is ${0}, ${1}', formatTokens(m.core), ratio >= 1.5 ? i18nFormat('${0}x the usual', ratio.toFixed(1)) : i18nFormat('${0}% of the context', Math.round(share * 100))),
            why: reasons.join(''),
            source: i18n('Based on the memory graph\'s injection and token records'),
            sig: `${Math.round(m.core / 500)}`,
            actions: [{ kind: 'ask', label: i18n('See which ones'), question: i18n('Why is memory graph always-on injection so high? Which types and entries take it up?') }],
        };
    },
    'memory.unmerged'(snap) {
        const m = snap.memory;
        if (!m || !(m.unmerged > 50)) return null;
        const why = i18nFormat('${0} events in total; ${1} are not merged into summaries and are all injected.', m.events, m.unmerged)
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
    'memory.horizon'(snap) {
        const m = snap.memory;
        if (!m || m.maxSeqDistance !== 0 || !(m.floors > 200)) return null;
        return {
            text: i18n('"Max lookback floors for always-on injection" is unlimited'),
            why: i18nFormat('The chat has ${0} floors and this is 0 (unlimited), so very old content stays injected. Set it to ${1} and older content is recalled only when needed.', m.floors, HORIZON_SUGGESTED),
            source: i18n('Based on memory graph settings'),
            sig: 'on',
            actions: [{ kind: 'setHorizon', value: HORIZON_SUGGESTED, label: i18nFormat('Set to ${0} floors', HORIZON_SUGGESTED) }],
        };
    },
    'orch.errors'(snap) {
        const runs = (snap.orch?.runs || []).slice(-5);
        if (runs.length < 2) return null;
        const counts = new Map();
        for (const run of runs) {
            for (const a of run.agents || []) {
                if (!a.error) continue;
                const c = counts.get(a.id) || { label: a.label || a.id, n: 0, last: '' };
                c.n++;
                c.last = String(a.error);
                counts.set(a.id, c);
            }
        }
        const worst = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
        if (!worst || worst[1].n < 2) return null;
        const [id, c] = worst;
        return {
            text: i18nFormat('"${0}" failed ${1} of the last ${2} runs', c.label, c.n, runs.length),
            why: i18nFormat('In the last ${0} runs, "${1}" failed ${2} times. Latest error: ${3}', runs.length, c.label, c.n, c.last.slice(0, 120)),
            source: i18n('Based on orchestrator run records'),
            sig: `${id}:${c.n}`,
            actions: [{ kind: 'ai', ws: 'orch', label: i18n('Have the AI look'), prompt: i18nFormat('"${0}" in the orchestration failed ${1} of the last ${2} runs. Latest error: ${3}. Find out why.', c.label, c.n, runs.length, c.last.slice(0, 300)) }],
        };
    },
    'orch.slow'(snap) {
        const runs = (snap.orch?.runs || []).filter(r => r.durationMs > 0).slice(-10);
        if (runs.length < 3) return null;
        const share = new Map();
        for (const run of runs) {
            for (const a of run.agents || []) {
                if (!(a.durationMs > 0)) continue;
                const s = share.get(a.id) || { label: a.label || a.id, sum: 0, n: 0, ms: 0 };
                s.sum += a.durationMs / run.durationMs;
                s.ms += a.durationMs;
                s.n++;
                share.set(a.id, s);
            }
        }
        const top = [...share.entries()].map(([id, s]) => ({ id, ...s, avg: s.sum / s.n })).sort((a, b) => b.avg - a.avg)[0];
        if (!top || top.n < 3 || top.avg <= 0.5) return null;
        const sec = (top.ms / top.n / 1000).toFixed(1);
        return {
            text: i18nFormat('"${0}" takes over half of the orchestration time', top.label),
            why: i18nFormat('In the last ${0} runs, "${1}" averaged ${2}s, ${3}% of the whole run.', runs.length, top.label, sec, Math.round(top.avg * 100)),
            source: i18n('Based on orchestrator run records'),
            sig: `${top.id}:${Math.round(top.avg * 10)}`,
            actions: [{ kind: 'ai', ws: 'orch', label: i18n('Have the AI look'), prompt: i18nFormat('"${0}" in the orchestration averages ${1}s, ${2}% of the whole run. See if it can be faster.', top.label, sec, Math.round(top.avg * 100)) }],
        };
    },
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
 * @param {object} snap
 * @param {{ enabled?: Record<string, boolean>, dismissed?: Record<string, string> }} prefs
 *   dismissed: ruleId → sig at the time it was ignored; it comes back when the numbers change.
 * @returns {{ id, tone, name, text, why, source, actions }[]}
 */
export function runRules(snap, { enabled = {}, dismissed = {} } = {}) {
    const out = [];
    for (const rule of RULES) {
        const on = enabled[rule.id] ?? rule.defaultOn;
        if (!on) continue;
        let found = null;
        try { found = CHECKS[rule.id](snap || {}); } catch { found = null; }
        if (!found) continue;
        if (dismissed[rule.id] && dismissed[rule.id] === found.sig) continue;
        out.push({ id: rule.id, tone: rule.tone, name: rule.name, ...found });
    }
    // Things waiting on the user first.
    return out.sort((a, b) => (b.id === 'card.pending') - (a.id === 'card.pending'));
}
