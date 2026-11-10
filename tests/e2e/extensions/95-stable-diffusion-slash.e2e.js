// Case #95 — Stable Diffusion: `/imagine` slash via real send textarea
//
// Spec:
//   - Spawn an in-process HTTP server that mocks the Automatic1111-compatible
//     SD WebUI surface.
//   - Configure the SD extension to source='auto' with auto_url pointing at
//     the mock so isValidState() passes.
//   - Type `/imagine <prompt>` into #send_textarea and click #send_but to
//     run the slash command exactly as a user would.
//   - Verify a chat message with an image attachment lands at the tail.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { startSdWebUiMock } from '../_lib/sdMock.js';

let server, mock, sdMock;

test.beforeAll(async () => {
    sdMock = await startSdWebUiMock();
    mock = await startMockLLM({
        scriptedReplies: [
            '*Ash sets the brass spyglass down to admire the sketch.* "Sharp eye for the gull rocks."',
        ],
    });
    server = await startServer({ batchKey: 'extensions', scenarioId: '95-stable-diffusion' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
    await sdMock?.stop();
});

test.describe('#95 — Stable Diffusion /imagine via real send textarea + send button', () => {
    test('typing /imagine ... + clicking send attaches a generated PNG to a new chat message', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Establish the chat-completion connection with the real plug button.
        // e2e starts from persisted settings; the status check is a user gesture.
        await page.evaluate(() => document.querySelector('#api_button_openai').click());
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Configure the SD extension via its persisted settings (programmatic
        // setup — same as opening the SD drawer and configuring it by hand,
        // but headless). The ACT below is the real slash gesture.
        await page.evaluate((sdBaseURL) => {
            const ctx = window.Luker.getContext();
            ctx.extensionSettings.sd = ctx.extensionSettings.sd || {};
            const sd = ctx.extensionSettings.sd;
            sd.source = 'auto';
            sd.auto_url = sdBaseURL;
            sd.auto_auth = '';
            sd.steps = 20;
            sd.scale = 7;
            sd.width = 64;
            sd.height = 64;
            sd.sampler = 'DDIM';
            sd.scheduler = 'normal';
            sd.seed = -1;
            sd.model = 'mock-model';
            sd.vae = '';
            sd.command_visible = true;
            sd.free_extend = false;
            sd.restore_faces = false;
            sd.enable_hr = false;
            sd.adetailer_face = false;
            sd.prompt_prefix = '';
            sd.negative_prompt = '';
            ctx.saveSettingsDebounced();
        }, sdMock.baseURL);

        const before = sdMock.requests.length;
        const chatLenBefore = await page.evaluate(() => window.Luker.getContext().chat.length);

        // REAL gesture: type the slash into #send_textarea, click #send_but.
        const textarea = page.locator('#send_textarea');
        await textarea.fill('/imagine quiet=false a brass spyglass laid across a folded reef chart at dusk');
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 10_000 });
        await page.locator('#send_but').click();

        // Image generation is async — wait for the new chat message to land.
        await page.waitForFunction((targetLen) => {
            const ctx = window.Luker.getContext();
            return ctx.chat.length > targetLen;
        }, chatLenBefore, { timeout: 60_000 });

        // ===== Assert mock saw the expected calls. =====
        const newSdReqs = sdMock.requests.slice(before);
        const txt2imgCall = newSdReqs.find(r => r.url === '/sdapi/v1/txt2img');
        expect(txt2imgCall, 'mock should have received POST /sdapi/v1/txt2img').toBeTruthy();
        expect(typeof txt2imgCall.body.prompt).toBe('string');
        expect(txt2imgCall.body.prompt).toMatch(/spyglass/);

        const optionsCall = newSdReqs.find(r => r.url === '/sdapi/v1/options');
        expect(optionsCall, 'Luker proxy should probe /sdapi/v1/options before /txt2img').toBeTruthy();

        // ===== Assert the chat message has the expected attachment. =====
        const tail = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat[ctx.chat.length - 1];
            return {
                name: m?.name,
                isUser: !!m?.is_user,
                isSystem: !!m?.is_system,
                mes: m?.mes,
                media: Array.isArray(m?.extra?.media) ? m.extra.media.map(x => ({ url: x.url, type: x.type, source: x.source })) : null,
            };
        });

        expect(tail.media, 'new tail message must carry a media attachment').toBeTruthy();
        expect(tail.media.length).toBeGreaterThan(0);
        const att = tail.media[0];
        expect(att.url, 'attachment url must be present').toBeTruthy();
        const fetched = await page.evaluate(async (url) => {
            const r = await fetch(url);
            const buf = await r.arrayBuffer();
            const bytes = new Uint8Array(buf);
            return {
                ok: r.ok,
                length: bytes.length,
                isPng: bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
            };
        }, att.url);
        expect(fetched.ok).toBe(true);
        expect(fetched.isPng, 'saved attachment must be a real PNG').toBe(true);
        expect(fetched.length).toBeGreaterThan(50);
    });
});
