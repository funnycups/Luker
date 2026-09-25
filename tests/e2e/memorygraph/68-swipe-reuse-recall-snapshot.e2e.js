// tests/e2e/memorygraph/68-swipe-reuse-recall-snapshot.e2e.js
//
// #68 — Overswipe regenerate REUSES the recall snapshot instead of running
// a fresh RAG recall on every swipe.
//
// Regression: overswipe REGENERATE (public/script.js `swipe()` →
// OVERSWIPE_BEHAVIOR.REGENERATE) wipes `chat[mesId].mes` to '' BEFORE
// animateSwipe() emits MESSAGE_SWIPED. The memory-graph listener derived
// the affected assistant seq via the extractable walk (non-empty mes),
// which skipped the wiped slot and returned null; the mutation-invalidation
// path then treated fromSeq=null as "cannot preserve" and cleared
// latestRecallSnapshot. Every swipe retry re-ran the full RAG pipeline
// (query embedding + rerank), visible to users as repeated embedding calls.
//
// Real-user flow:
//   1. Enable MG + RAG mode, import a seeded graph, sync vector index.
//   2. Send a message → fresh recall (embeddings request observed).
//   3. Overswipe right on the reply (new variant via REGENERATE branch).
//   4. Assert the second generation REUSED the snapshot:
//      - no new /embeddings request after the swipe's recall window,
//      - lastRecallProjection timestamp changes but focusPacket content is
//        identical (snapshot blocks re-projected, not recomputed).
//   5. Contrast guard: a normal send (new anchor) MUST trigger fresh recall.

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
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

let server, mock, importPath;

const SEED_RECORDS = [
    {
        idHint: 'cliff-lantern',
        type: 'event',
        title: 'Summary 1',
        fields: {
            summary: 'Cliff-path watch at dusk: the brass signal lantern was trimmed and lit before tide-rise.',
        },
    },
    {
        idHint: 'watchpost',
        type: 'location_state',
        title: 'Bryn headland watchpost',
        fields: {
            title: 'Bryn headland watchpost',
            state: 'Active nighttime post: brass spyglass on the rail, tidal charts pinned.',
            controller: 'Seraphina',
        },
    },
];

const REPLIES = [
    '*Seraphina steadies the lantern against the wind.* "First variant — the brass signal holds its flame steady above the tide."',
    '*Seraphina leans on the rail, watching the dark water.* "Second variant — the tide turns and the brass light keeps its vigil."',
    '*Seraphina folds the tidal chart away.* "Third variant — the wind shifts, yet the lantern answers from the headland."',
];

// The chat send path consumes scripted replies in order: the two warmup
// turns burn replies 1-2, so the anchor turn lands on reply 3 and the
// first overswipe lands on reply 4. Make replies 3+ cycle deterministically:
// anchor = 'Third variant', swipe variant 2 = 'First variant'.
test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [...REPLIES, ...REPLIES, ...REPLIES] });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'swipe-reuse-recall' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    bootstrapVectorsBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mg-swipe-reuse-'));
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

async function enableMgAndSelectRag(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    await page.evaluate(() => {
        const enableCb = document.getElementById('luker_rpg_memory_enabled');
        if (enableCb && !enableCb.checked) {
            enableCb.checked = true;
            enableCb.dispatchEvent(new Event('input', { bubbles: true }));
            enableCb.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Auto-extraction OFF — this test seeds the graph via Import; a live
        // extraction pass would hit the mock with tool-call-shaped requests.
        const autoCb = document.getElementById('luker_rpg_memory_auto_extraction_enabled');
        if (autoCb && autoCb.checked) {
            autoCb.checked = false;
            autoCb.dispatchEvent(new Event('input', { bubbles: true }));
            autoCb.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const method = document.getElementById('luker_rpg_memory_recall_method');
        if (method) {
            method.value = 'rag';
            method.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Imported nodes (seqTo 1..N) must stay recallable: disable the
        // raw-recent-turns exclude window like #61 does.
        const ctx = window.Luker.getContext();
        const s = ctx.extensionSettings?.memory_graph;
        if (s) s.recentRawTurns = 0;
    });
}

async function importBindLatest(page, filePath) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    // The Import button lives in the Graph pane. The tabs component
    // persists the last-selected tab in settings, so a dataRoot cloned
    // from a dev env may open on any pane — click through the real tab
    // bar like a user would instead of assuming the default pane.
    await page.evaluate(() => {
        const tab = document.querySelector('#luker_rpg_memory_tabs [data-luker-tab-key="graph"]');
        if (!tab) throw new Error('memory-graph Graph tab not in DOM');
        tab.click();
    });
    await page.locator('#luker_rpg_memory_import').click();
    await page.locator('#luker_rpg_memory_import_file').setInputFiles(filePath);
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 10_000 });
    await popup.locator('.popup-button-custom', { hasText: /Bind Latest|绑定最新/ }).first().click();
    await popup.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(500);
}

