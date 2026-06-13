// #32 — Vectorized entries — embed → query → inject
//
// Vectorized WI entries get added to the vectors extension's semantic
// pool: (1) embedded into a per-world collection, (2) queried by the
// recent chat tail, (3) top-K appended back into the prompt context.
// This requires a working embedding backend (transformers / openai-embed
// / ollama / etc.) — the in-process mock LLM does not implement
// /v1/embeddings, so we can't end-to-end the semantic ranking path.
//
// What this test verifies deterministically without an embedder:
//   - The vectorized flag persists on disk (round-trip via /worldinfo/get).
//   - The flag does NOT prevent keyword activation — i.e. when a primary
//     key matches in the user message, a vectorized entry still injects
//     via the keyword path. The vectorized flag is an OPT-IN ADDITION to
//     the semantic pool, not a replacement for keyword matching.
//   - A vectorized entry with EMPTY key array does not inject when the
//     vectors extension's WI feature is disabled (its default).
//
// The full end-to-end (embed → query → inject) is marked test.fixme()
// with a documented plan for how to plumb a mock embedder.

import { test, expect } from '@playwright/test';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { writeCharacterWithBinding, startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

const VECTOR_ENTRIES = [
    {
        key: [], // empty key — only the vectors extension's semantic path can activate this
        comment: 'coastal-navigation',
        content: 'VECTOR_NAV: Coastal navigation in fog relies on rhythmic bell pings from harbor markers; mariners listen for the 4-second cadence to triangulate position.',
        vectorized: true,
        order: 100,
    },
    {
        key: [], // empty key — only the vectors extension's semantic path can activate this
        comment: 'inland-husbandry',
        content: 'VECTOR_FARM: Inland sheep husbandry in the Bryn highlands follows a 9-month grazing rotation tied to the rainfall pattern.',
        vectorized: true,
        order: 110,
    },
    {
        key: ['kelp', 'south reef'],
        comment: 'vectorized-with-keyword',
        content: 'VECTOR_KEYWORD: This vectorized entry also has a primary key — keyword matching should still activate it even though the vectorized flag is set.',
        vectorized: true,
        order: 120,
    },
    {
        key: ['always'], // baseline non-vector keyword entry
        comment: 'baseline-keyword',
        content: 'BASELINE_LORE: This baseline lore activates via the keyword "always" and proves the WI pipeline is reaching the prompt.',
        order: 130,
    },
];

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: Array.from({ length: 6 }, (_, i) =>
            `*A reply tuned to the wind.* Acknowledged (${i + 1}).`,
        ),
    });
    server = await startWorldInfoServer({ specBaseName: '32-vectorized-entries', scenarioId: 'vectorized' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    writeWorldBook({ dataRoot: server.dataRoot, name: 'vector-book', entries: VECTOR_ENTRIES });
    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-navigator.png',
        name: 'Ash Navigator',
        worldBook: 'vector-book',
    });
});

test.afterAll(async () => {
    await tearDownWorldInfoServer(server);
    await mock?.stop();
});

async function sendAndCaptureBody(page, text) {
    const before = mock.requests.length;
    await sendMessageAndAwaitReply(page, text);
    const newReqs = mock.requests.slice(before);
    const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
    expect(chatReq, 'expected a chat-completion request after sending').toBeTruthy();
    return JSON.stringify(chatReq.body.messages);
}

test.describe('#32 — Vectorized WI entries', () => {
    test('keyword path still activates a vectorized entry when its key matches', async ({ page }) => {
        // The vectorized flag is additive — it adds the entry to the
        // vectors extension's semantic pool, but it does NOT remove the
        // entry from the keyword-match path. So a vectorized entry whose
        // primary key is in the user message still injects via keywords.
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Navigator');
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'vector-book';
        }, { timeout: 10_000 });
        // Settle the first_mes so MESSAGE_RECEIVED is from our /trigger.
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        const body = await sendAndCaptureBody(page, 'I always think about kelp on the south reef when the bells start ringing.');
        // baseline keyword entry must fire — proves WI pipeline is alive
        expect(body, 'baseline keyword entry should fire on "always" key').toContain('BASELINE_LORE');
        // vectorized entry with a primary key matches via keyword path:
        expect(body, 'vectorized entry with a primary key should activate via keyword path').toContain('VECTOR_KEYWORD');
        // entries with empty key arrays do NOT activate via keywords (no key to match)
        // and the vectors extension's WI flag is off by default, so no semantic injection:
        expect(body, 'empty-key vectorized entry should NOT inject without vectors extension').not.toContain('VECTOR_NAV');
        expect(body, 'empty-key vectorized entry should NOT inject without vectors extension').not.toContain('VECTOR_FARM');
    });

    test('vectorized flag persists on disk through a server restart', async ({ page }) => {
        await server.restart();
        await awaitMainUI(page, server.baseURL);

        const persisted = await page.evaluate(async () => {
            const headers = { 'Content-Type': 'application/json', ...window.SillyTavern.getContext().getRequestHeaders() };
            const res = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name: 'vector-book' }) });
            const data = await res.json();
            return Object.values(data.entries || {}).map(e => ({
                comment: e.comment,
                vectorized: !!e.vectorized,
            }));
        });
        const vectorMarks = persisted.filter(e => e.comment.includes('coastal-navigation') || e.comment.includes('inland-husbandry') || e.comment.includes('vectorized-with-keyword'));
        expect(vectorMarks.length).toBe(3);
        for (const m of vectorMarks) {
            expect(m.vectorized).toBe(true);
        }
        const baseline = persisted.find(e => e.comment === 'baseline-keyword');
        expect(baseline?.vectorized).toBe(false);
    });

    test.fixme('full embed → query → inject pipeline (needs mock embedder backend)', async ({ page }) => {
        // BLOCKED: requires a real embedding backend that implements
        // /v1/embeddings (or a stub for one of vectors_source = openai /
        // transformers / nomicai / ollama / llamacpp / vllm / webllm).
        //
        // Plumbing plan (for the follow-up agent):
        //   1. Extend tests/e2e/_lib/mockLLM.js to also respond to
        //      /v1/embeddings with deterministic per-string vectors
        //      (e.g. hash → fixed-dim float[] so cosine similarity is
        //      deterministic for the test corpus).
        //   2. In bootstrapCustomBackend(), additionally set
        //        s.extensionSettings.vectors = {
        //          source: 'openai',
        //          enabled_world_info: true,
        //          openai_model: 'mock-embed',
        //        };
        //      so the vectors extension targets the mock for embeddings.
        //   3. In the spec, ensure the vectors extension's activate() runs
        //      after the connection profile is selected; the mock will
        //      receive an /v1/embeddings burst for each WI entry's content.
        //   4. Send a turn whose semantic content matches VECTOR_NAV
        //      (e.g. "How do mariners find their way through thick fog?").
        //   5. Assert chatReq.body.messages JSON contains VECTOR_NAV even
        //      though no keyword matched.
        //
        // Until that plumbing is in place, this scenario is fundamentally
        // blocked by a missing test-double, NOT a product bug.
    });
});
