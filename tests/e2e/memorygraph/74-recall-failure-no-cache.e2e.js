// tests/e2e/memorygraph/74-recall-failure-no-cache.e2e.js
//
// #74 — a failed recall must not poison the next prompt or the recall cache.
//
// Contract:
//   1. The pre-scan RUNTIME clear removes last turn's recall focus even when
//      GENERATION_ENDED never delivered its cleanup. Persistent always-inject
//      entries are a separate channel and must still reach the prompt.
//   2. A recall failure writes a failure trace but no focus packet and no
//      READY snapshot. Regenerating at the same anchor must run a fresh recall
//      instead of reusing the failure.
//
// Real-user flow:
//   - seed an always-inject event + a non-always-inject character sheet
//   - baseline send: successful LLM recall selects the character sheet
//   - wait for the normal ENDED cleanup, then plant a stale RUNTIME entry
//     (the crash / missed-ENDED shape) and make recall's tool-call LLM fail
//   - next send: main prompt must drop the planted focus, keep the persistent
//     event, and record recall_failed
//   - disarm the failure and regenerate: fresh recall must run and the new
//     focus must reach the prompt

import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    bootstrapVectorsBackend,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    regenerateViaUI,
} from '../_lib/page.js';
import { importMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';

let server, mock, importPath;

const EVENT_PHRASE = 'harbor bell recast with a crescent-shaped flaw along its inner lip';
const CHARACTER_PHRASE = 'folded tide-table stitched inside the left cuff of her weather coat';
const STALE_MARKER = 'STALE_RECALL_FROM_PREVIOUS_TURN: the obsolete watch roster listed only three names.';

const BASELINE_USER = 'The harbor bell cracked during the autumn gale. Did the founders ever recast it?';
const FAILED_USER = 'I heard the fleet returned under a green sky. What did the watchpost record?';

const BASELINE_REPLY = '*Seraphina sets down the tide-table and taps the bell inscription with one finger.* "They recast it before the fleet returned. The crescent flaw stayed — a signature, not a mistake."';
const FAILED_REPLY = '*Seraphina glances toward the headland, chart still folded in her cuff.* "The watch log says green sky at dusk, then three hulls north by skiff. Nothing after that."';
const REGEN_REPLY = '*Seraphina opens the cuff and lays the tide-table flat.* "The old watchpost record lists the green sky, then three hulls north. The rest of the page is salt-stained."';

const SEED_RECORDS = [
    {
        idHint: 'harbor-bell',
        type: 'event',
        title: 'Harbor bell recast',
        fields: {
            summary: 'Harbor bell recast with a crescent-shaped flaw along its inner lip before the autumn fleet returned.',
        },
    },
    {
        idHint: 'seraphina-tide-table',
        type: 'character_sheet',
        title: 'Seraphina the cartographer',
        fields: {
            title: 'Seraphina the cartographer',
            aliases: 'Sera',
            identity: 'Keeps a folded tide-table stitched inside the left cuff of her weather coat.',
            traits: 'Patient, exacting, dry-witted.',
        },
    },
    {
        idHint: 'watchpost',
        type: 'location_state',
        title: 'Bryn headland watchpost',
        fields: {
            title: 'Bryn headland watchpost',
            state: 'Green-sky watch log kept under the brass rail.',
            controller: 'Seraphina',
        },
    },
];

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [BASELINE_REPLY, FAILED_REPLY, REGEN_REPLY],
    });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'recall-failure-no-cache' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    bootstrapVectorsBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mg-recall-failure-'));
    importPath = resolve(tmpDir, 'seed.json');
    const nodes = {};
    let seq = 0;
    for (const rec of SEED_RECORDS) {
        seq += 1;
        nodes[`n_${seq}`] = {
            id: `n_${seq}`,
            type: rec.type,
            level: 'semantic',
            title: rec.title,
            parentId: '',
            childrenIds: [],
            fields: rec.fields,
            seqTo: seq,
        };
    }
    writeFileSync(importPath, JSON.stringify({
        version: 2,
        nodeSeq: SEED_RECORDS.length,
        seqCounter: SEED_RECORDS.length,
        appliedSeqTo: SEED_RECORDS.length,
        loggedSeqTo: SEED_RECORDS.length,
        nodes,
        edges: [],
    }, null, 2));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function enableMgAndTune(page) {
    await setMgSettings(page, {
        enabled: true,
        autoExtractionEnabled: false,
        recallMethod: 'llm',
        toolCallRetryMax: 0,
    }, { closeAfter: true });
}

