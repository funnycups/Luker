// Dynamic LoRA selection on the ComfyUI generation path: `/imagine loras=…`
// and the illustration studio both reach the workflow graph as real
// LoraLoader nodes, zero selected LoRAs collapse the template back to its
// source links, and every rejection path surfaces a toast without issuing a
// backend request.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI, openExtensionsDrawer, openInlineDrawer, selectCharacterByName,
    closeAnyOpenTopSettingsDrawer, sendMessageAndAwaitReply,
} from '../_lib/page.js';
import { startSdWebUiMock } from '../_lib/sdMock.js';
import { startComfyMock } from '../_lib/comfyMock.js';

let server, mock, sdMock, comfy;

// Template node 10 sits between the checkpoint loader (node 4) and every
// consumer of its model/clip outputs. Placeholders stay quoted strings so
// the workflow text parses before substitution.
const LORA_WORKFLOW = {
    3: {
        class_type: 'KSampler',
        inputs: {
            seed: '%seed%',
            steps: '%steps%',
            cfg: '%scale%',
            sampler_name: '%sampler%',
            scheduler: '%scheduler%',
            denoise: '%denoise%',
            model: ['10', 0],
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
        inputs: { text: '%prompt%', clip: ['10', 1] },
    },
    7: {
        class_type: 'CLIPTextEncode',
        inputs: { text: '%negative_prompt%', clip: ['10', 1] },
    },
    8: {
        class_type: 'VAEDecode',
        inputs: { samples: ['3', 0], vae: ['4', 2] },
    },
    9: {
        class_type: 'SaveImage',
        inputs: { images: ['8', 0], filename_prefix: 'lora-test' },
    },
    10: {
        class_type: 'LoraLoader',
        inputs: {
            lora_name: '%lora_name%',
            strength_model: '%lora_strength_model%',
            strength_clip: '%lora_strength_clip%',
            model: ['4', 0],
            clip: ['4', 1],
        },
    },
};

function writeLoraWorkflow(dataRoot) {
    const workflowPath = resolve(dataRoot, 'default-user/user/workflows/LoraTest.json');
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, JSON.stringify(LORA_WORKFLOW, null, 4));

    // Same graph without the template node: consumers read the checkpoint
    // loader directly, which is the pre-existing workflow shape.
    const plainWorkflow = structuredClone(LORA_WORKFLOW);
    delete plainWorkflow[10];
    plainWorkflow[3].inputs.model = ['4', 0];
    plainWorkflow[6].inputs.clip = ['4', 1];
    plainWorkflow[7].inputs.clip = ['4', 1];
    writeFileSync(
        resolve(dataRoot, 'default-user/user/workflows/PlainTest.json'),
        JSON.stringify(plainWorkflow, null, 4),
    );

    // Same template node, but with fixed strengths instead of placeholders:
    // selecting a LoRA here must keep the literal values untouched.
    const literalWorkflow = structuredClone(LORA_WORKFLOW);
    literalWorkflow[10].inputs.strength_model = 0.7;
    literalWorkflow[10].inputs.strength_clip = 0.6;
    writeFileSync(
        resolve(dataRoot, 'default-user/user/workflows/LiteralTest.json'),
        JSON.stringify(literalWorkflow, null, 4),
    );
}

test.beforeAll(async () => {
    comfy = await startComfyMock();
    comfy.setLoras(['lora_a.safetensors']);
    sdMock = await startSdWebUiMock();
    mock = await startMockLLM({ scriptedReplies: ['*Ash keeps the lantern trimmed and waits.*'] });
    server = await startServer({ batchKey: 'image-illustration', scenarioId: '02-loras' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, api: 'custom' });
    writeLoraWorkflow(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
    await sdMock?.stop();
    await comfy?.stop();
});

async function openSdSettings(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'sd_container');
}

async function connectChatCompletion(page) {
    await page.locator('#sys-settings-button > .drawer-toggle').click();
    await page.locator('#api_button_openai').click();
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await closeAnyOpenTopSettingsDrawer(page);
}

