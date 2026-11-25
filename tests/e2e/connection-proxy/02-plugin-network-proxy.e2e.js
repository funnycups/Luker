// Connection profile network proxy — plugin request path.
//
// ConnectionManagerRequestService builds its own chat-completion payload
// instead of going through openai.js. This test proves the profile's
// network-proxy field reaches that payload and the outbound request traverses
// the recording proxy.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { startRecordingProxy } from '../_lib/recording-proxy.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mock, proxy;
const PROFILE_NAME = 'e2e-plugin-network-proxy';
const REPLY = 'The plugin relay reached the far lantern.';

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [REPLY] });
    proxy = await startRecordingProxy();
    server = await startServer({ scope, batchKey: 'generation', scenarioId: 'plugin-network-proxy' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({
        dataRoot: server.dataRoot,
        baseURL: mock.baseURL,
        name: PROFILE_NAME,
        api: 'custom',
        profileOverrides: { 'network-proxy': proxy.baseURL },
    });
});

test.afterAll(async () => {
    await proxy?.stop();
    await mock?.stop();
});

test('ConnectionManagerRequestService carries the profile network proxy', async ({ page }) => {
    test.setTimeout(120_000);
    await awaitMainUI(page, server.baseURL);

    const result = await page.evaluate(async ({ profileName }) => {
        const { ConnectionManagerRequestService } = await import('/scripts/extensions/shared.js');
        const profile = window.Luker.getContext().extensionSettings.connectionManager.profiles
            .find(candidate => candidate.name === profileName);
        if (!profile) return { ok: false, error: `profile not found: ${profileName}` };

        try {
            const response = await ConnectionManagerRequestService.sendRequest(
                profile.id,
                [{ role: 'user', content: 'Relay the tide reading.' }],
                128,
                { stream: false, extractData: true },
            );
            return { ok: true, content: response?.content || '' };
        } catch (error) {
            return { ok: false, error: String(error?.message || error) };
        }
    }, { profileName: PROFILE_NAME });

    expect(result.ok, `plugin call failed: ${result.error}`).toBe(true);
    expect(result.content).toContain('plugin relay reached the far lantern');

    const chatHits = proxy.requests.filter(request => request.url.includes('/v1/chat/completions'));
    expect(chatHits.length, `expected the plugin request to traverse the proxy; observed=${JSON.stringify(proxy.requests)}`).toBeGreaterThan(0);
});
