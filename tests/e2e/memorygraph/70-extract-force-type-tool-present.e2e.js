// tests/e2e/memorygraph/70-extract-force-type-tool-present.e2e.js
//
// #70 — A node type marked Force Update is active in every extraction round,
// so its create tool is always present in the extraction request. When a type
// is declared hard-required in the prompt while its tool is withheld, the
// round can never satisfy the requirement: the two surfaces must agree.
//
// Two specs share the file:
//
//   A. Shipped-default pin. The built-in `event` type is Force Update and
//      declares no cadence. Enable MG through the real checkboxes, drive the
//      real Fill Graph button, and assert the event tool rides every
//      extraction request, an event node with the mocked summary lands, and
//      no retry toast renders.
//
//   B. Discriminating spec. Persist `event` as Force Update with a cadence
//      greater than one through the real Schema Iteration Studio, then drive
//      Fill Graph on a chat whose extraction seq is not a multiple of that
//      cadence. The event tool must still ride the request. Without the
//      scheduler treating force-update types as always active, this round
//      withholds the tool and the assertion goes red.

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
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { fillMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

const SETUP_TURN = 'The reef line shifted overnight; the third buoy drags its mooring.';
const SETUP_REPLY = '*Ash folds the chart and studies the buoy line.* "Then we move before the turn of the tide."';
const EVENT_TOOL = 'luker_rpg_extract_event_create';
const DONE_TOOL = 'luker_rpg_extract_done';
const EVENT_SUMMARY = '时间：测试；开场。';
const PERSISTED_CADENCE = 3;
const RETRY_TOAST_PATTERN_SOURCE = 'retrying|正在重试|正在重試';

// The terminal done call is unique to the one-shot extraction request (the
// crawl exploration tools never carry it), so it identifies an extraction
// round without depending on the tool under test.
function extractionRequests(mock) {
    return mock.requests.filter((r) => {
        const tools = Array.isArray(r.body?.tools) ? r.body.tools : [];
        return tools.some((t) => t?.function?.name === DONE_TOOL);
    });
}

// Every extraction round answers with a valid event create plus the terminal
// done call. Any other request (main chat generation, the schema studio,
// world-info probes) returns null so the mock's queue serves it.
function installExtractionRouter(mock) {
    mock.scriptCompletion((req) => {
        const names = req.toolNames || [];
        if (!names.includes(EVENT_TOOL)) {
            return null;
        }
        return { toolCalls: [
            { name: EVENT_TOOL, arguments: { summary: EVENT_SUMMARY, links: [], no_link_reason: 'mock' } },
            { name: DONE_TOOL, arguments: {} },
        ] };
    });
}

function messageText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
    }
    return '';
}

// The batch's highest dialogue seq, read off the request surface. Each
// role-split dialogue message opens with a `<seq>{n}</seq>` tag; the input
// guide's literal `<seq>{n}</seq>` mention carries no digits so it never
// matches.
function extractionBatchSeq(request) {
    const messages = Array.isArray(request?.body?.messages) ? request.body.messages : [];
    const seqs = [];
    for (const message of messages) {
        const text = messageText(message?.content);
        const re = /<seq>(\d+)<\/seq>/g;
        let match;
        while ((match = re.exec(text)) !== null) {
            seqs.push(Number(match[1]));
        }
    }
    return seqs.length > 0 ? Math.max(...seqs) : null;
}

async function openMgSchemaStudio(page) {
    await openIterStudio(page, 'mg');
}

async function enableMgAndFillGraph(page) {
    await setMgSettings(page, {
        enabled: true,
        autoExtractionEnabled: true,
        autoCompressionEnabled: false,
    });
    await fillMgGraph(page, { closeAfter: true });
}

// Record every retry-toast text the DOM ever renders. Installed before MG is
// enabled because auto-extraction may fire the moment it turns on; the retry
// text is i18n'd, so match English or either zh locale.
async function installRetryToastObserver(page) {
    await page.evaluate((source) => {
        const pattern = new RegExp(source);
        window.__retryToastTexts = [];
        const scan = () => {
            for (const el of document.querySelectorAll('.toast-message')) {
                const text = el.textContent || '';
                if (pattern.test(text) && !window.__retryToastTexts.includes(text)) {
                    window.__retryToastTexts.push(text);
                }
            }
        };
        scan();
        new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
    }, RETRY_TOAST_PATTERN_SOURCE);
}

