// #49 — Attachment upload → in chat → in prompt.
//
// Drive the user-visible attachment workflow:
//   1. Open the extensions wand menu (#extensionsMenuButton).
//   2. Click the visible "Attach a File" item (#attachFile) which the
//      attachments extension renders inside #attach_file_wand_container.
//   3. Set the file on the hidden #file_form_input via setInputFiles —
//      ST's onFileAttach change handler picks it up.
//   4. Send a real user message via the send_textarea + send_but path.
//      The composer's populateFileAttachment uploads the file under
//      <user-root>/files/<name> and writes the URL + base64 text into
//      extra.files on the outgoing message.
//   5. Assert the mock LLM receives a request whose body references the
//      attachment (URL, filename, or text content).

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

test.describe('#49 — chat attachment via real paperclip → referenced in prompt body', () => {
    test('text file attachment surfaces in the next LLM request', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Open the extensions wand menu so #attachFile becomes interactable.
        // The wand sits in the composer row; clicking it shows #extensionsMenu.
        await page.locator('#extensionsMenuButton').click();
        const attachItem = page.locator('#attachFile');
        await attachItem.waitFor({ state: 'visible', timeout: 5000 });
        // Clicking #attachFile arms the .on('change') for #file_form_input
        // and triggers a click on it. setInputFiles then fires change with
        // the bytes we provide, which onFileAttach picks up.
        await attachItem.click();

        // Drop the file into the now-armed hidden input. Use a real
        // text/plain payload so populateFileAttachment encodes it cleanly
        // and the prompt body carries the original text.
        const fileInput = page.locator('#file_form_input');
        await fileInput.setInputFiles({
            name: 'reef-log.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from(ATTACHMENT_TEXT, 'utf8'),
        });

        // Wait for the form-display row to flip out of displayNone — that's
        // the user-visible indicator the file is attached + queued.
        await page.locator('#file_form:not(.displayNone)').waitFor({ state: 'visible', timeout: 10_000 });

        const userText = 'Take a look at this reef log I picked up at the headland.';
        const before = mock.requests.length;
        await sendMessageAndAwaitReply(page, userText);

        // Inspect the chat completion request and verify it references the
        // attachment — either by URL, filename, or text content.
        const newReq = mock.requests.slice(before).find(r => r.url.includes('chat/completions'));
        expect(newReq, `no chat/completions request observed after send; saw ${mock.requests.slice(before).map(r => r.url).join(',')}`).toBeTruthy();
        const payload = JSON.stringify(newReq.body);
        const referenced = payload.includes('reef-log.txt')
            || payload.includes('Bryn-headland reef log')
            || payload.includes('Salt-mark drifter')
            || /files\/.*reef-log/.test(payload);
        expect(referenced, `prompt body should reference attachment (filename/text/URL). Body snippet: ${payload.slice(0, 800)}`).toBe(true);

        // Sanity: the just-sent user message in chat carries extra.files
        // with the captured upload URL. This proves we went through the
        // real onFileAttach + populateFileAttachment chain, not a side
        // injection.
        const lastUserFiles = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const last = [...ctx.chat].reverse().find(m => m.is_user);
            return last?.extra?.files || null;
        });
        expect(lastUserFiles, 'sent user message should carry extra.files').toBeTruthy();
        expect(Array.isArray(lastUserFiles)).toBe(true);
        expect(lastUserFiles.length).toBeGreaterThan(0);
        expect(String(lastUserFiles[0]?.name || '')).toBe('reef-log.txt');
    });
});
