// generation-basic #7 — auto-persist writes the exact upstream reply
// text to chat.jsonl on disk, for BOTH streaming and non-streaming
// generation paths.
//
// The persist path lives on the server (dispatch → job.text accumulator
// → auto-persist writer). basic.e2e.js already covers the streaming
// happy-path with the smoke assertion "chat.jsonl contains the reply
// substring"; here we pin down the exact-content contract that
// downstream users depend on:
//
//   - `mes` field equals the scripted reply verbatim (no truncation,
//     no HTML-entity mangling, no SSE `data:` prefix leakage, no extra
//     whitespace or trailing newline artifacts).
//   - `is_user` is false for the assistant turn.
//   - `send_date` parses as a plausible recent timestamp.
//
// The streaming variant additionally proves accumulateChunkTextIntoJob
// (see commit 2ae4464f7 + f199e5765) correctly assembles SSE frames
// into a single delta-free `mes` string at persist time. Both variants
// use the mockLLM so the scripted upstream reply is byte-exact.

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
} from '../_lib/page.js';

// Two carefully-chosen replies:
//   - The non-stream reply carries characters that would surface JSON-
//     escaping bugs (quotes, apostrophes, ampersands) if the persist
//     writer forgot to un-escape at read time.
//   - The stream reply carries multiple words so we can prove SSE
//     frame extraction assembled every delta into a single coherent
//     string.
// Both use only whitespace-single-space normalized content because the
// mockLLM's streaming path splits on /\s+/ and rejoins with a single
// space (see mockLLM.js line ~469-474) — any \n or repeated spaces in
// the source string would be flattened by the mock BEFORE they reach
// the persist layer and would produce a false "persist mangled it"
// failure. The DOM markdown renderer applies extra transforms
// (angle-bracket HTML → escaped, markdown emphasis) so we deliberately
// avoid `< > *` too; the persist contract is about what's on disk, not
// what the renderer displays.
const NONSTREAM_REPLY = 'Persisted reply from mock. Punctuation: "quoted" and \'apostrophe\' and ampersand&.';
const STREAM_REPLY = 'This is chunk one. This is chunk two. End of stream reply.';

async function resolveChatPath(page, dataRoot) {
    const avatarFolder = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        const c = ctx.characters[ctx.characterId];
        return (c?.avatar || '').replace(/\.png$/, '');
    });
    const chatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
    return resolve(dataRoot, 'default-user', 'chats', avatarFolder, `${chatId}.jsonl`);
}

