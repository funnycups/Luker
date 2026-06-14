// tests/e2e/memorygraph/58-vector-index-rebuild.e2e.js
//
// #58 — MG vector-index rebuild + semantic retrieval, then survive restart.
//
// The vector pipeline:
//   1. Seed N MG nodes via `session.createNode` with semantically distinct
//      content (different RP scenes / characters / places).
//   2. Call `syncVectorIndex(store, profile, chatKey)` directly — this is
//      what the "Full Rebuild" button in the MG settings panel runs under
//      the hood. It batches `/api/vector/insert` calls through the mock's
//      `/v1/embeddings` endpoint (cf. tests/e2e/_lib/mockLLM.js — bag-of-
//      tokens hash so shared content tokens cluster by cosine).
//   3. Use `session.vectorSearch({ query, k })` (Layer-1 read API) to
//      paraphrase each seeded node's content and assert the node ranks
//      first. Then `server.restart()` + `reloadAndAwait` and repeat the
//      same vectorSearch — the per-chat vectra collection must reload
//      from disk and produce the same ranking.
//
// The mock embedder gives us deterministic but coarse cosine similarity;
// "rank first" is the strongest assertion we can make without a real
// embedder, and it's exactly the rebuild contract the user cares about
// (the right record floats to the top, restart doesn't lose the index).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, bootstrapVectorsBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';

let server, mock;

