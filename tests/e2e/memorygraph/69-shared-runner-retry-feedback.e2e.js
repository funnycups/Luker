import { test, expect } from '../../harness/playwright.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { completeOnboarding, createNewChatViaUI, selectCharacterByName, sendMessageViaUI } from '../_lib/page.js';
import { closeWorkbench } from '../_lib/ui-workbench.js';
import { exportMgGraph, fillMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';
import { FILL_DONE_STATUS, EXTRACT_EVENT_TOOL, CRAWL_INSPECT_TOOL, toolNamesOf, memoryGraphStatus } from './_runner-helpers.js';

const REPLY = 'The harbor lantern marks the safe channel through the reef.';
const SUMMARY = 'The harbor lantern marks the safe channel.';
const RETRY_TEXT = /retrying|正在重试|正在重試/;

let scratch, server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    scratch = (await scope.directory('memory graph retry support')).path;
    const data = await scope.directory('memory graph retry data');
    mock = await startMockLLM({ scriptedReplies: [REPLY] });
    server = await startServer({ scope,
        batchKey: 'memorygraph',
        scenarioId: 'shared-runner-retry',
        data,
        extraConfig: {
            enableUserAccounts: false,
            globalExtensionsPath: join(scratch, 'global-extensions'),
            serverPluginsPath: join(scratch, 'server-plugins'),
        },
    });
});

test.beforeEach(async ({ page }) => {
    await page.goto(server.baseURL);
    await completeOnboarding(page);
    await page.waitForFunction(() => performance.getEntriesByName('[init] complete').length > 0);

    await page.locator('#API-status-top').click();
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(mock.baseURL);
    await page.locator('#custom_model_id').fill('mock-gpt-4o');
    await page.locator('#api_button_openai').click();
    await expect(page.locator('#send_but')).toBeVisible();
    await page.locator('#create_connection_profile').click();
    const popup = page.locator('dialog[open]').last();
    await popup.locator('.popup-input').fill('Memory retry connection');
    await popup.locator('.popup-button-ok').click();
    await expect(popup).toHaveCount(0);
    await page.locator('#API-status-top').click();

    await selectCharacterByName(page, 'Seraphina');
    // Both scenarios assert the frames of a single chat; start a fresh one
    // instead of appending to the chat the previous test generated into.
    await createNewChatViaUI(page);
    // The queue is shared by every test in this file, so replenish the plain
    // chat reply before each scenario consumes it.
    mock.scriptReply(REPLY);
    await sendMessageViaUI(page, 'We follow the harbor lantern to find the safe channel.');
    await expect(page.locator('#chat .mes.last_mes .mes_text')).toContainText(REPLY);
    await expect(page.locator('#mes_stop')).toBeHidden();
    await setMgSettings(page, {
        autoExtractionEnabled: false,
        recallEnabled: false,
        autoCompressionEnabled: false,
        enabled: true,
        updateEvery: 1,
        extractBatchTurns: 1,
        toolCallRetryMax: 1,
        extractConcurrent: false,
    }, { closeAfter: true });
});

test.afterEach(async ({}, testInfo) => {
    if (mock) {
        const path = testInfo.outputPath('upstream-requests.json');
        writeFileSync(path, JSON.stringify(mock.requests, null, 2));
        await testInfo.attach('upstream-requests', {
            path,
            contentType: 'application/json',
        });
    }
});

test.afterAll(async () => {

    await mock?.stop();
    scratch = server = mock = null;
});

function completeExtraction() {
    return { toolCalls: [
        { name: EXTRACT_EVENT_TOOL, arguments: { summary: SUMMARY, links: [], no_link_reason: 'No existing graph nodes.' } },
        { name: 'luker_rpg_extract_done', arguments: {} },
    ] };
}

// Hold transport, not application behavior. The real retry reaches the real
// endpoint after the toast assertion; no DOM observer or product code is installed.
async function holdSecondToolRequest(page, toolName) {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    let requests = 0;
    await page.route('**/api/backends/chat-completions/generate', async route => {
        if (toolNamesOf(route.request().postDataJSON()).includes(toolName)) {
            requests += 1;
            if (requests === 2) {
                entered.resolve();
                await released.promise;
            }
        }
        await route.continue();
    });
    return { entered: entered.promise, release: () => released.resolve() };
}