async function importBindLatest(page, filePath) {
    await importMgGraph(page, filePath, { mode: 'bind-latest', closeAfter: true });
    await page.waitForTimeout(500);
}

function recallToolNames(request) {
    return (request.body?.tools || []).map(t => String(t?.function?.name || t?.name || ''));
}

function isRecallRequest(request) {
    const names = recallToolNames(request);
    return names.includes('luker_rpg_recall_plan') || names.includes('luker_rpg_recall_finalize');
}

function recallRequestCount() {
    return mock.requests.filter(r => r.url.includes('/chat/completions') && isRecallRequest(r)).length;
}

function findMainRequest(userText) {
    return [...mock.requests].reverse().find((request) => {
        if (!request.url.includes('/chat/completions')) return false;
        if (isRecallRequest(request)) return false;
        return JSON.stringify(request.body?.messages || []).includes(userText);
    });
}

async function readStoreState(page) {
    return await page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        const main = await import('/scripts/extensions/memory-graph/main.js');
        const store = await main.ensureMemoryStoreLoaded(ctx);
        return {
            trace: structuredClone(store?.lastRecallTrace || []),
            snapshot: main._getLatestRecallSnapshotForTest(),
            chat: (ctx.chat || []).map(m => ({ is_user: Boolean(m?.is_user), mes: String(m?.mes || '') })),
        };
    });
}

function lastUserFloor(chat) {
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (chat[i]?.is_user) return i + 1;
    }
    return null;
}

async function runtimeEntries(page) {
    return await page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        const book = await ctx.loadWorldInfo('__MEMORY_GRAPH__');
        return Object.values(book?.entries || {})
            .filter(entry => String(entry?.comment || '').startsWith('MEMORY_GRAPH_RUNTIME::'))
            .map(entry => ({
                comment: String(entry?.comment || ''),
                content: String(entry?.content || ''),
            }));
    });
}

async function seedStaleRuntimeEntry(page, marker) {
    await page.evaluate(async (staleContent) => {
        const ctx = window.Luker.getContext();
        const book = await ctx.loadWorldInfo('__MEMORY_GRAPH__');
        if (!book || !book.entries) throw new Error('shared memory-graph lorebook missing');
        const entries = Object.entries(book.entries);
        const persistent = entries.find(([, entry]) => String(entry?.comment || '').startsWith('MEMORY_GRAPH_PERSISTENT::'));
        if (!persistent) throw new Error('persistent memory-graph entry missing');
        const maxUid = entries.reduce((max, [uid]) => Math.max(max, Number(uid) || 0), -1);
        const nextUid = maxUid + 1;
        book.entries[String(nextUid)] = {
            ...structuredClone(persistent[1]),
            uid: nextUid,
            comment: 'MEMORY_GRAPH_RUNTIME::FOCUS_PACKET',
            content: staleContent,
            order: 9850,
            constant: true,
            disable: false,
        };
        await ctx.saveWorldInfo('__MEMORY_GRAPH__', book, true, { refreshEditor: true });
    }, marker);
}

