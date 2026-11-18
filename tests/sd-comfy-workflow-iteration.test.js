/**
 * @jest-environment jsdom
 */
import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { createWorkbenchRegistry } from '../public/scripts/workbench/registry.js';
import { runIterateTurn } from '../public/scripts/workbench/model/iterate.js';
import { initSdLens } from '../public/scripts/extensions/stable-diffusion/lens/index.js';

beforeAll(() => {
    globalThis.structuredClone ??= v => JSON.parse(JSON.stringify(v));
});

const DEFAULT_WF = {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%model%' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%', clip: ['4', 1] } },
    '3': {
        class_type: 'KSampler',
        inputs: {
            seed: '%seed%', steps: '%steps%', cfg: '%scale%', sampler_name: '%sampler%', scheduler: '%scheduler%', denoise: 1,
            model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
        },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Luker', images: ['8', 0] } },
};

describe('Workbench sd ComfyUI workflow iteration, draft test-run, commit, and undo', () => {
    test('loads workflows (including broken JSON recovery), probes object_info, edits nodes with validation, test-runs draft without mutating disk, renders node diff + preview, commits atomically, and undoes cleanly', async () => {
        const diskWorkflows = new Map([
            ['Default_Comfy_Workflow.json', JSON.stringify(DEFAULT_WF, null, 2)],
            ['Broken_Legacy.json', '{ invalid json, "broken_marker": 456'],
        ]);
        let refreshHookCount = 0;
        let lastGeneratedPromptPayload = null;
        let lastGenerateSignal = null;
        let uploadedRefsPayload = null;
        let failComfyGenerateOnce = true;

        const reg = createWorkbenchRegistry();
        const sdSettings = {
            source: 'comfy',
            comfy_type: 'standard',
            comfy_url: 'http://192.168.50.8:8188',
            comfy_workflow: 'Default_Comfy_Workflow.json',
            comfy_placeholders: [{ find: 'custom_tag', replace: 'masterpiece' }],
            model: 'illustrious.safetensors',
            vae: 'auto', sampler: 'euler', scheduler: 'normal',
            steps: 20, scale: 6, width: 832, height: 1216, denoising_strength: 1, clip_skip: 1, seed: 77,
            generationPresets: {
                currentId: 'gp_1',
                presets: [{ id: 'gp_1', name: 'Comfy Main', config: { comfy_workflow: 'Default_Comfy_Workflow.json', comfy_placeholders: [] } }],
            },
            illustration: { enabled: true, currentPresetId: 'p1', presets: [{ id: 'p1', name: 'Tag', illustrationPrompt: 'a', studioPrompt: 'b', llm: {} }] },
        };

        const ctx = {
            extensionSettings: { sd: sdSettings },
            workbench: reg,
            translate: s => String(s ?? ''),
            getCurrentLocale: () => 'en',
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            saveSettings: async (_d, opts) => opts?.onSaved?.(),
            getGlobalState: async () => ({ ok: true, state: {} }),
            updateGlobalState: async () => ({ ok: true, state: {} }),
        };
        globalThis.Luker = { getContext: () => ctx };

        const originalFetch = globalThis.fetch;
        globalThis.fetch = jest.fn(async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : {};
            if (url === '/api/sd/comfy/workflows') {
                return { ok: true, status: 200, json: async () => [...diskWorkflows.keys()] };
            }
            if (url === '/api/sd/comfy/workflow') {
                return { ok: true, status: 200, json: async () => diskWorkflows.get(body.file_name) ?? '' };
            }
            if (url === '/api/sd/comfy/save-workflow') {
                diskWorkflows.set(body.file_name, body.workflow);
                return { ok: true, status: 200, json: async () => [...diskWorkflows.keys()] };
            }
            if (url === '/api/sd/comfy/delete-workflow') {
                diskWorkflows.delete(body.file_name);
                return { ok: true, status: 200, text: async () => 'OK' };
            }
            if (url === '/api/sd/comfy/object-info/search') {
                return { ok: true, status: 200, json: async () => ({ mode: 'matches', totalMatches: 1, matches: [{ classType: 'LoraLoader' }], formattedLines: 'LoraLoader [loaders]' }) };
            }
            if (url === '/api/sd/comfy/object-info/node') {
                return { ok: true, status: 200, json: async () => ({ nodes: { LoraLoader: { classType: 'LoraLoader', outputs: [{ index: 0, type: 'MODEL' }, { index: 1, type: 'CLIP' }] } }, notFound: [] }) };
            }
            if (url === '/api/sd/comfy/upload-references') {
                uploadedRefsPayload = body;
                return { ok: true, status: 200, json: async () => ({ filenames: ['uploaded_ref_1.png'] }) };
            }
            if (url === '/api/sd/comfy/generate') {
                lastGenerateSignal = init?.signal || null;
                lastGeneratedPromptPayload = JSON.parse(body.prompt);
                if (failComfyGenerateOnce) {
                    failComfyGenerateOnce = false;
                    return { ok: false, status: 500, text: async () => 'ComfyUI generation did not succeed.\n\nKSampler [3] ValueError: bad link' };
                }
                return { ok: true, status: 200, json: async () => ({ format: 'png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const cleanup = initSdLens({
            getContext: () => ctx,
            comfyBridge: {
                onComfyWorkflowsCommitted: async () => { refreshHookCount += 1; },
                savePreviewBase64: async () => '/user/images/_studio/comfy_draft_preview.png',
            },
        });

        try {
            const target = reg.getIterateTargets().find(t => t.id === 'sd');
            const askProvider = reg.getAskProviders().find(p => p.id === 'sd');
            expect(target.chips(ctx).length).toBeGreaterThan(0);

            const loaded = await target.load('global', ctx);
            const base = JSON.parse(JSON.stringify(loaded.live));

            // 1. Broken legacy JSON on disk did not crash load and is reported in sd_list_workflows
            const wfList = await target.runRead({ name: 'sd_list_workflows', args: {} }, base);
            expect(wfList.find(w => w.fileName === 'Broken_Legacy.json')?.rawError).toBeTruthy();

            const wfRead = await target.runRead({ name: 'sd_read_workflow', args: { file_name: 'Default_Comfy_Workflow.json', node_ids: ['3'] } }, base);
            expect(wfRead).toContain('[3] KSampler');
            const brokenRead = await target.runRead({ name: 'sd_read_workflow', args: { file_name: 'Broken_Legacy.json' } }, base);
            expect(brokenRead).toContain('"broken_marker": 456');

            // 2. Object-info search & node schema read tools
            const searchRes = await target.runRead({ name: 'sd_search_comfy_nodes', args: { query: 'lora' } }, base);
            expect(searchRes.formattedLines).toContain('LoraLoader');
            const nodeRes = await target.runRead({ name: 'sd_inspect_comfy_node', args: { class_types: ['LoraLoader'] } }, base);
            expect(nodeRes.nodes.LoraLoader).toBeDefined();

            // 3. Reject LiteGraph UI format when creating workflow
            await expect(target.runEdit({
                name: 'sd_create_workflow',
                args: { file_name: 'UI_Export', workflow_json: { nodes: [{ id: 1 }], links: [] } },
            }, JSON.parse(JSON.stringify(base)))).rejects.toThrow(/API Format/i);

            // Clone Default_Comfy_Workflow.json -> Flux_LoRA_Ref.json, set active
            let draft = await target.runEdit({
                name: 'sd_create_workflow',
                args: { file_name: 'Flux_LoRA_Ref', clone_from: 'Default_Comfy_Workflow.json', set_active: true },
            }, JSON.parse(JSON.stringify(base)));

            // Reject removing a node still referenced downstream
            await expect(target.runEdit({
                name: 'sd_remove_workflow_nodes',
                args: { file_name: 'Flux_LoRA_Ref.json', node_ids: ['4'] },
            }, draft)).rejects.toThrow(/missing|dangling|4/i);

            // Deleting the active workflow in a throwaway copy rebinds activeWorkflow; deleting the last workflow is rejected
            const delCopy = await target.runEdit({
                name: 'sd_delete_workflow',
                args: { file_name: 'Flux_LoRA_Ref.json' },
            }, JSON.parse(JSON.stringify(draft)));
            expect(delCopy.comfyConfig.activeWorkflow).toBe('Default_Comfy_Workflow.json');
            const oneLeft = await target.runEdit({
                name: 'sd_delete_workflow',
                args: { file_name: 'Broken_Legacy.json' },
            }, delCopy);
            await expect(target.runEdit({
                name: 'sd_delete_workflow',
                args: { file_name: 'Default_Comfy_Workflow.json' },
            }, oneLeft)).rejects.toThrow(/last|at least one/i);

            draft = await target.runEdit({
                name: 'sd_upsert_workflow_nodes',
                args: {
                    file_name: 'Flux_LoRA_Ref.json',
                    nodes: {
                        '14': {
                            class_type: 'LoraLoader',
                            inputs: {
                                model: ['4', 0], clip: ['4', 1],
                                lora_name: '%lora_name%', strength_model: '%lora_strength_model%', strength_clip: '%lora_strength_clip%',
                            },
                        },
                        '20': { class_type: 'LoadImage', inputs: { image: '%ref_image%' } },
                        '3': { ...DEFAULT_WF['3'], inputs: { ...DEFAULT_WF['3'].inputs, model: ['14', 0] } },
                        '6': { ...DEFAULT_WF['6'], inputs: { ...DEFAULT_WF['6'].inputs, clip: ['14', 1] } },
                    },
                },
            }, draft);

            draft = await target.runEdit({
                name: 'sd_update_comfy_config',
                args: {
                    placeholders: [{ find: 'custom_tag', replace: 'cinematic lighting' }],
                },
            }, draft);

            // 4. Draft test-run: first run returns structured error without throwing or writing disk; second run via runIterateTurn forwards AbortSignal, uploads refs, expands LoRA, and saves preview
            const diskSnapshotBeforeCommit = new Map(diskWorkflows);
            const failedTest = await target.runRead({ name: 'sd_test_workflow_draft', args: { prompt: '1girl, test' } }, draft);
            expect(failedTest.ok).toBe(false);
            expect(failedTest.error).toContain('KSampler [3]');

            const abortController = new AbortController();
            let turnRound = 0;
            const turnResult = await runIterateTurn({
                messages: [{ role: 'user', content: 'Test draft' }],
                live: draft,
                tools: await target.tools(),
                isRead: n => target.isRead(n),
                runRead: (call, live, helpers) => target.runRead(call, live, helpers),
                runEdit: (call, live, helpers) => target.runEdit(call, live, helpers),
                signal: abortController.signal,
                request: async () => {
                    turnRound += 1;
                    if (turnRound === 1) {
                        return {
                            text: '',
                            calls: [{
                                id: 'c_test',
                                name: 'sd_test_workflow_draft',
                                args: {
                                    prompt: '1girl, test',
                                    loras: [{ name: 'detail_tweaker.safetensors', weight: 0.8 }],
                                    reference_image_paths: ['/user/images/_references/ref_a.png'],
                                },
                            }],
                        };
                    }
                    return { text: 'Verified draft.', calls: [] };
                },
            });
            const toolMsg = JSON.parse(turnResult.messages.find(m => m.role === 'tool').content);
            expect(toolMsg).toMatchObject({ ok: true, imagePath: '/user/images/_studio/comfy_draft_preview.png' });
            expect(lastGenerateSignal).toBe(abortController.signal);
            expect(uploadedRefsPayload?.references).toEqual([{ imagePath: '/user/images/_references/ref_a.png', role: 'character' }]);
            expect(JSON.stringify(lastGeneratedPromptPayload)).toContain('detail_tweaker.safetensors');
            expect(JSON.stringify(lastGeneratedPromptPayload)).toContain('uploaded_ref_1.png');
            expect(diskWorkflows.has('Flux_LoRA_Ref.json')).toBe(false);
            expect([...diskWorkflows.entries()]).toEqual([...diskSnapshotBeforeCommit.entries()]);

            // Preview renders per-node summary and test preview image
            const previewEl = target.renderPreview({ base, ai: draft });
            expect(previewEl).not.toBeNull();
            expect(previewEl.textContent).toContain('LoraLoader');
            expect(previewEl.querySelector('img')?.getAttribute('src')).toBe('/user/images/_studio/comfy_draft_preview.png');

            // 5. Commit selected workflow + comfy:config -> writes disk, updates activeWorkflow & generationPresets, triggers refresh hook
            const keys = ['workflow:Flux_LoRA_Ref.json', 'comfy:config'];
            const rebuilt = target.rebuild(base, draft, keys);
            const committed = await target.commit(loaded.target, base, rebuilt, keys);
            expect(committed.applied).toEqual(expect.arrayContaining(keys));
            expect(diskWorkflows.has('Flux_LoRA_Ref.json')).toBe(true);
            expect(sdSettings.comfy_workflow).toBe('Flux_LoRA_Ref.json');
            expect(sdSettings.comfy_placeholders).toEqual([{ find: 'custom_tag', replace: 'cinematic lighting' }]);
            expect(sdSettings.generationPresets.presets[0].config.comfy_workflow).toBe('Flux_LoRA_Ref.json');
            expect(refreshHookCount).toBe(1);

            // 6. AskProvider wb_read_sd part:'workflows' exposes workflow summary while redacting private comfy_url
            const wfAsk = await askProvider.readers.wb_read_sd({ part: 'workflows' }, ctx);
            expect(JSON.stringify(wfAsk)).toContain('Flux_LoRA_Ref.json');
            expect(JSON.stringify(wfAsk)).not.toContain('192.168.50.8');

            // 7. Undo deletes newly created Flux_LoRA_Ref.json and restores comfy_workflow
            await committed.undo();
            expect(diskWorkflows.has('Flux_LoRA_Ref.json')).toBe(false);
            expect(sdSettings.comfy_workflow).toBe('Default_Comfy_Workflow.json');
            expect(sdSettings.comfy_placeholders).toEqual([{ find: 'custom_tag', replace: 'masterpiece' }]);
            expect(refreshHookCount).toBe(2);
        } finally {
            globalThis.fetch = originalFetch;
            cleanup();
        }
    });

    test('redacts single-dot LAN hostnames before URL masking, guards partial-selection commit/undo & preset config, clears stale draft preview after commit, and guards RunPod serverless & upload network errors', async () => {
        const diskWorkflows = new Map([
            ['Default_Comfy_Workflow.json', JSON.stringify(DEFAULT_WF, null, 2)],
            ['Active_Second.json', JSON.stringify(DEFAULT_WF, null, 2)],
        ]);
        let throwOnUpload = false;

        const reg = createWorkbenchRegistry();
        const sdSettings = {
            source: 'comfy',
            comfy_type: 'standard',
            comfy_url: 'http://comfy-nas.lan:8188',
            sdcpp_url: 'http://sdcpp-box:8080',
            drawthings_auth: 'dtuser:dtsecret987',
            comfy_workflow: 'Active_Second.json',
            comfy_placeholders: [
                { find: 'endpoint_leak', replace: 'http://comfy-nas.lan:8188/view and http://sdcpp-box:8080 and dtuser:dtsecret987' },
            ],
            model: 'transient-unloaded-model',
            seed: 12,
            generationPresets: {
                currentId: 'gp_keep',
                presets: [{
                    id: 'gp_keep',
                    name: 'Keep Preset Fields',
                    config: {
                        model: 'kept-preset-model.safetensors',
                        comfy_workflow: 'Active_Second.json',
                        comfy_placeholders: [],
                    },
                }],
            },
            illustration: { enabled: true, currentPresetId: 'p1', presets: [{ id: 'p1', name: 'Tag', illustrationPrompt: 'a', studioPrompt: 'b', llm: {} }] },
        };

        const ctx = {
            extensionSettings: { sd: sdSettings },
            workbench: reg,
            translate: s => String(s ?? ''),
            getCurrentLocale: () => 'en',
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            saveSettings: async (_d, opts) => opts?.onSaved?.(),
            getGlobalState: async () => ({ ok: true, state: {} }),
            updateGlobalState: async () => ({ ok: true, state: {} }),
        };
        globalThis.Luker = { getContext: () => ctx };

        const originalFetch = globalThis.fetch;
        globalThis.fetch = jest.fn(async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : {};
            if (url === '/api/sd/comfy/workflows') {
                return { ok: true, status: 200, json: async () => [...diskWorkflows.keys()] };
            }
            if (url === '/api/sd/comfy/workflow') {
                return { ok: true, status: 200, json: async () => diskWorkflows.get(body.file_name) ?? '' };
            }
            if (url === '/api/sd/comfy/save-workflow') {
                diskWorkflows.set(body.file_name, body.workflow);
                return { ok: true, status: 200, json: async () => [...diskWorkflows.keys()] };
            }
            if (url === '/api/sd/comfy/delete-workflow') {
                diskWorkflows.delete(body.file_name);
                return { ok: true, status: 200, text: async () => 'OK' };
            }
            if (url === '/api/sd/comfy/upload-references') {
                if (throwOnUpload) throw new Error('ECONNRESET during upload');
                return { ok: true, status: 200, json: async () => ({ filenames: ['ref.png'] }) };
            }
            if (url === '/api/sd/comfy/generate') {
                return { ok: true, status: 200, json: async () => ({ format: 'png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const cleanup = initSdLens({
            getContext: () => ctx,
            comfyBridge: {
                onComfyWorkflowsCommitted: async () => {},
                savePreviewBase64: async () => '/user/images/_studio/preview_2.png',
            },
        });

        try {
            const target = reg.getIterateTargets().find(t => t.id === 'sd');
            const askProvider = reg.getAskProviders().find(p => p.id === 'sd');

            // 1. Single-dot LAN hostname & extra SD URLs/secrets redacted completely
            const wfAsk = await askProvider.readers.wb_read_sd({ part: 'workflows' }, ctx);
            const wfAskStr = JSON.stringify(wfAsk);
            expect(wfAskStr).not.toContain('comfy-nas.lan');
            expect(wfAskStr).not.toContain('sdcpp-box');
            expect(wfAskStr).not.toContain('dtsecret987');

            const loaded = await target.load('global', ctx);
            const base = JSON.parse(JSON.stringify(loaded.live));

            // 2. Partial selection: user checks comfy:config (pointing to Unsaved_New.json) while unchecking workflow:Unsaved_New.json
            const withNewWf = await target.runEdit({
                name: 'sd_create_workflow',
                args: { file_name: 'Unsaved_New.json', clone_from: 'Active_Second.json', set_active: true },
            }, JSON.parse(JSON.stringify(base)));

            // Run draft test on Unsaved_New.json -> verify cloning Active_Second.json does NOT show preview on Active_Second.json, and after commit preview clears when 0 changes remain
            const testRes = await target.runRead({ name: 'sd_test_workflow_draft', args: { file_name: 'Unsaved_New.json', prompt: 'test' } }, withNewWf);
            expect(testRes.ok).toBe(true);
            expect(target.renderPreview({ base, ai: base })).toBeNull();

            const partialKeys = ['comfy:config'];
            const partialRebuilt = target.rebuild(base, withNewWf, partialKeys);
            await target.commit(loaded.target, base, partialRebuilt, partialKeys);
            // Active_Second.json stays active since Unsaved_New.json was NOT committed, and preset model was NOT clobbered!
            expect(sdSettings.comfy_workflow).toBe('Active_Second.json');
            expect(sdSettings.generationPresets.presets[0].config.model).toBe('kept-preset-model.safetensors');
            expect(target.renderPreview({ base, ai: base })).toBeNull();

            // 3. Partial selection: user deletes Active_Second.json while unchecking comfy:config -> falls back on commit and restores Active_Second.json on undo!
            const afterDeleteDraft = await target.runEdit({
                name: 'sd_delete_workflow',
                args: { file_name: 'Active_Second.json' },
            }, JSON.parse(JSON.stringify(base)));
            const delOnlyKeys = ['workflow:Active_Second.json'];
            const delOnlyRebuilt = target.rebuild(base, afterDeleteDraft, delOnlyKeys);
            const delCommitted = await target.commit(loaded.target, base, delOnlyRebuilt, delOnlyKeys);
            expect(sdSettings.comfy_workflow).toBe('Default_Comfy_Workflow.json');
            await delCommitted.undo();
            expect(diskWorkflows.has('Active_Second.json')).toBe(true);
            expect(sdSettings.comfy_workflow).toBe('Active_Second.json');

            // 4. Upload network error returns { ok: false, error } without throwing
            const withRefWf = await target.runEdit({
                name: 'sd_upsert_workflow_nodes',
                args: {
                    file_name: 'Active_Second.json',
                    nodes: { '20': { class_type: 'LoadImage', inputs: { image: '%ref_image%' } } },
                },
            }, JSON.parse(JSON.stringify(base)));
            throwOnUpload = true;
            const uploadErrRes = await target.runRead({
                name: 'sd_test_workflow_draft',
                args: { file_name: 'Active_Second.json', reference_image_paths: ['/user/images/_references/a.png'] },
            }, withRefWf);
            expect(uploadErrRes.ok).toBe(false);
            expect(uploadErrRes.error).toContain('ECONNRESET');
            throwOnUpload = false;

            // 5. RunPod Serverless mode guards /object_info and draft test tools explicitly
            sdSettings.comfy_type = 'runpod_serverless';
            await expect(target.runRead({ name: 'sd_search_comfy_nodes', args: {} }, base)).rejects.toThrow(/standard ComfyUI/i);
            const runpodTestRes = await target.runRead({ name: 'sd_test_workflow_draft', args: {} }, base);
            expect(runpodTestRes.ok).toBe(false);
            expect(runpodTestRes.error).toMatch(/standard ComfyUI/i);
        } finally {
            globalThis.fetch = originalFetch;
            cleanup();
        }
    });
});
