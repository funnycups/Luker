// DeepSeek deprecated penalties — full-chain e2e over the DeepSeek source.
//
// The DeepSeek chat-completions API marks presence_penalty and frequency_penalty
// as deprecated: "It will not take effect if you pass it to the API"
// (https://api-docs.deepseek.com/api/create-chat-completion). So the client
// hides both controls and drops the two keys from the outgoing body, while
// temperature and top_p survive. This drives a real send through the DeepSeek
// provider and asserts both the client body and the upstream wire body.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapDeepseekBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

const MOCK_REPLY = 'The kelp line runs west of the buoy; we drift the nets there before the ebb.';

let server;
let mock;

/** The last chat-completions request the mock received. */
function lastChatRequest() {
    return [...mock.requests].reverse().find(r => r.url.endsWith('/chat/completions'));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [MOCK_REPLY, MOCK_REPLY] });
    server = await startServer({ scope, batchKey: 'generation', scenarioId: 'deepseek-sampling-params' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapDeepseekBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, model: 'deepseek-v4-pro' });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe.serial('DeepSeek deprecated penalties', () => {
    test('request body drops frequency_penalty and presence_penalty', async ({ page }) => {
        test.setTimeout(120_000);
        // Capture the client's own POST body — that is where the drop happens.
        const posted = [];
        page.on('request', req => {
            if (req.url().includes('/chat-completions/generate')) {
                try { posted.push(JSON.parse(req.postData() || '{}')); } catch { /* non-JSON */ }
            }
        });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await sendMessageAndAwaitReply(page, 'Which way does the ebb run past the buoy?');

        const clientBody = posted[posted.length - 1];
        expect(clientBody, 'no /chat-completions/generate request was captured').toBeTruthy();
        expect(clientBody.chat_completion_source).toBe('deepseek');
        expect(clientBody.temperature).toBeDefined();
        expect(clientBody.top_p).toBeDefined();
        expect(clientBody.frequency_penalty).toBeUndefined();
        expect(clientBody.presence_penalty).toBeUndefined();

        // End-to-end: the provider forwards penalties verbatim, so their absence
        // upstream confirms the client dropped them; the surviving params prove
        // the request carried the baseline the fixture set.
        const gen = lastChatRequest();
        expect(gen, 'no /chat/completions request was recorded').toBeTruthy();
        const body = gen.body || {};
        expect(body.model).toBe('deepseek-v4-pro');
        expect(Array.isArray(body.messages)).toBe(true);
        expect(body.temperature).toBe(0.7);
        expect(body.top_p).toBe(0.9);
        expect(body.frequency_penalty).toBeUndefined();
        expect(body.presence_penalty).toBeUndefined();
    });
});
