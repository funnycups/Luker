// generation-basic #1 — happy-path streaming generation over the new
// transport-agnostic dispatch layer.
//
// Under the ws-delivery fetch proxy every POST to
// `/api/backends/chat-completions/generate` returns HTTP 200 + a
// `x-luker-generation-id` header immediately; the actual streaming
// payload arrives out-of-band on the `/api/ws-delivery` WebSocket.
//
// Asserts the full loop:
//   1. HTTP POST returned 200 + carries `x-luker-generation-id`.
//   2. A WebSocket was opened to `/api/ws-delivery`.
//   3. The scripted mock reply is rendered into the assistant bubble.
//   4. The chat.jsonl on disk contains the user + assistant turns.

import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    getRenderedChatTexts,
} from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        'Hello from mock LLM. This is a test reply.',
    ] });
    server = await startServer({ batchKey: 'generation', scenarioId: 'basic' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('generation-basic: HTTP 200 + x-luker-generation-id + ws-delivery stream + persisted chat.jsonl', async ({ page }) => {
    // Capture every WS the page opens so we can prove ws-delivery is used.
    const wsOpens = [];
    page.on('websocket', (ws) => { wsOpens.push(ws.url()); });

    // Capture the /generate HTTP response so we can assert status + header.
    const generateResponses = [];
    page.on('response', (resp) => {
        const url = resp.url();
        if (url.includes('/api/backends/chat-completions/generate')) {
            generateResponses.push({
                status: resp.status(),
                generationId: resp.headers()['x-luker-generation-id'] || '',
                url,
            });
        }
    });

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    // Wait for the greeting first_mes to land so the reply we assert on
    // is unambiguously the /generate response.
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    const userText = 'Please respond with the test greeting.';
    const { replyId, text: replyText } = await sendMessageAndAwaitReply(page, userText);

    // (3) DOM primary: the mock reply is rendered into the bubble.
    expect(replyText).toContain('Hello from mock LLM');
    const rendered = await getRenderedChatTexts(page);
    expect(rendered[replyId]).toBe(replyText);

    // (1) HTTP contract.
    expect(generateResponses.length, 'a POST to /api/backends/chat-completions/generate should have fired').toBeGreaterThan(0);
    const genResp = generateResponses.at(-1);
    expect(genResp.status).toBe(200);
    expect(genResp.generationId, 'x-luker-generation-id must be present on the /generate response').toMatch(/^[0-9a-f-]{8,}/i);

    // (2) A WebSocket to /api/ws-delivery was opened.
    const deliveryWs = wsOpens.find(u => u.includes('/api/ws-delivery'));
    expect(deliveryWs, `expected a ws to /api/ws-delivery; observed: ${JSON.stringify(wsOpens)}`).toBeTruthy();

    // (4) chat.jsonl on disk contains both the user and assistant turns.
    const avatarFolder = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        const c = ctx.characters[ctx.characterId];
        return (c?.avatar || '').replace(/\.png$/, '');
    });
    const chatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
    const jsonlPath = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder, `${chatId}.jsonl`);
    expect(existsSync(jsonlPath), `expected chat file at ${jsonlPath}`).toBe(true);
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const userLine = lines.find(o => o.is_user && String(o.mes || '').includes('test greeting'));
    const asstLine = lines.find(o => !o.is_user && String(o.mes || '').includes('Hello from mock LLM'));
    expect(userLine, 'user turn should be persisted').toBeTruthy();
    expect(asstLine, 'assistant reply should be persisted').toBeTruthy();
});
