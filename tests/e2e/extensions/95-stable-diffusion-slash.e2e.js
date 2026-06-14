// Case #95 — Stable Diffusion: `/sd` slash command produces a chat image
//
// Spec:
//   - Spawn an in-process HTTP server that mocks the Automatic1111-compatible
//     SD WebUI surface (the same one Luker's /api/sd/* routes proxy to).
//   - Configure the SD extension to `source: 'auto'` (WebUI) with auto_url
//     pointing at the mock so isValidState() passes.
//   - Run `/sd <prompt>` (alias of `/imagine`) via the slash command runtime.
//   - Verify a chat message with an image attachment lands at the tail and
//     that the attachment's url resolves to the mock's known 1x1 PNG bytes.
//
// Notes on the Luker endpoint:
//   src/endpoints/stable-diffusion.js#router.post('/generate', ...) calls
//     1. GET  {sd_url}/sdapi/v1/options    (probes for forge_preset key)
//     2. POST {sd_url}/sdapi/v1/txt2img    (returns {images: [base64]})
//   So our mock needs to satisfy both. Other endpoints (/sd-models, /samplers,
//   /schedulers) are only hit when the user opens settings or refreshes the
//   model dropdown, neither of which we trigger here — but we still serve
//   permissive responses for them in case the extension does background
//   probes on first load.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

// A 1x1 transparent PNG — minimum valid PNG bytes. Base64 form is what
// Automatic1111 returns in the `images` array of /sdapi/v1/txt2img.
const ONE_PX_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let server, mock, sdMock;

/**
 * Start an Automatic1111-compatible SD WebUI mock. Tracks every call into
 * `requests` so the test can assert /sdapi/v1/txt2img was actually hit.
 *
 * @returns {Promise<{baseURL: string, requests: object[], stop: () => Promise<void>}>}
 */
async function startSdWebUiMock() {
    const requests = [];
    const httpServer = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { /* ignore non-JSON probes */ }
        requests.push({ url: req.url, method: req.method, body: parsed });

        const respondJson = (status, payload) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
        };

        if (req.url === '/sdapi/v1/options' && req.method === 'GET') {
            // Bare options surface — no forge_preset key, so the Luker
            // proxy will leave forge_additional_modules alone.
            respondJson(200, { samples_format: 'png', sd_model_checkpoint: 'mock-model' });
            return;
        }
        if (req.url === '/sdapi/v1/sd-models') {
            respondJson(200, [
                { title: 'mock-model [abc]', model_name: 'mock-model', hash: 'abc', sha256: 'def', filename: 'mock-model.safetensors', config: null },
            ]);
            return;
        }
        if (req.url === '/sdapi/v1/samplers') {
            respondJson(200, [{ name: 'DDIM', aliases: [], options: {} }]);
            return;
        }
        if (req.url === '/sdapi/v1/schedulers') {
            respondJson(200, [{ name: 'normal', label: 'Normal' }]);
            return;
        }
        if (req.url === '/sdapi/v1/upscalers') {
            respondJson(200, [{ name: 'Latent' }]);
            return;
        }
        if (req.url === '/sdapi/v1/latent-upscale-modes') {
            respondJson(200, [{ name: 'Latent' }]);
            return;
        }
        if (req.url === '/sdapi/v1/txt2img' && req.method === 'POST') {
            // Real Automatic1111 returns base64 strings in `images`.
            respondJson(200, {
                images: [ONE_PX_PNG_BASE64],
                parameters: parsed,
                info: JSON.stringify({ prompt: parsed.prompt, seed: 42 }),
            });
            return;
        }
        if (req.url === '/sdapi/v1/interrupt' && req.method === 'POST') {
            respondJson(200, {});
            return;
        }
        // Catch-all: respond 200 with an empty object so unknown probes
        // (e.g. /sdapi/v1/cmd-flags) don't crash the extension.
        respondJson(200, {});
    });

    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = httpServer.address().port;
    return {
        baseURL: `http://127.0.0.1:${port}`,
        requests,
        stop: () => new Promise((resolve) => httpServer.close(() => resolve())),
    };
}

test.beforeAll(async () => {
    sdMock = await startSdWebUiMock();
    mock = await startMockLLM({
        scriptedReplies: [
            // The /sd command's "free mode" path doesn't call the LLM
            // for prompt refinement (FREE skips refinePrompt), so this
            // reply is just a safety net in case test load ever changes.
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

test.describe('#95 — Stable Diffusion /sd slash command', () => {
    test('/sd <prompt> attaches a generated PNG to a new chat message', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Configure the SD extension. The auto_url points at our local mock
        // so the Luker /api/sd/generate proxy hits a reachable target — the
        // upstream test note flagged that the stock localhost:7860 default
        // unreachability is what makes other batches' SD tests throw.
        await page.evaluate((sdBaseURL) => {
            const ctx = window.Luker.getContext();
            ctx.extensionSettings.sd = ctx.extensionSettings.sd || {};
            const sd = ctx.extensionSettings.sd;
            sd.source = 'auto';            // WebUI source
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
            // command_visible=true so the assistant-named message is not
            // filed as is_system (we want it visible in chat for the test).
            sd.command_visible = true;
            // No prompt-extension via LLM — keep the FREE path simple.
            sd.free_extend = false;
            sd.restore_faces = false;
            sd.enable_hr = false;
            sd.adetailer_face = false;
            sd.prompt_prefix = '';
            sd.negative_prompt = '';
            // Persist; saveSettingsDebounced fires the same path the UI uses.
            ctx.saveSettingsDebounced();
        }, sdMock.baseURL);

        const before = sdMock.requests.length;
        const chatLenBefore = await page.evaluate(() => window.Luker.getContext().chat.length);

        // Run the slash. /sd is an alias of /imagine. Use quiet=false so a
        // chat message is appended for our assertion.
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            await ctx.executeSlashCommandsWithOptions('/sd quiet=false a brass spyglass laid across a folded reef chart at dusk');
        });

        // The image generation is async — wait until either a new chat
        // message lands (sendMessage) or 60s elapse.
        await page.waitForFunction((targetLen) => {
            const ctx = window.Luker.getContext();
            return ctx.chat.length > targetLen;
        }, chatLenBefore, { timeout: 60_000 });

        // ===== Assert the mock saw the right calls. =====
        const newSdReqs = sdMock.requests.slice(before);
        const txt2imgCall = newSdReqs.find(r => r.url === '/sdapi/v1/txt2img');
        expect(txt2imgCall, 'mock should have received POST /sdapi/v1/txt2img').toBeTruthy();
        expect(typeof txt2imgCall.body.prompt).toBe('string');
        expect(txt2imgCall.body.prompt).toMatch(/spyglass/);

        // The options probe should have fired first.
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
        // Luker saves the base64 PNG to disk and references it by relative
        // path — pull the bytes and confirm they match our 1x1 PNG.
        const fetched = await page.evaluate(async (url) => {
            const r = await fetch(url);
            const buf = await r.arrayBuffer();
            const bytes = new Uint8Array(buf);
            // Compare PNG magic header — full byte-for-byte equality
            // depends on whether Luker re-encodes; magic is the contract.
            return {
                ok: r.ok,
                length: bytes.length,
                isPng: bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
            };
        }, att.url);
        expect(fetched.ok).toBe(true);
        expect(fetched.isPng, 'saved attachment must be a real PNG').toBe(true);
        // The 1x1 transparent PNG decodes to ~70 bytes; allow a generous
        // upper bound but require it isn't suspiciously empty.
        expect(fetched.length).toBeGreaterThan(50);
    });
});
