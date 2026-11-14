// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The advanced settings shown on the settings page (no DOM).

const isLlm = (values) => values.recallMethod !== 'rag';
const rewrites = (values) => values.recallMethod === 'rag' && Boolean(values.ragUseQueryRewrite);

/** Labels are the English i18n keys already used by memory-graph. */
export const ADVANCED_FIELDS = [
    { key: 'includeWorldInfoWithPreset', label: 'Include world info', kind: 'bool' },
    { key: 'recentRawTurns', label: 'Exclude latest N assistant turns from memory injection', kind: 'int', min: 0 },
    { key: 'persistentInjectionMaxSeqDistance', label: 'Persistent injection recency horizon (assistant turns; 0 = no limit)', kind: 'int', min: 0 },
    { key: 'recallMaxIterations', label: 'Recall max iterations', kind: 'int', min: 2, max: 6, when: isLlm },
    { key: 'toolCallRetryMax', label: 'Tool-call retries', kind: 'int', min: 0, max: 10 },
    { key: 'rpmLimit', label: 'RPM limit (0 = unlimited)', kind: 'int', min: 0, max: 600 },
    { key: 'extractContextTurns', label: 'Extract context assistant turns', kind: 'int', min: 1, max: 32 },
    { key: 'extractExcludeRecentTurns', label: 'Exclude latest N assistant turns from graph extraction', kind: 'int', min: 0 },
    { key: 'recallQueryMessages', label: 'Recall query recent assistant turns', kind: 'int', min: 1, max: 64 },
    { key: 'llmVisibleRecentMessages', label: 'Visible recent message layers for generation (0 = disabled)', kind: 'int', min: 0, max: 200 },
    { key: 'extractBatchTurns', label: 'Extract batch assistant turns', kind: 'int', min: 1 },
    { key: 'extractMode', label: 'Extraction graph mode', kind: 'select', options: [['oneshot', 'One-shot (full graph input)'], ['crawl', 'Crawl (LLM-explored local slice)']] },
    { key: 'extractConcurrent', label: 'Concurrent extraction', kind: 'bool' },
    { key: 'extractCrawlMaxRounds', label: 'Crawl max rounds', kind: 'int', min: 1, max: 5 },
    { key: 'extractCrawlCandidateLimit', label: 'Crawl candidate limit', kind: 'int', min: 10, max: 100 },
    { key: 'extractCrawlMaxReads', label: 'Crawl read budget', kind: 'int', min: 1, max: 30 },
    { key: 'extractCrawlSystemPrompt', label: 'Extraction Crawl Prompt', kind: 'text' },
    { key: 'extractTemplate', label: 'Extraction Template', kind: 'text' },
    { key: 'extractEdgeRules', label: 'Edge Rules', kind: 'text' },
    { key: 'recallRouteSystemPrompt', label: 'Recall Stage 1 Prompt (Route/Drill)', kind: 'text', when: isLlm },
    { key: 'recallFinalizeSystemPrompt', label: 'Recall Stage 2 Prompt (Finalize)', kind: 'text', when: isLlm },
    { key: 'ragRewriteSystemPrompt', label: 'Query rewrite system prompt', kind: 'text', when: rewrites },
    { key: 'configIterSystemPrompt', label: 'Configuration Iteration Prompt (configuration-editor AI)', kind: 'text' },
    { key: 'graphIterSystemPrompt', label: 'Graph Revision Prompt (graph-editor AI)', kind: 'text' },
];

/** Options list with an empty choice, keeping a saved value that no longer exists. */
export function withMissing(names, selected, emptyLabel, missingSuffix) {
    const out = [{ value: '', label: emptyLabel }, ...names.map(name => ({ value: name, label: name }))];
    const value = String(selected || '');
    if (value && !names.includes(value)) out.push({ value, label: `${value} ${missingSuffix}` });
    return out;
}
