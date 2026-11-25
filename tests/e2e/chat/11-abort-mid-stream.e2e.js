// #11 — Abort before the first upstream token.
//
// The first upstream call hangs until the client goes away, so the
// generation is reliably in flight when #mes_stop is clicked. The mock's
// latency is abort-aware: the aborted call closes before any reply is
// dequeued, so the single scripted reply belongs to the follow-up turn.
// Real user gestures only:
//   1. Type into #send_textarea and click #send_but.
//   2. Wait until the request reaches the mock.
//   3. Click #mes_stop (via the abortGenerationViaUI helper).
//   4. Assert the upstream request closed unanswered, the stop button hides
//      and the send button re-enables.
//   5. Send a fresh follow-up via #send_textarea and confirm it lands.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    abortGenerationViaUI,
} from '../_lib/page.js';

let server, mock;

const FIRST_PROMPT = 'The wind is cold; please tell me everything you saw on the path.';
const FOLLOW_UP_PROMPT = 'Continue: now what?';

function chatRequests() {
    return mock.requests.filter((r) => (r.url || '').includes('/chat/completions'));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    let chatCalls = 0;
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina lights a fresh wick.* "Now — second turn — the lantern is burning steady again."',
        ],
        latencyMs: (req) => {
            if (!(req.url || '').includes('/chat/completions')) return 0;
            chatCalls += 1;
            return chatCalls === 1 ? 600_000 : 0;
        },
    });
    server = await startServer({ scope, batchKey: 'chat', scenarioId: 'abort' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#11 — abort before first token', () => {
    test('clicking #mes_stop kills in-flight gen, next send via #send_but succeeds', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await expect(page.locator('#chat .mes').first()).toBeVisible({ timeout: 10_000 });

        // Real user gesture #1: fill #send_textarea, click #send_but.
        await page.locator('#send_textarea').fill(FIRST_PROMPT);
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await page.locator('#send_but').click();

        await expect.poll(() => chatRequests().length, { timeout: 30_000 }).toBe(1);
        await expect(page.locator('#mes_stop'), '#mes_stop should be visible mid-stream').toBeVisible();

        // Real user gesture #2: click #mes_stop (no underlying-API fallback).
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            window.__e2eStopped = false;
            const handler = () => {
                ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_STOPPED, handler);
                window.__e2eStopped = true;
            };
            window.__e2eStopProbeCleanup = () => ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_STOPPED, handler);
            ctx.eventSource.on(ctx.eventTypes.GENERATION_STOPPED, handler);
        });
        try {
            await abortGenerationViaUI(page);
            await expect.poll(() => page.evaluate(() => window.__e2eStopped), { timeout: 10_000 }).toBe(true);
        } finally {
            await page.evaluate(() => { window.__e2eStopProbeCleanup?.(); delete window.__e2eStopProbeCleanup; });
        }

        // The abort reaches the upstream request: it closes with no reply bytes.
        const [aborted] = chatRequests();
        await expect.poll(() => aborted.closedAt ?? null, { timeout: 10_000 }).not.toBeNull();
        expect(aborted.firstByteAt).toBeNull();
        expect(aborted.responseCompleted).toBe(false);

        await expect(page.locator('#mes_stop')).toBeHidden({ timeout: 10_000 });
        await expect(page.locator('#send_but'), '#send_but should not be permanently hidden after abort')
            .not.toHaveClass(/displayNone/, { timeout: 10_000 });

        // Real user gesture #3: fresh send via #send_textarea + #send_but.
        const { text } = await sendMessageAndAwaitReply(page, FOLLOW_UP_PROMPT, { timeoutMs: 30_000 });
        expect(text).toMatch(/second turn|lantern is burning|steady/i);

        const requests = chatRequests();
        expect(requests).toHaveLength(2);
        expect(requests[1].body.messages.at(-1).content).toContain(FOLLOW_UP_PROMPT);
    });
});
