// #49 — Attachment upload → in chat → in prompt.
//
// Drive the in-chat attachment workflow programmatically:
//   1. Upload a text file via POST /api/files/upload (the same endpoint the
//      drag-drop UI calls under the hood).
//   2. Attach it to the next user message by populating message.extra.files
//      (the same data shape that drag-drop produces).
//   3. Trigger a generation and verify the mock LLM receives a request whose
//      body references the attachment (either inline text content or a file
//      URL referenced in the message body).
//
// The test deliberately programmatic-drives the attach because the
// drag-and-drop primitive in Playwright is brittle and the data-shape
// contract (message.extra.files entries) is what we actually care about
// locking in for the prompt-injection regression class.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

const ATTACHMENT_TEXT = [
    'Bryn-headland reef log — 14th of the seventh moon.',
    'Salt-mark drifter skiff: two lanterns spotted three breakers north of the gull rocks.',
    'Tide level: minus seven from the marker stone. Wind: WSW, steady.',
].join('\n');

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash glances over the page you handed her.* "The drifters never light two lanterns by accident. Stay low."',
    ] });
    server = await startServer({ batchKey: 'server', scenarioId: 'attach' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#49 — chat attachment → upload → referenced in prompt body', () => {
    test('text file attachment surfaces in the next LLM request', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // (1) Upload the file via /api/files/upload (server stores it under
        //     <user-root>/files/<name>).
        const uploadResult = await page.evaluate(async ({ name, text }) => {
            const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await csrfResp.json();
            const data = btoa(unescape(encodeURIComponent(text)));
            const resp = await fetch('/api/files/upload', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                body: JSON.stringify({ name, data }),
            });
            const body = await resp.text();
            return { status: resp.status, body: body.slice(0, 200) };
        }, { name: 'reef-log.txt', text: ATTACHMENT_TEXT });

        expect(uploadResult.status, `upload returned ${uploadResult.status} ${uploadResult.body}`).toBe(200);
        const uploadedPath = JSON.parse(uploadResult.body).path;
        expect(uploadedPath).toMatch(/files\//);

        // (2) Attach to the next user message by writing extra.files on the
        //     intended turn. Easiest approach: send a user message via slash,
        //     then mutate the just-added user msg's extra.files BEFORE the
        //     /trigger fires. But our sendMessageAndAwaitReply does
        //     `/send | /trigger` as one chain. Instead, do it in two steps:
        //     append the user message + attachment, then /trigger.
        const userText = 'Take a look at this reef log I picked up at the headland.';
        const before = mock.requests.length;
        await page.evaluate(async ({ text, fileUrl, fileName, fileText }) => {
            const ctx = window.Luker.getContext();
            // Append the user message manually with extra.files populated.
            ctx.chat.push({
                name: ctx.name1 || 'You',
                is_user: true,
                send_date: new Date().toString(),
                mes: text,
                extra: {
                    files: [{
                        url: fileUrl,
                        name: fileName,
                        text: fileText,
                        size: fileText.length,
                    }],
                },
            });
            await ctx.saveChat();
            // Now trigger generation.
            await ctx.executeSlashCommandsWithOptions('/trigger');
        }, { text: userText, fileUrl: uploadedPath, fileName: 'reef-log.txt', fileText: ATTACHMENT_TEXT });

        // Wait for the reply event.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            const last = ctx.chat?.[ctx.chat.length - 1];
            return last && !last.is_user && (last.mes || '').length > 0;
        }, { timeout: 30_000 });

        // (3) Inspect the most recent chat-completions request and verify it
        //     references the attachment — either by URL, filename, or text.
        const newReq = mock.requests.slice(before).find(r => r.url.includes('chat/completions'));
        expect(newReq, `no chat/completions request observed after /trigger; saw ${mock.requests.slice(before).map(r => r.url).join(',')}`).toBeTruthy();
        const payload = JSON.stringify(newReq.body);
        const referenced = payload.includes('reef-log.txt')
            || payload.includes('Bryn-headland reef log')
            || payload.includes(uploadedPath);
        expect(referenced, `prompt body should reference attachment (filename/text/URL). Body snippet: ${payload.slice(0, 800)}`).toBe(true);
    });
});
