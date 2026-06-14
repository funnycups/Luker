// #2 — Streaming vs non-streaming flips
//
// Two scenarios in one file:
//   a) stream_openai=true  → bubble grows over multiple ticks
//   b) stream_openai=false → bubble appears in a single tick
//
// The shared mockLLM streams its chunks back-to-back with no inter-chunk
// pause, which is too fast for a 100ms sampler to catch intermediate
// states. For the streaming-on scenario we spin up an inline SSE server
// with explicit per-chunk delays so we can observe the bubble growing.
// Non-streaming uses the standard mock.

import http from 'node:http';
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LONG_REPLY = '*Seraphina watches the dark line of the breakers and speaks slowly, as if drawing each phrase off the tide.* "The reef holds. The lantern holds. The path holds. We walk it again before the night turns."';

function patchStreamFlag(dataRoot, on) {
    const sp = resolve(dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.stream_openai = !!on;
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

/**
 * A streaming OpenAI-compatible mock that pauses chunkDelayMs between
 * every SSE frame. Each frame is one word (mirrors the shared mockLLM).
 */
async function startSlowStreamMock({ chunkDelayMs = 80 } = {}) {
    let replyText = LONG_REPLY;
    const server = http.createServer(async (req, res) => {
        if (req.url.endsWith('/models') || req.url.endsWith('/v1/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'slow-stream', object: 'model' }] }));
            return;
        }
        if (req.url.endsWith('/chat/completions') || req.url.endsWith('/v1/chat/completions')) {
            // Read body (we don't need it) so the request closes.
            let body = '';
            for await (const chunk of req) body += chunk;
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                'connection': 'keep-alive',
            });
            const words = replyText.split(/\s+/);
            for (const w of words) {
                const piece = (words.indexOf(w) === 0 ? '' : ' ') + w;
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, finish_reason: null }] })}\n\n`);
                await new Promise(r => setTimeout(r, chunkDelayMs));
            }
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    return { port, baseURL: `http://127.0.0.1:${port}/v1`, stop: () => new Promise(r => server.close(() => r())) };
}

async function captureGrowthCurve(page, { samplePeriodMs = 80, maxSamples = 120 } = {}) {
    return page.evaluate(async ({ samplePeriodMs, maxSamples }) => {
        const ctx = window.Luker.getContext();
        const startLen = ctx.chat.length;
        const samples = [];
        let assistantIdx = -1;
        const startTs = performance.now();
        return await new Promise((resolve) => {
            let done = false;
            const intervalId = setInterval(() => {
                if (done) return;
                const elapsed = performance.now() - startTs;
                if (assistantIdx < 0) {
                    for (let i = startLen; i < ctx.chat.length; i++) {
                        if (!ctx.chat[i]?.is_user) { assistantIdx = i; break; }
                    }
                }
                if (assistantIdx >= 0) {
                    const m = ctx.chat[assistantIdx];
                    samples.push({ ts: elapsed, len: (m?.mes || '').length });
                }
                if (samples.length >= maxSamples) {
                    clearInterval(intervalId);
                    done = true;
                    resolve(samples);
                }
            }, samplePeriodMs);
            const eventName = ctx.eventTypes.MESSAGE_RECEIVED;
            const off = ctx.eventSource.on(eventName, (id) => {
                try { ctx.eventSource.removeListener(eventName, off); } catch {}
                setTimeout(() => {
                    if (done) return;
                    if (assistantIdx < 0) assistantIdx = id;
                    const m = ctx.chat[assistantIdx];
                    samples.push({ ts: performance.now() - startTs, len: (m?.mes || '').length, final: true });
                    clearInterval(intervalId);
                    done = true;
                    resolve(samples);
                }, samplePeriodMs * 2);
            });
        });
    }, { samplePeriodMs, maxSamples });
}

async function sendAndSample(page, text) {
    const samplerP = captureGrowthCurve(page);
    await page.evaluate(async (msg) => {
        const ctx = window.Luker.getContext();
        await ctx.executeSlashCommandsWithOptions(`/send ${msg.replace(/\n/g, ' ')} | /trigger`);
    }, text);
    return await samplerP;
}

test.describe('#2 — streaming vs non-streaming bubble growth', () => {
    test('streaming reply grows incrementally over multiple ticks', async ({ page }) => {
        const slow = await startSlowStreamMock({ chunkDelayMs: 80 });
        const server = await startServer({ batchKey: 'chat', scenarioId: 'stream-on' });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: slow.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: slow.baseURL });
        patchStreamFlag(server.dataRoot, true);

        try {
            await awaitMainUI(page, server.baseURL);
            await selectCharacterByName(page, 'Seraphina');
            await page.waitForFunction(() => {
                const ctx = window.Luker.getContext();
                return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
            }, { timeout: 10_000 }).catch(() => {});

            const samples = await sendAndSample(page, 'The wind is gathering. Tell me what to watch for.');
            const finalLen = samples[samples.length - 1].len;
            expect(finalLen).toBeGreaterThan(50);
            const distinctIntermediate = new Set(samples.filter(s => s.len > 0 && s.len < finalLen).map(s => s.len));
            expect(distinctIntermediate.size,
                `streaming should yield 2+ distinct partial lengths; samples=${JSON.stringify(samples.map(s => s.len))}`)
                .toBeGreaterThanOrEqual(2);
            for (let i = 1; i < samples.length; i++) {
                expect(samples[i].len, `growth not monotonic at i=${i}: ${samples[i-1].len} -> ${samples[i].len}`)
                    .toBeGreaterThanOrEqual(samples[i-1].len);
            }
        } finally {
            await tearDownServer(server);
            await slow.stop();
        }
    });

    test('non-streaming reply lands in a single observable tick', async ({ page }) => {
        const mock = await startMockLLM({ scriptedReplies: [LONG_REPLY] });
        const server = await startServer({ batchKey: 'chat', scenarioId: 'stream-off' });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        patchStreamFlag(server.dataRoot, false);

        try {
            await awaitMainUI(page, server.baseURL);
            await selectCharacterByName(page, 'Seraphina');
            await page.waitForFunction(() => {
                const ctx = window.Luker.getContext();
                return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
            }, { timeout: 10_000 }).catch(() => {});

            const samples = await sendAndSample(page, 'No streaming this time — speak plain.');
            const finalLen = samples[samples.length - 1].len;
            expect(finalLen).toBeGreaterThan(50);
            const nonzero = samples.filter(s => s.len > 0);
            expect(nonzero.length).toBeGreaterThan(0);
            for (const s of nonzero) {
                expect(s.len, `non-streaming partial detected at ts=${s.ts}: len=${s.len}, final=${finalLen}`)
                    .toBe(finalLen);
            }
        } finally {
            await tearDownServer(server);
            await mock.stop();
        }
    });
});
