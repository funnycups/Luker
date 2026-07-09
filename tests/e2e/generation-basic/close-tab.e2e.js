// generation-basic #4 — close tab mid-stream, reopen in a fresh tab and
// resume the still-active generation.
//
// The server-side dispatcher is decoupled from any single client: once
// /generate has returned its request-id, the job continues to accumulate
// chunks into its buffer irrespective of whether the caller's WebSocket
// is still around. So the flow this test locks down is:
//
//   1. Tab A opens, kicks off a slow stream (20 chunks × 500ms).
//   2. As soon as the first chunk lands in Tab A's assistant bubble, we
//      hard-close Tab A. All in-flight fetches on Tab A get cancelled,
//      the ws-delivery WebSocket dies.
//   3. Tab B opens against the same server (fresh page context, no
//      settings), navigates to the same chat, and:
//        (a) `GET /api/generation/active?avatar_url=…&file_name=…`
//            returns the still-running job with the last known request-id.
//        (b) A fresh ws-delivery subscribe against that request-id
//            replays every buffered chunk from seq 1 and receives the
//            continuing stream to completion.
//        (c) The joined chunk contents cover every one of the 20
//            scripted words — zero loss across the tab handoff.
//
// If the accumulated `job.text` had been broken (as it was before commit
// f199e5765), step 3(a) would still return the job but with `text: ''`,
// and even if the WS replay itself worked, any downstream code that
// reads `job.text` (e.g. the recovery preview) would show empty.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server, mock;

