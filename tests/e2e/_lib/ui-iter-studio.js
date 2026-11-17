// Real-UI helpers for AI iteration inside the unified Workbench.
// Maps legacy studio variant names ('cpa', 'orch', 'cea', 'mg', 'mg-graph',
// 'world') onto real Workbench UI gestures (open Workbench → AI iteration tab →
// target segmented control → composer fill + Send → Apply selected / Discard / Undo).

import {
    applyIterateChanges,
    closeWorkbench,
    discardIterateChanges,
    openWorkbenchIterate,
    sendIteratePrompt,
    undoIterateChanges,
} from './ui-workbench.js';

const VARIANT_TARGET_MAP = {
    cpa: 'preset',
    preset: 'preset',
    orch: 'orch',
    cea: 'card',
    card: 'card',
    mg: 'memory',
    memory: 'memory',
    'mg-graph': 'memory_graph',
    memory_graph: 'memory_graph',
    world: 'world',
};

function resolveTarget(variant) {
    const targetId = VARIANT_TARGET_MAP[variant];
    if (!targetId) throw new Error(`unknown iter-studio variant: ${variant}`);
    return targetId;
}

/**
 * Open Workbench AI iteration for the given variant via real DOM clicks.
 *
 * @param {import('@playwright/test').Page} page
 * @param {'cpa'|'orch'|'cea'|'mg'|'mg-graph'|'world'} variant
 * @param {object} [opts]
 * @param {'global'|'character'|'preset'|'chat'|null} [opts.scope]
 * @param {number} [opts.timeoutMs]
 */
export async function openIterStudio(page, variant, { scope = null, timeoutMs = 20_000 } = {}) {
    const targetId = resolveTarget(variant);
    await openWorkbenchIterate(page, targetId, { scope, timeoutMs });
}

/**
 * Fill the Workbench AI iteration composer, click Send, and wait for the
 * pending change list card to render.
 */
export async function sendIterPrompt(page, variant, prompt, { applyTimeoutMs = 60_000 } = {}) {
    resolveTarget(variant);
    await sendIteratePrompt(page, prompt, { waitFor: 'changes', timeoutMs: applyTimeoutMs });
}

/**
 * Click `Apply selected` on the pending change list card.
 */
export async function applyIterBatch(page, variant, { timeoutMs = 30_000 } = {}) {
    resolveTarget(variant);
    await applyIterateChanges(page, { timeoutMs });
}

/**
 * Click `Discard everything` on the pending change list card.
 */
export async function discardIterBatch(page, variant, { timeoutMs = 10_000 } = {}) {
    resolveTarget(variant);
    await discardIterateChanges(page, { timeoutMs });
}

/**
 * Click `Undo` on the applied change list card.
 */
export async function rollbackIterBatch(page, variant, { timeoutMs = 15_000 } = {}) {
    resolveTarget(variant);
    await undoIterateChanges(page, { timeoutMs });
}

/**
 * Fold the Workbench window back to its corner pill.
 */
export async function closeIterStudio(page) {
    await closeWorkbench(page);
}
