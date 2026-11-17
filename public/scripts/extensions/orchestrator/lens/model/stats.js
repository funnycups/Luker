// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-agent figures over recorded runs: how often each agent ran, how long
// it took, how often it failed. Tokens are only reported per run (not per
// agent), so they are averaged per run, not split. Pure: no DOM.

import { buildRunView, displayStatus } from './run.js';

const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * @param {object[]} runs recorded runs (recorder.history())
 * @param {{ knownIds?: string[], source?: string }} [opts]
 * @returns {{ runs: number, failedRuns: number, avgDuration: number, avgTokens: number,
 *   agents: { agentId: string, runs: number, steps: number, failed: number, failRate: number,
 *     avg: number, median: number, max: number, share: number, lastError: string }[] }}
 */
export function agentStats(runs, { knownIds = [], source = 'orchestrator' } = {}) {
    const list = (runs || []).filter(run => run && (run.source || 'orchestrator') === source && run.status !== 'running' && !run.quiet);
    const byAgent = new Map();
    let failedRuns = 0;
    let durationSum = 0;
    let tokenSum = 0;
    let tokenRuns = 0;
    for (const raw of list) {
        const view = buildRunView(raw, knownIds);
        const status = displayStatus(raw.status, raw.error);
        if (status === 'error' || status === 'failed' || status === 'budget_exhausted') failedRuns++;
        durationSum += view.duration;
        if (view.tokens) { tokenSum += view.tokens; tokenRuns++; }
        const seenInRun = new Set();
        for (const seg of view.segments) {
            const entry = byAgent.get(seg.agentId) || { agentId: seg.agentId, runs: 0, steps: 0, failed: 0, durations: [], busy: 0, lastError: '' };
            entry.steps++;
            if (!seenInRun.has(seg.agentId)) { entry.runs++; seenInRun.add(seg.agentId); }
            if (seg.status === 'failed') {
                entry.failed++;
                const err = seg.sections.map(s => s.meta?.err || '').find(Boolean);
                if (err && !entry.lastError) entry.lastError = String(err);
            }
            entry.durations.push(seg.duration);
            entry.busy += seg.duration;
            byAgent.set(seg.agentId, entry);
        }
    }
    const totalBusy = [...byAgent.values()].reduce((sum, e) => sum + e.busy, 0) || 1;
    const agents = [...byAgent.values()].map(e => ({
        agentId: e.agentId,
        runs: e.runs,
        steps: e.steps,
        failed: e.failed,
        failRate: e.steps ? e.failed / e.steps : 0,
        avg: e.durations.reduce((a, b) => a + b, 0) / (e.durations.length || 1),
        median: median(e.durations),
        max: Math.max(0, ...e.durations),
        // Share of all agent working time (parallel steps both count).
        share: e.busy / totalBusy,
        lastError: e.lastError,
    })).sort((a, b) => b.share - a.share);
    return {
        runs: list.length,
        failedRuns,
        avgDuration: list.length ? durationSum / list.length : 0,
        avgTokens: tokenRuns ? tokenSum / tokenRuns : 0,
        agents,
    };
}