async function configureComfy(page) {
    await openSdSettings(page);
    await page.locator('#sd_source').selectOption('comfy');
    await page.locator('#sd_comfy_type').selectOption('standard');
    await page.locator('#sd_comfy_url').fill(comfy.baseURL);
    await page.locator('#sd_comfy_validate').click();
    await expect(page.locator('#sd_model option').first()).toBeAttached({ timeout: 15_000 });
    const workflowOption = page.locator('#sd_comfy_workflow option[value="LoraTest.json"]');
    await expect(workflowOption).toBeAttached({ timeout: 15_000 });
    await page.locator('#sd_comfy_workflow').selectOption('LoraTest.json');
}

async function openStudio(page) {
    await closeAnyOpenTopSettingsDrawer(page);
    await page.locator('#extensionsMenuButton').click();
    await page.locator('#sd_illustration_open_studio').click();
    await expect(page.locator('#sd_studio')).toBeVisible({ timeout: 10_000 });
}

function studioImages(page) {
    return page.evaluate(() => {
        const bucket = window.Luker.getContext().extensionSettings?.sd?.illustration?.studioSessions || {};
        return Object.values(bucket).flatMap(session => session.images || []);
    });
}

async function sendImagine(page, command) {
    await closeAnyOpenTopSettingsDrawer(page);
    const textarea = page.locator('#send_textarea');
    await textarea.fill(command);
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#send_but').click();
}

/**
 * Run `/imagine`, wait for the browser request that carries the workflow to
 * the server, then wait for the attached image message so the next command
 * starts from an idle generator. Returns the parsed request body.
 */
async function imagineWorkflowPayload(page, command) {
    const chatLength = await page.evaluate(() => window.Luker.getContext().chat.length);
    const requestPromise = page.waitForRequest(
        request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/sd/comfy/generate',
        { timeout: 120_000 },
    );
    await sendImagine(page, command);
    const request = await requestPromise;
    await page.waitForFunction(
        length => window.Luker.getContext().chat.length > length,
        chatLength,
        { timeout: 120_000 },
    );
    return request.postDataJSON();
}

function loraNodes(graph) {
    return Object.entries(graph).filter(([, node]) => node.class_type === 'LoraLoader' || node.class_type === 'LoraLoaderModelOnly');
}