test.describe('generation-basic: persist-to-disk contract (non-stream + stream)', () => {
    // ─────────────────────────────────────────────────────────────
    // Variant A — non-streaming
    // ─────────────────────────────────────────────────────────────
    test.describe('non-stream variant', () => {
        let server, mock;

        test.beforeAll(async () => {
            mock = await startMockLLM({ scriptedReplies: [NONSTREAM_REPLY] });
            server = await startServer({ batchKey: 'generation', scenarioId: 'persist-nonstream' });
            markOnboarded({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            // Force non-streaming for this variant. The bootstrap default
            // is `stream_openai: true`; flipping it here means the
            // GenerateOpenAI path builds a non-stream request and the
            // dispatcher's non-stream branch runs (single-chunk emit).
            const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
            const path = resolve(server.dataRoot, 'default-user/settings.json');
            const s = JSON.parse(rf(path, 'utf8'));
            s.oai_settings = s.oai_settings || {};
            s.oai_settings.stream_openai = false;
            wf(path, JSON.stringify(s, null, 4));
        });

        test.afterAll(async () => {
            await tearDownServer(server);
            await mock?.stop();
        });

        test('non-stream: chat.jsonl assistant `mes` equals the scripted reply verbatim', async ({ page }) => {
            const t0 = Date.now();
            await awaitMainUI(page, server.baseURL);
            await selectCharacterByName(page, 'Seraphina');
            await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

            const userText = 'Trigger the non-stream persistence path.';
            const { replyId, text: replyText } = await sendMessageAndAwaitReply(page, userText);
            expect(replyText, `rendered reply must include scripted body; got: ${JSON.stringify(replyText)}`).toContain('Persisted reply from mock.');

            const chatPath = await resolveChatPath(page, server.dataRoot);
            expect(existsSync(chatPath), `expected chat file at ${chatPath}`).toBe(true);

            // Auto-persist is debounced; give it a beat to flush the
            // reply-turn to disk before reading. We poll instead of
            // hard-sleeping so slow CI doesn't flake and fast machines
            // don't waste time.
            let lines = [];
            let asstLine = null;
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline) {
                lines = readFileSync(chatPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
                asstLine = lines.find(o => !o.is_user && String(o.mes || '').includes('Persisted reply from mock.'));
                if (asstLine) break;
                await new Promise(r => setTimeout(r, 200));
            }
            expect(asstLine, `assistant turn should be persisted; last read ${lines.length} lines`).toBeTruthy();

            // The `mes` field must equal the scripted reply exactly.
            // No htmlEscape, no truncation, no trailing whitespace, no
            // leading `data:` SSE prefix leakage.
            expect(asstLine.mes, `persisted mes must equal scripted reply verbatim`).toBe(NONSTREAM_REPLY);
            expect(asstLine.is_user, 'assistant turn must have is_user=false').toBe(false);

            // Timestamp sanity — send_date should parse and be within a
            // window that starts before this test started (allow for
            // clock skew) and ends now + a small buffer.
            const sendDateMs = Date.parse(asstLine.send_date);
            expect(Number.isFinite(sendDateMs), `send_date must parse; got ${JSON.stringify(asstLine.send_date)}`).toBe(true);
            expect(sendDateMs, `send_date must be within a plausible window`).toBeGreaterThan(t0 - 60_000);
            expect(sendDateMs, `send_date must not be in the future`).toBeLessThan(Date.now() + 60_000);
        });
    });

    // ─────────────────────────────────────────────────────────────
    // Variant B — streaming (proves accumulateChunkTextIntoJob's
    // SSE-frame assembly at persist time).
    // ─────────────────────────────────────────────────────────────
    test.describe('stream variant', () => {
        let server, mock;

        test.beforeAll(async () => {
            mock = await startMockLLM({
                scriptedReplies: [STREAM_REPLY],
                streamChunkDelayMs: 50,
            });
            server = await startServer({ batchKey: 'generation', scenarioId: 'persist-stream' });
            markOnboarded({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            // bootstrapCustomBackend already sets stream_openai: true —
            // no override needed here.
        });

        test.afterAll(async () => {
            await tearDownServer(server);
            await mock?.stop();
        });

        test('stream: SSE frames assemble into an exact `mes` at persist time', async ({ page }) => {
            const t0 = Date.now();
            await awaitMainUI(page, server.baseURL);
            await selectCharacterByName(page, 'Seraphina');
            await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

            const { replyId, text: replyText } = await sendMessageAndAwaitReply(page, 'Trigger the streaming persistence path.');
            expect(replyText).toContain('This is chunk one.');

            const chatPath = await resolveChatPath(page, server.dataRoot);
            expect(existsSync(chatPath), `expected chat file at ${chatPath}`).toBe(true);

            let lines = [];
            let asstLine = null;
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline) {
                lines = readFileSync(chatPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
                asstLine = lines.find(o => !o.is_user && String(o.mes || '').includes('End of stream reply'));
                if (asstLine) break;
                await new Promise(r => setTimeout(r, 200));
            }
            expect(asstLine, `stream assistant turn should be persisted; last read ${lines.length} lines`).toBeTruthy();

            // Exact-match invariant — the SSE frame accumulator (see
            // accumulateChunkTextIntoJob) must have joined every delta
            // into a single string identical to the scripted reply.
            // If SSE frame parsing was broken (e.g. the trailing frame
            // wasn't flushed), the `\nEnd of stream reply.` tail would
            // be missing; if `data:` prefixes leaked, the `mes` would
            // start with `data:`.
            expect(asstLine.mes, 'streamed mes must equal scripted reply verbatim after SSE reassembly').toBe(STREAM_REPLY);
            expect(asstLine.is_user).toBe(false);
            expect(asstLine.mes.startsWith('data:'), 'persisted mes must not carry the SSE `data:` prefix').toBe(false);

            const sendDateMs = Date.parse(asstLine.send_date);
            expect(Number.isFinite(sendDateMs)).toBe(true);
            expect(sendDateMs).toBeGreaterThan(t0 - 60_000);
            expect(sendDateMs).toBeLessThan(Date.now() + 60_000);
        });
    });
});
