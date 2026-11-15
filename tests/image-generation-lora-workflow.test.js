import { expect, test } from '@jest/globals';
import {
    LORA_NAME_PLACEHOLDER,
    LORA_MODEL_STRENGTH_PLACEHOLDER,
    LORA_CLIP_STRENGTH_PLACEHOLDER,
    inspectLoraTemplate,
    applyLorasToWorkflow,
} from '../public/scripts/extensions/stable-diffusion/lora/workflow.js';

function makeWorkflow() {
    return {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['5', 1] } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['5', 1] } },
        '3': {
            class_type: 'KSampler',
            inputs: {
                seed: 42,
                steps: 20,
                cfg: 7,
                sampler_name: 'euler',
                scheduler: 'normal',
                denoise: 1,
                model: ['5', 0],
                positive: ['1', 0],
                negative: ['2', 0],
                latent_image: ['6', 0],
            },
        },
        '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
        '5': {
            class_type: 'LoraLoader',
            inputs: {
                lora_name: LORA_NAME_PLACEHOLDER,
                strength_model: LORA_MODEL_STRENGTH_PLACEHOLDER,
                strength_clip: LORA_CLIP_STRENGTH_PLACEHOLDER,
                model: ['4', 0],
                clip: ['4', 1],
            },
        },
        '6': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
        '7': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
        '8': { class_type: 'SaveImage', inputs: { filename_prefix: 'image', images: ['7', 0] } },
    };
}

function makeModelOnlyWorkflow() {
    const workflow = makeWorkflow();
    workflow['5'] = {
        class_type: 'LoraLoaderModelOnly',
        inputs: {
            lora_name: LORA_NAME_PLACEHOLDER,
            strength_model: LORA_MODEL_STRENGTH_PLACEHOLDER,
            model: ['4', 0],
        },
    };
    workflow['1'].inputs.clip = ['4', 1];
    workflow['2'].inputs.clip = ['4', 1];
    return workflow;
}

function catchError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    throw new Error('Expected the call to throw');
}

test('placeholder constants use the template syntax', () => {
    expect(LORA_NAME_PLACEHOLDER).toBe('%lora_name%');
    expect(LORA_MODEL_STRENGTH_PLACEHOLDER).toBe('%lora_strength_model%');
    expect(LORA_CLIP_STRENGTH_PLACEHOLDER).toBe('%lora_strength_clip%');
});

test('inspectLoraTemplate returns the template node id and strength placeholders', () => {
    expect(inspectLoraTemplate(makeWorkflow())).toEqual({
        nodeId: '5',
        hasModelStrength: true,
        hasClipStrength: true,
    });
});

test('inspectLoraTemplate returns null when no template node exists', () => {
    const workflow = makeWorkflow();
    delete workflow['5'];
    expect(inspectLoraTemplate(workflow)).toBeNull();
});

test('inspectLoraTemplate rejects two template nodes', () => {
    const workflow = makeWorkflow();
    workflow['9'] = {
        class_type: 'LoraLoader',
        inputs: { ...workflow['5'].inputs },
    };
    const error = catchError(() => inspectLoraTemplate(workflow));
    expect(error.code).toBe('lora_template_multiple');
    expect(error.message).toMatch(/'5'/);
    expect(error.message).toMatch(/'9'/);
});

test('inspectLoraTemplate rejects an unsupported template class type', () => {
    const workflow = makeWorkflow();
    workflow['5'].class_type = 'LoraLoaderAdvanced';
    const error = catchError(() => inspectLoraTemplate(workflow));
    expect(error.code).toBe('lora_template_unmappable');
    expect(error.message).toMatch(/'5'/);
    expect(error.message).toContain('LoraLoaderAdvanced');
});

test('inspectLoraTemplate rejects a malformed model link on a LoraLoader template', () => {
    const workflow = makeWorkflow();
    workflow['5'].inputs.model = ['4', '0'];
    const error = catchError(() => inspectLoraTemplate(workflow));
    expect(error.code).toBe('lora_template_unmappable');
    expect(error.message).toMatch(/'5'/);
    expect(error.message).toContain('model');
});

test('inspectLoraTemplate rejects template link inputs that are not [string, integer]', () => {
    for (const malformed of ['4', ['4'], ['4', '0'], [4, 0], ['4', 0.5]]) {
        const workflow = makeWorkflow();
        workflow['5'].inputs.clip = malformed;
        const error = catchError(() => inspectLoraTemplate(workflow));
        expect(error.code).toBe('lora_template_unmappable');
        expect(error.message).toMatch(/'5'/);
        expect(error.message).toContain('clip');
    }
});

