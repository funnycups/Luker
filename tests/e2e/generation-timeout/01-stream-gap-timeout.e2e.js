// 连接配置请求超时 #1 — 流式 chunk 间隔超过 profile 超时。
// head + 第一个 chunk 已到，上游随后静默；ws-delivery 的惰性定时器到点
// 抛 TimeoutError，客户端发 abort 通知，服务端 job 被取消，无幽灵持久化。
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, getChatSnapshot } from '../_lib/page.js';

let server, mock;

const REPLY = 'first beacon lantern stays lit while the tide turns and the reef whispers back to us';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [REPLY] });
    mock.setStreamStall({ afterChunks: 1, stallMs: 30_000 });
    server = await startServer({ batchKey: 'generation', scenarioId: 'timeout-stream-gap' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({
        dataRoot: server.dataRoot,
        baseURL: mock.baseURL,
        name: 'e2e-timeout',
        profileOverrides: { 'request-timeout': 2 },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('streaming chunk gap beyond the profile timeout aborts generation and cancels the server job', async ({ page }) => {
    test.setTimeout(120_000);
    const abortRequests = [];
    const abortResponses = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('/api/generation/') && url.endsWith('/abort') && req.method() === 'POST') abortRequests.push(url);
    });
    page.on('response', (resp) => {
        const url = resp.url();
        if (url.includes('/api/generation/') && url.endsWith('/abort')) abortResponses.push(resp.status());
    });

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    await page.locator('#send_textarea').fill('The lantern needs another turn before the tide shifts.');
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.querySelector('#send_but').click());

    // 首批输出到达（证明流已开始），随后 mock 静默。
    await page.waitForFunction(() => {
        const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
        for (const b of bubbles) {
            if ((b.querySelector('.mes_text')?.innerText || '').includes('first')) return true;
        }
        return false;
    }, { timeout: 20_000 });

    // 2s profile 超时到点 → 客户端 abort 通知（HTTP），不必等 30s 静默结束。
    await expect.poll(() => abortRequests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(500);

    expect(abortRequests[0]).toMatch(/\/api\/generation\/[0-9a-f-]{8,}\/abort$/i);
    expect(abortResponses.length).toBeGreaterThanOrEqual(1);
    expect(abortResponses[0]).toBeGreaterThanOrEqual(200);
    expect(abortResponses[0]).toBeLessThan(300);

    // 生成已解绑：发送按钮回来。
    await page.waitForFunction(() => {
        const el = document.querySelector('#send_but');
        return !!el && !el.classList.contains('displayNone');
    }, { timeout: 15_000 });

    // 上游只收到一次调用（流已开始 → 超时属于 post-head，不触发重试）。
    const chatCalls = mock.requests.filter(r => (r.url || '').includes('/chat/completions'));
    expect(chatCalls.length).toBe(1);

    // 无幽灵回复：静默之后的词不可能出现在任何 assistant 消息里。
    const snapshot = await getChatSnapshot(page);
    const assistantTexts = (snapshot.messages || []).filter(m => !m.is_user).map(m => String(m.mes || '')).join('\n');
    expect(assistantTexts).not.toContain('whispers');
});
