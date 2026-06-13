// Case #96 — Caption extension: upload an image, auto-caption fires,
//             caption text appears in the resulting chat message.
//
// Spec:
//   1. Enable caption extension with source='local' (which POSTs to
//      Luker's /api/extra/caption endpoint, a transformers-pipeline route).
//   2. Stub /api/extra/caption via page.route with a deterministic body so
//      the test doesn't depend on the transformers model being downloaded.
//   3. Drive the chat-input "upload picture" pathway: feed a small PNG into
//      the hidden #img_file input the caption extension installs in #form_sheld
//      and fire the change event.
//   4. Verify a user-side chat message lands whose body includes the caption
//      text + a media attachment whose URL serves the PNG bytes.
//
// Why local + page.route instead of multimodal + LLM mock:
//   The "real" path the test brief asks about is "upload image → caption
//   request fires → caption text appears". With source='multimodal' we'd
//   route through /api/openai/caption-image which itself talks to the
//   custom URL — equivalent indirection, more moving parts. Local +
//   page.route is the smallest mock surface that exercises the full
//   onSelectImage → getCaptionForFile → sendCaptionedMessage chain.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

// A 1x1 transparent PNG. The caption extension reads the file via
// FileReader → base64 and POSTs it to the captioner backend.
const ONE_PX_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const STUB_CAPTION = 'A wind-bitten cartographer\'s spyglass laid across a reef chart, lantern light reflected on the brass.';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash glances at the picture, then folds the chart.* "Good likeness of the spyglass."',
    ] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '96-caption' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#96 — Caption: upload → auto-caption → chat bubble', () => {
    test('uploading a PNG into the hidden #img_file fires /api/extra/caption and a captioned user message is appended', async ({ page }) => {
        // Stub the local-caption backend BEFORE awaitMainUI so any boot
        // probes are also intercepted. Track call count.
        let captionCalls = 0;
        let lastCaptionPayload = null;
        await page.route(/\/api\/extra\/caption$/, async (route) => {
            captionCalls += 1;
            try { lastCaptionPayload = JSON.parse(route.request().postData() || '{}'); } catch {}
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ caption: STUB_CAPTION }),
            });
        });

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Configure the caption extension. show_in_chat=true so the image
        // is rendered inline. The local source uses /api/extra/caption.
        await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            ctx.extensionSettings.caption = ctx.extensionSettings.caption || {};
            const cap = ctx.extensionSettings.caption;
            cap.source = 'local';
            cap.refine_mode = false;          // never prompt the user — keep flow non-interactive
            cap.prompt_ask = false;
            cap.show_in_chat = true;
            cap.template = '[{{user}} sends {{char}} a picture that contains: {{caption}}]';
            ctx.saveSettingsDebounced();
        });

        // The caption extension appends a hidden file input to #form_sheld:
        //   <form id="img_form"><input type="file" id="img_file" hidden></form>
        // Wait until init finished and the element exists.
        const fileInput = page.locator('#img_file');
        await fileInput.waitFor({ state: 'attached', timeout: 15_000 });

        const chatLenBefore = await page.evaluate(() => window.SillyTavern.getContext().chat.length);

        // Set the file. setInputFiles with a buffer is the Playwright
        // canonical way; the caption extension wires `change` → onSelectImage.
        const pngBytes = Buffer.from(ONE_PX_PNG_BASE64, 'base64');
        await fileInput.setInputFiles({
            name: 'spyglass.png',
            mimeType: 'image/png',
            buffer: pngBytes,
        });

        // The whole pipeline is async: getBase64Async → /api/extra/caption →
        // saveBase64AsFile → sendCaptionedMessage. Wait for the new chat
        // message to appear at the tail.
        await page.waitForFunction((targetLen) => {
            const ctx = window.SillyTavern.getContext();
            return ctx.chat.length > targetLen;
        }, chatLenBefore, { timeout: 30_000 });

        // ===== Assert the stub was called. =====
        expect(captionCalls, 'caption extension must POST to /api/extra/caption').toBeGreaterThan(0);
        expect(lastCaptionPayload?.image, 'payload must include a base64 image field').toBeTruthy();
        expect(typeof lastCaptionPayload.image).toBe('string');

        // ===== Assert the captioned user message has the right shape. =====
        const tail = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            const m = ctx.chat[ctx.chat.length - 1];
            return {
                isUser: !!m?.is_user,
                mes: m?.mes,
                media: Array.isArray(m?.extra?.media)
                    ? m.extra.media.map(x => ({ url: x.url, type: x.type, source: x.source, captioned: !!x.captioned, title: x.title }))
                    : null,
            };
        });
        // sendCaptionedMessage sets is_user=true and wraps the caption in
        // the template. The full caption text (no truncation) must appear
        // in the bubble per feedback_no_silent_truncation.
        expect(tail.isUser).toBe(true);
        expect(tail.mes).toContain(STUB_CAPTION);
        expect(tail.media, 'captioned message must carry the uploaded image as media').toBeTruthy();
        expect(tail.media.length).toBeGreaterThan(0);
        expect(tail.media[0].captioned).toBe(true);
        expect(tail.media[0].source).toBe('captioned');

        // Verify the saved attachment is the actual PNG bytes we sent.
        const fetched = await page.evaluate(async (url) => {
            const r = await fetch(url);
            const buf = await r.arrayBuffer();
            const bytes = new Uint8Array(buf);
            return {
                ok: r.ok,
                length: bytes.length,
                isPng: bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
            };
        }, tail.media[0].url);
        expect(fetched.ok).toBe(true);
        expect(fetched.isPng).toBe(true);
        expect(fetched.length).toBeGreaterThan(50);
    });
});
