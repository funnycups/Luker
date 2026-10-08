// 连接配置请求超时 #10 — 超时重试复用同一 job_id 时，服务端不得同时运行两个
// 上游请求。旧实现里，靠回放的陈旧 error 帧快速失败的那次重试不会发 abort，
// 下一次重试回收 job 时又只把上一轮的 AbortController 置空而不 abort，于是
// 上一轮的上游请求被遗弃并继续与新请求并发运行。
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    // 所有上游调用都挂起，让每次尝试都停留在进行中，便于观测并发。
    mock = await startMockLLM({
        scriptedReplies: ['never used'],
        latencyMs: 600_000,
    });
    server = await startServer({ batchKey: 'generation', scenarioId: 'no-concurrent-upstream' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream: true });
    appendConnectionProfile({
        dataRoot: server.dataRoot,
        baseURL: mock.baseURL,
        name: 'e2e-no-concurrent-upstream',
        profileOverrides: { 'request-timeout': 3, 'max-request-retries': 2 },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('a timed-out retry never runs concurrently with the previous attempt upstream', async ({ page }) => {
    test.setTimeout(120_000);

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});
    await page.locator('#send_textarea').fill('Chart the reef line before dawn.');
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.querySelector('#send_but').click());

    // 覆盖初次尝试加两次重试的超时周期。
    await page.waitForTimeout(20_000);

    expect(mock.requests.filter(r => (r.url || '').includes('/chat/completions')).length).toBeGreaterThanOrEqual(2);
    expect(mock.getMaxConcurrentChatRequests()).toBe(1);
});
