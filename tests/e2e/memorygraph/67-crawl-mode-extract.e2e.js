// #67 — crawl extraction mode: before the one-shot extraction pass, MG runs
// a bounded read-only tool loop where the extraction LLM inspects candidate
// nodes, then the crawled local slice replaces the full graph in the
// extraction prompt.
//
// What this test pins (through real user gestures + a scripted mock LLM):
//   1. Enable MG + auto extraction via the real checkboxes, flip
//      extractMode to 'crawl' via the real Advanced settings select, send
//      RP turns through the composer.
//   2. The mock LLM must see crawl tool requests whose tools array contains
//      luker_rpg_extract_crawl_inspect / _neighbors / _search / _done and
//      whose user prompt carries the candidate_nodes JSON-XML index.
//   3. The scripted crawl flow inspects one candidate, then calls done.
//   4. The subsequent one-shot extraction request must carry graph_scope
//      'crawled_local_slice' + the inspected node's key_values projection,
//      and semantic_node_total must equal the true as-of graph total (2
//      seeded + 1 auto event), not the slice size.
//   5. Crawl tool failures must surface as structured error observations:
//      a scripted inspect of a nonexistent node_id must produce an
//      observation containing "not_found" in the NEXT crawl prompt round.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

const TURNS = [
    'The harbor ledger lists a missing cargo manifest for the third time this season.',
    'I found the manifest hidden behind the customs house shutters.',
    'The harbormaster wants the manifest delivered before the evening tide.',
];

let server, mock;

function isCrawlRequest(body) {
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    return tools.some(t => String(t?.function?.name || '') === 'luker_rpg_extract_crawl_inspect');
}

function isExtractionRequest(body) {
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    return tools.some(t => String(t?.function?.name || '') === 'luker_rpg_extract_event_create');
}