// Positive control: prove the observer sees the DOM and the selector plus
// pattern match, so the later "no retry toast" verdict cannot pass vacuously.
// A matching node is injected, captured, then removed and dropped from the
// buffer before the real verdict is taken.
async function assertRetryToastObserverIsLive(page) {
    const controlText = 'retrying — observer control';
    await page.evaluate((text) => {
        const el = document.createElement('div');
        el.className = 'toast-message';
        el.id = '__retry_toast_control';
        el.textContent = text;
        document.body.appendChild(el);
    }, controlText);
    await expect.poll(
        () => page.evaluate((text) => Array.isArray(window.__retryToastTexts) && window.__retryToastTexts.includes(text), controlText),
        { timeout: 5000, intervals: [50, 100, 200] },
    ).toBe(true);
    await page.evaluate((text) => {
        document.getElementById('__retry_toast_control')?.remove();
        window.__retryToastTexts = window.__retryToastTexts.filter((entry) => entry !== text);
    }, controlText);
}

// Wait until no new extraction request has arrived for `stableMs`. Throws on
// timeout so a verdict is never taken over an incomplete round set.
async function waitForExtractionQuiescence(mock, { stableMs = 2500, timeoutMs = 120_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastCount = -1;
    let lastChangeAt = Date.now();
    while (Date.now() < deadline) {
        const count = extractionRequests(mock).length;
        if (count !== lastCount) {
            lastCount = count;
            lastChangeAt = Date.now();
        }
        if (count > 0 && Date.now() - lastChangeAt >= stableMs) {
            return count;
        }
        await new Promise((resolve) => { setTimeout(resolve, 250); });
    }
    throw new Error(`extraction did not quiesce within ${timeoutMs}ms (last request count = ${lastCount})`);
}

async function readEventSummaries(page) {
    return page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        const mg = ctx.getExtensionApi?.('memory-graph');
        const session = await mg?.openSession?.(ctx);
        if (!session) return [];
        return session.listVisibleCandidates({ types: ['event'] }).map((n) => String(n?.fields?.summary || ''));
    });
}

test.describe('#70 — a force-update type always carries its create tool', () => {
    let server, mock;

    test.beforeAll(async ({ workerResources }, testInfo) => {
        const scope = await workerResources.scenario(testInfo.file);
        mock = await startMockLLM({ scriptedReplies: [SETUP_REPLY] });
        server = await startServer({ scope, batchKey: 'memorygraph', scenarioId: 'extract-force-type-tool' });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        disableTagImportPopup({ dataRoot: server.dataRoot });
        writeEmbeddedCharacter({ dataRoot: server.dataRoot });
        installExtractionRouter(mock);
    });

    test.afterAll(async () => {

        await mock?.stop();
    });

    test.setTimeout(180_000);

    test('the shipped default event type rides every extraction request', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        // One real turn while MG is still off, so there is a floor to extract.
        await sendMessageAndAwaitReply(page, SETUP_TURN);

        await installRetryToastObserver(page);
        await assertRetryToastObserverIsLive(page);

        await enableMgAndFillGraph(page);

        await expect.poll(() => extractionRequests(mock).length, {
            timeout: 120_000,
            intervals: [200, 300, 500, 1000],
        }).toBeGreaterThanOrEqual(1);

        // The mocked summary must land in the graph, so the assertion pins
        // the landing, not merely the presence of some event node.
        await expect.poll(() => readEventSummaries(page), {
            timeout: 120_000,
            intervals: [200, 300, 500, 1000],
        }).toContain(EVENT_SUMMARY);

        await waitForExtractionQuiescence(mock);

        // Snapshot the full request set only after the backfill has gone
        // quiet, so rounds that arrive during the graph poll are covered.
        const rounds = extractionRequests(mock);
        expect(
            rounds.some((r) => r.body.tools.some((t) => t?.function?.name === EVENT_TOOL)),
            'at least one extraction request must carry the force-update type create tool',
        ).toBe(true);
        for (const round of rounds) {
            const toolNames = round.body.tools.map((t) => String(t?.function?.name || ''));
            expect(
                toolNames,
                'every extraction request must carry the force-update type create tool',
            ).toContain(EVENT_TOOL);
        }

        const retryToastTexts = await page.evaluate(() => window.__retryToastTexts.slice());
        expect(
            retryToastTexts,
            'a round that completes on the first attempt must not surface a retry toast',
        ).toHaveLength(0);
    });
});

