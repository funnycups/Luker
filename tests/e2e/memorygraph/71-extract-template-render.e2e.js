// tests/e2e/memorygraph/71-extract-template-render.e2e.js
//
// #71 — The extraction request is one editable template rendered in place.
//
// The prompt is a single template string carrying two markers. The program
// replaces each marker with a block it generates itself: the node block holds
// the node heading over the active types' rules, the edge block holds the edge
// heading over the edge rules. The rendered string is the extraction request's
// system message.
//
// Unit tests stay out of the prompt body, so nothing below the assembly
// helpers pins what the request actually carries. This file does: it drives a
// real extraction through the real Fill Graph button and asserts the rendered
// system message carries the template's own fixed text, both program-generated
// headings, and one line out of the active types' rules and out of the edge
// rules. Every expected line is read off the shipped constants rather than
// pasted here, so a reworded line re-derives instead of rotting the check.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
} from '../_lib/page.js';
import { fillMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';
import {
    DEFAULT_EXTRACT_EDGE_RULES,
    DEFAULT_EXTRACT_TEMPLATE,
    DEFAULT_PER_TYPE_INSTRUCTIONS,
} from '../../../public/scripts/extensions/memory-graph/default-prompts.js';
import {
    EDGES_BLOCK_HEADING,
    NODES_BLOCK_HEADING,
} from '../../../public/scripts/extensions/memory-graph/extraction-schedule.js';

const SETUP_TURN = 'The reef line shifted overnight; the third buoy drags its mooring.';
const SETUP_REPLY = '*Ash folds the chart and studies the buoy line.* "Then we move before the turn of the tide."';
const EVENT_TOOL = 'luker_rpg_extract_event_create';
const DONE_TOOL = 'luker_rpg_extract_done';
const EVENT_SUMMARY = '时间：测试；开场。';

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
// done call. Any other request (main chat generation, world-info probes)
// returns null so the mock's queue serves it.
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

// The opening line of a shipped prompt constant: its first non-empty line,
// skipping the marker lines the program replaces before the request leaves.
// Reading it off the constant keeps this check pinned to the shipped text, and
// a line the constant no longer carries re-derives rather than failing on a
// hand-copied sentence. Each constant's own opening statement is the line a
// rewrite touches first, so it is the sharpest signal that the constant — not
// some other copy of its rules — reached the request.
function openingLine(text) {
    return String(text)
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.includes('{{')) || '';
}

async function enableMgAndFillGraph(page) {
    await setMgSettings(page, {
        enabled: true,
        autoExtractionEnabled: true,
        autoCompressionEnabled: false,
    });
    await fillMgGraph(page, { closeAfter: true });
}

test.describe('#71 — the extraction request carries the rendered template', () => {
    let server, mock;

    test.beforeAll(async () => {
        mock = await startMockLLM({ scriptedReplies: [SETUP_REPLY] });
        server = await startServer({ batchKey: 'memorygraph', scenarioId: 'extract-template-render' });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        disableTagImportPopup({ dataRoot: server.dataRoot });
        writeEmbeddedCharacter({ dataRoot: server.dataRoot });
        installExtractionRouter(mock);
    });

    test.afterAll(async () => {
        await tearDownServer(server);
        await mock?.stop();
    });

    test.setTimeout(180_000);

    test('the system message holds the template text, both headings and both rule sets', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        // One real turn while MG is still off, so there is a floor to extract.
        await sendMessageAndAwaitReply(page, SETUP_TURN);

        await enableMgAndFillGraph(page);

        await expect.poll(() => extractionRequests(mock).length, {
            timeout: 120_000,
            intervals: [200, 300, 500, 1000],
        }).toBeGreaterThanOrEqual(1);

        const request = extractionRequests(mock)[0];
        const messages = Array.isArray(request.body?.messages) ? request.body.messages : [];

        // The template lands as its own system message. The preset's character
        // card contributes system messages ahead of it, so locate it by the
        // template's own fixed text rather than by position, then pin the rest
        // on that same message.
        const templateLine = openingLine(DEFAULT_EXTRACT_TEMPLATE);
        const extractionSystem = messages
            .filter((message) => message?.role === 'system')
            .map((message) => messageText(message.content))
            .find((text) => text.includes(templateLine));
        expect(
            extractionSystem,
            'the extraction request must carry a system message rendered from the template',
        ).toBeTruthy();

        expect(extractionSystem).toContain(templateLine);
        expect(extractionSystem).toContain(NODES_BLOCK_HEADING);
        expect(extractionSystem).toContain(openingLine(DEFAULT_PER_TYPE_INSTRUCTIONS.event));
        expect(extractionSystem).toContain(EDGES_BLOCK_HEADING);
        expect(extractionSystem).toContain(openingLine(DEFAULT_EXTRACT_EDGE_RULES));
    });
});