async function readRecallState(page) {
    return await page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        const main = await import('/scripts/extensions/memory-graph/main.js');
        const store = await main.ensureMemoryStoreLoaded(ctx);
        return {
            projection: structuredClone(store?.lastRecallProjection || null),
            trace: structuredClone(store?.lastRecallTrace || []),
        };
    });
}

function embedRequestCount() {
    return mock.requests.filter(r => r.url.includes('/embeddings')).length;
}

async function waitForSwipeIdle(page, timeoutMs = 30_000) {
    await page.waitForFunction(() => {
        const stop = document.querySelector('#mes_stop');
        const stopHidden = !stop || getComputedStyle(stop).display === 'none';
        const swiping = document.body.dataset.swiping === 'true';
        return stopHidden && !swiping;
    }, { timeout: timeoutMs });
    await page.waitForTimeout(150);
}

test.describe('#68 — overswipe regenerate reuses the recall snapshot', () => {
    test.setTimeout(240_000);

    test('swipe to a new variant does not re-run RAG recall when the anchor user message is unchanged', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableMgAndSelectRag(page);

        // Two RP turns for a real chat tail.
        await sendMessageAndAwaitReply(page, 'I walked the cliff path tonight.');
        await sendMessageAndAwaitReply(page, 'The brass signal lantern was trimmed and lit before tide-rise.');

        await importBindLatest(page, importPath);

        // Sync the vector index so the imported nodes are searchable, then
        // count embeddings baseline (index sync embeds nodes once).
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const settings = ctx.extensionSettings?.memory_graph;
            const main = await import('/scripts/extensions/memory-graph/main.js');
            const vi = await import('/scripts/extensions/memory-graph/vector-index.js');
            const profile = vi.getVectorConfigFromSettings(settings);
            if (!profile) return;
            const chatKey = main.resolveChatKeyForSession(ctx);
            const store = await main.ensureMemoryStoreLoaded(ctx);
            if (!store) return;
            const beforeSync = structuredClone(store);
            await vi.syncVectorIndex(store, profile, chatKey, { purge: true, tolerateErrors: false });
            await main.commitSessionMutation(ctx, chatKey, beforeSync, store);
        });

        const embedsAfterSync = embedRequestCount();
        expect(embedsAfterSync, 'vector index sync should have embedded seeded nodes').toBeGreaterThan(0);

        // The anchor turn: a normal send runs fresh RAG recall. The user
        // message mentions the seeded lantern so the recall has real hits.
        const anchor = await sendMessageAndAwaitReply(
            page,
            'Tell me about the brass signal lantern on the cliff-path watch.',
        );
        // Warmup turns burn scripted replies 1-2; the anchor turn gets
        // reply 3 ('Third variant').
        expect(anchor.text).toContain('Third variant');

        const stateAfterAnchor = await readRecallState(page);
        expect(
            stateAfterAnchor.trace.filter(t => t.step === 'rag_recall').length,
            'the anchor send must have run a fresh RAG recall',
        ).toBeGreaterThan(0);
        const anchorFocus = stateAfterAnchor.projection?.blocks?.focusPacket || '';
        expect(anchorFocus, 'anchor recall should produce a non-empty focus packet').not.toBe('');

        const embedsAfterAnchor = embedRequestCount();
        expect(
            embedsAfterAnchor - embedsAfterSync,
            'the anchor send should embed its RAG query',
        ).toBeGreaterThan(0);

        // Overswipe right on the reply: variant 2 lands via the REGENERATE
        // branch (the exact production path that used to kill the snapshot).
        //
        // Capture the recall projection DURING the swipe generation: the
        // reuse block runs inside GENERATION_AFTER_WORLD_INFO_SCAN, but the
        // post-generation MESSAGE_RECEIVED(swipe) mutation invalidation
        // nulls store.lastRecallProjection afterwards — so reading it after
        // settle always sees null. A one-shot listener on the same event
        // memory-graph's recall handler runs on observes the live state at
        // the moment reuse decided (read-only observation, no driving).
        await waitForSwipeIdle(page);
        const swipeRecallStatePromise = page.evaluate(() => new Promise((resolve, reject) => {
            const ctx = window.Luker.getContext();
            const t = setTimeout(() => reject(new Error('swipe recall state capture timeout')), 120_000);
            const off = ctx.eventSource.on(ctx.eventTypes.GENERATION_AFTER_WORLD_INFO_SCAN, async () => {
                // memory-graph's own listener for this event runs the recall;
                // it registered at init so it runs before this one. Once our
                // listener fires the projection is what this turn settled on.
                try {
                    const main = await import('/scripts/extensions/memory-graph/main.js');
                    const store = await main.ensureMemoryStoreLoaded(ctx);
                    clearTimeout(t);
                    try { ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_AFTER_WORLD_INFO_SCAN, off); } catch { /* already detached */ }
                    resolve({
                        projection: structuredClone(store?.lastRecallProjection || null),
                        trace: structuredClone(store?.lastRecallTrace || []),
                    });
                } catch (err) {
                    reject(err);
                }
            });
        }));
        await page.evaluate(() => {
            const arrow = document.querySelector('#chat .last_mes .swipe_right');
            if (!arrow) throw new Error('.swipe_right not in DOM');
            arrow.click();
        });
        // After the anchor (reply 3), the swipe regen consumes reply 4 —
        // the first entry of the second REPLIES cycle ('First variant').
        await page.waitForFunction(
            () => (document.querySelector('#chat .last_mes .mes_text')?.innerText || '').includes('First variant'),
            { timeout: 120_000 },
        );
        const swipeRecallState = await swipeRecallStatePromise;

        // Reuse contract: the focus packet is re-projected from the snapshot
        // (identical blocks), NOT recomputed by a new rag_recall pass.
        const swipeFocus = swipeRecallState.projection?.blocks?.focusPacket || '';
        expect(swipeFocus, 'swipe recall should keep a non-empty focus packet').not.toBe('');
        expect(
            swipeFocus,
            'swipe regenerate must reuse the anchor snapshot focus packet instead of re-running RAG',
        ).toBe(anchorFocus);

        // The embedding endpoint must NOT have been hit again for the swipe
        // recall: reuse skips query embedding + rerank entirely.
        const embedsAfterSwipe = embedRequestCount();
        expect(
            embedsAfterSwipe,
            'overswipe regenerate must not issue new embedding requests (snapshot reuse)',
        ).toBe(embedsAfterAnchor);

        // Contrast guard — a NEW anchor (normal send, new user message) must
        // run a fresh recall with a new embedding. This proves the previous
        // assertion is not vacuous (the mock still serves embeddings).
        await sendMessageAndAwaitReply(page, 'The salt-mark drifters moved north by skiff after midnight.');
        const embedsAfterNewAnchor = embedRequestCount();
        expect(
            embedsAfterNewAnchor,
            'a new user turn must run a fresh RAG recall (new query embedding)',
        ).toBeGreaterThan(embedsAfterSwipe);
    });
});
