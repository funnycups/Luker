// Case #90 — Vectors: vectorize char/chat/WI → query injection
//
// Spec:
//   Vectorize a character description, an old chat message, and a world
//   info book. Send a turn whose user content is semantically similar to
//   one indexed item. Verify the matched item gets injected into the
//   prompt sent to the mock.
//
// Status:
//   The vectors extension requires an `embeddingProfileId` pointing at a
//   real embedding backend (transformers WASM, OpenAI, Cohere, Ollama,
//   etc.) — see public/scripts/extensions/vectors/index.js:69-120.
//   The CUSTOM `mock-gpt-4o` profile in fixtures.js does not provide an
//   embeddings endpoint, so `synchronizeChat()` short-circuits with
//   `embedding_profile_missing` and no /api/vector/* calls are issued.
//
//   To exercise the real vectorize→query→inject pipeline end-to-end we
//   need either (a) a webllm-enabled browser context with a small ONNX
//   embedding model fetched at runtime, or (b) an in-process mock that
//   responds to the server-side `/api/vector/insert` + `/api/vector/query`
//   surface while also serving `/v1/embeddings`. Both require fixtures
//   that don't exist in the current `_lib`.
//
// Fixme: leave as a placeholder until an embedding-mock helper exists.

import { test } from '@playwright/test';

test.fixme('#90 — vectors vectorize+inject', () => {
    // Blocked: no in-process embedding-provider mock available.
    //
    // Required to implement:
    //  - Spin up an embedding endpoint that returns deterministic
    //    fixed-length vectors so cosine-similarity is predictable.
    //  - Wire it into `extension_settings.vectors.embeddingProfileId` via
    //    the connection-manager profile bootstrap.
    //  - Drive `/api/vector/insert` (POST), `/api/vector/list` (GET),
    //    `/api/vector/query` (POST) to confirm injection into the
    //    `getRegexedString`/`extension_prompts` pipeline.
});
