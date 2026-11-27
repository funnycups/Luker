// tests/e2e/memorygraph/72-crawl-empty-response.e2e.js
//
// #72 — an empty crawl reply ends exploration for that batch.
//
// Real-user flow:
//   1. Chat three RP turns with MG off.
//   2. Enable MG (auto extraction off), switch Extraction graph mode to
//      crawl in Advanced, click Fill Graph.
//   3. The mock answers every crawl request with an empty message (no text,
//      no tool calls) and every extraction request with one event for the
//      batch's turn + done.
//
// Pins:
//   - each batch sends exactly one crawl request (round 1, no retry): no
//     two crawl requests are adjacent and crawl count equals extraction
//     count;
//   - the extracted event is in the graph and survives a server restart
//     without any extraction or crawl request after the restart.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import { awaitMainUI, openOptionsAndClick, reloadAndAwait, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { closeWorkbench } from '../_lib/ui-workbench.js';
import { openMemoryWorkspace, setMgSettings } from '../_lib/ui-mg-varops.js';
import {
    CRAWL_INSPECT_TOOL,
    EXTRACT_EVENT_TOOL,
    FILL_DONE_STATUS,
    toolNamesOf,
    chatCompletionRecords,
    disableMemoryGraphInSettingsFile,
    clickFillGraph,
    readMemoryGraphState,
    memoryGraphStatus,
} from './_runner-helpers.js';

const TURNS = [
    'The customs house shutters rattle; something is wedged behind the left panel.',
    'I pry the panel loose and find a bundle of manifests wrapped in oilcloth.',
    'The harbormaster wants the manifests logged before the evening tide.',
];

const REPLIES = [
    '*Ash sets down the chart and listens to the shutters knock.* "That is not the wind. Something heavy is caught back there."',
    '*Ash peels back a corner of the oilcloth and squints at the ink.* "Customs manifests, and dry. Someone wanted these kept, not lost."',
    '*Ash glances at the tide marks on the pilings.* "Then we write fast. The water will not wait for the harbormaster\'s patience."',
];

const EVENT_SENTINEL = 'Oilcloth manifests recovered from behind the customs house shutters';

// Fill Graph extracts one turn per batch, oldest first, so the latest turn
// named in an extraction request is the one that batch covers; a request
// naming none of them covers the greeting floor.
const BATCH_EVENTS = [
    { marker: TURNS[2], summary: '时间：涨潮前；the harbormaster orders the oilcloth manifests logged before the evening tide.' },
    { marker: TURNS[1], summary: `时间：涨潮前；${EVENT_SENTINEL}.` },
    { marker: TURNS[0], summary: '时间：涨潮前；something wedged behind the customs house shutters rattles the left panel.' },
];
const GREETING_EVENT = '时间：涨潮前；Ash trims the watchpost lantern while the tide settles.';

let server, mock;

function kindOf(record) {
    const names = toolNamesOf(record.body);
    if (names.includes(CRAWL_INSPECT_TOOL)) return 'crawl';
    if (names.includes(EXTRACT_EVENT_TOOL)) return 'extract';
    return 'other';
}

function eventSummaryFor(body) {
    const blob = JSON.stringify(body?.messages || []);
    const match = BATCH_EVENTS.find(({ marker }) => blob.includes(JSON.stringify(marker).slice(1, -1)));
    return match ? match.summary : GREETING_EVENT;
}

function hasSentinelEvent(state) {
    return state.nodes.some(node => node.type === 'event' && !node.archived && JSON.stringify(node.fields).includes(EVENT_SENTINEL));
}

function readMgSettingsOnDisk(dataRoot) {
    const settings = JSON.parse(readFileSync(resolve(dataRoot, 'default-user', 'settings.json'), 'utf8'));
    const mg = settings?.extension_settings?.memory_graph || {};
    return { enabled: mg.enabled, autoExtractionEnabled: mg.autoExtractionEnabled, extractMode: mg.extractMode };
}

