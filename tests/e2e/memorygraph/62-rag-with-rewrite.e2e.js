// tests/e2e/memorygraph/62-rag-with-rewrite.e2e.js
//
// #62 — RAG recall with the query-rewrite toggle on.
//
// Real-user flow:
//   1. Enable MG, switch recall method to RAG.
//   2. Tick "Enable query rewrite" and configure the rewrite preset to point
//      at the mock LLM (reuses the same connection profile as main chat).
//   3. Import 4 distinctive seeded nodes.
//   4. Pre-queue a scripted tool_call for `rewrite_recall_query` returning
//      tokens that semantically match Summary 1 (cliff lantern) — the user
//      message will be generic to prove the rewrite is what's embedded.
//   5. Send a generic user turn.
//   6. Inspect `lastRecallTrace` and assert meta.rewriteApplied=true and
//      n_1 was selected.

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
} from '../_lib/page.js';
import { importMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';

let server, mock, importPath, mockProfileName;

const REWRITE_TARGET = 'brass signal lantern trimmed at dusk cliff-path watch';

const SEED_RECORDS = [
    {
        type: 'event',
        title: 'Summary 1',
        fields: {
            summary: 'Cliff-path watch at dusk: the brass signal lantern was trimmed and lit before tide-rise.',
        },
    },
    {
        type: 'event',
        title: 'Summary 2',
        fields: {
            summary: 'Salt-mark drifters were sighted moving north by skiff along the channel after midnight.',
        },
    },
    {
        type: 'character_sheet',
        title: 'Seraphina',
        fields: {
            title: 'Seraphina',
            identity: 'Wind-bitten Bryn coastal cartographer.',
            traits: 'Observant.',
        },
    },
    {
        type: 'location_state',
        title: 'Bryn headland watchpost',
        fields: {
            title: 'Bryn headland watchpost',
            state: 'Active nighttime post.',
        },
    },
];

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: Array.from({ length: 8 }, (_, i) => `*Seraphina nods.* "Note ${i + 1}."`),
    });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'rag-rewrite' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    const cp = appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, api: 'custom' });
    mockProfileName = cp.name;
    bootstrapVectorsBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mg-rag-rewrite-'));
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

test.describe('#62 — RAG recall with query rewrite hits the LLM and embeds the rewritten string', () => {
    test.setTimeout(180_000);

    test('rewrite tool-call is consumed, rewritten query is embedded, recall surfaces the matching seed', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await setMgSettings(page, {
            enabled: true,
            autoExtractionEnabled: false,
            recallMethod: 'rag',
            ragUseQueryRewrite: true,
            ragRewriteApiPresetName: mockProfileName,
        }, { closeAfter: true });

        // Two turns to give MG a real tail.
        await sendMessageAndAwaitReply(page, 'The first watch starts.');
        await sendMessageAndAwaitReply(page, 'I survey the cliff side again.');
        await importMgGraph(page, importPath, { mode: 'bind-latest', closeAfter: true });
        await page.waitForTimeout(500);

        // Force vector index sync against the seeded store.
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

        // Pre-queue the rewrite tool call — the next chat-completion call the
        // mock receives will return this tool_call instead of a reply.
        // The user's message below is intentionally generic; the rewriter
        // surfaces a sharp callback for the cliff-lantern event.
        mock.scriptToolCall({
            name: 'rewrite_recall_query',
            arguments: { rewritten_query: REWRITE_TARGET },
        });

        // Reset request log around the next send so we can isolate which
        // calls came from this turn.
        const beforeCount = mock.requests.length;

        await sendMessageAndAwaitReply(page, 'Anything from the last watch worth recalling?');

        const newRequests = mock.requests.slice(beforeCount);
        // The rewrite goes to /v1/chat/completions; the main reply also goes
        // there. Pick out the request whose body asks for rewrite_recall_query.
        const rewriteRequest = newRequests.find(r =>
            r.url.includes('/chat/completions')
            && /rewrite_recall_query/.test(JSON.stringify(r.body || {})),
        );
        expect(rewriteRequest, 'a chat-completions call requesting the rewrite_recall_query tool should fire').toBeTruthy();

        // The rewrite happens before the recall, so the next embeddings call
        // must use the rewritten string (REWRITE_TARGET), not the raw user
        // message.
        const embedRequestsAfterRewrite = newRequests.filter(r => r.url.includes('/embeddings'));
        expect(embedRequestsAfterRewrite.length, 'at least one embed call for the recall query should fire').toBeGreaterThan(0);
        const rewriteEmbed = embedRequestsAfterRewrite.find(r =>
            r.body && Array.isArray(r.body.input) && r.body.input.some(s => String(s || '').includes('brass signal lantern')),
        );
        expect(rewriteEmbed, `expected an embed call carrying the rewritten query, saw bodies: ${
            JSON.stringify(embedRequestsAfterRewrite.map(r => r.body))}`).toBeTruthy();

        // And the trace must record rewriteApplied=true with the right string.
        const trace = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const main = await import('/scripts/extensions/memory-graph/main.js');
            const store = await main.ensureMemoryStoreLoaded(ctx);
            return store?.lastRecallTrace || [];
        });
        // Sanity check that the rewrite preset wiring stuck in the settings.
        const settingsDump = await page.evaluate(() => {
            const s = window.Luker.getContext().extensionSettings?.memory_graph || {};
            return {
                recallMethod: s.recallMethod,
                ragUseQueryRewrite: s.ragUseQueryRewrite,
                ragRewriteApiPresetName: s.ragRewriteApiPresetName,
                ragRewriteLlmPresetName: s.ragRewriteLlmPresetName,
            };
        });
        expect(settingsDump.recallMethod, 'recallMethod should be rag').toBe('rag');
        expect(settingsDump.ragUseQueryRewrite, 'ragUseQueryRewrite should be true').toBe(true);
        expect(settingsDump.ragRewriteApiPresetName, 'ragRewriteApiPresetName should match the mock profile').toBe(mockProfileName);

        const ragStep = trace.find(t => t.step === 'rag_recall');
        expect(ragStep, `expected a rag_recall trace step, got ${JSON.stringify(trace)}`).toBeTruthy();
        expect(
            ragStep.meta?.rewriteApplied,
            `expected rewriteApplied=true; full meta=${JSON.stringify(ragStep.meta)} requests=${JSON.stringify(newRequests.map(r => ({ u: r.url, hasRewriteTool: /rewrite_recall_query/.test(JSON.stringify(r.body || {})) })))}`,
        ).toBe(true);
        expect(ragStep.meta?.rewrittenQuery).toBe(REWRITE_TARGET);
        const seededIds = new Set(['n_1', 'n_2', 'n_3', 'n_4']);
        const seededHits = (ragStep.selected_ids || []).filter(id => seededIds.has(id));
        expect(
            seededHits.length,
            `expected at least one seeded node (n_1..n_4) in selected_ids, saw ${JSON.stringify(ragStep.selected_ids)}`,
        ).toBeGreaterThan(0);
    });
});
