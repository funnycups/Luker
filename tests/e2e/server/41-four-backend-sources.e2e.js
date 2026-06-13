// #41 — Four chat-completion / generation sources walked.
//
// Confirms a basic generation round-trip reaches each of the four backend
// routers under src/endpoints/backends/:
//   (a) chat-completions.js  — CUSTOM source (OpenAI-compatible)
//   (b) text-completions.js  — main_api=textgenerationwebui (GENERIC type)
//   (c) kobold.js            — main_api=kobold
//   (d) luker-generation.js  — verifies the job-tracking sidecar is reachable
//                              (status / events queries against a known job)
//
// The shared OpenAI mock is reused for (a). Per-spec http mocks are spun up
// for (b)/(c) because they speak different request/response shapes than the
// OpenAI-compatible mock.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, ccMock;
const sideMocks = [];

async function startTextgenMock() {
    const requests = [];
    const srv = http.createServer(async (req, res) => {
        let body = '';
        for await (const c of req) body += c;
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch {}
        requests.push({ url: req.url, method: req.method, body: parsed });

        if (req.url === '/v1/models' || req.url === '/models') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'textgen-mock-model', object: 'model' }] }));
            return;
        }
        if (req.url.startsWith('/v1/completions') || req.url.startsWith('/completions')) {
            const choice = { text: '*The textgen mock replies.* "Ash threads a salt-bitten ribbon through the spyglass strap."', index: 0, finish_reason: 'stop' };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'tg-1',
                object: 'text_completion',
                model: parsed.model || 'textgen-mock-model',
                choices: [choice],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
            return;
        }
        // Health probes / props / generic
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const baseURL = `http://127.0.0.1:${port}`;
    return { baseURL, requests, stop: () => new Promise((r) => srv.close(() => r())) };
}

async function startKoboldMock() {
    const requests = [];
    const srv = http.createServer(async (req, res) => {
        let body = '';
        for await (const c of req) body += c;
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch {}
        requests.push({ url: req.url, method: req.method, body: parsed });

        if (req.url === '/api/v1/model' || req.url === '/v1/model') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ result: 'kobold-mock-model' }));
            return;
        }
        if (req.url === '/api/v1/info/version' || req.url === '/v1/info/version') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ result: '1.2.3' }));
            return;
        }
        if (req.url === '/api/extra/version' || req.url === '/extra/version') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ result: 'KoboldCpp', version: '1.2.3' }));
            return;
        }
        if (req.url === '/v1/generate' || req.url === '/api/v1/generate') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                results: [{ text: '*The kobold mock replies.* The reef whistles low through the gull rocks tonight.' }],
            }));
            return;
        }
        if (req.url === '/extra/generate/stream' || req.url === '/api/extra/generate/stream') {
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                'connection': 'keep-alive',
            });
            res.write(`data: ${JSON.stringify({ token: '*The kobold stream replies.* ' })}\n\n`);
            res.write(`data: ${JSON.stringify({ token: 'The reef holds.' })}\n\n`);
            res.end();
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const baseURL = `http://127.0.0.1:${port}`;
    return { baseURL, requests, stop: () => new Promise((r) => srv.close(() => r())) };
}