test('zero LoRAs remove the template and rewire every reference to its link inputs', () => {
    const result = applyLorasToWorkflow(makeWorkflow(), []);
    expect(result).not.toHaveProperty('5');
    expect(result['3'].inputs.model).toEqual(['4', 0]);
    expect(result['1'].inputs.clip).toEqual(['4', 1]);
    expect(result['2'].inputs.clip).toEqual(['4', 1]);
    expect(result['7'].inputs).toEqual({ samples: ['3', 0], vae: ['4', 2] });
    expect(Object.keys(result).sort()).toEqual(['1', '2', '3', '4', '6', '7', '8']);
});

test('one LoRA replaces the template with a concrete node and rewires downstream links', () => {
    const result = applyLorasToWorkflow(makeWorkflow(), [
        { name: 'detail.safetensors', weight: 0.65 },
    ]);
    expect(result).not.toHaveProperty('5');
    expect(result['9']).toEqual({
        class_type: 'LoraLoader',
        inputs: {
            lora_name: 'detail.safetensors',
            strength_model: 0.65,
            strength_clip: 0.65,
            model: ['4', 0],
            clip: ['4', 1],
        },
    });
    expect(result['3'].inputs.model).toEqual(['9', 0]);
    expect(result['1'].inputs.clip).toEqual(['9', 1]);
    expect(result['2'].inputs.clip).toEqual(['9', 1]);
});

test('expanded copies keep template-level metadata', () => {
    const workflow = makeWorkflow();
    workflow['5']._meta = { title: 'LoRA template' };
    const result = applyLorasToWorkflow(workflow, [
        { name: 'first.safetensors', weight: 0.8 },
        { name: 'second.safetensors', weight: 0.2 },
    ]);
    expect(result['9']._meta).toEqual({ title: 'LoRA template' });
    expect(result['10']._meta).toEqual({ title: 'LoRA template' });
    expect(result['9']._meta).not.toBe(workflow['5']._meta);
    expect(result['10']._meta).not.toBe(workflow['5']._meta);
});

test('two LoRAs chain in selection order and downstream links use the last copy', () => {
    const result = applyLorasToWorkflow(makeWorkflow(), [
        { name: 'first.safetensors', weight: 0.8 },
        { name: 'second.safetensors', weight: -0.4 },
    ]);
    expect(result).not.toHaveProperty('5');
    expect(result['9']).toEqual({
        class_type: 'LoraLoader',
        inputs: {
            lora_name: 'first.safetensors',
            strength_model: 0.8,
            strength_clip: 0.8,
            model: ['4', 0],
            clip: ['4', 1],
        },
    });
    expect(result['10']).toEqual({
        class_type: 'LoraLoader',
        inputs: {
            lora_name: 'second.safetensors',
            strength_model: -0.4,
            strength_clip: -0.4,
            model: ['9', 0],
            clip: ['9', 1],
        },
    });
    expect(result['3'].inputs.model).toEqual(['10', 0]);
    expect(result['1'].inputs.clip).toEqual(['10', 1]);
    expect(result['2'].inputs.clip).toEqual(['10', 1]);
});

test('a zero weight is written to both strength fields', () => {
    const result = applyLorasToWorkflow(makeWorkflow(), [
        { name: 'detail.safetensors', weight: 0 },
    ]);
    expect(result['9'].inputs.strength_model).toBe(0);
    expect(result['9'].inputs.strength_clip).toBe(0);
    expect(result['9'].inputs.strength_model).not.toBe(LORA_MODEL_STRENGTH_PLACEHOLDER);
    expect(result['9'].inputs.strength_clip).not.toBe(LORA_CLIP_STRENGTH_PLACEHOLDER);
});

test('LoraLoaderModelOnly expands through its single model link and output 0', () => {
    expect(inspectLoraTemplate(makeModelOnlyWorkflow())).toEqual({
        nodeId: '5',
        hasModelStrength: true,
        hasClipStrength: false,
    });
    const result = applyLorasToWorkflow(makeModelOnlyWorkflow(), [
        { name: 'first.safetensors', weight: 0.5 },
        { name: 'second.safetensors', weight: 0.75 },
    ]);
    expect(result).not.toHaveProperty('5');
    expect(result['9'].inputs).toEqual({
        lora_name: 'first.safetensors',
        strength_model: 0.5,
        model: ['4', 0],
    });
    expect(result['10'].inputs).toEqual({
        lora_name: 'second.safetensors',
        strength_model: 0.75,
        model: ['9', 0],
    });
    expect(result['3'].inputs.model).toEqual(['10', 0]);
    expect(result['1'].inputs.clip).toEqual(['4', 1]);
    expect(result['2'].inputs.clip).toEqual(['4', 1]);
});

