// 连接配置请求超时 #7 — 真实 UI 路径：Advanced 抽屉里给选中 profile 设置
// request-timeout，落盘持久化，刷新后仍在；随后该超时真实触发 abort。
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, closeAnyOpenTopSettingsDrawer, openInlineDrawer, reloadAndAwait } from '../_lib/page.js';

let server, mock;

/**
 * 打开连接配置编辑器所在面板并展开 Advanced 内联抽屉。
 * 真实用户路径：顶部插头图标 (#API-status-top) 打开 API Connections
 * 抽屉 → 点 Advanced 标题。连接配置不在 Extensions 抽屉里。
 */
async function openAdvancedProfileSettings(page) {
    const apiBlock = page.locator('#rm_api_block');
    const isApiOpen = await apiBlock.evaluate(el => el.classList.contains('openDrawer')).catch(() => false);
    if (!isApiOpen) {
        await page.locator('#API-status-top').click();
        await page.waitForFunction(() => document.getElementById('rm_api_block')?.classList.contains('openDrawer'), null, { timeout: 10_000 });
    }
    await openInlineDrawer(page, 'rm_api_block');
}

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['first beacon lantern stays lit while the tide turns'] });
    mock.setStreamStall({ afterChunks: 1, stallMs: 30_000 });
    server = await startServer({ batchKey: 'generation', scenarioId: 'timeout-ui' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, name: 'e2e-ui-timeout' });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('setting request timeout in the Advanced drawer persists and drives a real abort', async ({ page }) => {
    test.setTimeout(180_000);
    const abortRequests = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('/api/generation/') && url.endsWith('/abort') && req.method() === 'POST') abortRequests.push(url);
    });

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');

    // 走真实 UI：API Connections 抽屉 → connection manager Advanced 抽屉。
    await openAdvancedProfileSettings(page);
    const input = page.locator('#connection_profile_request_timeout');
    await input.waitFor({ state: 'attached', timeout: 10_000 });
    await page.locator('#connection_profile_request_timeout_block').scrollIntoViewIfNeeded();
    await input.fill('2');
    await input.dispatchEvent('change');

    // saveSettingsDebounced 落盘后，settings.json 的 profile 必须带值。
    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    await expect.poll(() => {
        const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
        const profile = (s.extension_settings?.connectionManager?.profiles || []).find(p => p.name === 'e2e-ui-timeout');
        return profile?.['request-timeout'];
    }, { timeout: 10_000 }).toBe(2);

    // 关闭抽屉后发消息：2s 静默 → abort。
    await closeAnyOpenTopSettingsDrawer(page);
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});
    await page.locator('#send_textarea').fill('Log the fog bank before the turn shifts.');
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.querySelector('#send_but').click());
    await expect.poll(() => abortRequests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

    // 重启 + 刷新：值仍在盘上，输入框回显 2。
    await server.restart();
    await reloadAndAwait(page, server.baseURL);
    await openAdvancedProfileSettings(page);
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const persistedProfile = (persisted.extension_settings?.connectionManager?.profiles || []).find(p => p.name === 'e2e-ui-timeout');
    expect(persistedProfile?.['request-timeout']).toBe(2);
    await expect(page.locator('#connection_profile_request_timeout')).toHaveValue('2');

    // 清空为 0：监听器删除 request-timeout 键，落盘后 profile 上不再有这个 key。
    await input.fill('0');
    await input.dispatchEvent('change');
    await expect.poll(() => {
        const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
        const profile = (s.extension_settings?.connectionManager?.profiles || []).find(p => p.name === 'e2e-ui-timeout');
        return profile ? Object.hasOwn(profile, 'request-timeout') : true;
    }, { timeout: 10_000 }).toBe(false);
});