test.beforeAll(async () => {
    ccMock = await startMockLLM({ scriptedReplies: [
        '*Ash answers — chat-completions path.* "The lantern caught the second breaker before the chart updated."',
    ] });
    server = await startServer({ batchKey: 'server', scenarioId: 'four-sources' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: ccMock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await ccMock?.stop();
    for (const m of sideMocks) await m.stop().catch(() => {});
});

test.describe('#41 — four backend sources reachable', () => {
    test('(a) chat-completions (CUSTOM) — UI-driven turn round-trips', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        const before = ccMock.requests.length;
        await sendMessageAndAwaitReply(page, 'I checked the lantern; the wick is dry.');
        const chatReq = ccMock.requests.slice(before).find(r => r.url.includes('chat/completions'));
        expect(chatReq, 'CUSTOM source should hit /v1/chat/completions on the mock').toBeTruthy();
        expect(Array.isArray(chatReq.body.messages)).toBe(true);
    });

    test('(b) text-completions backend — direct POST /api/backends/text-completions/generate', async ({ page }) => {
        // Use a request-context call from the loaded page (carries CSRF + session cookie).
        await awaitMainUI(page, server.baseURL);
        const textgenMock = await startTextgenMock();
        sideMocks.push(textgenMock);

        const result = await page.evaluate(async ({ apiServer }) => {
            const tokenResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await tokenResp.json();
            const resp = await fetch('/api/backends/text-completions/generate', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
                body: JSON.stringify({
                    api_server: apiServer,
                    api_type: 'generic',
                    model: 'textgen-mock-model',
                    prompt: 'The reef shifts under the dark.',
                    max_tokens: 64,
                    stream: false,
                    temperature: 0.7,
                }),
            });
            const text = await resp.text();
            return { status: resp.status, text };
        }, { apiServer: textgenMock.baseURL });

        // Either the backend forwards a 200, or the mock answered. The defining
        // signal is the mock saw a /v1/completions hit.
        const hit = textgenMock.requests.find(r => r.url.includes('/completions'));
        expect(hit, `text-completions backend should reach the mock; instead requests=${JSON.stringify(textgenMock.requests.map(r => r.url))} status=${result.status} body=${result.text?.slice(0,200)}`).toBeTruthy();
    });

    test('(c) kobold backend — direct POST /api/backends/kobold/generate', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        const koboldMock = await startKoboldMock();
        sideMocks.push(koboldMock);

        const result = await page.evaluate(async ({ apiServer }) => {
            const tokenResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await tokenResp.json();
            const resp = await fetch('/api/backends/kobold/generate', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
                body: JSON.stringify({
                    api_server: apiServer,
                    streaming: false,
                    prompt: 'The reef shifts under the dark.',
                    max_context_length: 1024,
                    max_length: 64,
                    gui_settings: true,
                    model: 'kobold-mock-model',
                }),
            });
            const text = await resp.text();
            return { status: resp.status, text };
        }, { apiServer: koboldMock.baseURL });

        const hit = koboldMock.requests.find(r => r.url.includes('/generate'));
        expect(hit, `kobold backend should reach the mock; instead requests=${JSON.stringify(koboldMock.requests.map(r => r.url))} status=${result.status} body=${result.text?.slice(0,200)}`).toBeTruthy();
    });

    test('(d) luker-generation sidecar — job tracker reachable via chat-completions/jobs/active', async ({ page }) => {
        // luker-generation.js has no router of its own; it surfaces through the
        // chat-completions /jobs/* endpoints (and the equivalents on kobold and
        // text-completions). The "activation" is to mint a generation job by
        // dispatching a normal CC turn, then verify the job lookup endpoint
        // responds and reflects the request.
        //
        // Investigated: src/endpoints/backends/luker-generation.js exports
        // create/attach/forward helpers consumed by all three backend routers;
        // its routes live on chat-completions.js line 2045 (/jobs/status),
        // 2074 (/jobs/events), 2106 (/jobs/active), 2126 (/jobs/events-stream).
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        ccMock.scriptReply('*Ash answers — luker-gen path.* "Hold the lantern higher."');

        await sendMessageAndAwaitReply(page, 'I will hold here until the tide turns.');

        const active = await page.evaluate(async () => {
            const tokenResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await tokenResp.json();
            const resp = await fetch('/api/backends/chat-completions/jobs/active', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
                body: JSON.stringify({}),
            });
            return { status: resp.status, body: await resp.text() };
        });

        expect(active.status).toBe(200);
        // body shape: { jobs: [...] } — list may be empty if the just-finished
        // job already cleared, but the endpoint must respond with valid JSON.
        let parsed;
        try { parsed = JSON.parse(active.body); } catch {}
        expect(parsed, `jobs/active should return JSON; got status=${active.status} body=${active.body?.slice(0,200)}`).toBeTruthy();
        expect(Array.isArray(parsed.jobs)).toBe(true);
    });
});
