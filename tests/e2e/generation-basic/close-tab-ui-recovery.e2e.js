// generation-basic #8 — real-user-path tab-close recovery.
//
// close-tab.e2e.js (#4) drives the reattach via a HAND-ROLLED raw WebSocket
// resume inside page.evaluate. That proves the transport layer works but
// never exercises what an actual user sees after reopening the page:
//
//   public/script.js CHAT_CHANGED → startLukerGenerationRecovery()
//     → POST /api/backends/chat-completions/jobs/active
//     → #luker_generation_recovery_preview bubble
//     → SSE /jobs/events-stream live text
//     → completed → reloadCurrentChat() swaps the bubble for the persisted
//       message.
//
// Two scenarios locked here:
//   Scenario 1 (落盘): tab closed mid-stream, NO other client ever connects.
//     After the ack-grace window the server must have written the complete
//     reply into chat.jsonl on its own.
//   Scenario 2 (恢复): tab closed mid-stream, fresh tab opened through the
//     normal UI character-select path. The recovery preview bubble must
//     appear, reach the full streamed text, and be replaced by the real
//     persisted message once the job lands.
//
// Regression note: the recovery session used to be torn down seconds after
// opening, because PromptManager's token-count dry run
// (tryGenerate → Generate('normal', {}, dryRun=true), fired ~2s after every
// chat open) emits GENERATION_STARTED and the recovery's stop listener did
// not filter dry runs. The preview vanished mid-stream and the persisted
// reply only appeared after a manual refresh.

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
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

async function startStreamAndCloseTab(browser, server) {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await awaitMainUI(pageA, server.baseURL);
    await selectCharacterByName(pageA, 'Seraphina');
    await pageA.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    await pageA.locator('#send_textarea').fill('Please stream slowly.');
    await pageA.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await pageA.evaluate(() => document.querySelector('#send_but').click());

    // First chunk visible in the assistant bubble = generation is underway.
    await pageA.waitForFunction(() => {
        const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
        for (const b of bubbles) {
            if ((b.querySelector('.mes_text')?.innerText || '').includes('chunk01')) return true;
        }
        return false;
    }, { timeout: 20_000 });

    // Capture chat identity BEFORE teardown so disk assertions can find the file.
    const chatPath = await resolveChatPath(pageA, server.dataRoot);

    // Hard close: every in-flight fetch + the ws-delivery WebSocket die here,
    // exactly like a user closing the tab mid-generation.
    await pageA.close();
    await contextA.close();

    // Give the upstream a few chunks of headless streaming with zero clients.
    await new Promise(r => setTimeout(r, 3000));
    return { chatPath };
}