test.describe('#74 — failed recall is not cached and cannot leak stale focus', () => {
    test.setTimeout(240_000);

    test('stale RUNTIME is cleared before the scan; failure writes no focus and no READY snapshot', async ({ page }) => {
        test.setTimeout(240_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableMgAndTune(page);
        await importBindLatest(page, importPath);

        // Baseline: a successful LLM recall that selects the character sheet.
        mock.scriptToolCall({
            name: 'luker_rpg_recall_plan',
            arguments: {
                action: 'finalize',
                selected_node_ids: ['n_2', 'n_3'],
                reason: 'The cartographer and the headland watchpost ground the harbor-bell question.',
            },
        });
        await sendMessageAndAwaitReply(page, BASELINE_USER);

        const baselineState = await readStoreState(page);
        expect(
            baselineState.trace.some(step => step?.step === 'plan_early_finalize_1'),
            `baseline recall should have finalized successfully: ${JSON.stringify(baselineState.trace)}`,
        ).toBe(true);
        expect(baselineState.snapshot).not.toBeNull();
        expect(baselineState.snapshot.selectedCount).toBeGreaterThan(0);

        const baselineRequest = findMainRequest(BASELINE_USER);
        expect(baselineRequest, 'baseline main chat request should be recorded').toBeTruthy();
        const baselinePrompt = JSON.stringify(baselineRequest.body?.messages || []).toLowerCase();
        expect(baselinePrompt, 'persistent event must be in the baseline prompt').toContain(EVENT_PHRASE.toLowerCase());
        expect(baselinePrompt, 'successful recall focus must be in the baseline prompt').toContain(CHARACTER_PHRASE.toLowerCase());

        // Let the normal ENDED cleanup finish, then simulate the bug shape:
        // a RUNTIME entry survives on disk because that cleanup was missed.
        await expect.poll(async () => (await runtimeEntries(page)).length, { timeout: 15_000 }).toBe(0);
        await seedStaleRuntimeEntry(page, STALE_MARKER);
        await expect.poll(async () => (await runtimeEntries(page)).length, { timeout: 10_000 }).toBe(1);

        // Recall's tool-call LLM fails; the main chat generation still answers.
        mock.setChatCompletionFailure(({ parsed }) => {
            const names = (parsed?.tools || []).map(t => String(t?.function?.name || t?.name || ''));
            if (names.includes('luker_rpg_recall_plan') || names.includes('luker_rpg_recall_finalize')) {
                return { status: 500, body: 'recall upstream failed' };
            }
            return null;
        });
        const recallCallsBeforeFailure = recallRequestCount();
        await sendMessageAndAwaitReply(page, FAILED_USER);
        mock.setChatCompletionFailure(null);

        const failedState = await readStoreState(page);
        expect(
            failedState.trace.some(step => step?.step === 'recall_failed'),
            `failure trace must be recorded: ${JSON.stringify(failedState.trace)}`,
        ).toBe(true);
        const failedFloor = lastUserFloor(failedState.chat);
        expect(failedFloor).not.toBeNull();
        expect(
            failedState.snapshot === null || failedState.snapshot.anchorFloor !== failedFloor,
            `failed recall must not become the cached READY snapshot: ${JSON.stringify(failedState.snapshot)}`,
        ).toBe(true);
        expect(
            recallRequestCount(),
            'the failed turn must have attempted recall',
        ).toBeGreaterThan(recallCallsBeforeFailure);

        const failedRequest = findMainRequest(FAILED_USER);
        expect(failedRequest, 'failed-turn main chat request should be recorded').toBeTruthy();
        const failedPrompt = JSON.stringify(failedRequest.body?.messages || []).toLowerCase();
        expect(
            failedPrompt,
            'stale RUNTIME focus must be cleared before the WI scan, not after it',
        ).not.toContain(STALE_MARKER.toLowerCase());
        expect(
            failedPrompt,
            'a failed recall must not inject any recall candidates',
        ).not.toContain(CHARACTER_PHRASE.toLowerCase());
        expect(
            failedPrompt,
            'persistent always-inject entries must survive a recall failure',
        ).toContain(EVENT_PHRASE.toLowerCase());

        // Disarm and regenerate at the same anchor. If the failure had been
        // cached, reuse would skip recall entirely and keep an empty focus.
        mock.scriptToolCall({
            name: 'luker_rpg_recall_plan',
            arguments: {
                action: 'finalize',
                selected_node_ids: ['n_2'],
                reason: 'The cartographer holds the folded tide-table referenced in the watch record.',
            },
        });
        const recallCallsBeforeRegen = recallRequestCount();
        await regenerateViaUI(page, { timeoutMs: 120_000 });

        const regenState = await readStoreState(page);
        expect(
            recallRequestCount(),
            'regenerate after a failed recall must run fresh recall, not reuse the failure',
        ).toBeGreaterThan(recallCallsBeforeRegen);
        expect(
            regenState.trace.some(step => step?.step === 'plan_early_finalize_1'),
            `regenerate should finalize successfully: ${JSON.stringify(regenState.trace)}`,
        ).toBe(true);
        expect(
            regenState.snapshot,
            'regenerate should now cache a READY snapshot for the failed anchor',
        ).not.toBeNull();
        expect(regenState.snapshot.anchorFloor).toBe(failedFloor);
        expect(regenState.snapshot.selectedCount).toBeGreaterThan(0);

        const regenRequest = findMainRequest(FAILED_USER);
        expect(regenRequest, 'regenerated main chat request should be recorded').toBeTruthy();
        const regenPrompt = JSON.stringify(regenRequest.body?.messages || []).toLowerCase();
        expect(
            regenPrompt,
            'fresh recall focus must reach the regenerated prompt',
        ).toContain(CHARACTER_PHRASE.toLowerCase());
        expect(
            regenPrompt,
            'persistent injection must remain present after regenerate',
        ).toContain(EVENT_PHRASE.toLowerCase());
    });
});
