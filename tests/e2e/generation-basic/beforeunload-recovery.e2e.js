// generation-basic #10 — beforeunload must NOT kill a recoverable job.
//
// A real user closes the browser / tab mid-generation. That fires
// `beforeunload`, which (public/script.js:21726) calls
// `streamingProcessor.onStopStreaming()` → the StreamingProcessor's own
// AbortController aborts → the ws-delivery fetch proxy sees the signal fire
// → `sendAbortNotification` POSTs `/api/generation/:id/abort` → the server
// aborts the upstream fetch (node-fetch 'The operation was aborted') and
// marks the job `aborted by client`. The reply never lands and nothing is
// recoverable: the request-inspector shows "aborted" and reopening the page
// finds no active job.
//
// The close-tab e2e suite never caught this because `page.close()` in
// Playwright **does not run beforeunload** unless `runBeforeUnload: true` is
// passed explicitly. The server-side job-survives-disconnect contract was
// only ever exercised for a transport-level disconnect, never for the
// lifecycle event a real browser fires.
//
// Contract locked here: closing the tab through the real beforeunload path
// while a recoverable (normal) generation streams must leave the job
// running on the server — `/api/generation/active` still returns it and the
// recovery preview flow works in the reopened tab.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

const CHUNKS = Array.from({ length: 20 }, (_, i) => `chunk${String(i + 1).padStart(2, '0')}`);
const SCRIPTED_REPLY = CHUNKS.join(' ');
const CHUNK_DELAY_MS = 500;

async function resolveChatPath(page, dataRoot) {
    const avatarFolder = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        const c = ctx.characters[ctx.characterId];
        return (c?.avatar || '').replace(/\.png$/, '');
    });
    const chatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
    return resolve(dataRoot, 'default-user', 'chats', avatarFolder, `${chatId}.jsonl`);
}

test.describe('generation-basic: beforeunload keeps recoverable job alive', () => {
    let server, mock;

    test.beforeAll(async () => {
        mock = await startMockLLM({
            scriptedReplies: [SCRIPTED_REPLY],
            streamChunkDelayMs: CHUNK_DELAY_MS,
        });
        server = await startServer({ batchKey: 'generation', scenarioId: 'beforeunload-recovery' });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    });

    test.afterAll(async () => {
        await tearDownServer(server);
        await mock?.stop();
    });

    test('real beforeunload close leaves job running; reopened tab recovers the full reply', async ({ browser }) => {
        // ── Tab A: start the stream, close through the real lifecycle path.
        const contextA = await browser.newContext();
        const pageA = await contextA.newPage();
        await awaitMainUI(pageA, server.baseURL);
        await selectCharacterByName(pageA, 'Seraphina');
        await pageA.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        await pageA.locator('#send_textarea').fill('Please stream slowly.');
        await pageA.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await pageA.evaluate(() => document.querySelector('#send_but').click());

        await pageA.waitForFunction(() => {
            const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
            for (const b of bubbles) {
                if ((b.querySelector('.mes_text')?.innerText || '').includes('chunk01')) return true;
            }
            return false;
        }, { timeout: 20_000 });

        const chatPath = await resolveChatPath(pageA, server.dataRoot);
        // Capture the chat key off Tab A (Tab B has no character selected
        // yet at awaitMainUI, so its ctx.characterId is undefined).
        const persistTarget = await pageA.evaluate(() => {
            const ctx = window.Luker.getContext();
            const c = ctx.characters[ctx.characterId];
            return { avatar_url: c?.avatar || '', file_name: c?.chat || '' };
        });

        // The critical difference from close-tab.e2e.js: runBeforeUnload
        // makes the browser fire beforeunload + dispatch the abort
        // notification fetch with keepalive, exactly like a real user
        // closing the tab / the whole browser.
        await pageA.close({ runBeforeUnload: true });
        await contextA.close();

        // Give the server a few seconds of streaming with zero clients.
        await new Promise(r => setTimeout(r, 3000));

        // ── The job must still be alive server-side.
        const contextB = await browser.newContext();
        const pageB = await contextB.newPage();
        await awaitMainUI(pageB, server.baseURL);

        const activeResult = await pageB.evaluate(async ({ avatar_url, file_name }) => {
            const qs = new URLSearchParams({ avatar_url, file_name }).toString();
            const resp = await fetch(`/api/generation/active?${qs}`, { method: 'GET', credentials: 'same-origin' });
            return { status: resp.status, body: await resp.json() };
        }, persistTarget);
        expect(activeResult.status).toBe(200);
        expect(Array.isArray(activeResult.body?.jobs), `jobs array expected; body=${JSON.stringify(activeResult.body).slice(0, 300)}`).toBe(true);
        expect(activeResult.body.jobs.length, `job must survive a beforeunload tab close; got ${JSON.stringify(activeResult.body.jobs.map(j => ({ id: j.id, status: j.status })))}`).toBeGreaterThan(0);
        const job = activeResult.body.jobs[0];
        expect(['running', 'queued', 'awaiting_ack', 'persisting'], `job status must be non-terminal; got ${job.status}`).toContain(String(job.status));
        expect(String(job.text || ''), 'accumulated job.text must hold the streamed prefix').toContain('chunk');

        // ── Reopen through the real UI; the recovery preview must appear.
        await selectCharacterByName(pageB, 'Seraphina');
        await pageB.waitForFunction(() => Boolean(document.querySelector('#luker_generation_recovery_preview')), { timeout: 20_000 });

        // Completion: preview disappears, persisted message lands, disk copy
        // holds the verbatim reply.
        await pageB.waitForFunction(() => !document.querySelector('#luker_generation_recovery_preview'), { timeout: 45_000 });
        await pageB.waitForFunction(() => {
            const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
            for (const b of bubbles) {
                if ((b.querySelector('.mes_text')?.innerText || '').includes('chunk20')) return true;
            }
            return false;
        }, { timeout: 20_000 });

        let asstLine = null;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            try {
                const lines = readFileSync(chatPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
                asstLine = lines.find(o => !o.is_user && String(o.mes || '') === SCRIPTED_REPLY);
                if (asstLine) break;
            } catch { /* not written yet */ }
            await new Promise(r => setTimeout(r, 500));
        }
        expect(asstLine, 'persisted chat.jsonl must contain the verbatim streamed reply after beforeunload recovery').toBeTruthy();

        await contextB.close();
    });
});
