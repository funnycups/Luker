// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings metadata, quick cadence presets, gap detection, live animated demo
// frame generator, and dirty-key diffing for the Memory Graph settings view
// (pure: no DOM).

import { i18n, i18nFormat } from '../i18n.js';

const isLlm = (values) => values.recallMethod !== 'rag';
const rewrites = (values) => values.recallMethod === 'rag' && Boolean(values.ragUseQueryRewrite);

export const TECHNICAL_FIELDS = [
    { key: 'recallMaxIterations', label: 'Recall max iterations', kind: 'int', min: 2, max: 6, when: isLlm },
    { key: 'toolCallRetryMax', label: 'Tool-call retries', kind: 'int', min: 0 },
    { key: 'rpmLimit', label: 'RPM limit (0 = unlimited)', kind: 'int', min: 0, max: 600 },
    { key: 'recallQueryMessages', label: 'Recall query recent assistant turns', kind: 'int', min: 1, max: 64 },
    { key: 'extractConcurrent', label: 'Concurrent extraction', kind: 'bool' },
    { key: 'extractCrawlSystemPrompt', label: 'Extraction Crawl Prompt', kind: 'text' },
    { key: 'extractTemplate', label: 'Extraction Template', kind: 'text' },
    { key: 'extractEdgeRules', label: 'Edge Rules', kind: 'text' },
    { key: 'recallRouteSystemPrompt', label: 'Recall Routing Prompt', kind: 'text', when: isLlm },
    { key: 'recallFinalizeSystemPrompt', label: 'Recall Selection Prompt', kind: 'text', when: isLlm },
    { key: 'ragRewriteSystemPrompt', label: 'Query rewrite system prompt', kind: 'text', when: rewrites },
    { key: 'configIterSystemPrompt', label: 'Configuration Iteration Prompt (configuration-editor AI)', kind: 'text' },
    { key: 'graphIterSystemPrompt', label: 'Graph Revision Prompt (graph-editor AI)', kind: 'text' },
];

export const CADENCE_PRESETS = Object.freeze([
    Object.freeze({
        id: 'every_1',
        titleKey: 'Every reply',
        cadenceKey: 'Update every reply',
        hidingKey: 'Hide past 3 msgs',
        values: Object.freeze({
            updateEvery: 1,
            extractBatchTurns: 1,
            extractExcludeRecentTurns: 0,
            llmVisibleRecentMessages: 3,
        }),
    }),
    Object.freeze({
        id: 'balanced',
        titleKey: 'Balanced · Recommended',
        cadenceKey: 'Every 2 replies',
        hidingKey: 'Hide past 5 msgs',
        values: Object.freeze({
            updateEvery: 2,
            extractBatchTurns: 2,
            extractExcludeRecentTurns: 0,
            llmVisibleRecentMessages: 5,
        }),
    }),
    Object.freeze({
        id: 'saver',
        titleKey: 'Fewer calls',
        cadenceKey: 'Every 3 replies',
        hidingKey: 'Hide past 7 msgs',
        values: Object.freeze({
            updateEvery: 3,
            extractBatchTurns: 3,
            extractExcludeRecentTurns: 0,
            llmVisibleRecentMessages: 7,
        }),
    }),
    Object.freeze({
        id: 'long_window',
        titleKey: 'Long context',
        cadenceKey: 'Every 5 replies',
        hidingKey: 'Hide past 11 msgs',
        values: Object.freeze({
            updateEvery: 5,
            extractBatchTurns: 5,
            extractExcludeRecentTurns: 0,
            llmVisibleRecentMessages: 11,
        }),
    }),
    Object.freeze({
        id: 'no_hide',
        titleKey: 'No floor hiding',
        cadenceKey: 'Every 2 replies',
        hidingKey: 'Keep full history',
        values: Object.freeze({
            updateEvery: 2,
            extractBatchTurns: 2,
            extractExcludeRecentTurns: 0,
            llmVisibleRecentMessages: 0,
        }),
    }),
]);

