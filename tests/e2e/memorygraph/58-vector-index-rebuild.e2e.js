// tests/e2e/memorygraph/58-vector-index-rebuild.e2e.js
//
// #58 — MG vector-index rebuild + semantic retrieval, then survive restart.
//
// FIXME — this case is blocked by the same constraint that gates
// worldinfo #32 (vectorized world-info entries): MG's vector index goes
// through `EmbeddingService` against `/api/vector/*`, which requires a
// real embedding profile + a backend that can produce embeddings
// (OpenAI text-embedding-3-small, Cohere, local Transformers.js, etc).
//
// The mock LLM in `_lib/mockLLM.js` serves chat-completions only — it
// has no embedding endpoint. The Luker dev server has Transformers.js
// fallback for local embedding, but that requires the bundled model
// files to be present in the build (large, optional asset) AND a
// configured `extensionSettings.embeddingProfileId` pointing at a
// `local-transformers` profile.
//
// Without either piece, `findSimilarNodes` short-circuits to `[]`
// (returning no hits) — meaning we can confirm the orchestration is
// callable but cannot assert "phrase X retrieves record Y first" with
// any signal.
//
// Real coverage of the rebuild contract lives in jest at
// `tests/memory-graph/vector-index-persistence.test.js` (mocks the
// EmbeddingService faithfully and asserts rebuild + persist + reload
// invariants without needing a live embedder).
//
// To un-fixme this:
//   1. Wire a tiny embedding mock onto the existing `_lib/mockLLM.js`
//      that serves `/api/vector/insert` + `/api/vector/query` with a
//      deterministic hash-to-vector function, so the server's
//      EmbeddingService.insert/query roundtrips through it.
//   2. Configure the test to set `extensionSettings.memory_graph.embeddingProfileId`
//      to that mock profile, plus add a matching entry in
//      `extensionSettings.connectionManager.profiles` with kind
//      'embedding'.

import { test } from '@playwright/test';

test.describe('#58 — MG vector-index rebuild + retrieval (BLOCKED: no embedder in e2e fixtures)', () => {
    test.fixme(
        'requires a real embedder (OpenAI/Cohere/local-transformers) or a mock embedding endpoint ' +
        'wired into _lib/mockLLM.js. Until that exists, findSimilarNodes returns [] and the ' +
        '"phrase X retrieves Y first" assertion has no signal. Unit-level coverage of the rebuild ' +
        'contract lives at tests/memory-graph/vector-index-persistence.test.js.',
        async () => {
            // Intended shape:
            //   1. Build 5 records via session.createNode with semantically
            //      distinct prose (each anchored in a different RP scene).
            //   2. Call mg.rebuildVectorIndex() (or trigger via the settings
            //      panel button #luker_rpg_memory_vector_rebuild — confirm
            //      selector name in main.js if it exists).
            //   3. session.vectorSearch({ query: 'paraphrase of record N',
            //      k: 5 }) — assert record N ranks first.
            //   4. server.restart() + reloadAndAwait — re-open MG, repeat
            //      the search, assert the index reloaded from disk and the
            //      ranking is preserved.
        },
    );
});
