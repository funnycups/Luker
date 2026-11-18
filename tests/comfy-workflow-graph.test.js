import { describe, expect, test } from '@jest/globals';
import {
    compileComfyWorkflowPromptPayload,
    formatWorkflowTopology,
    normalizeWorkflowFileName,
    validateComfyWorkflowGraph,
} from '../public/scripts/extensions/stable-diffusion/comfy-workflow-graph.js';

const BASE_API_GRAPH = {
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

describe('comfy-workflow-graph validator, formatter, and compiler', () => {
    test('normalizeWorkflowFileName appends .json and rejects traversal or separators', () => {
        expect(normalizeWorkflowFileName('Flux_Custom')).toBe('Flux_Custom.json');
        expect(normalizeWorkflowFileName('Flux_Custom.json')).toBe('Flux_Custom.json');
        expect(() => normalizeWorkflowFileName('../settings.json')).toThrow(/invalid/i);
        expect(() => normalizeWorkflowFileName('nested/wf.json')).toThrow(/invalid/i);
        expect(() => normalizeWorkflowFileName('nested\\wf.json')).toThrow(/invalid/i);
        expect(() => normalizeWorkflowFileName('Flux: Test.json')).toThrow(/invalid/i);
        expect(() => normalizeWorkflowFileName('Flux*Test')).toThrow(/invalid/i);
        expect(() => normalizeWorkflowFileName('Flux?.json')).toThrow(/invalid/i);
        expect(() => normalizeWorkflowFileName('')).toThrow(/invalid/i);
    });

    test('validateComfyWorkflowGraph accepts valid API graph with LoRA + ref slots and rejects UI format, dangling links, cycles, numeric links, and broken templates', () => {
        const withLoraAndRef = {
            ...structuredClone(BASE_API_GRAPH),
            '14': {
                class_type: 'LoraLoader',
                inputs: {
                    model: ['4', 0], clip: ['4', 1],
                    lora_name: '%lora_name%', strength_model: '%lora_strength_model%', strength_clip: '%lora_strength_clip%',
                },
            },
            '20': { class_type: 'LoadImage', inputs: { image: '%ref_image_1%' } },
        };
        withLoraAndRef['3'].inputs.model = ['14', 0];
        withLoraAndRef['6'].inputs.clip = ['14', 1];
        const valid = validateComfyWorkflowGraph(withLoraAndRef);
        expect(valid.ok).toBe(true);
        expect(valid.summary.loraTemplate?.nodeId).toBe('14');
        expect(valid.summary.referenceSlots.slotCount).toBe(1);
        expect(valid.summary.placeholders).toContain('%prompt%');

        // LiteGraph UI format
        const uiFmt = validateComfyWorkflowGraph({ last_node_id: 9, nodes: [{ id: 1 }], links: [[1, 1, 0, 2, 0]] });
        expect(uiFmt).toMatchObject({ ok: false, code: 'ui_format_unsupported' });

        // Empty graph
        expect(validateComfyWorkflowGraph({})).toMatchObject({ ok: false, code: 'empty_graph' });

        // Dangling link
        const dangling = structuredClone(BASE_API_GRAPH);
        dangling['3'].inputs.model = ['999', 0];
        expect(validateComfyWorkflowGraph(dangling)).toMatchObject({ ok: false, code: 'dangling_link' });

        // Numeric node ID link mistake
        const numericLink = structuredClone(BASE_API_GRAPH);
        numericLink['3'].inputs.model = [4, 0];
        expect(validateComfyWorkflowGraph(numericLink)).toMatchObject({ ok: false, code: 'invalid_link_format' });

        // Self/cyclic link
        const cyclic = structuredClone(BASE_API_GRAPH);
        cyclic['14'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['15', 0], lora_name: 'a.safetensors', strength_model: 1 } };
        cyclic['15'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['14', 0], lora_name: 'b.safetensors', strength_model: 1 } };
        expect(validateComfyWorkflowGraph(cyclic)).toMatchObject({ ok: false, code: 'graph_cycle' });

        // Duplicate reference slot
        const dupRef = structuredClone(BASE_API_GRAPH);
        dupRef['20'] = { class_type: 'LoadImage', inputs: { image: '%ref_image_1%' } };
        dupRef['21'] = { class_type: 'LoadImage', inputs: { image: '%ref_image_1%' } };
        expect(validateComfyWorkflowGraph(dupRef)).toMatchObject({ ok: false, code: 'ref_template_duplicate_slot' });

        // Multiple LoRA templates
        const dupLora = structuredClone(withLoraAndRef);
        dupLora['15'] = {
            class_type: 'LoraLoaderModelOnly',
            inputs: { model: ['14', 0], lora_name: '%lora_name%', strength_model: 1 },
        };
        expect(validateComfyWorkflowGraph(dupLora)).toMatchObject({ ok: false, code: 'lora_template_multiple' });
    });

    test('formatWorkflowTopology renders readable node connections and compileComfyWorkflowPromptPayload safely encodes quotes, newlines, LoRAs, and references', () => {
        const text = formatWorkflowTopology('Default_Comfy_Workflow.json', BASE_API_GRAPH, { isActive: true });
        expect(text).toContain('Default_Comfy_Workflow.json (active)');
        expect(text).toContain('[3] KSampler');
        expect(text).toContain('#4:0');

        const filteredText = formatWorkflowTopology('Default_Comfy_Workflow.json', BASE_API_GRAPH, { nodeIds: ['6'] });
        expect(filteredText).toContain('[6] CLIPTextEncode');

        const graphWithLoraRef = {
            ...structuredClone(BASE_API_GRAPH),
            '14': {
                class_type: 'LoraLoader',
                inputs: {
                    model: ['4', 0], clip: ['4', 1],
                    lora_name: '%lora_name%', strength_model: '%lora_strength_model%', strength_clip: '%lora_strength_clip%',
                },
            },
            '20': { class_type: 'LoadImage', inputs: { image: '%ref_image_1%' } },
            '21': { class_type: 'VAEEncode', inputs: { pixels: ['20', 0], vae: ['4', 2] } },
            '22': { class_type: 'ReferenceLatent', inputs: { conditioning: ['6', 0], latent: ['21', 0] } },
        };
        graphWithLoraRef['3'].inputs.model = ['14', 0];
        graphWithLoraRef['3'].inputs.positive = ['22', 0];
        graphWithLoraRef['6'].inputs.clip = ['14', 1];
        graphWithLoraRef['7'].inputs.clip = ['14', 1];

        const compiled = compileComfyWorkflowPromptPayload({
            workflowText: JSON.stringify(graphWithLoraRef),
            prompt: '1girl, "lantern light",\nnight street',
            negativePrompt: 'lowres',
            sdSettings: {
                model: 'illustrious.safetensors', vae: 'auto', sampler: 'euler', scheduler: 'normal',
                steps: 24, scale: 6, width: 832, height: 1216, denoising_strength: 0.75, clip_skip: 2, seed: 42,
            },
            customPlaceholders: [{ find: 'custom_tag', replace: 'cinematic' }],
            loras: [{ name: 'detail.safetensors', weight: 0.8 }],
            uploadedFilenames: [],
            extraOptions: { width: 1024 },
        });
        expect(compiled.seed).toBe(42);
        expect(compiled.slotInfo.slotCount).toBe(1);
        const parsed = JSON.parse(compiled.promptPayload);
        expect(parsed.prompt['6'].inputs.text).toBe('1girl, "lantern light",\nnight street');
        expect(parsed.prompt['3'].inputs.seed).toBe(42);
        expect(parsed.prompt['5'].inputs.width).toBe(1024);
        // Unused optional reference branch pruned cleanly
        expect(parsed.prompt['20']).toBeUndefined();
        expect(parsed.prompt['22']).toBeUndefined();
        expect(parsed.prompt['3'].inputs.positive).toEqual(['6', 0]);
        // LoRA expanded cleanly
        const loraNodes = Object.values(parsed.prompt).filter(n => n.class_type === 'LoraLoader');
        expect(loraNodes).toHaveLength(1);
        expect(loraNodes[0].inputs.lora_name).toBe('detail.safetensors');
        expect(loraNodes[0].inputs.strength_model).toBe(0.8);
    });

    test('compileComfyWorkflowPromptPayload preserves $ replacement patterns and handles undefined settings cleanly', () => {
        const compiled = compileComfyWorkflowPromptPayload({
            workflowText: JSON.stringify(BASE_API_GRAPH),
            prompt: 'tag $& literal $$ and $\' "$`"',
            negativePrompt: 'neg $& $$',
            sdSettings: { seed: 99 },
            customPlaceholders: [{ find: 'dollar_ph', replace: 'val $& $$' }],
        });
        const parsed = JSON.parse(compiled.promptPayload);
        expect(parsed.prompt['6'].inputs.text).toBe('tag $& literal $$ and $\' "$`"');
        expect(parsed.prompt['7'].inputs.text).toBe('neg $& $$');
        expect(parsed.prompt['3'].inputs.seed).toBe(99);
    });
});
