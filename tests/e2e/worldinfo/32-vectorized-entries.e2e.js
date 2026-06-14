// #32 — Vectorized entries — embed → query → inject
//
// Vectorized WI entries get added to the vectors extension's semantic
// pool: (1) embedded into a per-world collection, (2) queried by the
// recent chat tail, (3) top-K appended back into the prompt context.
// This requires a working embedding backend; tests/e2e/_lib/mockLLM.js
// implements a deterministic /v1/embeddings endpoint (bag-of-tokens
// hash → 384-dim unit vector) wired in via bootstrapVectorsBackend so
// shared tokens cluster by cosine similarity — exactly what the WI
// vector path needs to score "navigate the coast" against "Coastal
// navigation in fog" without a real embedder.
//
// What this test verifies:
//   - The vectorized flag persists on disk (round-trip via /worldinfo/get).
//   - The flag does NOT prevent keyword activation — i.e. when a primary
//     key matches in the user message, a vectorized entry still injects
//     via the keyword path. The vectorized flag is an OPT-IN ADDITION to
//     the semantic pool, not a replacement for keyword matching.
//   - With the vectors extension's WI flag enabled and the mock embedder
//     wired in, an empty-key vectorized entry whose content is
//     semantically near the user's turn DOES inject via the semantic
//     pool, while a semantically distant empty-key entry does not.

import { test, expect } from '@playwright/test';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, bootstrapVectorsBackend, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
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
        scriptedReplies: Array.from({ length: 10 }, (_, i) =>
            `*A reply tuned to the wind.* Acknowledged (${i + 1}).`,
        ),
    });
    server = await startWorldInfoServer({ specBaseName: '32-vectorized-entries', scenarioId: 'vectorized' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    bootstrapVectorsBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

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
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'vector-book';
        }, { timeout: 10_000 });
        // Settle the first_mes so MESSAGE_RECEIVED is from our /trigger.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
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
            const headers = { 'Content-Type': 'application/json', ...window.Luker.getContext().getRequestHeaders() };
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

    test('semantic injection: empty-key vectorized entry near the query injects, distant one does not', async ({ page }) => {
        // The vectors-extension WI path: when `enabled_world_info` is true
        // and a vectorized entry's content is in the semantic top-K for
        // the recent chat tail, the entry is force-activated via
        // WORLDINFO_FORCE_ACTIVATE — even with an empty `key` array. We
        // flip the flag at runtime (the WI vector path reads it live) so
        // the earlier "WI flag stays off" assertions in tests 1+2 remain
        // valid; the same dataRoot now backs all three cases.
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Navigator');
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'vector-book';
        }, { timeout: 10_000 });
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Flip the vectors-extension WI flag on at runtime. The vectors
        // extension keeps a module-scope `settings` mirror that diverges
        // from `extension_settings.vectors` after init — mutating the
        // latter alone won't reach the interceptor. The
        // `#vectors_enabled_world_info` checkbox's input handler is the
        // canonical write path (settings.html is appended to
        // `#vectors_container` on init, so the element exists even when
        // the extension drawer is closed).
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const ext = ctx.extensionSettings?.vectors;
            if (!ext) throw new Error('vectors extension settings missing');

            const $ = window.jQuery || window.$;
            // Bootstrap wrote the embed profile into settings.json so
            // init's refreshEmbeddingProfileSelect should have picked
            // it up. If for any reason the dropdown didn't bind it (UI
            // hadn't mounted on first init), force-bind via the
            // canonical change handler so the vectors module-scope
            // settings get the id.
            const cm = ctx.extensionSettings?.connectionManager;
            const embedProfiles = (cm?.profiles || []).filter(p => p.mode === 'embed');
            if (embedProfiles.length === 0) {
                throw new Error('no embed profile found in connectionManager — bootstrap did not land');
            }
            const sel = $('#vectors_embedding_profile');
            if (sel.length && String(sel.val() || '') !== embedProfiles[0].id) {
                if (!sel.find(`option[value="${embedProfiles[0].id}"]`).length) {
                    sel.append(new Option(embedProfiles[0].name, embedProfiles[0].id));
                }
                sel.val(embedProfiles[0].id).trigger('change');
            }

            // The score_threshold input writes to the module-scope
            // settings mirror; setting it via `.val(...).trigger('input')`
            // matches the slider's canonical path. Bootstrap also wrote
            // 0.2 to settings.json, but that may have been clobbered
            // if init re-read defaults.
            const thresh = $('#vectors_score_threshold');
            if (thresh.length) thresh.val('0.2').trigger('input');

            const checkbox = $('#vectors_enabled_world_info');
            if (!checkbox.length) {
                throw new Error('vectors enabled_world_info checkbox not mounted');
            }
            checkbox.prop('checked', true).trigger('input');
        });

        // Pose a question whose content overlaps "Coastal navigation in
        // fog" / "harbor markers" / "mariners" — none of those are keys
        // on any WI entry, so the only path that can pull VECTOR_NAV in
        // is the semantic one. Also avoid every keyword from the
        // baseline / VECTOR_KEYWORD / "always" entries so this test is
        // genuinely measuring the vector path, not a keyword leak.
        const navBody = await sendAndCaptureBody(
            page,
            'Mariners cannot see the harbor markers tonight; tell me how to use the rhythmic pings to navigate through this fog.',
        );

        // Semantic hit: VECTOR_NAV must inject even though no key matched.
        expect(navBody, 'NAV entry should be force-activated by semantic similarity').toContain('VECTOR_NAV');
        // Semantic miss: the inland-husbandry entry shares no tokens with
        // the query, so its cosine ranks low and it must NOT inject.
        expect(navBody, 'FARM entry should NOT inject when query is about coastal navigation').not.toContain('VECTOR_FARM');
        // None of the baseline-keyword triggers were in the query, so
        // the keyword path must stay quiet — proves we're really
        // measuring the semantic injection.
        expect(navBody, 'baseline keyword should NOT inject (no "always" in the query)').not.toContain('BASELINE_LORE');
        expect(navBody, 'VECTOR_KEYWORD should NOT inject (no "kelp"/"south reef" in the query)').not.toContain('VECTOR_KEYWORD');

        // Sanity check: the mock saw at least one embeddings burst after
        // the WI flag flipped. Without this, a regression that silently
        // bypasses the embedder would still let the keyword assertions
        // above pass (false negatives elsewhere).
        const embedCalls = mock.requests.filter(r => r.url.includes('/embeddings'));
        expect(embedCalls.length, 'expected the mock to receive embeddings requests').toBeGreaterThan(0);

        // Now ask the inverse: a query whose tokens overlap FARM, not
        // NAV. FARM should inject and NAV should not — the same vector
        // pool ranks differently for different queries.
        const farmBody = await sendAndCaptureBody(
            page,
            'Tell me about inland sheep husbandry — how does the highland grazing rotation align with the rainfall pattern?',
        );
        expect(farmBody, 'FARM entry should inject when query is about inland husbandry').toContain('VECTOR_FARM');
        expect(farmBody, 'NAV entry should NOT inject when query has no coastal-navigation tokens').not.toContain('VECTOR_NAV');
    });
});
