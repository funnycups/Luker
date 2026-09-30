// 连接配置请求超时 #5 — 主聊天 text completion 流式路径
// (generateTextGenWithStreaming 注入)。TC profile 的 request-timeout 生效。
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { appendConnectionProfile, bootstrapTextgenMain, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['first beacon lantern stays lit while the tide turns and the reef whispers back to us'] });
    mock.setStreamStall({ afterChunks: 1, stallMs: 30_000 });
    server = await startServer({ batchKey: 'generation', scenarioId: 'timeout-tc-stream' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapTextgenMain({ dataRoot: server.dataRoot, baseURL: mock.baseURL, streaming: true });
    appendConnectionProfile({
        dataRoot: server.dataRoot,
        baseURL: mock.baseURL,
        name: 'e2e-timeout-tc-main',
        mode: 'tc',
        api: 'generic',
        profileOverrides: { 'request-timeout': 2 },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('main text-completion streaming gap beyond the profile timeout aborts generation', async ({ page }) => {
    test.setTimeout(120_000);
    const abortRequests = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('/api/generation/') && url.endsWith('/abort') && req.method() === 'POST') abortRequests.push(url);
    });

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    await page.locator('#send_textarea').fill('Log the reef line before the turn, slowly.');
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.querySelector('#send_but').click());

    await page.waitForFunction(() => {
        const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
        for (const b of bubbles) {
            if ((b.querySelector('.mes_text')?.innerText || '').includes('first')) return true;
        }
        return false;
    }, { timeout: 20_000 });

    await expect.poll(() => abortRequests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    expect(abortRequests[0]).toMatch(/\/api\/generation\/[0-9a-f-]{8,}\/abort$/i);
    await page.waitForFunction(() => {
        const el = document.querySelector('#send_but');
        return !!el && !el.classList.contains('displayNone');
    }, { timeout: 15_000 });

    const textgenCalls = mock.requests.filter(r => (r.url || '').endsWith('/completions') && !(r.url || '').includes('/chat/completions'));
    expect(textgenCalls.length).toBe(1);
});
