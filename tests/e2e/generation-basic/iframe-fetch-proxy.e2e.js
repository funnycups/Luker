// generation-basic #8 — /generate calls issued from inside a same-origin
// iframe MUST still route through the ws-delivery proxy.
//
// The runner architecture (src/luker-dispatch/runner.js) responds to every
// POST /api/backends/*/generate with HTTP 200 + `{}` immediately and pushes
// the actual payload over the WebSocket. The top-window ws-delivery proxy
// (public/scripts/ws-delivery.js:installFetchProxy) monkey-patches
// window.fetch to intercept that empty body and hand back a stream-backed
// Response.
//
// But iframes have their own `window` and their own `fetch`. Third-party
// script runtimes such as TavernHelper / JS-Slash-Runner sandbox user
// scripts inside a `TH-render` iframe; a raw
// `fetch('/api/backends/chat-completions/generate', ...)` from that
// iframe would previously bypass the top proxy entirely and see the
// runner's `{}` — exactly the failure reported by shujuku (SP·数据库)
// users on July 12: `parseNonStreamResponse Unknown response format:
// Object{}` after every retry.
//
// installFetchProxyForAllIframes patches every same-origin iframe on the
// page (current + future via MutationObserver + `load` re-patch). This
// test proves the contract by:
//
//   1. Boot server + mock LLM (as plugin-request.e2e.js does).
//   2. In the page, create a bare iframe and append it to the DOM.
//   3. In the iframe's own realm, do a raw fetch to
//      `/api/backends/chat-completions/generate` with `stream: false`
//      and `chat_completion_source: 'custom'` pointing at the mock.
//   4. Assert the iframe-fetched Response body carries the real upstream
//      JSON (has `choices[0].message.content` matching the scripted
//      reply) — NOT the runner's synthetic `{}`.
//   5. Assert the returned Response is an instance of the IFRAME's
//      Response constructor (realm-correct — proves we shadowed the
//      built-ins per-window inside installFetchProxy, not just returned
//      a parent-realm object).
//   6. Assert `x-luker-generation-id` was on the initial HTTP response
//      (dispatch actually ran) and a WebSocket to /api/ws-delivery was
//      opened (payload came via WS).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mock;