test.describe('dynamic LoRAs', () => {
    test('applies, clears and rejects LoRA selections through /imagine', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await connectChatCompletion(page);
        await configureComfy(page);

        // Selected LoRA: the template node becomes a concrete LoraLoader that
        // both the sampler and the text encoders read from.
        const enabledPayload = await imagineWorkflowPayload(page, '/imagine loras=lora_a.safetensors:0.8 a cat');
        expect(typeof enabledPayload.prompt).toBe('string');
        const enabledGraph = JSON.parse(enabledPayload.prompt).prompt;

        const templates = loraNodes(enabledGraph).filter(([, node]) => node.inputs.lora_name === '%lora_name%');
        expect(templates).toHaveLength(0);
        const selected = loraNodes(enabledGraph).filter(([, node]) => node.inputs.lora_name === 'lora_a.safetensors');
        expect(selected).toHaveLength(1);
        const [selectedId, selectedNode] = selected[0];
        expect(selectedNode.inputs.strength_model).toBe(0.8);
        expect(selectedNode.inputs.strength_clip).toBe(0.8);
        expect(enabledGraph['3'].inputs.model).toEqual([selectedId, 0]);
        expect(enabledGraph['6'].inputs.clip).toEqual([selectedId, 1]);
        expect(enabledGraph['7'].inputs.clip).toEqual([selectedId, 1]);

        // The mock records what the dispatch forwarded upstream: the same graph.
        const recorded = comfy.requests.at(-1);
        expect(recorded.prompt).toEqual(enabledGraph);

        // No selection: the template node is removed and its consumers read
        // the checkpoint loader again.
        const clearedPayload = await imagineWorkflowPayload(page, '/imagine a cat');
        const clearedGraph = JSON.parse(clearedPayload.prompt).prompt;
        expect(loraNodes(clearedGraph)).toHaveLength(0);
        expect(clearedGraph['3'].inputs.model).toEqual(['4', 0]);
        expect(clearedGraph['6'].inputs.clip).toEqual(['4', 1]);
        expect(clearedGraph['7'].inputs.clip).toEqual(['4', 1]);

        // Unknown name: a visible error, and the backend sees no new request.
        const promptCount = comfy.requests.length;
        await sendImagine(page, '/imagine loras=missing.safetensors a cat');
        await expect(page.locator('#toast-container .toast', { hasText: 'missing.safetensors' })).toBeVisible({ timeout: 10_000 });
        expect(comfy.requests).toHaveLength(promptCount);

        // A template with literal strengths accepts a bare name and keeps the
        // fixed strengths untouched.
        await openSdSettings(page);
        await page.locator('#sd_comfy_workflow').selectOption('LiteralTest.json');
        const literalPayload = await imagineWorkflowPayload(page, '/imagine loras=lora_a.safetensors a cat');
        const literalGraph = JSON.parse(literalPayload.prompt).prompt;
        const literalNodes = loraNodes(literalGraph).filter(([, node]) => node.inputs.lora_name === 'lora_a.safetensors');
        expect(literalNodes).toHaveLength(1);
        const [literalId, literalNode] = literalNodes[0];
        expect(literalNode.inputs.strength_model).toBe(0.7);
        expect(literalNode.inputs.strength_clip).toBe(0.6);
        expect(literalGraph['3'].inputs.model).toEqual([literalId, 0]);
        expect(literalGraph['6'].inputs.clip).toEqual([literalId, 1]);

        // A workflow without a LoRA template still generates through the
        // existing request path.
        await openSdSettings(page);
        await page.locator('#sd_comfy_workflow').selectOption('PlainTest.json');
        const plainPayload = await imagineWorkflowPayload(page, '/imagine a cat');
        const plainGraph = JSON.parse(plainPayload.prompt).prompt;
        expect(loraNodes(plainGraph)).toHaveLength(0);
        expect(plainGraph['3'].inputs.model).toEqual(['4', 0]);
        expect(plainGraph['6'].inputs.clip).toEqual(['4', 1]);

        // Non-ComfyUI source: rejected before any image request reaches the
        // selected backend.
        await openSdSettings(page);
        await page.locator('#sd_source').selectOption('auto');
        await page.locator('#sd_auto_url').fill(sdMock.baseURL);
        await page.locator('#sd_auto_validate').click();
        await expect(page.locator('#sd_model option').first()).toBeAttached({ timeout: 15_000 });

        const txt2imgCount = sdMock.requests.filter(request => request.url === '/sdapi/v1/txt2img').length;
        await sendImagine(page, '/imagine loras=lora_a.safetensors a cat');
        await expect(page.locator('#toast-container .toast', {
            hasText: 'Dynamic LoRA is only available for the standard ComfyUI server type.',
        })).toBeVisible({ timeout: 10_000 });
        expect(sdMock.requests.filter(request => request.url === '/sdapi/v1/txt2img')).toHaveLength(txt2imgCount);
    });
});