// Five semantically distinct seed records. Each query downstream uses
// content tokens that overlap only its target record's vector text.
const SEED_RECORDS = [
    {
        type: 'event',
        title: 'Cliff-path watch lantern',
        fields: {
            summary: 'Cliff-path watch at dusk: the brass signal lantern was trimmed and lit before tide-rise. Ash and the user walked the headland together and confirmed three rhythmic flashes per minute as the harbor protocol.',
        },
        query: 'Tell me about the brass signal lantern that was trimmed at dusk on the cliff-path watch.',
        idHint: 'cliff-lantern',
    },
    {
        type: 'character_sheet',
        title: 'Seraphina the cartographer',
        fields: {
            title: 'Seraphina the cartographer',
            aliases: 'Sera',
            identity: 'Wind-bitten Bryn coastal cartographer in her early thirties. Maps reef shifts nightly with a brass spyglass that once belonged to her mother.',
            traits: 'Observant, dry-witted, patient.',
            goal: 'Chart the reef before the great surge season returns.',
        },
        query: 'Describe Seraphina the wind-bitten cartographer who maps the Bryn reef nightly.',
        idHint: 'seraphina',
    },
    {
        type: 'location_state',
        title: 'Bryn headland watchpost',
        fields: {
            title: 'Bryn headland watchpost',
            state: 'Active nighttime post: brass spyglass on the rail, tidal charts pinned, signal lantern trimmed.',
            controller: 'Seraphina',
            resources: 'brass spyglass, tidal charts, spare oil flask, signal lantern',
        },
        query: 'Where on the Bryn headland is the spare oil flask kept along with the tidal charts?',
        idHint: 'headland-watchpost',
    },
    {
        type: 'event',
        title: 'Salt-mark drifter skiff sighting',
        fields: {
            summary: 'Salt-mark drifters were sighted moving north by skiff along the channel after midnight. The drifters never light fires inland and refused the cliffside relocation after the great surge.',
        },
        query: 'What were the salt-mark drifters doing in their skiff after midnight along the northern channel?',
        idHint: 'drifters-skiff',
    },
    {
        type: 'fact_rule',
        title: 'Bryn reef nineteen-day shift cycle',
        fields: {
            title: 'Bryn reef nineteen-day shift cycle',
            statement: 'The Bryn reef shifts on a strict nineteen-day cycle. Charts older than two weeks are considered unreliable; locals call the worst tide the slow swallow.',
        },
        query: 'How often does the Bryn reef shift on its nineteen-day cycle, and when are charts unreliable?',
        idHint: 'reef-cycle',
    },
];

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: Array.from({ length: 8 }, (_, i) =>
            `*Seraphina folds the chart and meets your eyes.* "Acknowledged. Note ${i + 1} recorded."`,
        ),
    });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'vector-rebuild' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    bootstrapVectorsBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#58 — MG vector-index rebuild + retrieval (mock embedder)', () => {
    test('rebuild → paraphrase query ranks the source node first; survives restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Send a few RP turns so MG's chat-key resolver has a real chat
        // to anchor against. The exact content doesn't matter for the
        // vector path — it embeds nodes, not chat messages.
        for (const t of [
            'I walked the cliff path. The wind is cold but the lantern holds.',
            'The drifters were silent tonight. I think they passed north.',
        ]) {
            await sendMessageAndAwaitReply(page, t);
        }

        // Seed the graph with the 5 distinct records, then rebuild the
        // vector index via the same `syncVectorIndex` entry point the
        // "Full Rebuild" button uses. Returns a snapshot of the
        // generated node ids so paraphrase queries can assert against them.
        const seeded = await page.evaluate(async (records) => {
            const ctx = window.Luker.getContext();
            const mgApi = ctx.getExtensionApi?.('memory-graph');
            if (!mgApi) return { ok: false, reason: 'extension api missing' };
            const settings = ctx.extensionSettings?.memory_graph;
            if (settings) settings.enabled = true;

            const session = await mgApi.openSession?.(ctx);
            if (!session) return { ok: false, reason: 'session unavailable' };

            const created = {};
            for (const rec of records) {
                const node = await session.createNode({
                    type: rec.type,
                    title: rec.title,
                    fields: rec.fields,
                });
                created[rec.idHint] = node.id;
            }

            // Trigger the rebuild path. The vector-index module exports
            // both `syncVectorIndex` (the rebuild driver) and
            // `getVectorConfigFromSettings` (resolves the profile from
            // extension_settings.memory_graph.embeddingProfileId). The
            // module cache returns the live instance the rest of MG uses,
            // so writes to `store.vectorIndexState` are immediately
            // visible to subsequent `vectorSearch` calls.
            const vi = await import('/scripts/extensions/memory-graph/vector-index.js');
            const main = await import('/scripts/extensions/memory-graph/main.js');
            const profile = vi.getVectorConfigFromSettings(settings);
            if (!profile) return { ok: false, reason: 'no embedding profile resolved' };

            const chatKey = main.resolveChatKeyForSession(ctx);
            if (!chatKey) return { ok: false, reason: 'chatKey unresolved' };
            const store = await main.ensureMemoryStoreLoaded(ctx);
            if (!store) return { ok: false, reason: 'store load failed for chatKey=' + chatKey };

            // Snapshot the store BEFORE syncVectorIndex so we can persist
            // the resulting vectorIndexState mutation via the public
            // commitSessionMutation API (it diffs before↔after and writes
            // both the floor log and the meta sidecar that carries
            // vectorIndexState across restart).
            const beforeSync = structuredClone(store);
            const result = await vi.syncVectorIndex(store, profile, chatKey, {
                purge: true,
                tolerateErrors: false,
            });
            await main.commitSessionMutation(ctx, chatKey, beforeSync, store);

            return { ok: true, ids: created, syncStats: result?.stats, chatKey };
        }, SEED_RECORDS);

        expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
        expect(Object.keys(seeded.ids).length).toBe(SEED_RECORDS.length);
        expect(seeded.syncStats?.total, 'expected all 5 seeded nodes to be vector-eligible').toBeGreaterThanOrEqual(5);

        // The mock must have actually been called. Without this guard, a
        // regression that silently bypasses the embedder (e.g. a profile
        // resolution error swallowed to []) would still leave the rest
        // of the test rank-first by sheer luck of node ordering.
        const embedCalls = mock.requests.filter(r => r.url.includes('/embeddings'));
        expect(embedCalls.length, 'mock should have received /embeddings requests during rebuild').toBeGreaterThan(0);

        // Run each paraphrase query and assert the matching node ranks
        // first. The mock's bag-of-tokens cosine gives substantial
        // separation between target and distractors (cf. mockLLM.js
        // smoke test in PR description).
        for (const rec of SEED_RECORDS) {
            const hits = await page.evaluate(async ({ query }) => {
                const ctx = window.Luker.getContext();
                const mgApi = ctx.getExtensionApi?.('memory-graph');
                const session = await mgApi.openSession?.(ctx);
                if (!session) return { ok: false, reason: 'no session' };
                const results = await session.vectorSearch({ query, k: 5 });
                return {
                    ok: true,
                    hits: results.map(r => ({ id: r.id, title: r.title, score: r.score })),
                };
            }, { query: rec.query });
            expect(hits.ok, JSON.stringify(hits)).toBe(true);
            expect(hits.hits.length, `expected at least one hit for "${rec.idHint}"`).toBeGreaterThan(0);
            const top = hits.hits[0];
            expect(
                top.id,
                `top hit for "${rec.idHint}" query should be the seeded node; got ${JSON.stringify(hits.hits)}`,
            ).toBe(seeded.ids[rec.idHint]);
        }

        // ---- Persistence across restart ----
        // Kill the server, restart, re-open the same chat, re-run the
        // paraphrase queries. The per-chat vectra index must reload from
        // disk and rank identically — no rebuild required.
        const embedCallsBeforeRestart = mock.requests.filter(r => r.url.includes('/embeddings')).length;

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            return ctx && Array.isArray(ctx.chat);
        }, { timeout: 10_000 });

        // Re-enable MG (settings re-hydrate from disk but the runtime
        // `settings.enabled` may need re-flipping after the cold load).
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const settings = ctx.extensionSettings?.memory_graph;
            if (settings) settings.enabled = true;
        });

        for (const rec of SEED_RECORDS) {
            const hits = await page.evaluate(async ({ query }) => {
                const ctx = window.Luker.getContext();
                const mgApi = ctx.getExtensionApi?.('memory-graph');
                const session = await mgApi.openSession?.(ctx);
                if (!session) return { ok: false, reason: 'no session post-restart' };
                const results = await session.vectorSearch({ query, k: 5 });
                return {
                    ok: true,
                    hits: results.map(r => ({ id: r.id, title: r.title, score: r.score })),
                };
            }, { query: rec.query });
            expect(hits.ok, JSON.stringify(hits)).toBe(true);
            expect(hits.hits.length, `post-restart: expected hits for "${rec.idHint}"`).toBeGreaterThan(0);
            const top = hits.hits[0];
            expect(
                top.id,
                `post-restart: top hit for "${rec.idHint}" should match pre-restart top; got ${JSON.stringify(hits.hits)}`,
            ).toBe(seeded.ids[rec.idHint]);
        }

        // Post-restart embedding calls are expected (the query path
        // still embeds the query each time), but `purge`-style rebuild
        // batches should NOT have re-run — the index loaded from disk
        // intact. We can't pin an exact count (query path is variable),
        // but we CAN assert that the embed-call count has grown only
        // modestly (one per vectorSearch query, not 5x that for a full
        // re-insert). Tolerance is loose to keep the assertion from
        // flapping on internal retry policy changes.
        const embedCallsAfterRestart = mock.requests.filter(r => r.url.includes('/embeddings')).length;
        const newCalls = embedCallsAfterRestart - embedCallsBeforeRestart;
        expect(
            newCalls,
            `post-restart should embed roughly one call per vectorSearch (${SEED_RECORDS.length} queries), ` +
            `not re-embed every seed (would be 5+); got ${newCalls} new calls`,
        ).toBeLessThan(SEED_RECORDS.length + 5);
    });
});