function normalizeCadenceParams({
    updateEvery = 2,
    extractBatchTurns = 2,
    extractContextTurns = 2,
    extractExcludeRecentTurns = 0,
    llmVisibleRecentMessages = 5,
} = {}) {
    const every = Math.max(1, Math.floor(Number(updateEvery) || 2));
    const batch = Math.max(1, Math.floor(Number(extractBatchTurns) || 2));
    const ctx = Math.max(1, Math.floor(Number(extractContextTurns) || 2));
    const exclude = Math.max(0, Math.floor(Number.isFinite(Number(extractExcludeRecentTurns)) ? Number(extractExcludeRecentTurns) : 0));
    const rawVisible = llmVisibleRecentMessages === '' || llmVisibleRecentMessages === null || llmVisibleRecentMessages === undefined
        ? 5
        : Number(llmVisibleRecentMessages);
    const visible = Math.max(0, Math.floor(Number.isFinite(rawVisible) ? rawVisible : 5));
    return { every, batch, ctx, exclude, visible };
}

/** Returns the matching preset id when all 4 cadence/visibility keys match, else null. */
export function matchCadencePreset(advanced = null) {
    if (!advanced || typeof advanced !== 'object') return null;
    const { every, batch, exclude, visible } = normalizeCadenceParams(advanced);
    for (const preset of CADENCE_PRESETS) {
        const v = preset.values;
        if (
            every === v.updateEvery
            && batch === v.extractBatchTurns
            && exclude === v.extractExcludeRecentTurns
            && visible === v.llmVisibleRecentMessages
        ) {
            return preset.id;
        }
    }
    return null;
}

/**
 * Checks whether floor hiding can hide an unextracted message (assistant reply
 * or its paired user prompt) before extraction triggers.
 *
 * Right before extraction runs, up to `maxUnextracted = exclude + (every - 1)`
 * assistant turns and their paired user prompts are not yet in the graph.
 * Keeping all of them plus the newest user prompt visible requires at least
 * `2 * maxUnextracted + 1` messages.
 */
export function detectVisibilityGap({
    updateEvery = 2,
    extractExcludeRecentTurns = 0,
    llmVisibleRecentMessages = 5,
} = {}) {
    const { every, exclude, visible } = normalizeCadenceParams({
        updateEvery,
        extractExcludeRecentTurns,
        llmVisibleRecentMessages,
    });
    if (visible <= 0) return { hasGap: false };
    const maxUnextracted = exclude + (every - 1);
    const minRecommendedVisible = 2 * maxUnextracted + 1;
    if (visible < minRecommendedVisible) {
        return {
            hasGap: true,
            minRecommendedVisible,
            maxUnextracted,
            visibleAssistantTurns: Math.floor(visible / 2),
        };
    }
    return { hasGap: false };
}

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

function buildSendMessages(completedTurns, coveredSeq, visible) {
    const raw = [];
    for (let t = 1; t <= completedTurns; t += 1) {
        raw.push({ id: `U${t}`, role: 'user', turn: t });
        raw.push({ id: `A${t}`, role: 'assistant', turn: t });
    }
    raw.push({ id: `U${completedTurns + 1}`, role: 'user', turn: completedTurns + 1 });

    let hasGap = false;
    const total = raw.length;
    const messages = raw.map((msg, idx) => {
        const depth = total - 1 - idx;
        const hidden = visible > 0 && depth >= visible;
        if (hidden) {
            if (msg.turn <= coveredSeq) {
                return { ...msg, state: 'hidden-extracted' };
            }
            hasGap = true;
            return { ...msg, state: 'hidden-unextracted' };
        }
        if (idx === total - 1) {
            return { ...msg, state: 'newest-user' };
        }
        return { ...msg, state: msg.turn <= coveredSeq ? 'visible-extracted' : 'visible-pending' };
    });
    return { messages, hasGap };
}

