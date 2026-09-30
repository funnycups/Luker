// 连接配置请求超时 #2 — 非流式：上游迟迟不响应，在"最终出字"之前超时。
// latencyMs(8s) > profile 超时(2s) → head 未解析 → fetch 抛出 TimeoutError；
// 请求体必须携带 request_timeout_ms；客户端发 abort；不重试（max-retries=0）。
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: ['*Ash checks the chart twice before answering.*'],
        latencyMs: 8_000,
    });
    server = await startServer({ batchKey: 'generation', scenarioId: 'timeout-nonstream' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream: false });
    appendConnectionProfile({
        dataRoot: server.dataRoot,
        baseURL: mock.baseURL,
        name: 'e2e-timeout-ns',
        profileOverrides: { 'request-timeout': 2 },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('non-streaming wait beyond the profile timeout aborts before any head frame', async ({ page }) => {
    test.setTimeout(120_000);
    const abortRequests = [];
    const generateBodies = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('/api/generation/') && url.endsWith('/abort') && req.method() === 'POST') abortRequests.push(url);
        if (url.includes('/api/backends/chat-completions/generate') && req.method() === 'POST') {
            try { generateBodies.push(JSON.parse(req.postData() || '{}')); } catch { generateBodies.push({}); }
        }
    });

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    await page.locator('#send_textarea').fill('Chart the reef line before dawn, no streaming.');
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.querySelector('#send_but').click());

    await expect.poll(() => abortRequests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(500);
    expect(abortRequests[0]).toMatch(/\/api\/generation\/[0-9a-f-]{8,}\/abort$/i);

    // 协议断言：请求体带上了 profile 的超时值（2000ms）。
    const withTimeout = generateBodies.filter(b => b?.luker_generation?.request_timeout_ms === 2000);
    expect(withTimeout.length).toBeGreaterThanOrEqual(1);

    // max-retries 未配置（0）→ 单次上游调用，不重试。
    const chatCalls = mock.requests.filter(r => (r.url || '').includes('/chat/completions'));
    expect(chatCalls.length).toBe(1);

    // 生成已解绑。
    await page.waitForFunction(() => {
        const el = document.querySelector('#send_but');
        return !!el && !el.classList.contains('displayNone');
    }, { timeout: 15_000 });
});