test('LoraLoaderModelOnly with zero LoRAs removes the template and restores downstream links', () => {
    const result = applyLorasToWorkflow(makeModelOnlyWorkflow(), []);
    expect(result).not.toHaveProperty('5');
    expect(result['3'].inputs.model).toEqual(['4', 0]);
    expect(result['1'].inputs.clip).toEqual(['4', 1]);
    expect(result['2'].inputs.clip).toEqual(['4', 1]);
});

test('only the placeholder strength is replaced with the weight', () => {
    const workflow = makeWorkflow();
    workflow['5'].inputs.strength_clip = 0.8;
    expect(inspectLoraTemplate(workflow)).toEqual({
        nodeId: '5',
        hasModelStrength: true,
        hasClipStrength: false,
    });
    const result = applyLorasToWorkflow(workflow, [
        { name: 'detail.safetensors', weight: 0.35 },
    ]);
    expect(result['9'].inputs.strength_model).toBe(0.35);
    expect(result['9'].inputs.strength_clip).toBe(0.8);
    expect(result['9'].inputs.lora_name).toBe('detail.safetensors');
});

test('a clip placeholder is replaced while a fixed model strength survives', () => {
    const workflow = makeWorkflow();
    workflow['5'].inputs.strength_model = 0.7;
    expect(inspectLoraTemplate(workflow)).toEqual({
        nodeId: '5',
        hasModelStrength: false,
        hasClipStrength: true,
    });
    const result = applyLorasToWorkflow(workflow, [
        { name: 'detail.safetensors', weight: 0.35 },
    ]);
    expect(result['9'].inputs.strength_model).toBe(0.7);
    expect(result['9'].inputs.strength_clip).toBe(0.35);
});

test('fixed strengths survive when neither strength field is a placeholder', () => {
    const workflow = makeWorkflow();
    workflow['5'].inputs.strength_model = 0.9;
    workflow['5'].inputs.strength_clip = 0.5;
    expect(inspectLoraTemplate(workflow)).toEqual({
        nodeId: '5',
        hasModelStrength: false,
        hasClipStrength: false,
    });
    const result = applyLorasToWorkflow(workflow, [
        { name: 'detail.safetensors', weight: 0.35 },
    ]);
    expect(result['9'].inputs.strength_model).toBe(0.9);
    expect(result['9'].inputs.strength_clip).toBe(0.5);
    expect(result['9'].inputs.lora_name).toBe('detail.safetensors');
});

test('the input workflow object is never mutated', () => {
    const workflow = makeWorkflow();
    const snapshot = structuredClone(workflow);
    const result = applyLorasToWorkflow(workflow, [
        { name: 'first.safetensors', weight: 0.8 },
        { name: 'second.safetensors', weight: 0.5 },
    ]);
    expect(workflow).toEqual(snapshot);
    expect(result).not.toBe(workflow);
    expect(result['4']).not.toBe(workflow['4']);
    expect(result['4'].inputs).not.toBe(workflow['4'].inputs);
    expect(result['8'].inputs.images).not.toBe(workflow['8'].inputs.images);
});

test('no template and no LoRAs returns an equivalent deep copy', () => {
    const workflow = makeWorkflow();
    delete workflow['5'];
    const result = applyLorasToWorkflow(workflow, []);
    expect(result).toEqual(workflow);
    expect(result).not.toBe(workflow);
    expect(result['8'].inputs).not.toBe(workflow['8'].inputs);
});

test('LoRAs without a template node raise lora_template_missing', () => {
    const workflow = makeWorkflow();
    delete workflow['5'];
    const error = catchError(() => applyLorasToWorkflow(workflow, [
        { name: 'detail.safetensors', weight: 0.6 },
    ]));
    expect(error.code).toBe('lora_template_missing');
    expect(error.message).toMatch(/template/i);
});

test('a clip-before-model template still wires in the fixed LoraLoader order', () => {
    const workflow = makeWorkflow();
    workflow['5'].inputs = {
        lora_name: LORA_NAME_PLACEHOLDER,
        strength_model: LORA_MODEL_STRENGTH_PLACEHOLDER,
        strength_clip: LORA_CLIP_STRENGTH_PLACEHOLDER,
        clip: ['4', 1],
        model: ['4', 0],
    };
    const result = applyLorasToWorkflow(workflow, [
        { name: 'detail.safetensors', weight: 0.65 },
    ]);
    expect(result['9'].inputs.model).toEqual(['4', 0]);
    expect(result['9'].inputs.clip).toEqual(['4', 1]);
    expect(result['3'].inputs.model).toEqual(['9', 0]);
    expect(result['1'].inputs.clip).toEqual(['9', 1]);
    expect(result['2'].inputs.clip).toEqual(['9', 1]);
});

