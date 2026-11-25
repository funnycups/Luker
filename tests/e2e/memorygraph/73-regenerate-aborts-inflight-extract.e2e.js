// tests/e2e/memorygraph/73-regenerate-aborts-inflight-extract.e2e.js
//
// Regenerating a turn whose floor is already being extracted must discard
// the in-flight extraction pass.
//
// The scheduled pass snapshots the chat frames at launch and builds each
// batch prompt from that snapshot. With the default batch size of one, the
// only uncommitted floor IS the batch currently in flight. Before this fix
// a chat mutation at that floor only lowered the pass's upper bound, which
// the running batch never observes — the pass finished against the deleted
// content and committed stale nodes (or threw on the now-missing floor).
//
// Real-user flow:
//   1. One turn while MG is off, so a floor exists before MG turns on.
//   2. Enable MG through the settings checkboxes, recall + compression off.
//   3. Fill Graph so the existing floors are covered; wait for messages=2.
//   4. Send a new turn → auto extraction starts for that last floor. The
//      mock stalls that extraction request so it is guaranteed in flight.
//   5. Click the real Regenerate option. The delete of that floor must
//      abort the extraction pass: the status surface reports a cancellation
//      instead of an extraction failure, and no stale batch commits.
//   6. The regenerated turn's own extraction still runs and succeeds.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    regenerateViaUI,
} from '../_lib/page.js';
import { closeWorkbench } from '../_lib/ui-workbench.js';
import { fillMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';

let fileScope;

test.beforeAll(async ({ workerResources }, testInfo) => {
    fileScope = await workerResources.scenario(testInfo.file);
});

const SETUP_TURN = 'The reef line shifted overnight; the third buoy drags its mooring.';
const LAST_FLOOR_TURN = 'The tide gauge at the mole reads higher than last night.';
const SETUP_REPLY = '*Ash folds the chart and studies the buoy line.* "Then we move before the turn of the tide."';
const LAST_FLOOR_REPLY = '*Ash taps the gauge log twice.* "Half a hand above the last mark. The mole holds for now."';
const REGENERATED_REPLY = '*Ash sets the log down and reaches for the tide tables.* "We check the outer mark before dusk."';
const EXTRACT_DONE = 'luker_rpg_extract_done';
const EVENT_CREATE = 'luker_rpg_extract_event_create';
// Longer than the time the test needs to click regenerate, short enough that
// an unnoticed stall does not hold the scenario open for long.
const EXTRACT_STALL_MS = 8_000;

let server, mock;
let stallNextExtract = false;
let chatReplyIndex = 0;
const CHAT_REPLIES = [SETUP_REPLY, LAST_FLOOR_REPLY, REGENERATED_REPLY];

function toolNamesOf(request) {
    const tools = Array.isArray(request?.body?.tools) ? request.body.tools : [];
    return tools.map((tool) => String(tool?.function?.name || ''));
}

function extractionRequests() {
    return mock.requests.filter((request) => toolNamesOf(request).includes(EXTRACT_DONE));
}

function requestText(request) {
    const messages = Array.isArray(request?.body?.messages) ? request.body.messages : [];
    return messages
        .map((message) => {
            const content = message?.content;
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
                return content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
            }
            return '';
        })
        .join('\n');
}