test.describe('studio LoRAs', () => {
    test('carries the selected LoRA into the record and drops it on regeneration', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await connectChatCompletion(page);
        await configureComfy(page);
        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_enabled').check();
        await closeAnyOpenTopSettingsDrawer(page);

        mock.scriptToolCall({
            name: 'generate_image',
            arguments: {
                prompt: '1girl, lighthouse',
                loras: [{ name: 'lora_a.safetensors', weight: 0.8 }],
            },
        });
        const promptCount = comfy.requests.length;

        await openStudio(page);
        await page.locator('#sd_studio_input').fill('A lighthouse at dusk');
        await page.locator('#sd_studio_send').click();

        // The tool schema the studio sends offers the backend's LoRA list, so
        // the model can only name a LoRA the workflow can apply.
        await expect.poll(
            () => mock.requests.filter(request => Array.isArray(request.body?.tools)).length,
            { timeout: 30_000 },
        ).toBeGreaterThan(0);
        const studioTools = mock.requests.filter(request => Array.isArray(request.body?.tools)).at(-1).body.tools;
        const generateTool = studioTools.find(tool => tool.function.name === 'generate_image');
        const lorasProperty = generateTool.function.parameters.properties.loras;
        expect(lorasProperty?.items?.properties?.name?.enum).toEqual(['lora_a.safetensors']);
        expect(lorasProperty?.items?.properties?.weight).toBeTruthy();

        // The selection reaches the workflow graph as a concrete LoraLoader.
        const imageCard = page.locator('#sd_studio [data-studio-image-id]').first();
        await expect(imageCard).toBeVisible({ timeout: 60_000 });
        await expect.poll(() => comfy.requests.length).toBeGreaterThan(promptCount);
        const generatedGraph = comfy.requests.at(-1).prompt;
        const applied = loraNodes(generatedGraph).filter(([, node]) => node.inputs.lora_name === 'lora_a.safetensors');
        expect(applied).toHaveLength(1);
        expect(applied[0][1].inputs.strength_model).toBe(0.8);
        expect(generatedGraph['3'].inputs.model).toEqual([applied[0][0], 0]);

        // The studio record keeps the validated selection for later replays.
        const recordedImages = await studioImages(page);
        expect(recordedImages).toHaveLength(1);
        expect(recordedImages[0].prompt).toBe('1girl, lighthouse');
        expect(recordedImages[0].loras).toEqual([{ name: 'lora_a.safetensors', weight: 0.8 }]);

        // Close the studio so the session is flushed to disk before the reload.
        await page.locator('dialog.popup[open] .popup-button-close').last().click();
        await expect(page.locator('#sd_studio')).toHaveCount(0, { timeout: 10_000 });
        const settingsFile = resolve(server.dataRoot, 'default-user', 'settings.json');
        await expect.poll(() => {
            try {
                const stored = JSON.parse(readFileSync(settingsFile, 'utf8'));
                const sessions = Object.values(stored.extension_settings?.sd?.illustration?.studioSessions || {});
                return sessions.some(session => (session.images || []).some(image => image.loras?.length === 1));
            } catch {
                return false;
            }
        }, { timeout: 15_000 }).toBe(true);

        // The backend no longer serves the LoRA the record saved. Re-validating
        // the backend is the settings gesture that reads the LoRA list again
        // for the open page.
        comfy.setLoras(['lora_b.safetensors']);
        await openSdSettings(page);
        const validateLoras = page.waitForResponse(
            response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/sd/comfy/loras',
        );
        await page.locator('#sd_comfy_validate').click();
        expect((await validateLoras).ok()).toBe(true);
        // Rebuilding the workflow options keeps the selected workflow.
        await expect(page.locator('#sd_comfy_workflow')).toHaveValue('LoraTest.json');
        await openStudio(page);
        await expect(page.locator('#sd_studio [data-studio-image-id]')).toHaveCount(1);

        const regenerateCount = comfy.requests.length;
        await page.locator('#sd_studio [data-studio-action="regenerate"]').click();
        await expect(page.locator('#toast-container .toast', {
            hasText: 'Some LoRAs are unavailable and were skipped: lora_a.safetensors',
        })).toHaveCount(1);
        await expect.poll(() => comfy.requests.length, { timeout: 60_000 }).toBeGreaterThan(regenerateCount);
        const regeneratedGraph = comfy.requests.at(-1).prompt;
        expect(loraNodes(regeneratedGraph)).toHaveLength(0);
        expect(regeneratedGraph['3'].inputs.model).toEqual(['4', 0]);

        await expect.poll(async () => (await studioImages(page)).length, { timeout: 15_000 }).toBe(2);
        const replayImages = await studioImages(page);
        expect(replayImages[1].prompt).toBe('1girl, lighthouse');
        expect(replayImages[1].loras).toEqual([]);

        // A record without LoRAs regenerates without a catalog refresh. The
        // image request reads the workflow once for itself; a refresh would
        // read it a second time and ask for the LoRA list as well.
        const requestPaths = [];
        const collectRequestPath = request => requestPaths.push(new URL(request.url()).pathname);
        page.on('request', collectRequestPath);
        const plainCount = comfy.requests.length;
        await page.locator('#sd_studio [data-studio-image-id]').nth(1)
            .locator('[data-studio-action="regenerate"]').click();
        await expect.poll(() => comfy.requests.length, { timeout: 60_000 }).toBeGreaterThan(plainCount);
        page.off('request', collectRequestPath);
        const catalogReads = requestPaths.filter(path => path === '/api/sd/comfy/workflow' || path === '/api/sd/comfy/loras');
        expect(catalogReads).toEqual(['/api/sd/comfy/workflow']);
        await expect.poll(async () => (await studioImages(page)).length, { timeout: 15_000 }).toBe(3);
        expect((await studioImages(page))[2].loras).toEqual([]);
    });
});