const IFRAME_REPLY = 'This reply arrived at an iframe fetch caller.';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [IFRAME_REPLY] });
    server = await startServer({ batchKey: 'generation', scenarioId: 'iframe-fetch-proxy' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('generation-basic: iframe-scoped fetch to /generate is proxied through ws-delivery', async ({ page }) => {
    const wsOpens = [];
    page.on('websocket', (ws) => { wsOpens.push(ws.url()); });

    const generateResponses = [];
    page.on('response', (resp) => {
        const url = resp.url();
        if (url.includes('/api/backends/chat-completions/generate')) {
            generateResponses.push({
                status: resp.status(),
                generationId: resp.headers()['x-luker-generation-id'] || '',
            });
        }
    });

    page.on('console', (msg) => {
        if (msg.type() === 'error') console.log('[browser-error]', msg.text());
    });
    page.on('pageerror', (err) => console.log('[browser-pageerror]', err.message));

    await awaitMainUI(page, server.baseURL);

    // Create an iframe, wait for our installFetchProxyForAllIframes hooks
    // to patch its contentWindow.fetch, then issue a raw /generate call
    // from inside the iframe realm. We use `iframe.contentWindow.fetch`
    // (not window.fetch bound to iframe) so the test exercises the
    // exact iframe-owned function object we patched.
    const iframeResult = await page.evaluate(async ({ customUrl, model }) => {
        // Fresh iframe with no src — contentWindow points at about:blank
        // whose fetch is a pristine iframe-realm builtin until our
        // MutationObserver patches it. We do NOT set srcdoc; we want the
        // simplest possible iframe so any breakage is unambiguously our
        // patch's fault, not srcdoc / script parsing.
        const iframe = document.createElement('iframe');
        // Hidden — Playwright default viewport doesn't need to render it.
        iframe.style.display = 'none';
        document.body.appendChild(iframe);

        // MutationObserver fires on a microtask boundary; add-iframe path
        // in installFetchProxyForAllIframes patches contentWindow.fetch
        // synchronously in that callback. A short spin is enough — we
        // don't need `iframe.load` because contentWindow is already the
        // about:blank window (no navigate required).
        for (let i = 0; i < 50; i++) {
            if (iframe.contentWindow?.__lukerFetchProxyDisposer) break;
            await new Promise(r => setTimeout(r, 20));
        }
        const patchWaitMs = 20 * 50;
        const wasPatched = Boolean(iframe.contentWindow?.__lukerFetchProxyDisposer);

        // Build a shujuku-shape body: chat_completion_source=custom pointing
        // at the mock, stream:false so the caller expects a JSON body
        // (which is exactly what shujuku's parseNonStreamResponse does).
        const body = JSON.stringify({
            messages: [{ role: 'user', content: 'iframe ping' }],
            model,
            max_tokens: 200,
            temperature: 1.0,
            top_p: 0.95,
            stream: false,
            chat_completion_source: 'custom',
            custom_url: customUrl,
            reverse_proxy: customUrl,
            custom_include_headers: '',
            custom_include_body: '',
            custom_exclude_body: '',
        });

        // Reuse the top window's CSRF headers — iframe shares cookies,
        // CSRF token is a per-session value. This is exactly what a
        // TavernHelper user script gets from SillyTavern.getRequestHeaders
        // via its cross-window bridge.
        const { getRequestHeaders } = await import('/script.js');
        const headers = { ...getRequestHeaders(), 'Content-Type': 'application/json' };

        let httpStatus, generationId, parsed, isIframeResponse, error;
        try {
            const response = await iframe.contentWindow.fetch(
                '/api/backends/chat-completions/generate',
                { method: 'POST', headers, body },
            );
            httpStatus = response.status;
            generationId = response.headers.get('x-luker-generation-id') || '';
            // Realm check: with the shadowed built-ins the proxied fetch
            // constructs `new Response(...)` in the iframe's realm, so
            // this must hold. Without the shadow it would be false.
            isIframeResponse = response instanceof iframe.contentWindow.Response;
            parsed = await response.json();
        } catch (err) {
            error = String(err?.message || err);
        }

        return { wasPatched, patchWaitMs, httpStatus, generationId, isIframeResponse, parsed, error };
    }, { customUrl: mock.baseURL, model: 'mock-gpt-4o' });

    expect(iframeResult.error, `iframe fetch must not throw: ${iframeResult.error}`).toBeUndefined();

    // Proves our lifecycle driver actually patched the iframe. If this
    // fails, everything downstream fails too — surface it explicitly.
    expect(iframeResult.wasPatched, `iframe.contentWindow was not patched within ${iframeResult.patchWaitMs}ms`).toBe(true);

    // Runner contract: HTTP 200 + x-luker-generation-id header.
    expect(iframeResult.httpStatus).toBe(200);
    expect(iframeResult.generationId, 'x-luker-generation-id must be echoed on the /generate response').toMatch(/^[0-9a-f-]{8,}/i);

    // Realm-correctness: the Response returned to the iframe is an
    // instance of the iframe's own Response constructor. Without the
    // shadowed built-ins inside installFetchProxy, this would be false
    // (parent Response !== iframe Response).
    expect(iframeResult.isIframeResponse, 'Response must be constructed in the iframe realm').toBe(true);

    // The actual body must be the scripted reply, NOT the runner's `{}`.
    // If the proxy were bypassed, parsed would be `{}` (no choices key)
    // and shujuku's parseNonStreamResponse would log "Unknown response
    // format: Object{}" — the exact production bug this test guards.
    const contentPath = iframeResult.parsed?.choices?.[0]?.message?.content;
    expect(contentPath, `iframe-fetched body must carry upstream content, got: ${JSON.stringify(iframeResult.parsed)}`).toBe(IFRAME_REPLY);

    // WebSocket to /api/ws-delivery was opened during the iframe call.
    const deliveryWs = wsOpens.find(u => u.includes('/api/ws-delivery'));
    expect(deliveryWs, `expected a ws to /api/ws-delivery; observed: ${JSON.stringify(wsOpens)}`).toBeTruthy();

    // Mock LLM saw exactly one upstream chat call from the iframe (no
    // double-dispatch, no short-circuit).
    const chatCalls = mock.requests.filter(r => (r.url || '').includes('/chat/completions'));
    expect(chatCalls.length, `mock LLM should have received 1 iframe-triggered chat call; got ${chatCalls.length}`).toBe(1);

    // The /generate HTTP call we care about must be in the observed list
    // (the awaitMainUI may fire probes too — we only require ours landed).
    expect(generateResponses.length, `expected at least one /generate response; observed ${generateResponses.length}`).toBeGreaterThanOrEqual(1);
    for (const resp of generateResponses) {
        expect(resp.status, `every /generate response must be 200; got ${resp.status}`).toBe(200);
        expect(resp.generationId, 'every /generate response must carry x-luker-generation-id').toMatch(/^[0-9a-f-]{8,}/i);
    }
});