async function assertStoredExtraction(page, testInfo) {
    await expect(memoryGraphStatus(page)).toHaveText(FILL_DONE_STATUS);
    const download = await exportMgGraph(page);
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    // The fresh chat has the shipped greeting and the generated assistant turn.
    // Both are real extraction frames and must be stored without the invalid value.
    expect(Object.values(exported.nodes).filter(node => node.type === 'event'))
        .toEqual([
            expect.objectContaining({ seqTo: 1, fields: { summary: SUMMARY } }),
            expect.objectContaining({ seqTo: 2, fields: { summary: SUMMARY } }),
        ]);
    await closeWorkbench(page);
    await page.reload();
    await page.waitForFunction(() => performance.getEntriesByName('[init] complete').length > 0);
    await selectCharacterByName(page, 'Seraphina');
    const persistedDownload = await exportMgGraph(page);
    const persisted = JSON.parse(readFileSync(await persistedDownload.path(), 'utf8'));
    await closeWorkbench(page);
    const path = testInfo.outputPath('graph-exports.json');
    writeFileSync(path, JSON.stringify({ exported, persisted }, null, 2));
    await testInfo.attach('graph-exports', { path, contentType: 'application/json' });
    expect(persisted.nodes).toEqual(exported.nodes);
    await page.screenshot({ path: testInfo.outputPath('persisted-graph.png') });
}

test('schema-invalid extraction reports invalid output before storing the successful retry', async ({ page }, testInfo) => {
    // Removing validation-error classification must fail the visible reason,
    // even though both versions can eventually store the valid model response.
    let rounds = 0;
    mock.scriptCompletion(({ toolNames }) => {
        if (!toolNames.includes(EXTRACT_EVENT_TOOL)) return null;
        rounds += 1;
        return rounds === 1
            ? { toolCalls: [
                { name: EXTRACT_EVENT_TOOL, arguments: { summary: ['invalid summary'], links: [] } },
                { name: 'luker_rpg_extract_done', arguments: {} },
            ] }
            : completeExtraction();
    });
    const hold = await holdSecondToolRequest(page, EXTRACT_EVENT_TOOL);
    try {
        await fillMgGraph(page, { closeAfter: false });
        await hold.entered;
        const retry = page.locator('#toast-container .toast-info .toast-message').filter({ hasText: RETRY_TEXT });
        await expect(retry).toHaveCount(1);
        await expect(retry).toContainText(/result invalid|结果无效|結果無效/);
        await page.screenshot({ path: testInfo.outputPath('invalid-output-retry.png') });
    } finally {
        hold.release();
        await page.unrouteAll({ behavior: 'wait' });
    }
    await assertStoredExtraction(page, testInfo);
});

test('crawl request retry reports the request failure before completing extraction', async ({ page }, testInfo) => {
    // Removing the shared-runner retry notification must leave this real
    // request retry without the release's user-visible feedback.
    await setMgSettings(page, { extractMode: 'crawl' });
    let crawlRounds = 0;
    mock.scriptCompletion(({ toolNames }) => {
        if (toolNames.includes(CRAWL_INSPECT_TOOL)) {
            crawlRounds += 1;
            if (crawlRounds === 1) throw new Error('Crawl upstream unavailable');
            return { tool: 'luker_rpg_extract_crawl_done', arguments: {} };
        }
        if (toolNames.includes(EXTRACT_EVENT_TOOL)) return completeExtraction();
        return null;
    });
    const hold = await holdSecondToolRequest(page, CRAWL_INSPECT_TOOL);
    try {
        await fillMgGraph(page, { closeAfter: false });
        await hold.entered;
        const retry = page.locator('#toast-container .toast-info .toast-message').filter({ hasText: RETRY_TEXT });
        await expect(retry).toHaveCount(1);
        await expect(retry).toContainText(/request failed|请求失败|請求失敗/);
        await page.screenshot({ path: testInfo.outputPath('request-retry.png') });
    } finally {
        hold.release();
        await page.unrouteAll({ behavior: 'wait' });
    }
    await assertStoredExtraction(page, testInfo);
});