function buildPostReplyMessages(completedTurns, coveredSeq, extractRange) {
    const messages = [];
    for (let t = 1; t <= completedTurns; t += 1) {
        const inExtract = extractRange && t >= extractRange.from && t <= extractRange.to;
        const state = inExtract
            ? 'extracting'
            : (t <= coveredSeq ? 'visible-extracted' : 'visible-pending');
        messages.push({ id: `U${t}`, role: 'user', turn: t, state });
        messages.push({ id: `A${t}`, role: 'assistant', turn: t, state });
    }
    return messages;
}

function formatCoveredLabel(coveredSeq) {
    if (coveredSeq <= 0) return i18n('Not extracted yet');
    if (coveredSeq === 1) return 'A1';
    return `A1–A${coveredSeq}`;
}

function formatVisibleLabel(visible, totalMessages) {
    if (visible <= 0) return i18n('All messages visible');
    return i18nFormat('Latest ${0} visible', Math.min(visible, totalMessages));
}

/**
 * Simulates the real extraction trigger + floor-hiding cycle into 4–6 key
 * frames for the interactive settings animation.
 */
export function buildCadenceDemoFrames({
    updateEvery = 2,
    extractBatchTurns = 2,
    extractExcludeRecentTurns = 0,
    llmVisibleRecentMessages = 5,
} = {}) {
    const { every, batch, exclude, visible } = normalizeCadenceParams({
        updateEvery,
        extractBatchTurns,
        extractExcludeRecentTurns,
        llmVisibleRecentMessages,
    });

    const firstTriggerTurn = exclude + every;
    const secondTriggerTurn = firstTriggerTurn + every;
    const gapInfo = detectVisibilityGap({
        updateEvery: every,
        extractExcludeRecentTurns: exclude,
        llmVisibleRecentMessages: visible,
    });

    const frames = [];
    const pushFrame = ({ caption, coveredSeq, messages, hasGap = false }) => {
        frames.push({
            step: frames.length + 1,
            caption,
            graphCovered: formatCoveredLabel(coveredSeq),
            visibleLabel: formatVisibleLabel(visible, messages.length),
            hasGap: Boolean(hasGap),
            messages,
        });
    };

    // Frame 1: accumulating (or pre-trigger gap snapshot when gap exists).
    if (gapInfo.hasGap) {
        const worstTurn = firstTriggerTurn - 1;
        const { messages, hasGap } = buildSendMessages(worstTurn, 0, visible);
        pushFrame({
            caption: i18nFormat(
                'Sending U${0}: hiding past ${1} floors hides unextracted messages before extraction triggers.',
                worstTurn + 1,
                visible,
            ),
            coveredSeq: 0,
            messages,
            hasGap,
        });
    } else if (firstTriggerTurn > 1) {
        const sampleTurn = Math.min(firstTriggerTurn - 1, Math.max(1, Math.floor(firstTriggerTurn / 2)));
        const messages = buildPostReplyMessages(sampleTurn, 0, null);
        pushFrame({
            caption: i18nFormat(
                'Reply A${0}: ${1}/${2} unextracted replies accumulated, waiting before extraction.',
                sampleTurn,
                Math.max(0, sampleTurn - exclude),
                every,
            ),
            coveredSeq: 0,
            messages,
            hasGap: false,
        });
    }

    // Frame 2: first extraction triggers at `firstTriggerTurn`.
    const firstCovered = Math.max(0, firstTriggerTurn - exclude);
    {
        const messages = buildPostReplyMessages(firstTriggerTurn, firstCovered, { from: 1, to: firstCovered });
        pushFrame({
            caption: firstCovered === 1
                ? i18nFormat('Reply A${0}: extraction triggers and writes A1 to the memory graph.', firstTriggerTurn)
                : i18nFormat('Reply A${0}: reached ${1} replies, extracting A1–A${2} into the memory graph.', firstTriggerTurn, every, firstCovered),
            coveredSeq: firstCovered,
            messages,
            hasGap: false,
        });
    }

    // Frame 3: sending right after first extraction.
    {
        const { messages, hasGap } = buildSendMessages(firstTriggerTurn, firstCovered, visible);
        const hiddenCount = messages.filter(m => m.state === 'hidden-extracted' || m.state === 'hidden-unextracted').length;
        const caption = visible <= 0
            ? i18nFormat('Sending U${0}: floor hiding is off, all ${1} messages stay visible.', firstTriggerTurn + 1, messages.length)
            : hiddenCount === 0
                ? i18nFormat('Sending U${0}: all ${1} messages fit within the ${2}-floor window.', firstTriggerTurn + 1, messages.length, visible)
                : i18nFormat('Sending U${0}: keeps the latest ${1} messages visible and hides ${2} older messages.', firstTriggerTurn + 1, visible, hiddenCount);
        pushFrame({ caption, coveredSeq: firstCovered, messages, hasGap });
    }

    // Frame 4: first turn where floor hiding kicks in (when hiding is enabled and didn't already hide in Frame 3).
    if (visible > 0) {
        const firstHideTurn = Math.max(firstTriggerTurn + 1, Math.ceil(visible / 2));
        if (firstHideTurn < secondTriggerTurn) {
            const { messages, hasGap } = buildSendMessages(firstHideTurn, firstCovered, visible);
            const hiddenExtracted = messages.filter(m => m.state === 'hidden-extracted');
            const firstId = hiddenExtracted[0]?.id || 'U1';
            const lastId = hiddenExtracted[hiddenExtracted.length - 1]?.id || firstId;
            const caption = hasGap
                ? i18nFormat('Sending U${0}: hiding past ${1} floors hides unextracted messages before extraction triggers.', firstHideTurn + 1, visible)
                : i18nFormat(
                    'Sending U${0}: keeps the latest ${1} floors while ${2}–${3} are hidden and served by the memory graph.',
                    firstHideTurn + 1,
                    visible,
                    firstId,
                    lastId,
                );
            pushFrame({ caption, coveredSeq: firstCovered, messages, hasGap });
        }
    }

    // Frame 5: second extraction cycle completed + next send sliding forward.
    {
        const secondCovered = Math.max(firstCovered, secondTriggerTurn - exclude);
        const { messages, hasGap } = buildSendMessages(secondTriggerTurn, secondCovered, visible);
        const batchStart = firstCovered + 1;
        const caption = visible <= 0
            ? i18nFormat(
                'After A${0} extracts A${1}–A${2}, sending U${3} keeps all messages visible alongside the updated graph.',
                secondTriggerTurn,
                batchStart,
                secondCovered,
                secondTriggerTurn + 1,
            )
            : i18nFormat(
                'After A${0} extracts A${1}–A${2} (${3}/batch), sending U${4} keeps the latest ${5} floors and serves older turns from the graph.',
                secondTriggerTurn,
                batchStart,
                secondCovered,
                batch,
                secondTriggerTurn + 1,
                visible,
            );
        pushFrame({ caption, coveredSeq: secondCovered, messages, hasGap });
    }

    return frames;
}

function valuesEqualForDiff(a, b) {
    if (a === b) return true;
    if (typeof b === 'boolean' || typeof a === 'boolean') return Boolean(a) === Boolean(b);
    if (typeof b === 'number') {
        if (a === '' || a === null || a === undefined) return false;
        return Number(a) === b;
    }
    if (typeof a === 'number') {
        if (b === '' || b === null || b === undefined) return false;
        return a === Number(b);
    }
    return String(a ?? '') === String(b ?? '');
}

/** Returns keys whose current draft value differs from the saved snapshot. */
export function getDirtyAdvancedKeys(current, saved) {
    if (!current || !saved || typeof current !== 'object' || typeof saved !== 'object') {
        return [];
    }
    const keys = new Set([...Object.keys(saved), ...Object.keys(current)]);
    const dirty = [];
    for (const key of keys) {
        if (!valuesEqualForDiff(current[key], saved[key])) {
            dirty.push(key);
        }
    }
    return dirty;
}
