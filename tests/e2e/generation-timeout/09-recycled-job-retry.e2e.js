// 连接配置请求超时 #9 — 超时重试复用同一 job_id 时，服务端必须清空上一轮
// 的流状态。否则重试的 `resume from_seq: 1` 会回放上一轮 abort 的
// error/trailer 帧，客户端把上一轮的失败当成重试的结果；上一轮的上游请求
// 也会因 AbortController 只被置空而继续并发运行。
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server, mock;

const REPLY = 'the second beacon answers once the tide settles over the reef line';

test.beforeAll(async () => {
    let chatCalls = 0;
    mock = await startMockLLM({
        scriptedReplies: [REPLY],
        // 首次上游调用挂起（触发 profile 超时），重试立即返回。
        latencyMs: (req) => {
            if (!(req.url || '').includes('/chat/completions')) return 0;
            chatCalls += 1;
            return chatCalls === 1 ? 600_000 : 0;
        },
    });
    server = await startServer({ batchKey: 'generation', scenarioId: 'recycled-job-retry' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream: true });
    appendConnectionProfile({
        dataRoot: server.dataRoot,
        baseURL: mock.baseURL,
        name: 'e2e-recycled-job-retry',
        profileOverrides: { 'request-timeout': 2, 'max-request-retries': 1 },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('the retry after a timeout does not replay the previous attempt abort', async ({ page }) => {
    test.setTimeout(180_000);

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    await page.locator('#send_textarea').fill('Chart the reef line before dawn.');
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.querySelector('#send_but').click());

    // 重试必须拿到自己的结果，而不是上一轮 abort 回放的 error 帧。
    await page.waitForFunction((needle) => {
        const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
        for (const b of bubbles) {
            if ((b.querySelector('.mes_text')?.innerText || '').includes(needle)) return true;
        }
        return false;
    }, REPLY, { timeout: 30_000 });

    // 该生成共 2 次上游调用（1 初次超时 + 1 重试）。mock 位于服务端之后，
    // 只统计带本次提示词的上游调用，排除测试数据里插件产生的后台调用。
    const normalCalls = mock.requests.filter(r =>
        (r.url || '').includes('/chat/completions')
        && JSON.stringify(r.body?.messages || []).includes('Chart the reef line before dawn.'));
    expect(normalCalls).toHaveLength(2);
});
