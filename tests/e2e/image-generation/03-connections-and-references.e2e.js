// SPDX-License-Identifier: AGPL-3.0-or-later

import http from 'node:http';
import zlib from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI, openExtensionsDrawer, openInlineDrawer, closeAnyOpenTopSettingsDrawer,
    selectCharacterByName, sendMessageAndAwaitReply,
} from '../_lib/page.js';
import { ONE_PX_PNG_BASE64, startSdWebUiMock } from '../_lib/sdMock.js';
import { startComfyMock } from '../_lib/comfyMock.js';

function createSingleFileZipBuffer(filename, data) {
    const nameBuf = Buffer.from(filename, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const size = data.length;

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(0, 42);
    nameBuf.copy(centralHeader, 46);

    const cdOffset = localHeader.length + size;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralHeader.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([localHeader, data, centralHeader, eocd]);
}

async function startGeminiImageMock() {
    const requests = [];
    const httpServer = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        if (req.method === 'GET' && pathname.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                models: [{ name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] }],
            }));
            return;
        }
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
        requests.push({
            url: req.url,
            method: req.method,
            headers: { ...req.headers },
            body: parsed,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            candidates: [{
                content: {
                    parts: [{
                        inlineData: {
                            mimeType: 'image/png',
                            data: ONE_PX_PNG_BASE64,
                        },
                    }],
                },
            }],
        }));
    });
    await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
    return {
        baseURL: `http://127.0.0.1:${httpServer.address().port}`,
        requests,
        stop: () => new Promise(r => httpServer.close(() => r())),
    };
}

async function startNovelImageMock() {
    const encodeVibeRequests = [];
    const generateRequests = [];
    const zipBuffer = createSingleFileZipBuffer('image_0.png', Buffer.from(ONE_PX_PNG_BASE64, 'base64'));
    const httpServer = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;

        if (pathname === '/ai/encode-vibe' && req.method === 'POST') {
            encodeVibeRequests.push({ headers: { ...req.headers }, body: parsed });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ encoding: 'vibe-encoded-blob-e2e' }));
            return;
        }
        if (pathname === '/ai/generate-image' && req.method === 'POST') {
            generateRequests.push({ headers: { ...req.headers }, body: parsed });
            res.writeHead(200, { 'content-type': 'application/zip' });
            res.end(zipBuffer);
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
    });
    await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
    return {
        baseURL: `http://127.0.0.1:${httpServer.address().port}`,
        encodeVibeRequests,
        generateRequests,
        stop: () => new Promise(r => httpServer.close(() => r())),
    };
}

const REF_COMFY_WORKFLOW = {
    3: {
        class_type: 'KSampler',
        inputs: {
            seed: '%seed%',
            steps: '%steps%',
            cfg: '%scale%',
            sampler_name: '%sampler%',
            scheduler: '%scheduler%',
            denoise: '%denoise%',
            model: ['4', 0],
            positive: ['15', 0],
            negative: ['7', 0],
            latent_image: ['5', 0],
        },
    },
    4: {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: '%model%' },
    },
    5: {
        class_type: 'EmptyLatentImage',
        inputs: { width: '%width%', height: '%height%', batch_size: 1 },
    },
    6: {
        class_type: 'CLIPTextEncode',
        inputs: { text: '%prompt%', clip: ['4', 1] },
    },
    7: {
        class_type: 'CLIPTextEncode',
        inputs: { text: '%negative_prompt%', clip: ['4', 1] },
    },
    8: {
        class_type: 'VAEDecode',
        inputs: { samples: ['3', 0], vae: ['4', 2] },
    },
    9: {
        class_type: 'SaveImage',
        inputs: { images: ['8', 0], filename_prefix: 'ref-test' },
    },
    11: {
        class_type: 'LoadImage',
        inputs: { image: '%ref_image_1%' },
    },
    12: {
        class_type: 'LoadImage',
        inputs: { image: '%ref_image_2%' },
    },
    13: {
        class_type: 'ImageBatch',
        inputs: { image1: ['11', 0], image2: ['12', 0] },
    },
    14: {
        class_type: 'VAEEncode',
        inputs: { pixels: ['13', 0], vae: ['4', 2] },
    },
    15: {
        class_type: 'ReferenceLatent',
        inputs: { conditioning: ['6', 0], latent: ['14', 0] },
    },
};

