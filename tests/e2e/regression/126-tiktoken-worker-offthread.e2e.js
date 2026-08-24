// tiktoken client tokenizer runs off the main thread (fix for the mobile
// Trace-20260824 profile that showed a single PromptManager idle-callback
// pinning the renderer for 34s doing nothing but js-tiktoken bytePairMerge).
//
// REAL USER FLOW: load the app, call countMessages() through the shipped
// client-tokenizers module (no shim), assert:
//   (1) worker was actually spawned (Worker ctor URL contains tiktoken-worker.js)
//   (2) main thread was NOT blocked during count — rAFs kept firing
//   (3) count value matches the server-side tokenizer for the same messages
//   (4) count value matches the in-thread fallback path

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

// A message array big enough that a main-thread encode would visibly block.
// bytePairMerge is O(n^2) per token chunk; heavy CJK + long English content
// exercises the merge loop hard. Kept deterministic (same seed, same repeats)
// so the server/worker/fallback three-way compare is byte-exact.
function buildHeavyMessages() {
    const chunks = [
        'The lantern glass fogged as she leaned closer, breath sour with old wine. ',
        '她抬起头,眼里映着灯芯里跳动的火焰,却看不清远处海面上正在缓慢升起的雾。',
        'Every joint in the pier creaked when the tide pulled back — a slow, deliberate withdrawal that left the barnacles clicking. ',
        '灯塔守望人在木梯上停下,把手电筒往上照,光柱里悬着无数细小的、被风带上来的盐粒。',
    ];
    const oneMessage = chunks.join('') .repeat(30); // ~ tens of KB of text
    const messages = [];
    for (let i = 0; i < 40; i++) {
        messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: oneMessage });
    }
    return messages;
}

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'tiktoken-worker', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('tiktoken client tokenizer runs off the main thread', () => {
    test('countMessages spawns a worker, keeps rAFs firing, and matches server + fallback counts', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Install the Worker-ctor probe BEFORE we import the adapter so the
        // very first ensureWorker() call is captured. The adapter caches its
        // Worker instance module-level, so a probe installed after import
        // could miss the ctor call entirely.
        await page.evaluate(() => {
            const originalWorker = window.Worker;
            const seen = [];
            window.__tiktokenWorkerProbe = { originalWorker, seen };
            window.Worker = class extends originalWorker {
                constructor(url, opts) {
                    seen.push({ url: String(url), type: opts?.type || 'classic' });
                    super(url, opts);
                }
            };
        });

        const messages = buildHeavyMessages();
        const model = 'gpt-4';

        // Run countMessages via the shipped adapter, while counting rAFs
        // on the main thread. If tiktoken ran in-thread, bytePairMerge for
        // this payload keeps the renderer pinned and rAF count drops to
        // near zero for the duration.
        const result = await page.evaluate(async ({ messages, model }) => {
            const mod = await import('/scripts/client-tokenizers/tiktoken-adapter.js');

            // rAF counter — measure over exactly the countMessages call.
            let rafs = 0;
            let stop = false;
            const tick = () => { if (stop) return; rafs++; requestAnimationFrame(tick); };
            requestAnimationFrame(tick);

            const t0 = performance.now();
            const workerCount = await mod.countMessages(model, messages);
            const t1 = performance.now();
            stop = true;

            return {
                workerCount,
                durationMs: t1 - t0,
                rafs,
                workerProbe: window.__tiktokenWorkerProbe.seen.slice(),
            };
        }, { messages, model });

        // (1) worker was really spawned via the tiktoken-worker.js URL as a module worker.
        const tiktokenSpawn = result.workerProbe.find(w => /tiktoken-worker\.js/.test(w.url));
        expect(tiktokenSpawn,
            'tiktoken-adapter must spawn public/scripts/workers/tiktoken-worker.js; ' +
            `Worker ctor was called with urls=${JSON.stringify(result.workerProbe.map(w => w.url))}`,
        ).toBeTruthy();
        expect(tiktokenSpawn.type,
            'tiktoken-worker.js is a module worker (dynamic import of the ESM bundle); ' +
            'if this regresses to classic, importScripts of an ESM module will throw at construction',
        ).toBe('module');

        // (2) main thread stayed live during count.
        // At ~60fps we'd expect ~durationMs/16 rAFs. Even under CI load we
        // want clear evidence the loop didn't halt. Threshold picks the
        // conservative floor: any rAF activity at all rules out a full
        // main-thread pin, and >= 3 rules out a single frame slipping past
        // the debouncer. The exact number depends on hardware; the point
        // is "nonzero and clearly running", not a fixed FPS target.
        expect(result.rafs,
            'rAF must keep firing while tiktoken worker computes ' +
            `(durationMs=${result.durationMs.toFixed(1)}, rafs=${result.rafs}); ` +
            'if this regresses to main-thread encode, bytePairMerge pins the renderer ' +
            'and rAF count drops to near zero',
        ).toBeGreaterThanOrEqual(3);

        // (3) matches the server tokenizer for the same messages. Route via
        // getRequestHeaders() so the CSRF token from the live session is
        // included — a raw fetch without it 403s before ever hitting the
        // tokenizer route.
        const serverResp = await page.evaluate(async ({ messages, model }) => {
            const mod = await import('/script.js');
            const headers = mod.getRequestHeaders();
            const res = await fetch(`/api/tokenizers/openai/count?model=${encodeURIComponent(model)}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(messages),
            });
            return { status: res.status, body: await res.json() };
        }, { messages, model });
        expect(serverResp.status, `server /api/tokenizers/openai/count must accept the request; body=${JSON.stringify(serverResp.body)}`).toBe(200);
        expect(result.workerCount,
            'worker countMessages must match server /api/tokenizers/openai/count; ' +
            `worker=${result.workerCount} server=${serverResp.body?.token_count}`,
        ).toBe(serverResp.body.token_count);

        // (4) matches the in-thread fallback (disable Worker, invalidate
        // the adapter's cached worker via module reimport with a cache
        // bust, and rerun). This proves the fallback branch computes the
        // same number the worker did — i.e. the two encode paths agree.
        const fallbackCount = await page.evaluate(async ({ messages, model }) => {
            window.Worker = undefined;
            // Cache-bust so tiktoken-adapter.js re-evaluates and picks up
            // the now-undefined Worker (its ensureWorker() short-circuits
            // when typeof Worker === 'undefined').
            const mod = await import('/scripts/client-tokenizers/tiktoken-adapter.js?_fallback=' + Date.now());
            return mod.countMessages(model, messages);
        }, { messages, model });
        expect(fallbackCount,
            'fallback in-thread encode must produce the same count as the worker; ' +
            `worker=${result.workerCount} fallback=${fallbackCount}`,
        ).toBe(result.workerCount);
    });
});
