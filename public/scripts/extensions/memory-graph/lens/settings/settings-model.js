// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings metadata, missing-option helpers, and deterministic cadence summary
// for the Memory Graph settings view (pure: no DOM).

import { i18nFormat } from '../i18n.js';

const isLlm = (values) => values.recallMethod !== 'rag';
const rewrites = (values) => values.recallMethod === 'rag' && Boolean(values.ragUseQueryRewrite);

export const TECHNICAL_FIELDS = [
    { key: 'recallMaxIterations', label: 'Recall max iterations', kind: 'int', min: 2, max: 6, when: isLlm },
    { key: 'toolCallRetryMax', label: 'Tool-call retries', kind: 'int', min: 0, max: 10 },
    { key: 'rpmLimit', label: 'RPM limit (0 = unlimited)', kind: 'int', min: 0, max: 600 },
    { key: 'recallQueryMessages', label: 'Recall query recent assistant turns', kind: 'int', min: 1, max: 64 },
    { key: 'llmVisibleRecentMessages', label: 'Visible recent message layers for generation (0 = disabled)', kind: 'int', min: 0, max: 200 },
    { key: 'extractConcurrent', label: 'Concurrent extraction', kind: 'bool' },
    { key: 'extractCrawlSystemPrompt', label: 'Extraction Crawl Prompt', kind: 'text' },
    { key: 'extractTemplate', label: 'Extraction Template', kind: 'text' },
    { key: 'extractEdgeRules', label: 'Edge Rules', kind: 'text' },
    { key: 'recallRouteSystemPrompt', label: 'Recall Stage 1 Prompt (Route/Drill)', kind: 'text', when: isLlm },
    { key: 'recallFinalizeSystemPrompt', label: 'Recall Stage 2 Prompt (Finalize)', kind: 'text', when: isLlm },
    { key: 'ragRewriteSystemPrompt', label: 'Query rewrite system prompt', kind: 'text', when: rewrites },
    { key: 'configIterSystemPrompt', label: 'Configuration Iteration Prompt (configuration-editor AI)', kind: 'text' },
    { key: 'graphIterSystemPrompt', label: 'Graph Revision Prompt (graph-editor AI)', kind: 'text' },
];

/** Options list with an empty choice, keeping a saved string value that no longer exists. */
export function withMissing(names, selected, emptyLabel, missingSuffix) {
    const list = Array.isArray(names) ? names : [];
    const out = [{ value: '', label: emptyLabel }, ...list.map(name => ({ value: name, label: name }))];
    const value = String(selected || '');
    if (value && !list.includes(value)) out.push({ value, label: `${value} ${missingSuffix}` });
    return out;
}

/** Options list for `{ id, name }` profiles, marking deleted profile IDs as missing. */
export function withMissingProfiles(profiles, selected, emptyLabel, missingSuffix) {
    const list = Array.isArray(profiles) ? profiles : [];
    const out = [{ value: '', label: emptyLabel }, ...list.map(p => ({ value: String(p.id || ''), label: String(p.name || p.id || '') }))];
    const value = String(selected || '');
    if (value && !list.some(p => String(p.id || '') === value)) {
        out.push({ value, label: `${value} ${missingSuffix}` });
    }
    return out;
}

/** Factual deterministic runtime summary of extraction cadence and window knobs. */
export function formatCadenceSummary({ updateEvery = 1, extractBatchTurns = 1, extractContextTurns = 4, extractExcludeRecentTurns = 0 } = {}) {
    const every = Math.max(1, Math.floor(Number(updateEvery) || 1));
    const batch = Math.max(1, Math.floor(Number(extractBatchTurns) || 1));
    const ctx = Math.max(1, Math.floor(Number(extractContextTurns) || 1));
    const exclude = Math.max(0, Math.floor(Number(extractExcludeRecentTurns) || 0));
    return i18nFormat(
        'Current configuration: triggers every ${0} assistant turns, processes up to ${1} unextracted turns per batch with ${2} preceding context turns, and excludes the latest ${3} assistant turns.',
        every,
        batch,
        ctx,
        exclude,
    );
}