test.describe('generation-basic: close-tab real-user-path recovery', () => {
    // ─────────────────────────────────────────────────────────────
    // Scenario 1 — nobody reopens anything; server must self-persist.
    // ─────────────────────────────────────────────────────────────
    test.describe('scenario 1: server persists after silent tab close', () => {
        let server, mock;

        test.beforeAll(async () => {
            mock = await startMockLLM({
                scriptedReplies: [SCRIPTED_REPLY],
                streamChunkDelayMs: CHUNK_DELAY_MS,
            });
            server = await startServer({ batchKey: 'generation', scenarioId: 'close-tab-silent-persist' });
            markOnboarded({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        });

        test.afterAll(async () => {
            await tearDownServer(server);
            await mock?.stop();
        });

        test('closed tab mid-stream → complete reply lands in chat.jsonl with no client ever acking', async ({ browser }) => {
            const { chatPath } = await startStreamAndCloseTab(browser, server);
            expect(existsSync(chatPath), `chat file expected at ${chatPath}`).toBe(true);

            // Stream tail (~8s left) + LUKER_GENERATION_ACK_GRACE_MS (15s)
            // + persistence write. Poll rather than sleep so slow CI passes
            // and fast machines don't stall the suite.
            let asstLine = null;
            let lastLines = [];
            const deadline = Date.now() + 45_000;
            while (Date.now() < deadline) {
                try {
                    lastLines = readFileSync(chatPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
                    asstLine = lastLines.find(o => !o.is_user && String(o.mes || '').includes('chunk20'));
                    if (asstLine) break;
                } catch { /* file may not exist yet */ }
                await new Promise(r => setTimeout(r, 500));
            }

            expect(asstLine, `server-side auto-persist must write the assistant turn; lines=${JSON.stringify(lastLines.map(l => ({ is_user: l.is_user, mes: String(l.mes || '').slice(0, 60) })))}`).toBeTruthy();
            // Complete content — every one of the 20 chunks, in order.
            expect(asstLine.mes, 'persisted mes must equal the full streamed reply verbatim').toBe(SCRIPTED_REPLY);
            expect(asstLine.extra?.luker_server_persisted, 'assistant turn must carry the server-persisted marker').toBe(true);
            expect(asstLine.is_user).toBe(false);
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Scenario 2 — reopen through the UI; recovery preview streams.
    // ─────────────────────────────────────────────────────────────
    test.describe('scenario 2: reopened tab resumes via recovery preview', () => {
        let server, mock;

        test.beforeAll(async () => {
            mock = await startMockLLM({
                scriptedReplies: [SCRIPTED_REPLY],
                streamChunkDelayMs: CHUNK_DELAY_MS,
            });
            server = await startServer({ batchKey: 'generation', scenarioId: 'close-tab-ui-resume' });
            markOnboarded({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        });

        test.afterAll(async () => {
            await tearDownServer(server);
            await mock?.stop();
        });

        test('fresh tab shows the recovery preview streaming, then the persisted message', async ({ browser }) => {
            await startStreamAndCloseTab(browser, server);

            // Fresh tab, plain user flow: load page, pick the same character
            // (opens the same last-active chat), nothing else.
            const contextB = await browser.newContext();
            const pageB = await contextB.newPage();
            await awaitMainUI(pageB, server.baseURL);
            await selectCharacterByName(pageB, 'Seraphina');

            // The recovery preview bubble must show up with the buffered text.
            await pageB.waitForFunction(() => Boolean(document.querySelector('#luker_generation_recovery_preview')), { timeout: 20_000 });

            // Live growth: the preview must accumulate text while the job is
            // still streaming (throttled status frames), not jump straight to
            // full text at completion.
            let prevLen = -1;
            let grew = false;
            const growthDeadline = Date.now() + 20_000;
            while (Date.now() < growthDeadline) {
                const len = await pageB.evaluate(() =>
                    (document.querySelector('#luker_generation_recovery_preview .luker_preview_text')?.innerText || '').length,
                ).catch(() => -1);
                if (len < 0) break;   // preview gone (job completed early)
                if (prevLen >= 0 && len > prevLen) { grew = true; break; }
                prevLen = len;
                await new Promise(r => setTimeout(r, 400));
            }
            expect(grew, `preview text must grow live during the recovered stream; last sampled length=${prevLen}`).toBe(true);

            // It must reach the tail of the upstream stream (the awaiting_ack
            // status frame carries the authoritative full job.text).
            await pageB.waitForFunction(() => {
                const t = document.querySelector('#luker_generation_recovery_preview .luker_preview_text')?.innerText || '';
                return t.includes('chunk20');
            }, { timeout: 30_000 });

            // On terminal status the preview is removed and reloadCurrentChat
            // paints the real persisted message in its place.
            await pageB.waitForFunction(() => !document.querySelector('#luker_generation_recovery_preview'), { timeout: 45_000 });
            await pageB.waitForFunction(() => {
                const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
                for (const b of bubbles) {
                    if ((b.querySelector('.mes_text')?.innerText || '').includes('chunk20')) return true;
                }
                return false;
            }, { timeout: 20_000 });

            // And the disk copy holds the verbatim reply.
            const chatPath = await resolveChatPath(pageB, server.dataRoot);
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
            expect(asstLine, 'persisted chat.jsonl must contain the verbatim streamed reply').toBeTruthy();

            await contextB.close();
        });
    });
});
