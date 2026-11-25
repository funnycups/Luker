// tests/e2e/memorygraph/_crawl-extract-scenario.js
//
// Crawl extraction scenario shared by #67 (preset streaming on) and #73
// (preset streaming off). Before the one-shot extraction pass, MG runs a
// bounded read-only tool loop where the extraction LLM inspects candidate
// nodes, then the crawled local slice replaces the full graph in the
// extraction prompt.
//
// What the scenario pins (through real user gestures + a scripted mock LLM):
//   1. Enable MG + auto extraction via the real checkboxes, flip
//      extractMode to 'crawl' via the real Advanced settings select, send
//      RP turns through the composer, click Fill Graph.
//   2. The mock LLM must see crawl tool requests whose tools array contains
//      luker_rpg_extract_crawl_inspect / _neighbors / _search / _done and
//      whose user prompt carries the candidate_nodes JSON-XML index.
//   3. Crawl tool failures surface as structured error observations: a
//      scripted inspect of a nonexistent node_id must produce an
//      observation containing "not_found" in the NEXT crawl prompt round.
//   4. The subsequent one-shot extraction request carries graph_scope
//      'crawled_local_slice', and semantic_node_total reports the as-of
//      graph total, not the slice size.
//   5. Every crawl and extraction request follows the preset's streaming
//      flag: `stream: true` with SSE when on, no `stream: true` (the mock
//      answers with a plain JSON body) when off.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { fillMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';
import {
    CRAWL_INSPECT_TOOL,
    EXTRACT_EVENT_TOOL,
    toolNamesOf,
    userPromptOf,
    disableMemoryGraphInSettingsFile,
} from './_runner-helpers.js';

const TURNS = [
    'The harbor ledger lists a missing cargo manifest for the third time this season.',
    'I found the manifest hidden behind the customs house shutters.',
    'The harbormaster wants the manifest delivered before the evening tide.',
];

function isCrawlRecord(record) {
    return toolNamesOf(record.body).includes(CRAWL_INSPECT_TOOL);
}

function isExtractionRecord(record) {
    return toolNamesOf(record.body).includes(EXTRACT_EVENT_TOOL);
}

/**
 * Register the crawl extraction scenario in the calling spec file.
 *
 * @param {object} options
 * @param {string} options.title describe-block title
 * @param {string} options.scenarioId server data-root scenario id
 * @param {boolean} options.stream saved preset streaming flag
 */