test.describe('automatic illustration LoRAs', () => {
    test('carries the model selection into the illustration record and drops it on regeneration', async ({ page }) => {
        // The mock serves this list for the whole test; the previous describe
        // may have replaced it when both ran in the same worker.
        comfy.setLoras(['lora_a.safetensors']);

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await configureComfy(page);
        await page.evaluate(() => document.querySelector('#api_button_openai').click());
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });

        // The illustration request is the only one that sees the prompt tool;
        // the main reply keeps the anchors the tool call inserts between.
        mock.scriptCompletion(({ toolNames }) => {
            if (toolNames.includes('add_image_prompt')) {
                return {
                    tool: 'add_image_prompt',
                    arguments: {
                        prompt: '1girl, brass spyglass',
                        insert_after: 'spyglass',
                        insert_before: 'on the chart',
                        loras: [{ name: 'lora_a.safetensors', weight: 0.8 }],
                    },
                };
            }
            return { text: '*Ash sets the brass spyglass on the chart and studies the reef.*' };
        });

        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_enabled').check();
        await page.locator('#sd_illustration_auto_generate').check();
        await closeAnyOpenTopSettingsDrawer(page);

        const promptCount = comfy.requests.length;
        await sendMessageAndAwaitReply(page, 'Show me the chart.');
        await page.waitForFunction(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return Array.isArray(message?.extra?.illustrations) && message.extra.illustrations.length > 0;
        }, null, { timeout: 60_000 });

        // The validated selection is stored on the record and the image is
        // placed at the tool's anchors.
        const illustration = await page.evaluate(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return {
                mes: String(message?.mes || ''),
                records: message.extra.illustrations,
            };
        });
        expect(illustration.records).toHaveLength(1);
        const original = illustration.records[0];
        expect(original.prompt).toBe('1girl, brass spyglass');
        expect(original.loras).toEqual([{ name: 'lora_a.safetensors', weight: 0.8 }]);
        expect(illustration.mes).toContain(`data-illustration-id="${original.id}"`);
        expect(illustration.mes).toContain('/user/images/');

        // The graph the backend received expanded the template node into one
        // concrete loader holding both the weight and the source links.
        await expect.poll(() => comfy.requests.length, { timeout: 60_000 }).toBeGreaterThan(promptCount);
        const generatedGraph = comfy.requests.at(-1).prompt;
        const appliedNodes = loraNodes(generatedGraph);
        expect(appliedNodes).toHaveLength(1);
        const [appliedId, appliedNode] = appliedNodes[0];
        expect(appliedNode.inputs.lora_name).toBe('lora_a.safetensors');
        expect(appliedNode.inputs.strength_model).toBe(0.8);
        expect(appliedNode.inputs.strength_clip).toBe(0.8);
        expect(appliedNode.inputs.model).toEqual(['4', 0]);
        expect(appliedNode.inputs.clip).toEqual(['4', 1]);
        expect(generatedGraph['3'].inputs.model).toEqual([appliedId, 0]);
        expect(generatedGraph['6'].inputs.clip).toEqual([appliedId, 1]);
        expect(generatedGraph['7'].inputs.clip).toEqual([appliedId, 1]);
        expect(generatedGraph['10']).toBeUndefined();

        // The backend stops serving the selected LoRA. Re-validating reads the
        // list again; regenerating replays the record and drops the name.
        comfy.setLoras(['lora_b.safetensors']);
        await openSdSettings(page);
        const validateLoras = page.waitForResponse(
            response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/sd/comfy/loras',
        );
        await page.locator('#sd_comfy_validate').click();
        expect((await validateLoras).ok()).toBe(true);
        await closeAnyOpenTopSettingsDrawer(page);

        const regenerateCount = comfy.requests.length;
        await page.locator('.mes_text img[data-illustration-id]').last().click();
        await expect(page.locator('#sd_illustration_actions')).toBeVisible();
        await page.locator('#sd_illustration_action_regenerate').click();
        await expect(page.locator('#toast-container .toast', { hasText: 'lora_a.safetensors' })).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#toast-container .toast', { hasText: 'lora_b.safetensors' })).toHaveCount(0);

        await expect.poll(() => comfy.requests.length, { timeout: 60_000 }).toBeGreaterThan(regenerateCount);
        const replayGraph = comfy.requests.at(-1).prompt;
        expect(loraNodes(replayGraph)).toHaveLength(0);
        expect(replayGraph['3'].inputs.model).toEqual(['4', 0]);
        expect(replayGraph['6'].inputs.clip).toEqual(['4', 1]);
        expect(replayGraph['7'].inputs.clip).toEqual(['4', 1]);

        // The replay appends a child record that keeps the surviving selection.
        await expect.poll(() => page.evaluate(() => {
            const message = window.Luker.getContext().chat.at(-1);
            return (message?.extra?.illustrations || []).length;
        }), { timeout: 15_000 }).toBe(2);
        const replayRecords = await page.evaluate(() => window.Luker.getContext().chat.at(-1).extra.illustrations);
        expect(replayRecords[1].parentId).toBe(original.id);
        expect(replayRecords[1].prompt).toBe('1girl, brass spyglass');
        expect(replayRecords[1].loras).toEqual([]);
    });
});

