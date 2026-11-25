// SPDX-License-Identifier: AGPL-3.0-or-later

import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    closeAnyOpenTopSettingsDrawer,
    openExtensionsDrawer,
    openInlineDrawer,
    selectCharacterByName,
} from '../_lib/page.js';
import { ONE_PX_PNG_BASE64 } from '../_lib/sdMock.js';
import { startComfyMock } from '../_lib/comfyMock.js';

test.describe.configure({ mode: 'serial' });

const BASE_WORKFLOW = {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%model%' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%', clip: ['4', 1] } },
    '3': {
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
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Luker', images: ['8', 0] } },
};

async function startIterationLlmMock() {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        if (req.method === 'GET' && pathname.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'mock-iter-llm' }] }));
            return;
        }

        const body = raw ? JSON.parse(raw) : {};
        requests.push(body);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const toolMsgs = messages.filter(m => m.role === 'tool');

        const sendToolCalls = (calls) => {
            const normalized = calls.map((c, index) => ({
                index,
                id: c.id || `call_${requests.length}_${index}`,
                type: 'function',
                function: {
                    name: c.name,
                    arguments: JSON.stringify(c.args || {}),
                },
            }));
            if (body.stream) {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                res.write(`data: ${JSON.stringify({
                    id: `chatcmpl_${requests.length}`,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: normalized }, finish_reason: null }],
                })}\n\n`);
                res.write(`data: ${JSON.stringify({
                    id: `chatcmpl_${requests.length}`,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                })}\n\n`);
                res.end('data: [DONE]\n\n');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: `chatcmpl_${requests.length}`,
                object: 'chat.completion',
                choices: [{
                    index: 0,
                    finish_reason: 'tool_calls',
                    message: {
                        role: 'assistant',
                        content: '',
                        tool_calls: normalized.map(({ index: _i, ...rest }) => rest),
                    },
                }],
            }));
        };

        const sendText = (text) => {
            if (body.stream) {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                res.write(`data: ${JSON.stringify({
                    id: `chatcmpl_${requests.length}`,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
                })}\n\n`);
                res.end('data: [DONE]\n\n');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: `chatcmpl_${requests.length}`,
                object: 'chat.completion',
                choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
            }));
        };

        if (toolMsgs.length === 0) {
            sendToolCalls([
                {
                    name: 'sd_inspect_comfy_node',
                    args: { class_types: ['LoraLoader', 'LoadImage'] },
                },
                {
                    name: 'sd_create_workflow',
                    args: {
                        file_name: 'Iterated_Comfy.json',
                        clone_from: 'Default_Comfy_Workflow.json',
                        set_active: true,
                    },
                },
                {
                    name: 'sd_upsert_workflow_nodes',
                    args: {
                        file_name: 'Iterated_Comfy.json',
                        nodes: {
                            '14': {
                                class_type: 'LoraLoader',
                                inputs: {
                                    model: ['4', 0],
                                    clip: ['4', 1],
                                    lora_name: '%lora_name%',
                                    strength_model: '%lora_strength_model%',
                                    strength_clip: '%lora_strength_clip%',
                                },
                            },
                            '20': {
                                class_type: 'LoadImage',
                                inputs: { image: '%ref_image%' },
                            },
                            '21': {
                                class_type: 'VAEEncode',
                                inputs: { pixels: ['20', 0], vae: ['4', 2] },
                            },
                            '22': {
                                class_type: 'ReferenceLatent',
                                inputs: { conditioning: ['6', 0], latent: ['21', 0] },
                            },
                            '6': {
                                class_type: 'CLIPTextEncode',
                                inputs: { text: '%prompt%', clip: ['14', 1] },
                            },
                            '7': {
                                class_type: 'CLIPTextEncode',
                                inputs: { text: '%negative_prompt%', clip: ['14', 1] },
                            },
                            '3': {
                                ...BASE_WORKFLOW['3'],
                                inputs: {
                                    ...BASE_WORKFLOW['3'].inputs,
                                    model: ['14', 0],
                                    positive: ['22', 0],
                                },
                            },
                        },
                    },
                },
            ]);
            return;
        }

        if (toolMsgs.length === 3) {
            sendToolCalls([
                {
                    name: 'sd_test_workflow_draft',
                    args: {
                        file_name: 'Iterated_Comfy.json',
                        prompt: '1girl, twilight harbor, warm lantern glow',
                        loras: [{ name: 'detail_tweaker.safetensors', weight: 0.75 }],
                        reference_image_paths: ['/user/images/_references/e2e_iter_ref.png'],
                        seed: 12345,
                    },
                },
            ]);
            return;
        }

        sendText('已克隆默认工作流为 Iterated_Comfy.json，接入动态 LoRA 与单槽参考图节点并通过草稿试跑验证。');
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return {
        baseURL: `http://127.0.0.1:${server.address().port}`,
        requests,
        stop: () => new Promise(r => {
            server.closeAllConnections?.();
            server.close(() => r());
        }),
    };
}