test.beforeAll(async () => {
    mock = await startMockLLM();
    // Every request is routed explicitly so the reply queue never desyncs.
    mock.scriptCompletion((req) => {
        const names = req.toolNames || [];
        if (names.includes(EXTRACT_DONE)) {
            return {
                toolCalls: [
                    {
                        name: EVENT_CREATE,
                        arguments: {
                            summary: '时间：测试；末楼重新生成前的中断检查。',
                            links: [],
                            no_link_reason: 'mock',
                        },
                    },
                    { name: EXTRACT_DONE, arguments: {} },
                ],
            };
        }
        return { text: CHAT_REPLIES[chatReplyIndex++] || REGENERATED_REPLY };
    });
    // The first extraction request after the stall is armed holds its
    // response until the client aborts or the window elapses.
    mock.setLatencyMs((_req, parsed) => {
        const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
        const isExtract = tools.some((tool) => String(tool?.function?.name || '') === EXTRACT_DONE);
        if (!isExtract || !stallNextExtract) {
            return 0;
        }
        stallNextExtract = false;
        return EXTRACT_STALL_MS;
    });

    server = await startServer({ scope: fileScope, batchKey: 'memorygraph', scenarioId: 'regenerate-aborts-inflight-extract' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await mock?.stop();
});

test.describe('regenerating the last turn aborts the extraction pass covering it', () => {
    test.setTimeout(180_000);

    test('the in-flight extraction is cancelled, not committed', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        // One real turn while MG is off, so the graph has floors to cover.
        await sendMessageAndAwaitReply(page, SETUP_TURN);

        // Enable MG through Memory Lens Settings. Recall and compression stay
        // off so the only extraction traffic is the pass under test.
        await setMgSettings(page, {
            enabled: true,
            autoExtractionEnabled: true,
            autoCompressionEnabled: false,
            recallEnabled: false,
            updateEvery: 1,
            extractBatchTurns: 1,
        });

        // Cover the floors that predate MG, so the next automatic pass starts
        // exactly at the last turn instead of replaying the backlog.
        await fillMgGraph(page);
        await expect.poll(async () => page.locator('.wbench .mlens .ml-settings-stats').first().innerText(), {
            timeout: 120_000,
            intervals: [200, 300, 500, 1000],
        }).toMatch(/messages=2\b/);

        // Record every status line the Memory Lens Settings view renders from
        // here on (the element stays in DOM even after folding Workbench).
        await page.evaluate(() => {
            window.__mgStatusLog = [];
            const el = document.querySelector('.wbench .mlens .ml-settings-status');
            if (!el) throw new Error('memory status element missing');
            const capture = () => {
                const text = String(el.textContent || '').trim();
                if (text && window.__mgStatusLog[window.__mgStatusLog.length - 1] !== text) {
                    window.__mgStatusLog.push(text);
                }
            };
            capture();
            new MutationObserver(capture).observe(el, { childList: true, characterData: true, subtree: true });
        });
        await closeWorkbench(page);

        // The next extraction request is the one for the turn we regenerate.
        stallNextExtract = true;
        await sendMessageAndAwaitReply(page, LAST_FLOOR_TURN);
        await expect.poll(() => extractionRequests().length, {
            timeout: 60_000,
            intervals: [100, 200, 300, 500],
        }).toBe(3);

        // The stalled request must be the pass that includes the last floor.
        const stalled = extractionRequests()[2];
        expect(requestText(stalled), 'the in-flight pass covers the last floor').toContain(LAST_FLOOR_TURN);

        // Real user gesture: the options dropdown's Regenerate item.
        const extractCountBeforeRegenerate = extractionRequests().length;
        await regenerateViaUI(page);

        // The delete of the last floor must abort the stalled pass. The
        // cancellation line is the user-visible proof; without the abort the
        // pass keeps waiting on the mock and never reports a cancellation.
        await expect.poll(async () => page.evaluate(
            () => (window.__mgStatusLog || []).some((line) => /cancelled|终止|終止/.test(line)),
        ), { timeout: 20_000, intervals: [100, 200, 300, 500] }).toBe(true);

        const statusLog = await page.evaluate(() => window.__mgStatusLog.slice());
        expect(
            statusLog.some((line) => /failed|失败|失敗/.test(line)),
            'the aborted pass must not surface as an extraction failure',
        ).toBe(false);

        // The regenerated turn's own extraction still runs, and it reads the
        // new reply rather than the cancelled one.
        await expect.poll(() => extractionRequests().length, {
            timeout: 60_000,
            intervals: [100, 200, 300, 500],
        }).toBeGreaterThan(extractCountBeforeRegenerate);
        const latestExtract = extractionRequests()[extractionRequests().length - 1];
        expect(requestText(latestExtract), 'the rerun pass reads the regenerated reply').toContain(REGENERATED_REPLY);
    });
});