export function defineCrawlExtractScenario({ title, scenarioId, stream }) {
    let server, mock;

    test.beforeAll(async ({ workerResources }, testInfo) => {
        const scope = await workerResources.scenario(testInfo.file);
        mock = await startMockLLM({ scriptedReplies: [...TURNS] });
        server = await startServer({ scope, batchKey: 'memorygraph', scenarioId });
        markOnboarded({ dataRoot: server.dataRoot });
        // Seeds stream_openai into both settings.json and the saved active
        // preset, as a user who toggled Streaming and saved the preset.
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        disableTagImportPopup({ dataRoot: server.dataRoot });
        writeEmbeddedCharacter({ dataRoot: server.dataRoot });
        // MG starts off so the pre-existing chat isn't auto-extracted before
        // crawl mode is armed through the real UI.
        disableMemoryGraphInSettingsFile(server.dataRoot);

        // Crawl router: inspect a nonexistent node in round 1 (error
        // feedback check), then done once the not_found observation is
        // back. The extraction pass emits one event + done.
        mock.scriptCompletion((req) => {
            const names = req.toolNames || [];
            if (names.includes(CRAWL_INSPECT_TOOL)) {
                const userText = (req.userMessages || []).join('\n');
                const roundMatch = /Exploration round (\d+)\//.exec(userText);
                const round = roundMatch ? Number(roundMatch[1]) : 1;
                if (round === 1 && !userText.includes('not_found')) {
                    return { toolCalls: [
                        { name: CRAWL_INSPECT_TOOL, arguments: { node_id: 'n_nonexistent' } },
                    ] };
                }
                if (userText.includes('not_found')) {
                    return { toolCalls: [
                        { name: 'luker_rpg_extract_crawl_done', arguments: { reason: 'enough context' } },
                    ] };
                }
                return { toolCalls: [
                    { name: 'luker_rpg_extract_crawl_done', arguments: { reason: 'fallback' } },
                ] };
            }
            if (names.includes(EXTRACT_EVENT_TOOL)) {
                return { toolCalls: [
                    { name: EXTRACT_EVENT_TOOL, arguments: { summary: '时间：傍晚涨潮前；Ash 在海关百叶窗后找到遗失的货单。', links: [], no_link_reason: 'No related node is recorded yet.' } },
                    { name: 'luker_rpg_extract_done', arguments: {} },
                ] };
            }
            return null;
        });
    });

    test.afterAll(async () => {

        await mock?.stop();
    });

    test.describe(title, () => {
        test.setTimeout(240_000);

        test('crawl tool loop runs, errors surface, extraction gets the crawled slice', async ({ page }) => {
            await awaitMainUI(page, server.baseURL);
            // The AI Response Configuration panel shows the loaded preset's
            // streaming flag.
            if (stream) {
                await expect(page.locator('#stream_toggle')).toBeChecked();
            } else {
                await expect(page.locator('#stream_toggle')).not.toBeChecked();
            }
            await selectCharacterByName(page, 'Ash the Cartographer');
            await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

            // RP turns while MG is off — pre-existing chat for extraction.
            for (const turn of TURNS) {
                await sendMessageAndAwaitReply(page, turn);
            }

            await setMgSettings(page, {
                enabled: true,
                autoExtractionEnabled: true,
                extractMode: 'crawl',
            });
            // Fill Graph forces the pending batches through; auto extraction
            // alone doesn't guarantee a pass fires after the mode flip lands.
            await fillMgGraph(page, { closeAfter: true });

            // ── Crawl requests fired with the 4 read tools ─────────────
            await expect.poll(() => mock.requests.filter(isCrawlRecord).length, { timeout: 120_000 })
                .toBeGreaterThanOrEqual(1);

            const firstCrawl = mock.requests.find(isCrawlRecord).body;
            const crawlToolNames = toolNamesOf(firstCrawl);
            for (const expected of [
                'luker_rpg_extract_crawl_inspect',
                'luker_rpg_extract_crawl_neighbors',
                'luker_rpg_extract_crawl_search',
                'luker_rpg_extract_crawl_done',
            ]) {
                expect(crawlToolNames).toContain(expected);
            }

            // Crawl prompt shape: dialogue_batch + candidate_nodes index.
            // Fill Graph backfills from floor 0, so the first crawl batch is
            // the greeting floor of the Ash fixture card.
            const firstCrawlUser = userPromptOf(firstCrawl);
            expect(firstCrawlUser).toContain('<dialogue_batch>');
            expect(firstCrawlUser).toContain('<candidate_nodes>');
            expect(firstCrawlUser).toContain('half-folded chart');
            // Regression: the join bug produced a literal backslash-n blob.
            expect(firstCrawlUser).not.toContain('\\n');

            // System prompt is the crawl prompt, not the one-shot extraction
            // prompt.
            const crawlSystem = firstCrawl.messages.filter(m => m?.role === 'system').map(m => String(m.content ?? '')).join('\n');
            expect(crawlSystem).toContain('memory-graph crawler');

            // ── Structured error feedback: the round-2 request is sent only
            // after the mock answers round 1, so it can land after the poll
            // above returns.
            await expect.poll(() => mock.requests.filter(isCrawlRecord).filter(r => userPromptOf(r.body).includes('not_found')).length, {
                message: 'bogus inspect must surface a not_found error observation to the next round',
                timeout: 120_000,
            }).toBeGreaterThanOrEqual(1);

            // ── Extraction pass gets the crawled local slice ────────────
            await expect.poll(() => mock.requests.filter(isExtractionRecord).length, { timeout: 120_000 })
                .toBeGreaterThanOrEqual(2);

            expect(mock.requests.filter(isExtractionRecord).map(r => userPromptOf(r.body)).join('\n')).toContain('crawled_local_slice');

            // semantic_node_total travels inside the <graph_data> JSON of the
            // extraction payload; prompt-order assembly may merge messages,
            // so search the whole body (JSON.stringify escapes inner quotes).
            const readTotals = () => mock.requests.filter(isExtractionRecord).map(r => {
                const m = /semantic_node_total\\?"?\s*:\s*(\d+)/.exec(JSON.stringify(r.body.messages));
                return m ? Number(m[1]) : null;
            }).filter(v => v !== null);
            expect(readTotals().length, 'semantic_node_total must appear in extraction payloads').toBeGreaterThanOrEqual(1);
            // Batch 1 reports 0 (graph empty before the greeting batch
            // commits); later batches must see the true total. A later
            // batch's request is sent only after batch 1 commits, so it can
            // land after the poll above returns.
            await expect.poll(() => readTotals().some(v => v >= 1), {
                message: 'later extraction batches must see a nonzero as-of graph total',
                timeout: 120_000,
            }).toBe(true);
            const totals = readTotals();
            for (const total of totals) {
                expect(Number.isInteger(total) && total >= 0).toBe(true);
            }

            // ── Transport follows the preset's streaming flag ───────────
            // The mock answers with SSE iff the body carries `stream: true`.
            for (const record of mock.requests.filter(r => isCrawlRecord(r) || isExtractionRecord(r))) {
                expect(record.body?.stream === true, `memory-graph request stream flag must be ${stream}`).toBe(stream);
            }
        });
    });
}
