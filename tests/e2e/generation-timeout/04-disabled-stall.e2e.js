// 连接配置请求超时 #4 — 0/缺省 = 禁用回归：profile 没配超时，上游静默时
// 请求必须无限等待（不引入任何默认超时）；手动"停止生成"仍然工作。
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, abortGenerationViaUI } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['first beacon lantern stays lit while the tide turns'] });
    mock.setStreamStall({ afterChunks: 1, stallMs: 30_000 });
    server = await startServer({ batchKey: 'generation', scenarioId: 'timeout-disabled' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, name: 'e2e-no-timeout' });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('a profile without request-timeout never times out on its own; manual stop still works', async ({ page }) => {
    test.setTimeout(120_000);
    const abortRequests = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('/api/generation/') && url.endsWith('/abort') && req.method() === 'POST') abortRequests.push(url);
    });

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    await page.locator('#send_textarea').fill('Describe the fog bank and take your time.');
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.querySelector('#send_but').click());

    await page.waitForFunction(() => {
        const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
        for (const b of bubbles) {
            if ((b.querySelector('.mes_text')?.innerText || '').includes('first')) return true;
        }
        return false;
    }, { timeout: 20_000 });

    // 静默 5s（远超一个"如果将错就错"的超时窗口）后仍在生成，且没有 abort。
    await page.waitForTimeout(5_000);
    expect(abortRequests.length, 'disabled timeout must not abort').toBe(0);
    const stopVisible = await page.evaluate(() => {
        const stop = document.querySelector('#mes_stop');
        return !!stop && getComputedStyle(stop).display !== 'none';
    });
    expect(stopVisible, 'generation should still be running while stalled').toBe(true);

    // 用户手动中止仍走原通路。
    await abortGenerationViaUI(page);
    await expect.poll(() => abortRequests.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await page.waitForFunction(() => {
        const el = document.querySelector('#send_but');
        return !!el && !el.classList.contains('displayNone');
    }, { timeout: 15_000 });
});