// 20 unique tokens so a "did we lose any?" assertion is unambiguous.
const CHUNKS = Array.from({ length: 20 }, (_, i) => `chunk${String(i + 1).padStart(2, '0')}`);
const SCRIPTED_REPLY = CHUNKS.join(' ');
// 500ms between SSE frames × 20 words ≈ 10s of upstream stream time —
// more than enough to close Tab A after the first chunk and still have
// most of the stream ahead of us on Tab B.
const CHUNK_DELAY_MS = 500;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [SCRIPTED_REPLY],
        streamChunkDelayMs: CHUNK_DELAY_MS,
    });
    server = await startServer({ batchKey: 'generation', scenarioId: 'close-tab' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('generation-basic: closing the tab mid-stream leaves the job running; a fresh tab reattaches via /api/generation/active + ws-delivery replay', async ({ browser }) => {
    // ────────────────────────────────────────────────────────────────
    // Tab A — start the slow stream, wait for the first chunk, close.
    // ────────────────────────────────────────────────────────────────
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();

    // Capture the request-id the server minted on the /generate response
    // so Tab B can hit /api/generation/active and cross-check.
    let generationRequestId = '';
    let persistTarget = null;
    pageA.on('response', (resp) => {
        const rid = resp.headers()['x-luker-generation-id'];
        if (rid && !generationRequestId) generationRequestId = String(rid);
    });

    await awaitMainUI(pageA, server.baseURL);
    await selectCharacterByName(pageA, 'Seraphina');
    await pageA.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    // Fire the send but do NOT await reply — we intend to close mid-stream.
    await pageA.locator('#send_textarea').fill('Please stream the reply slowly for me.');
    await pageA.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await pageA.evaluate(() => document.querySelector('#send_but').click());

    // Wait until the first scripted chunk is in the assistant bubble AND
    // we've captured the request-id off the /generate response headers.
    await pageA.waitForFunction(() => {
        const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
        for (const b of bubbles) {
            const t = b.querySelector('.mes_text')?.innerText || '';
            if (t.includes('chunk01')) return true;
        }
        return false;
    }, { timeout: 20_000 });
    await pageA.waitForFunction(() => document.querySelectorAll('#chat .mes:not([is_user="true"])').length >= 1, { timeout: 5000 });

    // Grab the persist_target for the current chat off ctx so Tab B can
    // reproduce the same chat-key lookup without going through the
    // character-select path again (character selection is not itself
    // what's under test here — the recovery HTTP + ws-delivery replay is).
    persistTarget = await pageA.evaluate(() => {
        const ctx = window.Luker.getContext();
        const c = ctx.characters[ctx.characterId];
        return {
            avatar_url: c?.avatar || '',
            // Same shape the client passes to /jobs/active: file_name is
            // character.chat (no .jsonl suffix). getPersistChatKey builds
            // `char:${avatar}:${fileName}` — mismatches yield an empty
            // active-jobs list even though the job is running.
            file_name: c?.chat || '',
        };
    });
    expect(persistTarget.avatar_url, 'must have avatar_url for chat-key lookup').toBeTruthy();
    expect(persistTarget.file_name, 'must have file_name for chat-key lookup').toBeTruthy();
    expect(generationRequestId, 'x-luker-generation-id must have been observed on /generate').toMatch(/^[0-9a-f-]{8,}/i);

    // Snapshot how many chunks made it to Tab A before we close so we can
    // prove Tab B saw the ones that arrived after.
    const preCloseChunkCount = await pageA.evaluate(() => {
        const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
        const last = bubbles[bubbles.length - 1];
        const text = last?.querySelector('.mes_text')?.innerText || '';
        return (text.match(/chunk\d+/g) || []).length;
    });

    // Close Tab A hard. Any pending fetch on Tab A gets cancelled by the
    // browser as part of document teardown; the ws-delivery WS dies with
    // the page. The server-side dispatcher does NOT interpret this as an
    // abort (there's no explicit POST /api/generation/:id/abort in the
    // page-close path), so the job keeps streaming into its buffer.
    await pageA.close();
    await contextA.close();

    // Give the server 3s of buffer time so chunks accumulate while there
    // is no client connected — this is the invariant we want to lock in.
    await new Promise(r => setTimeout(r, 3000));

    // ────────────────────────────────────────────────────────────────
    // Tab B — fresh context, same server. Reattach.
    // ────────────────────────────────────────────────────────────────
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await awaitMainUI(pageB, server.baseURL);

    // (a) /api/generation/active returns the still-running job with the
    // request-id we captured off Tab A's /generate response.
    const activeResult = await pageB.evaluate(async ({ avatar_url, file_name }) => {
        const qs = new URLSearchParams({ avatar_url, file_name }).toString();
        const resp = await fetch(`/api/generation/active?${qs}`, {
            method: 'GET',
            credentials: 'same-origin',
        });
        const body = await resp.json();
        return { status: resp.status, body };
    }, persistTarget);
    expect(activeResult.status, `GET /api/generation/active should be 200; got ${activeResult.status} body=${JSON.stringify(activeResult.body).slice(0, 300)}`).toBe(200);
    expect(Array.isArray(activeResult.body?.jobs), 'response must have jobs[]').toBe(true);
    const activeJob = activeResult.body.jobs.find(j => j.id === generationRequestId) || activeResult.body.jobs[0];
    expect(activeJob, `expected an active job matching request-id ${generationRequestId}; got ${JSON.stringify(activeResult.body.jobs)}`).toBeTruthy();
    expect(String(activeJob.id)).toBe(generationRequestId);
    // Post-fix (commit f199e5765) job.text accumulates from every chunk
    // event; before that fix it stayed empty even mid-stream. Preview UI
    // and any downstream reader relies on this.
    expect(String(activeJob.text || ''), 'job.text on the active-list response should reflect accumulated chunks (commit f199e5765)').toContain('chunk');

    // (b) Tab B directly subscribes/resumes over the ws-delivery WS
    // against the captured request-id and drains every remaining chunk
    // (replay + live). This is the "same server, fresh browser tab
    // resumes the in-flight stream" contract.
    const wsResult = await pageB.evaluate(async ({ requestId, expectedChunks, chunkDelayMs }) => {
        // Ticket first — WS auth is ticket-in-Sec-WebSocket-Protocol.
        // Use the app's own getRequestHeaders() so we pick up the CSRF
        // token; the ws-ticket endpoint sits behind the full CSRF stack.
        const scriptMod = await import('/script.js');
        const headers = scriptMod.getRequestHeaders();
        const ticketResp = await fetch('/api/ws-ticket', {
            method: 'POST',
            credentials: 'same-origin',
            headers,
        });
        const ticketBody = await ticketResp.json();
        const ticket = ticketBody?.ticket;
        if (!ticket) return { error: 'no-ticket', status: ticketResp.status, body: ticketBody };

        return await new Promise((resolve) => {
            const proto = `luker-ws-ticket.${ticket}`;
            const ws = new WebSocket(`ws://${location.host}/api/ws-delivery`, [proto]);
            let received = '';
            let seqCount = 0;
            let ended = false;
            // Bound the wait: 20 chunks × chunkDelayMs + generous slack.
            const budgetMs = expectedChunks * chunkDelayMs + 15_000;
            const timer = setTimeout(() => {
                try { ws.close(); } catch {}
                resolve({ error: 'timeout', received, seqCount, ended });
            }, budgetMs);
            ws.onopen = () => {
                // resume from seq 1 mirrors the client-lib default so we
                // pick up every buffered chunk from the beginning.
                ws.send(JSON.stringify({ type: 'resume', request_id: requestId, from_seq: 1 }));
            };
            ws.onmessage = (evt) => {
                let msg;
                try { msg = JSON.parse(evt.data); } catch { return; }
                if (msg.type === 'chunk') {
                    seqCount += 1;
                    // Each chunk is base64-encoded raw upstream SSE bytes.
                    // We don't care about parsing the SSE structure here —
                    // grep for chunk-word tokens across the decoded bag.
                    try {
                        const decoded = atob(msg.data);
                        received += decoded;
                    } catch {}
                } else if (msg.type === 'end') {
                    ended = true;
                    clearTimeout(timer);
                    try { ws.close(); } catch {}
                    resolve({ received, seqCount, ended });
                } else if (msg.type === 'error') {
                    clearTimeout(timer);
                    try { ws.close(); } catch {}
                    resolve({ error: msg.code || 'ws-error', message: msg.message, received, seqCount, ended });
                }
            };
            ws.onerror = () => {
                clearTimeout(timer);
                resolve({ error: 'ws-onerror', received, seqCount, ended });
            };
        });
    }, { requestId: generationRequestId, expectedChunks: CHUNKS.length, chunkDelayMs: CHUNK_DELAY_MS });

    expect(wsResult.error, `ws replay/resume must not error: ${JSON.stringify(wsResult)}`).toBeFalsy();
    expect(wsResult.ended, `ws stream must terminate with a type:end frame; got ${JSON.stringify(wsResult).slice(0, 400)}`).toBe(true);
    // Server buffered every chunk pre-close AND continued streaming after
    // — Tab B must observe every one of the 20 tokens in the accumulated
    // wire bytes, regardless of the exact framing granularity.
    for (const chunk of CHUNKS) {
        expect(wsResult.received, `expected ws replay to contain "${chunk}"; seqCount=${wsResult.seqCount} preCloseChunkCount=${preCloseChunkCount} received.length=${wsResult.received.length}`).toContain(chunk);
    }

    // (c) After the ws-delivery drain, the server-side job should have
    // finished. Refresh the /active check — a completed job leaves the
    // list (only running/queued/awaiting_ack/persisting appear there),
    // so we allow either empty jobs or a job with a terminal state.
    // The important post-condition is the ACCUMULATED text still covers
    // every chunk, whichever endpoint we read it from.
    const postJob = await pageB.evaluate(async ({ requestId }) => {
        const scriptMod = await import('/script.js');
        const headers = scriptMod.getRequestHeaders();
        const resp = await fetch(`/api/backends/chat-completions/jobs/status`, {
            method: 'POST',
            credentials: 'same-origin',
            headers,
            body: JSON.stringify({ id: requestId }),
        });
        const body = await resp.json().catch(() => ({}));
        return { status: resp.status, body };
    }, { requestId: generationRequestId });
    expect(postJob.status).toBe(200);
    // job.text must include every chunk word — the whole reason the
    // text-accumulation fix (2ae4464f7 + f199e5765) exists.
    const finalText = String(postJob.body?.text || '');
    for (const chunk of CHUNKS) {
        expect(finalText, `job.text after drain must include "${chunk}"; got ${finalText.slice(0, 400)}`).toContain(chunk);
    }

    await contextB.close();
});