async function openChatFromManageChats(page, chatId) {
    await openOptionsAndClick(page, 'option_select_chat');
    const row = page.locator('#select_chat_popup .select_chat_block_wrapper', {
        has: page.locator('.select_chat_block_filename', { hasText: chatId }),
    }).first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.locator('.select_chat_block').click();
    await page.waitForFunction(wantId => window.Luker.getContext().getCurrentChatId?.() === wantId, chatId, { timeout: 15_000 });
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [...REPLIES] });
    server = await startServer({ scope, batchKey: 'memorygraph', scenarioId: 'crawl-empty-response' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot });
    disableMemoryGraphInSettingsFile(server.dataRoot);

    mock.scriptCompletion((req) => {
        const names = req.toolNames || [];
        if (names.includes(CRAWL_INSPECT_TOOL)) {
            return { text: '' };
        }
        if (names.includes(EXTRACT_EVENT_TOOL)) {
            return {
                toolCalls: [
                    { name: EXTRACT_EVENT_TOOL, arguments: { summary: eventSummaryFor(req.body), links: [], no_link_reason: 'No related node is recorded yet.' } },
                    { name: 'luker_rpg_extract_done', arguments: {} },
                ],
            };
        }
        return null;
    });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#72 — empty crawl reply ends exploration without retry', () => {
    test.setTimeout(300_000);

    test('one crawl request per batch, extraction persists across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        for (const turn of TURNS) {
            await sendMessageAndAwaitReply(page, turn);
        }

        // Auto extraction goes off before MG turns on, so enabling never
        // starts an extraction before crawl mode is selected.
        await setMgSettings(page, {
            autoExtractionEnabled: false,
            enabled: true,
            extractMode: 'crawl',
            updateEvery: 1,
            extractBatchTurns: 1,
        });

        const before = mock.requests.length;
        await clickFillGraph(page);
        await expect(memoryGraphStatus(page)).toHaveText(FILL_DONE_STATUS, { timeout: 240_000 });
        await closeWorkbench(page);

        const kinds = chatCompletionRecords(mock, before).map(kindOf).filter(kind => kind !== 'other');
        const crawlCount = kinds.filter(kind => kind === 'crawl').length;
        const extractCount = kinds.filter(kind => kind === 'extract').length;
        expect(crawlCount, 'crawl mode must send crawl requests').toBeGreaterThanOrEqual(1);
        expect(kinds[0]).toBe('crawl');
        for (let i = 1; i < kinds.length; i += 1) {
            expect(kinds[i - 1] === 'crawl' && kinds[i] === 'crawl', `no back-to-back crawl requests: ${kinds.join(',')}`).toBe(false);
        }
        expect(crawlCount, `one crawl per extraction batch: ${kinds.join(',')}`).toBe(extractCount);

        await expect.poll(async () => hasSentinelEvent(await readMemoryGraphState(page)), { timeout: 30_000 }).toBe(true);

        const chatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());

        // Settings saves are debounced; the restart must not land before the
        // UI-made MG changes reach settings.json.
        await expect.poll(() => readMgSettingsOnDisk(server.dataRoot), { timeout: 15_000 })
            .toMatchObject({ enabled: true, autoExtractionEnabled: false, extractMode: 'crawl' });

        await server.restart();
        const beforeRestart = mock.requests.length;
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        const lens = await openMemoryWorkspace(page, { subview: 'settings' });
        await expect(lens.locator('[data-field-key="enabled"]').first()).toHaveAttribute('aria-checked', 'true');
        await expect(lens.locator('[data-field-key="autoExtractionEnabled"]').first()).toHaveAttribute('aria-checked', 'false');
        await closeWorkbench(page);
        // The fixture card carries no chat pointer, so selecting it after a
        // reload starts a fresh chat; the user reopens the extracted chat
        // from Manage Chat Files.
        await openChatFromManageChats(page, chatId);
        await expect.poll(async () => hasSentinelEvent(await readMemoryGraphState(page)), { timeout: 30_000 }).toBe(true);

        const kindsAfterRestart = chatCompletionRecords(mock, beforeRestart).map(kindOf).filter(kind => kind !== 'other');
        expect(kindsAfterRestart, 'the event is read back from storage, not extracted again').toEqual([]);
    });
});