test.describe('#70 — a persisted cadence does not withhold the force-update tool', () => {
    let server, mock;

    test.beforeAll(async ({ workerResources }, testInfo) => {
        const scope = await workerResources.scenario(testInfo.file);
        mock = await startMockLLM({ scriptedReplies: [SETUP_REPLY] });
        server = await startServer({ scope, batchKey: 'memorygraph', scenarioId: 'extract-force-type-tool-persisted-cadence' });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        disableTagImportPopup({ dataRoot: server.dataRoot });
        writeEmbeddedCharacter({ dataRoot: server.dataRoot });
        normalizeIterStudioSettings(server.dataRoot);
        installExtractionRouter(mock);
    });

    test.afterAll(async () => {

        await mock?.stop();
    });

    test.setTimeout(180_000);

    test('a cadence greater than one on a force-update type keeps the tool in the request', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        // One real turn while MG is off. The extractable assistant seqs become
        // 1 (greeting) and 2 (reply), neither a multiple of the cadence below.
        await sendMessageAndAwaitReply(page, SETUP_TURN);

        // Persist `event` as Force Update with a cadence greater than one
        // through the real Schema Iteration Studio. The queued tool call is
        // registered after the chat turn so the turn's own request consumes
        // the scripted reply instead.
        await openMgSchemaStudio(page);
        mock.scriptToolCall({
            name: 'mg_schema_set_node_type',
            arguments: { node_type: { id: 'event', forceUpdate: true, extractEveryN: PERSISTED_CADENCE } },
        });
        await sendIterPrompt(page, 'mg', `Make the event node type Force Update with a cadence of ${PERSISTED_CADENCE}.`);
        await applyIterBatch(page, 'mg');
        await closeIterStudio(page);

        // Setup check: the studio really persisted the defect state into the
        // effective schema, so a failure below cannot be blamed on an
        // unapplied edit. With a character selected the studio persists a
        // character-scoped schema, which is the schema extraction reads.
        await expect.poll(async () => page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const info = mg?.getSchemaScopeInfo?.(ctx);
            const entry = Array.isArray(info?.schema) ? info.schema.find((t) => t?.id === 'event') : null;
            return entry ? { forceUpdate: Boolean(entry.forceUpdate), extractEveryN: Number(entry.extractEveryN) } : null;
        }), { timeout: 15_000, intervals: [100, 200, 500] }).toEqual({ forceUpdate: true, extractEveryN: PERSISTED_CADENCE });

        await enableMgAndFillGraph(page);

        await expect.poll(() => extractionRequests(mock).length, {
            timeout: 120_000,
            intervals: [200, 300, 500, 1000],
        }).toBeGreaterThanOrEqual(1);

        await waitForExtractionQuiescence(mock);
        const rounds = extractionRequests(mock);

        // Precondition: every extraction round ran on a seq the persisted
        // cadence would skip. The tool must still ride the request.
        const batchSeqs = rounds.map(extractionBatchSeq);
        expect(batchSeqs, 'every extraction request must expose its dialogue seq').not.toContain(null);
        for (const seq of batchSeqs) {
            expect(
                seq % PERSISTED_CADENCE,
                `extraction seq ${seq} must not be a multiple of the persisted cadence ${PERSISTED_CADENCE}`,
            ).not.toBe(0);
        }

        for (const round of rounds) {
            const toolNames = round.body.tools.map((t) => String(t?.function?.name || ''));
            expect(
                toolNames,
                'a cadence greater than one on a force-update type must not withhold its create tool',
            ).toContain(EVENT_TOOL);
        }
    });
});
