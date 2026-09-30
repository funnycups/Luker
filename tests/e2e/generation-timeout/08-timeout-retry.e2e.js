// 连接配置请求超时 #8 — 超时错误是网络类抛出错误，参与 profile 的
// max-request-retries：非流式 + max-retries=1 时，上游应收到 2 次调用
// （首次超时 → backoff → 重试再超时 → 最终失败）。
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*Ash checks the chart twice.*'], latencyMs: 6_000 });
    server = await startServer({ batchKey: 'generation', scenarioId: 'timeout-retry' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream: false });
    appendConnectionProfile({
        dataRoot: server.dataRoot,
        baseURL: mock.baseURL,
        name: 'e2e-timeout-retry',
        profileOverrides: { 'request-timeout': 1, 'max-request-retries': 1 },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('a timed-out request is retried under the profile retry policy', async ({ page }) => {
    test.setTimeout(180_000);
    const abortRequests = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('/api/generation/') && url.endsWith('/abort') && req.method() === 'POST') abortRequests.push(url);
    });

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    await page.locator('#send_textarea').fill('Chart the reef line before dawn, no streaming.');
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.querySelector('#send_but').click());

    // 首次尝试 1s 超时 → backoff（≥1s）→ 重试再 1s 超时 → 共 2 次上游调用。
    await expect.poll(
        () => mock.requests.filter(r => (r.url || '').includes('/chat/completions')).length,
        { timeout: 30_000 },
    ).toBe(2);
    await expect.poll(() => abortRequests.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    await page.waitForFunction(() => {
        const el = document.querySelector('#send_but');
        return !!el && !el.classList.contains('displayNone');
    }, { timeout: 20_000 });
});