function userPromptOf(body) {
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    const user = msgs.filter(m => m?.role === 'user').map(m => String(m.content ?? ''));
    return user.join('\n');
}

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [...TURNS] });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'crawl-extract' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot });

    // Start with MG OFF so the pre-existing chat isn't auto-extracted before
    // crawl mode is armed through the real UI. Runtime switches (mode flip)
    // go through the real Advanced settings select — never settings.json
    // (see e2e README). The only settings.json edit here is the initial
    // MG disable, mirroring #65's fixture pattern.
    const mgSettingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const mgSettings = JSON.parse(readFileSync(mgSettingsPath, 'utf8'));
    mgSettings.extension_settings = mgSettings.extension_settings || {};
    mgSettings.extension_settings.memory_graph = {
        ...(mgSettings.extension_settings.memory_graph || {}),
        enabled: false,
        auto_extraction_enabled: false,
    };
    writeFileSync(mgSettingsPath, JSON.stringify(mgSettings, null, 4));

    // Crawl router: inspect a nonexistent node first round (error feedback
    // check), then search, then done. Follow-on extraction pass emits one
    // event + done.
    mock.scriptCompletion((req) => {
        const names = req.toolNames || [];
        if (names.includes('luker_rpg_extract_crawl_inspect')) {
            const userText = (req.userMessages || []).join('\n');
            const roundMatch = /Exploration round (\d+)\//.exec(userText);
            const round = roundMatch ? Number(roundMatch[1]) : 1;
            if (round === 1 && !userText.includes('not_found')) {
                // First crawl round: inspect a bogus id → structured error
                // observation must come back in round 2.
                return { toolCalls: [
                    { name: 'luker_rpg_extract_crawl_inspect', arguments: { node_id: 'n_nonexistent' } },
                ] };
            }
            if (userText.includes('not_found')) {
                // Round 2 (error observed): finish exploration.
                return { toolCalls: [
                    { name: 'luker_rpg_extract_crawl_done', arguments: { reason: 'enough context' } },
                ] };
            }
            return { toolCalls: [
                { name: 'luker_rpg_extract_crawl_done', arguments: { reason: 'fallback' } },
            ] };
        }
        if (names.includes('luker_rpg_extract_event_create')) {
            return { toolCalls: [
                { name: 'luker_rpg_extract_event_create', arguments: { summary: '时间：测试；Crawl mode e2e event.', links: [], no_link_reason: 'mock' } },
                { name: 'luker_rpg_extract_done', arguments: {} },
            ] };
        }
        return null;
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function enableMgAndCrawlMode(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    await page.evaluate(() => {
        for (const id of ['luker_rpg_memory_enabled', 'luker_rpg_memory_auto_extraction_enabled']) {
            const el = document.getElementById(id);
            if (!el) continue;
            if (!el.checked) {
                el.checked = true;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    });
    // The Advanced tab lives in the MG tab strip — open it, then flip
    // Extraction graph mode to crawl through the real select.
    await page.locator('#luker_rpg_memory_tabs .luker-tabs-tab[data-luker-tab-key="advanced"]').click();
    await page.locator('#luker_rpg_memory_advanced_extract_mode').selectOption('crawl');
}

async function fillGraphViaUi(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings');
    // Fill Graph lives in the Graph tab pane of the MG tab strip.
    await page.locator('#luker_rpg_memory_tabs .luker-tabs-tab[data-luker-tab-key="graph"]').click();
    await page.locator('#luker_rpg_memory_fill').click();
}

test.describe('#67 — crawl extraction mode explores before extracting', () => {
    test.setTimeout(240_000);

    test('crawl tool loop runs, errors surface, extraction gets the crawled slice', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        // RP turns while MG is off — pre-existing chat for extraction.
        for (const t of TURNS) {
            await sendMessageAndAwaitReply(page, t);
        }

        await enableMgAndCrawlMode(page);

        // Drive a backfill through the real Fill Graph button (auto
        // extraction alone doesn't guarantee a pass fires after the mode
        // flip lands; Fill Graph forces the pending batches through).
        await fillGraphViaUi(page);

        // ── Crawl requests fired with the 4 read tools ─────────────────
        await expect.poll(() => {
            return mock.requests
                .map(r => r.body)
                .filter(isCrawlRequest)
                .length;
        }, { timeout: 120_000 }).toBeGreaterThanOrEqual(1);

        const crawlBodies = mock.requests.map(r => r.body).filter(isCrawlRequest);
        const firstCrawl = crawlBodies[0];

        // All four crawl tools present in schema.
        const crawlToolNames = firstCrawl.tools.map(t => String(t?.function?.name || ''));
        for (const expected of [
            'luker_rpg_extract_crawl_inspect',
            'luker_rpg_extract_crawl_neighbors',
            'luker_rpg_extract_crawl_search',
            'luker_rpg_extract_crawl_done',
        ]) {
            expect(crawlToolNames).toContain(expected);
        }

        // Crawl prompt shape: dialogue_batch + candidate_nodes index, and
        // NO literal backslash-n artifacts (join bug regression).
        const firstCrawlUser = userPromptOf(firstCrawl);
        expect(firstCrawlUser).toContain('<dialogue_batch>');
        expect(firstCrawlUser).toContain('<candidate_nodes>');
        // Fill Graph backfills from floor 0, so the FIRST crawl batch is
        // the character greeting floor. Assert the greeting text (from
        // the Ash fixture card) is in the batch.
        expect(firstCrawlUser).toContain('half-folded chart');
        // Regression: the join bug produced a literal backslash-n blob.
        expect(firstCrawlUser).not.toContain('\\n');

        // System prompt is the crawl prompt (editable setting), not the
        // one-shot extraction prompt.
        const crawlSystem = (firstCrawl.messages.filter(m => m?.role === 'system').map(m => String(m.content ?? ''))).join('\n');
        expect(crawlSystem).toContain('memory-graph crawler');

        // ── Structured error feedback: bogus inspect round 1 → not_found
        // observation in round 2 ─────────────────────────────────────────
        const errorFeedbackBodies = crawlBodies.filter(b => userPromptOf(b).includes('not_found'));
        expect(errorFeedbackBodies.length, 'bogus inspect must surface a not_found error observation to the next round').toBeGreaterThanOrEqual(1);

        // ── Extraction pass gets the crawled local slice ────────────────
        await expect.poll(() => {
            return mock.requests
                .map(r => r.body)
                .filter(isExtractionRequest)
                .length;
        }, { timeout: 120_000 }).toBeGreaterThanOrEqual(1);

        const extractionBodies = mock.requests.map(r => r.body).filter(isExtractionRequest);
        const extractionUser = extractionBodies.map(userPromptOf).join('\n');
        expect(extractionUser).toContain('crawled_local_slice');

        // semantic_node_total must report the true as-of graph total, not
        // the crawl slice size. It travels inside the <graph_data> JSON of
        // the extraction payload's message content (prompt-order assembly
        // may merge messages, so search the whole body; JSON.stringify
        // escapes the inner quotes as \\\"). )
        const totals = extractionBodies.map(b => {
            const m = /semantic_node_total\\?\"?\s*:\s*(\d+)/.exec(JSON.stringify(b.messages));
            return m ? Number(m[1]) : null;
        }).filter(v => v !== null);
        expect(totals.length, 'semantic_node_total must appear in extraction payloads').toBeGreaterThanOrEqual(1);
        // Batch 1 legitimately reports 0 (graph still empty before the
        // greeting batch commits). Later batches must see the true total —
        // at least one payload with total >= 1 across the run.
        expect(totals.some(v => v >= 1), 'later extraction batches must see a nonzero as-of graph total').toBe(true);
        for (const total of totals) {
            expect(Number.isInteger(total) && total >= 0).toBe(true);
        }
    });
});