const PLAIN_COMFY_WORKFLOW = {
    3: {
        class_type: 'KSampler',
        inputs: {
            seed: '%seed%',
            steps: '%steps%',
            cfg: '%scale%',
            sampler_name: '%sampler%',
            scheduler: '%scheduler%',
            denoise: '%denoise%',
            model: ['4', 0],
            positive: ['6', 0],
            negative: ['7', 0],
            latent_image: ['5', 0],
        },
    },
    4: {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: '%model%' },
    },
    5: {
        class_type: 'EmptyLatentImage',
        inputs: { width: '%width%', height: '%height%', batch_size: 1 },
    },
    6: {
        class_type: 'CLIPTextEncode',
        inputs: { text: '%prompt%', clip: ['4', 1] },
    },
    7: {
        class_type: 'CLIPTextEncode',
        inputs: { text: '%negative_prompt%', clip: ['4', 1] },
    },
    8: {
        class_type: 'VAEDecode',
        inputs: { samples: ['3', 0], vae: ['4', 2] },
    },
    9: {
        class_type: 'SaveImage',
        inputs: { images: ['8', 0], filename_prefix: 'plain-test' },
    },
};

function seedConnectionAndReferenceFixtures({ dataRoot, mockBaseURL, geminiBaseURL }) {
    const userDir = resolve(dataRoot, 'default-user');
    const pngBytes = Buffer.from(ONE_PX_PNG_BASE64, 'base64');

    const refImagePath = resolve(userDir, 'user/images/_references/e2e_char_ref.png');
    mkdirSync(dirname(refImagePath), { recursive: true });
    writeFileSync(refImagePath, pngBytes);

    const styleUploadPath = resolve(dataRoot, 'e2e_upload_style.png');
    writeFileSync(styleUploadPath, pngBytes);

    const workflowPath = resolve(userDir, 'user/workflows/RefTest.json');
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, JSON.stringify(REF_COMFY_WORKFLOW, null, 4));

    const plainWorkflowPath = resolve(userDir, 'user/workflows/PlainTextOnly.json');
    writeFileSync(plainWorkflowPath, JSON.stringify(PLAIN_COMFY_WORKFLOW, null, 4));

    const secretsPath = resolve(userDir, 'secrets.json');
    writeFileSync(secretsPath, JSON.stringify({
        _migrated: true,
        api_key_makersuite: [
            { id: 'sec-global-google', value: 'global-key-must-never-leak', label: 'Global', active: true },
            { id: 'sec-gemini-profile', value: 'profile-key-gemini-ok', label: 'GeminiProfile', active: false },
            { id: 'sec-deletable', value: 'deletable-key', label: 'TempProfile', active: false },
        ],
        api_key_novel: [
            { id: 'sec-novel', value: 'novel-token-e2e', label: 'NovelKey', active: true },
        ],
        api_key_custom: [
            { id: 'sec-chat-mock', value: 'chat-mock-key', label: 'ChatMock', active: true },
        ],
    }, null, 4));

    const settingsPath = resolve(userDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.connectionManager = {
        selectedProfile: null,
        profiles: [
            {
                id: 'prof-chat-mock',
                mode: 'cc',
                name: 'e2e-chat-mock',
                api: 'custom',
                'api-url': mockBaseURL,
                'secret-id': 'sec-chat-mock',
                model: 'mock-gpt-4o',
            },
            {
                id: 'prof-gemini-valid',
                mode: 'cc',
                name: 'e2e-gemini-profile',
                api: 'makersuite',
                'api-url': geminiBaseURL,
                'secret-id': 'sec-gemini-profile',
                model: 'gemini-2.5-flash-image',
            },
            {
                id: 'prof-gemini-temp',
                mode: 'cc',
                name: 'e2e-deletable-profile',
                api: 'makersuite',
                'api-url': geminiBaseURL,
                'secret-id': 'sec-deletable',
                model: 'gemini-2.5-flash-image',
            },
        ],
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
    return { styleUploadPath };
}

let server, mock, sdMock, comfy, geminiMock, novelMock, styleUploadPath;
let rerunCounter = 0;

test.beforeAll(async () => {
    sdMock = await startSdWebUiMock();
    comfy = await startComfyMock();
    geminiMock = await startGeminiImageMock();
    novelMock = await startNovelImageMock();
    mock = await startMockLLM();
    mock.scriptCompletion(({ toolNames, userMessages }) => {
        if (toolNames.includes('add_image_prompt')) {
            const callIdx = ++rerunCounter;
            return {
                toolCalls: [
                    {
                        name: 'add_image_prompt',
                        arguments: {
                            prompt: `1girl, brass compass, run ${callIdx}`,
                            insert_after: 'brass compass',
                            insert_before: 'on the oak desk',
                        },
                    },
                    {
                        name: 'add_image_prompt',
                        arguments: {
                            prompt: `1girl, silver astrolabe, run ${callIdx}`,
                            insert_after: 'silver astrolabe',
                            insert_before: 'beside the candle',
                        },
                    },
                ],
            };
        }
        if (userMessages.some(text => text.includes('Show both instruments'))) {
            return {
                text: '*Ash places the brass compass on the oak desk, then aligns the silver astrolabe beside the candle.*',
            };
        }
        return { text: '*Ash nods quietly.*' };
    });

    server = await startServer({ batchKey: 'image-illustration', scenarioId: '03-connections-and-references' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    ({ styleUploadPath } = seedConnectionAndReferenceFixtures({
        dataRoot: server.dataRoot,
        mockBaseURL: mock.baseURL,
        geminiBaseURL: geminiMock.baseURL,
    }));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
    await sdMock?.stop();
    await comfy?.stop();
    await geminiMock?.stop();
    await novelMock?.stop();
});

async function openSdSettings(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'sd_container');
}

async function connectChatCompletion(page) {
    await page.locator('#sys-settings-button > .drawer-toggle').click();
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(mock.baseURL);
    await page.locator('#api_button_openai').click();
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await closeAnyOpenTopSettingsDrawer(page);
}

async function sendImagine(page, command) {
    await closeAnyOpenTopSettingsDrawer(page);
    await page.locator('#send_textarea').fill(command);
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#send_but').click();
}

async function runImagineAndWaitForChatMessage(page, command) {
    const beforeLen = await page.evaluate(() => window.Luker.getContext().chat.length);
    await sendImagine(page, command);
    await page.waitForFunction(
        len => window.Luker.getContext().chat.length > len,
        beforeLen,
        { timeout: 60_000 },
    );
}

test.describe.configure({ mode: 'serial' });

test.describe('connection binding, reference protocols, and illustration version controls', () => {
    test('binds connection profiles with fail-fast missing-profile error and routes references across Gemini, NovelAI V4.5, and ComfyUI', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await connectChatCompletion(page);

        // 1. Bind a Connection Profile in SD settings, then delete that profile via Connection Manager UI.
        await openSdSettings(page);
        await page.locator('#sd_source').selectOption('google');
        await page.locator('#sd_model').selectOption('gemini-2.5-flash-image');
        await page.locator('#sd_connection_profile').selectOption('e2e-deletable-profile');
        await expect(page.locator('#sd_direct_api_key_row')).toBeHidden();

        await closeAnyOpenTopSettingsDrawer(page);
        await page.locator('#sys-settings-button > .drawer-toggle').click();
        await page.locator('#connection_profiles').selectOption({ label: 'e2e-deletable-profile' });
        await expect(page.locator('#connection_profile_spinner')).toHaveClass(/hidden/, { timeout: 15_000 });
        await page.locator('#delete_connection_profile').click();
        const confirmDelete = page.locator('dialog.popup[open]').last();
        await confirmDelete.locator('.popup-button-ok').click();
        await confirmDelete.waitFor({ state: 'detached' });
        await expect(page.locator('#connection_profile_spinner')).toHaveClass(/hidden/, { timeout: 15_000 });

        // Reconnect main chat to custom mock backend, leaving SD bound to the deleted profile name.
        await page.locator('#chat_completion_source').selectOption('custom');
        await page.locator('#custom_api_url_text').fill(mock.baseURL);
        await page.locator('#api_button_openai').click();
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await closeAnyOpenTopSettingsDrawer(page);

        const geminiCountBeforeMissing = geminiMock.requests.length;
        await sendImagine(page, '/imagine a lone watchtower');
        await expect(page.locator('#toast-container .toast', {
            hasText: 'e2e-deletable-profile',
        })).toBeVisible({ timeout: 10_000 });
        expect(geminiMock.requests).toHaveLength(geminiCountBeforeMissing);

        // 2. Bind valid Gemini profile and generate with character reference + aspectRatio.
        await openSdSettings(page);
        await expect(page.locator('#sd_connection_profile option[value="e2e-deletable-profile"]')).toContainText('(missing)');
        await page.locator('#sd_connection_profile').selectOption('e2e-gemini-profile');

        await runImagineAndWaitForChatMessage(
            page,
            '/imagine ref=/user/images/_references/e2e_char_ref.png ratio=16:9 silver knight on cliff',
        );

        expect(geminiMock.requests.length).toBeGreaterThan(geminiCountBeforeMissing);
        const geminiReq = geminiMock.requests.at(-1);
        expect(geminiReq.url).toContain('/models/gemini-2.5-flash-image:generateContent');
        expect(geminiReq.headers['x-goog-api-key']).toBe('profile-key-gemini-ok');
        expect(geminiReq.body.generationConfig?.imageConfig?.aspectRatio).toBe('16:9');
        const parts = geminiReq.body.contents?.[0]?.parts || [];
        expect(parts[0]).toEqual({ text: '[Character reference]' });
        expect(parts[1]?.inlineData?.mimeType).toBe('image/png');
        expect(parts[1]?.inlineData?.data).toBe(ONE_PX_PNG_BASE64);
        expect(parts.at(-1)?.text).toContain('silver knight on cliff');

        // 3. NovelAI V4.5: character director reference + uploaded style Vibe reference with toggle gating and disk SHA-256 cache hit.
        await openSdSettings(page);
        await page.locator('#sd_source').selectOption('novel');
        await page.locator('#sd_model').selectOption('nai-diffusion-4-5-full');
        await page.locator('#sd_novel_url').fill(novelMock.baseURL);
        await page.locator('#sd_style_ref_file').setInputFiles(styleUploadPath);
        await expect(page.locator('#sd_style_ref_list > div')).toHaveCount(1, { timeout: 15_000 });
        await expect(page.locator('#sd_style_references_enabled')).toBeChecked();

        // Toggling style references off retains the saved list in dimmed state and omits style references from generation.
        await page.locator('#sd_style_references_enabled').uncheck();
        await expect(page.locator('#sd_style_ref_list > div')).toHaveCount(1);
        await expect(page.locator('#sd_style_ref_list')).toHaveClass(/is-disabled/);

        await runImagineAndWaitForChatMessage(
            page,
            '/imagine ref=/user/images/_references/e2e_char_ref.png ratio=2:3 style disabled check',
        );
        expect(novelMock.encodeVibeRequests).toHaveLength(0);
        expect(novelMock.generateRequests).toHaveLength(1);
        expect(novelMock.generateRequests[0].body.parameters.reference_image_multiple).toEqual([]);

        // Re-enabling style references sends the saved style vibe reference and hits /ai/encode-vibe once.
        await openSdSettings(page);
        await page.locator('#sd_style_references_enabled').check();
        await expect(page.locator('#sd_style_ref_list')).not.toHaveClass(/is-disabled/);

        await runImagineAndWaitForChatMessage(
            page,
            '/imagine ref=/user/images/_references/e2e_char_ref.png ratio=2:3 portrait under moonlight',
        );

        expect(novelMock.encodeVibeRequests).toHaveLength(1);
        expect(novelMock.generateRequests).toHaveLength(2);
        const novelParams = novelMock.generateRequests[1].body.parameters;
        expect(novelParams.director_reference_images).toHaveLength(1);
        expect(typeof novelParams.director_reference_images[0]).toBe('string');
        expect(novelParams.director_reference_images[0].length).toBeGreaterThan(20);
        expect(novelParams.reference_image_multiple).toEqual(['vibe-encoded-blob-e2e']);
        expect(novelParams.sm).toBe(false);
        expect(novelParams.sm_dyn).toBe(false);

        // Next NovelAI V4.5 run hits disk Vibe cache without calling /ai/encode-vibe again.
        await runImagineAndWaitForChatMessage(
            page,
            '/imagine ref=/user/images/_references/e2e_char_ref.png ratio=2:3 second portrait',
        );
        expect(novelMock.encodeVibeRequests).toHaveLength(1);
        expect(novelMock.generateRequests).toHaveLength(3);

        // Remove the style reference row so subsequent ComfyUI test receives only the explicit /imagine ref.
        await openSdSettings(page);
        await page.locator('#sd_style_ref_list > div .menu_button').first().click();
        await expect(page.locator('#sd_style_ref_list > div')).toHaveCount(0);
        await page.locator('#sd_style_references_enabled').uncheck();

        // 4. ComfyUI standard: POST /upload/image + %ref_image_1% substitution + unused %ref_image_2% slot pruning.
        await page.locator('#sd_source').selectOption('comfy');
        await page.locator('#sd_comfy_type').selectOption('standard');
        await page.locator('#sd_comfy_url').fill(comfy.baseURL);
        await page.locator('#sd_comfy_validate').click();
        await expect(page.locator('#sd_model option').first()).toBeAttached({ timeout: 15_000 });
        await expect(page.locator('#sd_comfy_workflow option[value="RefTest.json"]')).toBeAttached({ timeout: 15_000 });
        await page.locator('#sd_comfy_workflow').selectOption('RefTest.json');

        const comfyUploadsBefore = comfy.uploads.length;
        await runImagineAndWaitForChatMessage(
            page,
            '/imagine ref=/user/images/_references/e2e_char_ref.png castle courtyard',
        );

        expect(comfy.uploads).toHaveLength(comfyUploadsBefore + 1);
        const uploadedEntry = comfy.uploads.at(-1);
        const comfyGraph = comfy.requests.at(-1).prompt;
        expect(comfyGraph['11']?.inputs?.image).toBe(uploadedEntry.returnedName);
        expect(comfyGraph['12']).toBeUndefined();
        expect(comfyGraph['13']).toBeUndefined();
        expect(comfyGraph['14']?.inputs?.pixels).toEqual(['11', 0]);
    });

    test('exercises preset reference switches and live configuration conflict warnings across workflow and source changes', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openSdSettings(page);

        const charEnabled = page.locator('#sd_character_reference_enabled');
        const charModeRow = page.locator('#sd_character_reference_mode_row');
        const charMode = page.locator('#sd_character_reference_mode');
        const img2imgEnabled = page.locator('#sd_img2img_enabled');
        const styleEnabled = page.locator('#sd_style_references_enabled');
        const warningsBox = page.locator('#sd_reference_warnings');

        await expect(charEnabled).not.toBeChecked();
        await expect(charModeRow).toBeHidden();
        await expect(img2imgEnabled).not.toBeChecked();
        await expect(styleEnabled).not.toBeChecked();
        await expect(warningsBox).toBeHidden();

        // ComfyUI workflow without %ref_image% slots: text_only stays valid, image modes and img2img trigger live warnings.
        await page.locator('#sd_source').selectOption('comfy');
        await page.locator('#sd_comfy_type').selectOption('standard');
        await page.locator('#sd_comfy_url').fill(comfy.baseURL);
        await page.locator('#sd_comfy_validate').click();
        await expect(page.locator('#sd_comfy_workflow option[value="PlainTextOnly.json"]')).toBeAttached({ timeout: 15_000 });
        await page.locator('#sd_comfy_workflow').selectOption('PlainTextOnly.json');

        await charEnabled.check();
        await expect(charModeRow).toBeVisible();
        await expect(charMode).toHaveValue('text_only');
        await expect(warningsBox).toBeHidden();

        await charMode.selectOption('text_and_image');
        await expect(warningsBox).toBeVisible();
        await expect(warningsBox.locator('[data-warning-code="comfy_missing_ref_slots"]')).toBeVisible();
        await expect(warningsBox).toContainText('%ref_image%');

        await charMode.selectOption('text_only');
        await expect(warningsBox).toBeHidden();

        await img2imgEnabled.check();
        await expect(warningsBox).toBeVisible();
        await expect(warningsBox.locator('[data-warning-code="comfy_missing_ref_slots"]')).toBeVisible();

        // Switching to a workflow with %ref_image% slots clears the conflict warning immediately.
        await page.locator('#sd_comfy_workflow').selectOption('RefTest.json');
        await expect(warningsBox).toBeHidden();

        // Switching to WebUI with image-mode character references shows webui_source_only, cleared by text_only.
        await page.locator('#sd_source').selectOption('auto');
        await charMode.selectOption('image_only');
        await expect(warningsBox).toBeVisible();
        await expect(warningsBox.locator('[data-warning-code="webui_source_only"]')).toBeVisible();
        await charMode.selectOption('text_only');
        await expect(warningsBox).toBeHidden();

        // Preset switches isolate reference toggles per generation preset.
        await page.locator('#sd_source').selectOption('comfy');
        await page.locator('#sd_comfy_workflow').selectOption('RefTest.json');
        await charMode.selectOption('text_and_image');
        await img2imgEnabled.check();
        await styleEnabled.check();

        await page.locator('#sd_generation_preset_new').click();
        const presetDialog = page.locator('dialog.popup[open]').last();
        await presetDialog.locator('.popup-input').fill('TextOnlyPreset');
        await presetDialog.locator('.popup-button-ok').click();
        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);

        await charMode.selectOption('text_only');
        await img2imgEnabled.uncheck();
        await styleEnabled.uncheck();

        const presetSelect = page.locator('#sd_generation_preset');
        await presetSelect.selectOption({ label: 'Default' });
        await expect(charEnabled).toBeChecked();
        await expect(charMode).toHaveValue('text_and_image');
        await expect(img2imgEnabled).toBeChecked();
        await expect(styleEnabled).toBeChecked();

        await presetSelect.selectOption({ label: 'TextOnlyPreset' });
        await expect(charEnabled).toBeChecked();
        await expect(charMode).toHaveValue('text_only');
        await expect(img2imgEnabled).not.toBeChecked();
        await expect(styleEnabled).not.toBeChecked();

        // Reset Default switches off cleanly before the next test.
        await presetSelect.selectOption({ label: 'Default' });
        await charEnabled.uncheck();
        await img2imgEnabled.uncheck();
        await styleEnabled.uncheck();
        await closeAnyOpenTopSettingsDrawer(page);
    });

    test('preserves locked illustrations on message re-run, edits from source image via img2img, and switches history versions across reload', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await connectChatCompletion(page);

        await openSdSettings(page);
        await page.locator('#sd_source').selectOption('auto');
        await page.locator('#sd_auto_url').fill(sdMock.baseURL);
        await page.locator('#sd_auto_validate').click();
        await expect(page.locator('#sd_model option').first()).toBeAttached({ timeout: 15_000 });
        await expect(page.locator('#sd_img2img_enabled')).not.toBeChecked();

        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_enabled').check();
        await page.locator('#sd_illustration_auto_generate').check();
        await closeAnyOpenTopSettingsDrawer(page);

        await sendMessageAndAwaitReply(page, 'Show both instruments.');
        await page.waitForFunction(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return (message?.extra?.illustrations || []).length === 2;
        }, null, { timeout: 60_000 });

        const initialRecords = await page.evaluate(() => window.Luker.getContext().chat.at(-1).extra.illustrations);
        expect(initialRecords).toHaveLength(2);
        const lockedCandidate = initialRecords[0];
        const unlockedCandidate = initialRecords[1];

        // 1. Lock the first illustration via action dialog.
        await page.locator(`.mes_text img[data-illustration-id="${lockedCandidate.id}"]`).click();
        await expect(page.locator('#sd_illustration_actions')).toBeVisible();
        await page.locator('#sd_illustration_action_toggle_lock').click();
        await expect.poll(() => page.evaluate((id) => {
            const recs = window.Luker.getContext().chat.at(-1).extra.illustrations;
            return Boolean(recs.find(r => r.id === id)?.locked);
        }, lockedCandidate.id)).toBe(true);

        // 2. Re-run message-level illustration generation: locked illustration stays intact, unlocked is replaced.
        await page.evaluate(() => {
            const messages = [...document.querySelectorAll('.mes:not([is_user="true"]):not([is_system="true"])')];
            messages.at(-1)?.querySelector('.sd_illustration_gen')?.click();
        });
        const confirmReplace = page.locator('dialog.popup[open]').last();
        await expect(confirmReplace).toContainText('This message already has illustrations. Replace them?');
        await confirmReplace.locator('.popup-button-ok').click();

        await page.waitForFunction(({ lockedId, oldUnlockedId }) => {
            const msg = window.Luker.getContext().chat.at(-1);
            const recs = msg?.extra?.illustrations || [];
            return recs.some(r => r.id === lockedId && r.locked)
                && !recs.some(r => r.id === oldUnlockedId)
                && recs.length >= 2;
        }, { lockedId: lockedCandidate.id, oldUnlockedId: unlockedCandidate.id }, { timeout: 60_000 });

        const afterRerun = await page.evaluate(() => {
            const msg = window.Luker.getContext().chat.at(-1);
            return { mes: msg.mes, records: msg.extra.illustrations };
        });
        expect(afterRerun.mes).toContain(`data-illustration-id="${lockedCandidate.id}"`);
        const activeUnlocked = afterRerun.records.find(r => r.id !== lockedCandidate.id && afterRerun.mes.includes(`data-illustration-id="${r.id}"`));
        expect(activeUnlocked).toBeTruthy();

        // 3. Edit from this image -> hidden while #sd_img2img_enabled is unchecked; once enabled via UI, routes role:'source' to /sdapi/v1/img2img.
        await page.locator(`.mes_text img[data-illustration-id="${activeUnlocked.id}"]`).click();
        await expect(page.locator('#sd_illustration_actions')).toBeVisible();
        await expect(page.locator('#sd_illustration_action_edit_from_image')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(page.locator('#sd_illustration_actions')).toHaveCount(0);

        await openSdSettings(page);
        await page.locator('#sd_img2img_enabled').check();
        await closeAnyOpenTopSettingsDrawer(page);

        const img2imgBefore = sdMock.requests.filter(r => r.url === '/sdapi/v1/img2img').length;
        await page.locator(`.mes_text img[data-illustration-id="${activeUnlocked.id}"]`).click();
        await expect(page.locator('#sd_illustration_actions')).toBeVisible();
        await page.locator('#sd_illustration_action_edit_from_image').click();
        const editPopup = page.locator('dialog.popup[open]').last();
        await editPopup.locator('.popup-input').last().fill('1girl, warm sunset glow');
        await editPopup.locator('.popup-button-ok').click();

        await expect.poll(
            () => sdMock.requests.filter(r => r.url === '/sdapi/v1/img2img').length,
            { timeout: 60_000 },
        ).toBe(img2imgBefore + 1);
        const img2imgCall = sdMock.requests.filter(r => r.url === '/sdapi/v1/img2img').at(-1);
        expect(Array.isArray(img2imgCall.body.init_images)).toBe(true);
        expect(img2imgCall.body.init_images).toHaveLength(1);

        await page.waitForFunction((parentId) => {
            const recs = window.Luker.getContext().chat.at(-1)?.extra?.illustrations || [];
            return recs.some(r => r.parentId === parentId);
        }, activeUnlocked.id, { timeout: 60_000 });

        const editedChild = await page.evaluate((parentId) => {
            const recs = window.Luker.getContext().chat.at(-1).extra.illustrations;
            return recs.find(r => r.parentId === parentId);
        }, activeUnlocked.id);
        expect(editedChild).toBeTruthy();
        await expect(page.locator(`.mes_text img[data-illustration-id="${editedChild.id}"]`)).toBeVisible();

        // 4. Open History and switch directly back to parent version with 0 new generation calls.
        const sdRequestsBeforeSwitch = sdMock.requests.filter(
            r => r.url === '/sdapi/v1/txt2img' || r.url === '/sdapi/v1/img2img',
        ).length;
        await page.locator(`.mes_text img[data-illustration-id="${editedChild.id}"]`).click();
        await expect(page.locator('#sd_illustration_actions')).toBeVisible();
        await page.locator('#sd_illustration_action_history').click();
        await expect(page.locator('#sd_illustration_history_list')).toBeVisible();
        await page.locator(`#sd_illustration_history_list .sd_illustration_history_switch[data-illustration-switch-id="${activeUnlocked.id}"]`).click();

        await expect(page.locator(`.mes_text img[data-illustration-id="${activeUnlocked.id}"]`)).toBeVisible({ timeout: 10_000 });
        expect(sdMock.requests.filter(
            r => r.url === '/sdapi/v1/txt2img' || r.url === '/sdapi/v1/img2img',
        )).toHaveLength(sdRequestsBeforeSwitch);

        // 5. Reload page and verify switched version and lock flag persist on disk.
        await page.reload();
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await expect(page.locator(`.mes_text img[data-illustration-id="${activeUnlocked.id}"]`)).toBeVisible({ timeout: 15_000 });
        await expect(page.locator(`.mes_text img[data-illustration-id="${lockedCandidate.id}"]`)).toBeVisible({ timeout: 15_000 });
        const persistedLock = await page.evaluate((id) => {
            const recs = window.Luker.getContext().chat.at(-1)?.extra?.illustrations || [];
            return Boolean(recs.find(r => r.id === id)?.locked);
        }, lockedCandidate.id);
        expect(persistedLock).toBe(true);
    });
});
