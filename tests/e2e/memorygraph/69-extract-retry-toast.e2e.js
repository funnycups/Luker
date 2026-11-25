// tests/e2e/memorygraph/69-extract-retry-toast.e2e.js
//
// #69 — When a memory-graph extraction round fails and the pipeline retries,
// the user sees exactly ONE transient info toast describing the retry. Before
// this change every retry was silent (console.warn only), so a flaky
// extraction could churn without the user ever knowing.
//
// What this pins (all through real user gestures):
//   1. One real RP turn while MG is OFF, so a chat floor exists before any
//      extraction pass runs.
//   2. MG enabled via the real settings checkboxes; auto-compression turned
//      OFF so the only retryable LLM traffic is the extraction pass.
//   3. The mock LLM answers the FIRST extraction request with a type-create
//      but WITHOUT the terminal `luker_rpg_extract_done` call — an
//      "incomplete output" failure — and answers correctly on the retry.
//   4. Extraction is driven by the real Fill Graph button. The retry toast
//      must appear, and there must be exactly one of them: the batch layer
//      re-rolls the same failure silently rather than adding a second toast.
//
// The retry toast is transient (toastr timeOut ≈ 4s) and auto-extraction may
// fire the instant MG turns on, so this test records every distinct retry-toast
// text the DOM ever renders via a MutationObserver installed before MG is
// enabled, then asserts on that capture.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
} from '../_lib/page.js';
import { fillMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';

const SETUP_TURN = 'The reef line shifted overnight; the third buoy drags its mooring.';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash folds the chart and studies the buoy line.* "Then we move before the turn of the tide."',
    ] });
    server = await startServer({ scope, batchKey: 'memorygraph', scenarioId: 'extract-retry-toast' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot });

    // Extraction routing. The first extraction round omits the terminal done
    // call (incomplete output → semantic retry + retry toast); every later
    // round answers with a valid create + done pair. Any other request
    // (main chat generation, world-info probes) falls through to the queue.
    let extractRounds = 0;
    mock.scriptCompletion((req) => {
        const names = req.toolNames || [];
        if (!names.includes('luker_rpg_extract_event_create')) {
            return null;
        }
        extractRounds += 1;
        const create = {
            name: 'luker_rpg_extract_event_create',
            arguments: { summary: '时间：测试；retry toast probe.', links: [], no_link_reason: 'mock' },
        };
        if (extractRounds === 1) {
            return { toolCalls: [create] }; // missing luker_rpg_extract_done
        }
        return { toolCalls: [create, { name: 'luker_rpg_extract_done', arguments: {} }] };
    });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#69 — an extraction retry surfaces exactly one info toast', () => {
    test.setTimeout(180_000);

    test('incomplete extraction output shows one retry toast', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        // One real turn while MG is still off, so there is a floor to extract.
        await sendMessageAndAwaitReply(page, SETUP_TURN);

        // Record every distinct retry-toast text the DOM ever renders, starting
        // BEFORE MG is enabled (auto-extraction may fire the moment it turns
        // on). Observing the rendered toast keeps the assertion on the real
        // user-visible surface rather than an internal marker. The retry text
        // is i18n'd, so match English or either zh locale.
        await page.evaluate(() => {
            window.__retryToastTexts = [];
            const scan = () => {
                for (const el of document.querySelectorAll('.toast-message')) {
                    const text = el.textContent || '';
                    if (/retrying|正在重试|正在重試/.test(text) && !window.__retryToastTexts.includes(text)) {
                        window.__retryToastTexts.push(text);
                    }
                }
            };
            scan();
            new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
        });

        // Enable MG through Memory Lens Settings; keep compression off so the
        // only retryable LLM traffic is the extraction pass.
        await setMgSettings(page, {
            enabled: true,
            autoExtractionEnabled: true,
            autoCompressionEnabled: false,
        });

        // Drive extraction from the Fill Graph button.
        await fillMgGraph(page, { closeAfter: true });

        await expect.poll(async () => page.evaluate(() => window.__retryToastTexts.length), {
            timeout: 120_000,
            intervals: [200, 300, 500, 1000],
        }).toBeGreaterThanOrEqual(1);

        // The retry actually reached the model: at least a second request.
        await expect.poll(() => mock.requests.filter((r) =>
            Array.isArray(r.body?.tools)
            && r.body.tools.some((t) => t?.function?.name === 'luker_rpg_extract_event_create')).length, {
            message: 'extraction must have been retried',
            timeout: 120_000,
            intervals: [200, 300, 500, 1000],
        }).toBeGreaterThanOrEqual(2);

        // Exactly one retry toast for the single failed round — the batch
        // layer must not add a second toast for the same failure. The mock's
        // first round omitted the terminal done call, so the toast must name
        // the incomplete-output reason, not a generic request failure.
        const retryToastTexts = await page.evaluate(() => window.__retryToastTexts.slice());
        expect(retryToastTexts, 'exactly one retry toast for the one failed round').toHaveLength(1);
        expect(retryToastTexts[0], 'retry toast must name the incomplete-output reason').toMatch(/incomplete|不完整/);
    });
});