test.describe('workflow placeholder preset sync', () => {
    test('writes workflow editor placeholder edits into the current preset', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await connectChatCompletion(page);
        await configureComfy(page);
        await openSdSettings(page);

        const editor = page.locator('dialog.popup[open]', { has: page.locator('#sd_comfy_workflow_editor_workflow') });
        await page.locator('#sd_comfy_open_workflow_editor').click();
        await expect(editor).toBeVisible({ timeout: 15_000 });

        const readPresetPlaceholders = () => page.evaluate(() => {
            const bucket = window.Luker.getContext().extensionSettings.sd.generationPresets;
            const preset = bucket.presets.find(entry => entry.id === bucket.currentId);
            return preset?.config?.comfy_placeholders ?? [];
        });

        await editor.locator('#sd_comfy_workflow_editor_placeholder_add').click();
        const item = editor.locator('#sd_comfy_workflow_editor_placeholder_list_custom > li').last();
        await item.locator('.sd_comfy_workflow_editor_custom_find').fill('e2e_marker');
        await item.locator('.sd_comfy_workflow_editor_custom_replace').fill('e2e_value');
        await expect.poll(readPresetPlaceholders, { timeout: 15_000 })
            .toContainEqual({ find: 'e2e_marker', replace: 'e2e_value' });

        // Removing the row drops the same entry from the preset.
        await item.locator('.sd_comfy_workflow_editor_custom_remove').click();
        await expect.poll(
            async () => (await readPresetPlaceholders()).some(entry => entry?.find === 'e2e_marker'),
            { timeout: 15_000 },
        ).toBe(false);

        await editor.locator('.popup-button-cancel').click();
        await editor.waitFor({ state: 'detached' });
    });
});
