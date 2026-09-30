// 连接配置请求超时 #3 — 插件复用 ConnectionManagerRequestService 时按"实际
// 使用的 profile"取值：cc 与 tc 两条分支都测。请求体必须带
// request_timeout_ms，超时后插件调用以错误结束且上游被中止。
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mock, ccProfile, tcProfile;

function selectProfile({ dataRoot, profileId }) {
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.connectionManager = s.extension_settings.connectionManager || { profiles: [], selectedProfile: null };
    s.extension_settings.connectionManager.selectedProfile = profileId;
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
}

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['plugin one', 'plugin two'] });
    mock.setStreamStall({ afterChunks: 1, stallMs: 30_000 });
    server = await startServer({ batchKey: 'generation', scenarioId: 'timeout-plugin' });
    markOnboarded({ dataRoot: server.dataRoot });
    ccProfile = appendConnectionProfile({
        dataRoot: server.dataRoot,
        baseURL: mock.baseURL,
        name: 'e2e-timeout-cc',
        api: 'custom',
        profileOverrides: { 'request-timeout': 2 },
    });
    tcProfile = appendConnectionProfile({
        dataRoot: server.dataRoot,
        baseURL: mock.baseURL,
        name: 'e2e-timeout-tc',
        mode: 'tc',
        api: 'generic',
        profileOverrides: { 'request-timeout': 2 },
    });
    selectProfile({ dataRoot: server.dataRoot, profileId: ccProfile.profileId });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('plugin cc call times out on the used profile and carries request_timeout_ms', async ({ page }) => {
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

    const result = await page.evaluate(async ({ profileId }) => {
        const { ConnectionManagerRequestService } = await import('/scripts/extensions/shared.js');
        try {
            const factory = await ConnectionManagerRequestService.sendRequest(
                profileId,
                [{ role: 'user', content: 'Hold the reef line.' }],
                128,
                { stream: true, extractData: true },
            );
            let text = '';
            for await (const snapshot of factory()) text = String(snapshot?.text || '');
            return { ok: true, text };
        } catch (err) {
            return { ok: false, message: String(err?.message || err), cause: String(err?.cause?.message || '') };
        }
    }, { profileId: ccProfile.profileId });

    expect(result.ok, `plugin call must fail with a timeout; got: ${JSON.stringify(result)}`).toBe(false);
    // Streaming generator errors surface directly (sendRequest's try/catch
    // only wraps the pre-iteration await), so check both slots of the chain.
    expect(`${result.message} ${result.cause}`).toMatch(/timed out/i);
    await expect.poll(() => abortRequests.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const withTimeout = generateBodies.filter(b => b?.luker_generation?.request_timeout_ms === 2000);
    expect(withTimeout.length).toBeGreaterThanOrEqual(1);
});

test('plugin tc call times out on the used profile and carries request_timeout_ms', async ({ page }) => {
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

    const result = await page.evaluate(async ({ profileId }) => {
        const { ConnectionManagerRequestService } = await import('/scripts/extensions/shared.js');
        try {
            const factory = await ConnectionManagerRequestService.sendRequest(
                profileId,
                'Continue the tide log.',
                128,
                { stream: true, extractData: true },
            );
            let text = '';
            for await (const snapshot of factory()) text = String(snapshot?.text || '');
            return { ok: true, text };
        } catch (err) {
            return { ok: false, message: String(err?.message || err), cause: String(err?.cause?.message || '') };
        }
    }, { profileId: tcProfile.profileId });

    expect(result.ok, `plugin tc call must fail with a timeout; got: ${JSON.stringify(result)}`).toBe(false);
    expect(`${result.message} ${result.cause}`).toMatch(/timed out/i);
    await expect.poll(() => abortRequests.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const withTimeout = textgenBodies.filter(b => b?.luker_generation?.request_timeout_ms === 2000);
    expect(withTimeout.length).toBeGreaterThanOrEqual(1);
});