let server;
let comfy;
let llm;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    comfy = await startComfyMock({ loraNames: ['detail_tweaker.safetensors'] });
    llm = await startIterationLlmMock();
    server = await startServer({ scope, batchKey: 'image-illustration', scenarioId: '04-comfy-workflow-iteration' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: llm.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: llm.baseURL, api: 'custom' });

    const userDir = resolve(server.dataRoot, 'default-user');
    const defaultWfPath = resolve(userDir, 'user/workflows/Default_Comfy_Workflow.json');
    mkdirSync(dirname(defaultWfPath), { recursive: true });
    writeFileSync(defaultWfPath, JSON.stringify(BASE_WORKFLOW, null, 2));

    const refPath = resolve(userDir, 'user/images/_references/e2e_iter_ref.png');
    mkdirSync(dirname(refPath), { recursive: true });
    writeFileSync(refPath, Buffer.from(ONE_PX_PNG_BASE64, 'base64'));
});

test.afterAll(async () => {
    await comfy?.stop();
    await llm?.stop();
});

test.describe('ComfyUI workflow AI iteration in Workbench', () => {
    test('opens AI iteration from ComfyUI settings, probes /object_info, test-runs draft without writing disk, applies workflow + dropdown update, and undoes cleanly', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Connect LLM backend
        await page.locator('#sys-settings-button > .drawer-toggle').click();
        await page.locator('#api_button_openai').click();
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await closeAnyOpenTopSettingsDrawer(page);

        // Configure ComfyUI in Image Generation settings
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_container');
        await page.locator('#sd_source').selectOption('comfy');
        await page.locator('#sd_comfy_type').selectOption('standard');
        await page.locator('#sd_comfy_url').fill(comfy.baseURL);
        await page.locator('#sd_comfy_validate').click();
        await expect(page.locator('#sd_model option').first()).toBeAttached({ timeout: 15_000 });
        await expect(page.locator('#sd_comfy_workflow')).toHaveValue('Default_Comfy_Workflow.json');

        // Click #sd_comfy_iterate_workflow shortcut button -> opens Workbench AI Iteration pre-seeded for current workflow
        const iterateBtn = page.locator('#sd_comfy_iterate_workflow');
        await expect(iterateBtn).toBeVisible();
        await iterateBtn.click();

        const wbWin = page.locator('.wbench .wb-win:not([hidden])');
        await expect(wbWin).toBeVisible({ timeout: 10_000 });
        const wbInput = wbWin.locator('.wb-input');
        await expect(wbInput).toHaveValue(/Default_Comfy_Workflow\.json/);

        // Append user request and send
        await wbInput.fill('Inspect Default_Comfy_Workflow.json and add dynamic LoRA + reference image support, then test-run.');
        await wbWin.locator('.wb-send').click();

        // Wait for pending Change list card to appear after draft test-run completes
        const pendingCard = wbWin.locator('.wb-chg.is-pending');
        await expect(pendingCard).toBeVisible({ timeout: 30_000 });

        // Verify ComfyUI received the draft test-run (with expanded LoRA + uploaded reference) while disk was NOT touched yet
        expect(comfy.uploads.length).toBe(1);
        expect(comfy.requests.length).toBe(1);
        const testPromptGraph = comfy.requests[0].prompt;
        expect(JSON.stringify(testPromptGraph)).toContain('detail_tweaker.safetensors');
        expect(testPromptGraph['20']?.inputs?.image).toBe(comfy.uploads[0].returnedName);

        const iteratedWfDiskPath = resolve(server.dataRoot, 'default-user', 'user/workflows/Iterated_Comfy.json');
        expect(existsSync(iteratedWfDiskPath)).toBe(false);

        // Verify preview pane shows draft test preview image
        const previewImg = wbWin.locator('.wb-iter-preview img');
        await expect(previewImg).toBeVisible({ timeout: 10_000 });
        await expect(previewImg).toHaveAttribute('src', /\/user\/images\/_studio\//);

        // Click Apply selected in Change list -> writes Iterated_Comfy.json to disk and updates #sd_comfy_workflow
        await pendingCard.locator('.wb-chg-foot button').last().click();
        await expect(wbWin.locator('.wb-chg.is-applied')).toBeVisible({ timeout: 15_000 });

        await expect.poll(() => existsSync(iteratedWfDiskPath), { timeout: 10_000 }).toBe(true);
        const savedGraph = JSON.parse(readFileSync(iteratedWfDiskPath, 'utf8'));
        expect(savedGraph['14']?.inputs?.lora_name).toBe('%lora_name%');
        expect(savedGraph['20']?.inputs?.image).toBe('%ref_image%');

        await expect(page.locator('#sd_comfy_workflow')).toHaveValue('Iterated_Comfy.json', { timeout: 10_000 });

        // Open Workbench Change history tab and click Undo -> deletes Iterated_Comfy.json and restores Default_Comfy_Workflow.json
        await wbWin.locator('.wb-rail .wb-tab').nth(3).click();
        const undoBtn = wbWin.locator('.wb-hist-item button', { hasText: /Undo|撤销|撤銷/ }).first();
        await expect(undoBtn).toBeVisible({ timeout: 10_000 });
        await undoBtn.click();

        await expect.poll(() => existsSync(iteratedWfDiskPath), { timeout: 10_000 }).toBe(false);
        await expect(page.locator('#sd_comfy_workflow')).toHaveValue('Default_Comfy_Workflow.json', { timeout: 10_000 });
    });
});
