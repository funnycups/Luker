// 连接配置请求超时 #6 — 主聊天 text completion 非流式路径
// (script.js#sendGenerationRequest 通用分支注入)。上游延迟 > 超时 → pre-head 抛出。
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { appendConnectionProfile, bootstrapTextgenMain, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*Ash checks the chart twice.*'], latencyMs: 8_000 });
    server = await startServer({ batchKey: 'generation', scenarioId: 'timeout-tc-nonstream' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapTextgenMain({ dataRoot: server.dataRoot, baseURL: mock.baseURL, streaming: false });
    appendConnectionProfile({
        dataRoot: server.dataRoot,
        baseURL: mock.baseURL,
        name: 'e2e-timeout-tc-ns',
        mode: 'tc',
        api: 'generic',
        profileOverrides: { 'request-timeout': 2 },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('main text-completion non-stream wait beyond the profile timeout aborts before head', async ({ page }) => {
    test.setTimeout(120_000);
    const abortRequests = [];
    const textgenBodies = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('/api/generation/') && url.endsWith('/abort') && req.method() === 'POST') abortRequests.push(url);
        if (url.includes('/api/backends/text-completions/generate') && req.method() === 'POST') {
            try { textgenBodies.push(JSON.parse(req.postData() || '{}')); } catch { textgenBodies.push({}); }
        }
    });

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    await page.locator('#send_textarea').fill('Chart the reef line before dawn, no streaming.');
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.querySelector('#send_but').click());

    await expect.poll(() => abortRequests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    expect(abortRequests[0]).toMatch(/\/api\/generation\/[0-9a-f-]{8,}\/abort$/i);
    const withTimeout = textgenBodies.filter(b => b?.luker_generation?.request_timeout_ms === 2000);
    expect(withTimeout.length).toBeGreaterThanOrEqual(1);
    await page.waitForFunction(() => {
        const el = document.querySelector('#send_but');
        return !!el && !el.classList.contains('displayNone');
    }, { timeout: 15_000 });
});