test('new node ids are consecutive integers after the current maximum numeric id', () => {
    const workflow = makeWorkflow();
    workflow['12'] = { class_type: 'Note', inputs: { text: 'kept' } };
    const result = applyLorasToWorkflow(workflow, [
        { name: 'first.safetensors', weight: 0.8 },
        { name: 'second.safetensors', weight: 0.2 },
    ]);
    expect(result).toHaveProperty('13');
    expect(result).toHaveProperty('14');
    expect(result).not.toHaveProperty('9');
    expect(result).not.toHaveProperty('10');
    expect(result).not.toHaveProperty('15');
    expect(result['13'].inputs.model).toEqual(['4', 0]);
    expect(result['14'].inputs.model).toEqual(['13', 0]);
    expect(result['12']).toEqual({ class_type: 'Note', inputs: { text: 'kept' } });
});

test('a template node holding the maximum numeric id still expands after it', () => {
    const workflow = makeWorkflow();
    const template = workflow['5'];
    delete workflow['5'];
    workflow['30'] = template;
    workflow['1'].inputs.clip = ['30', 1];
    workflow['2'].inputs.clip = ['30', 1];
    workflow['3'].inputs.model = ['30', 0];
    const result = applyLorasToWorkflow(workflow, [
        { name: 'detail.safetensors', weight: 0.5 },
    ]);
    expect(result).not.toHaveProperty('30');
    expect(result).toHaveProperty('31');
    expect(result).not.toHaveProperty('9');
    expect(result['31'].inputs.model).toEqual(['4', 0]);
    expect(result['31'].inputs.clip).toEqual(['4', 1]);
    expect(result['3'].inputs.model).toEqual(['31', 0]);
    expect(result['1'].inputs.clip).toEqual(['31', 1]);
    expect(result['2'].inputs.clip).toEqual(['31', 1]);
});

test('a reference to an output the template does not expose raises lora_template_unmappable', () => {
    const workflow = makeModelOnlyWorkflow();
    workflow['1'].inputs.clip = ['5', 1];
    const error = catchError(() => applyLorasToWorkflow(workflow, []));
    expect(error.code).toBe('lora_template_unmappable');
    expect(error.message).toMatch(/'5'/);
    expect(error.message).toContain('clip');
});

test('a reference to a missing template output raises during multi-LoRA expansion', () => {
    const workflow = makeModelOnlyWorkflow();
    workflow['1'].inputs.clip = ['5', 1];
    const error = catchError(() => applyLorasToWorkflow(workflow, [
        { name: 'detail.safetensors', weight: 0.5 },
    ]));
    expect(error.code).toBe('lora_template_unmappable');
    expect(error.message).toMatch(/'5'/);
    expect(error.message).toContain('clip');
});

test('zero LoRAs reject a malformed external reference to the template', () => {
    const workflow = makeWorkflow();
    workflow['1'].inputs.clip = ['5'];
    const error = catchError(() => applyLorasToWorkflow(workflow, []));
    expect(error.code).toBe('lora_template_unmappable');
    expect(error.message).toMatch(/'5'/);
    expect(error.message).toContain('clip');
    expect(error.message).toContain('["5"]');
});

test('multi-LoRA expansion rejects a malformed external reference to the template', () => {
    const workflow = makeWorkflow();
    workflow['3'].inputs.model = ['5', '0'];
    const error = catchError(() => applyLorasToWorkflow(workflow, [
        { name: 'detail.safetensors', weight: 0.5 },
    ]));
    expect(error.code).toBe('lora_template_unmappable');
    expect(error.message).toMatch(/'3'/);
    expect(error.message).toMatch(/'5'/);
    expect(error.message).toContain('model');
    expect(error.message).toContain('["5","0"]');
});

test('a graph entry without an inputs object raises lora_template_unmappable', () => {
    for (const inputs of [undefined, null]) {
        const workflow = makeWorkflow();
        workflow['6'] = inputs === undefined
            ? { class_type: 'EmptyLatentImage' }
            : { class_type: 'EmptyLatentImage', inputs };
        const error = catchError(() => applyLorasToWorkflow(workflow, []));
        expect(error.code).toBe('lora_template_unmappable');
        expect(error.message).toMatch(/'6'/);
    }
});
