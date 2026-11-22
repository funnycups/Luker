import { expect, test } from '@jest/globals';
import {
    ADD_IMAGE_PROMPT_TOOL, GENERATE_IMAGE_TOOL,
    buildAddImagePromptTool, buildGenerateImageTool, buildIllustrationAgentTools,
    validateAddImagePromptArgs, validateGenerateImageArgs,
    resolvePromptCharacterRefs, selectPromptCalls, filterReplayReferences,
} from '../public/scripts/extensions/stable-diffusion/illustration/tools.js';

const LORA_NAMES = ['a.safetensors'];

test('tool schemas expose the fixed contract', () => {
    expect(ADD_IMAGE_PROMPT_TOOL.function.name).toBe('add_image_prompt');
    expect(ADD_IMAGE_PROMPT_TOOL.function.parameters.required)
        .toEqual(['prompt', 'insert_after', 'insert_before']);
    expect(ADD_IMAGE_PROMPT_TOOL.function.parameters.properties).not.toHaveProperty('loras');
    expect(GENERATE_IMAGE_TOOL.function.name).toBe('generate_image');
    expect(GENERATE_IMAGE_TOOL.function.parameters.required).toEqual(['prompt']);
    expect(GENERATE_IMAGE_TOOL.function.parameters.properties).not.toHaveProperty('loras');
});

test('builders add the LoRA property only when names are available', () => {
    const promptTool = buildAddImagePromptTool(LORA_NAMES);
    expect(promptTool.function.parameters.properties.loras).toMatchObject({
        type: 'array',
        items: {
            properties: { name: { type: 'string', enum: LORA_NAMES } },
            required: ['name'],
        },
    });
    expect(buildAddImagePromptTool([]).function.parameters.properties).not.toHaveProperty('loras');

    const imageTool = buildGenerateImageTool(LORA_NAMES);
    expect(imageTool.function.parameters.properties.loras.items.properties).toHaveProperty('name');
    expect(buildGenerateImageTool([]).function.parameters.properties).not.toHaveProperty('loras');
});

test('builders keep the weight out unless the LoRA parameter includes one', () => {
    const unweighted = buildAddImagePromptTool(LORA_NAMES, { includeWeight: false });
    expect(unweighted.function.parameters.properties.loras.items.properties).not.toHaveProperty('weight');

    const weighted = buildGenerateImageTool(LORA_NAMES, { includeWeight: true });
    expect(weighted.function.parameters.properties.loras.items.properties.weight)
        .toMatchObject({ type: 'number' });
    expect(weighted.function.parameters.properties.loras.items.required).toEqual(['name']);
});

test('builders copy the base definitions instead of mutating them', () => {
    const withLoras = buildAddImagePromptTool(LORA_NAMES, { includeWeight: true });
    const withoutLoras = buildAddImagePromptTool([]);
    expect(withLoras.function.parameters.properties).toHaveProperty('loras');
    expect(withoutLoras.function.parameters.properties).not.toHaveProperty('loras');
    expect(ADD_IMAGE_PROMPT_TOOL.function.parameters.properties).not.toHaveProperty('loras');
    expect(ADD_IMAGE_PROMPT_TOOL.function.parameters.required)
        .toEqual(['prompt', 'insert_after', 'insert_before']);

    buildGenerateImageTool(LORA_NAMES);
    expect(GENERATE_IMAGE_TOOL.function.parameters.properties).not.toHaveProperty('loras');
    expect(GENERATE_IMAGE_TOOL.function.parameters.required).toEqual(['prompt']);
});

test('rejects empty prompt and anchors', () => {
    expect(validateAddImagePromptArgs({ prompt: ' ', insert_after: 'a', insert_before: 'b' }).ok).toBe(false);
    expect(validateAddImagePromptArgs({ prompt: 'x', insert_after: '', insert_before: 'b' }).ok).toBe(false);
    expect(validateGenerateImageArgs({ prompt: '' }).ok).toBe(false);
});

test('validation returns an empty LoRA list when the argument is omitted', () => {
    expect(validateAddImagePromptArgs({ prompt: 'x', insert_after: 'a', insert_before: 'b' })).toEqual({
        ok: true,
        value: { prompt: 'x', insertAfter: 'a', insertBefore: 'b', loras: [] },
    });
    expect(validateGenerateImageArgs({ prompt: 'x' }, {
        availableLoras: LORA_NAMES,
        includeWeight: true,
    })).toEqual({
        ok: true,
        value: { prompt: 'x', loras: [] },
    });
});

test('validation normalizes the LoRA selection it accepts', () => {
    const loras = [{ name: 'a.safetensors', weight: 0.8 }];
    expect(validateAddImagePromptArgs({
        prompt: 'x',
        insert_after: 'a',
        insert_before: 'b',
        loras,
    }, { availableLoras: LORA_NAMES, includeWeight: true })).toEqual({
        ok: true,
        value: {
            prompt: 'x',
            insertAfter: 'a',
            insertBefore: 'b',
            loras: [{ name: 'a.safetensors', weight: 0.8 }],
        },
    });
    expect(validateGenerateImageArgs({
        prompt: 'x',
        loras: [{ name: 'a.safetensors' }],
    }, { availableLoras: LORA_NAMES, includeWeight: true })).toEqual({
        ok: true,
        value: { prompt: 'x', loras: [{ name: 'a.safetensors', weight: 1 }] },
    });
});

test('validation skips the availability check when no LoRA list is supplied', () => {
    expect(validateGenerateImageArgs({
        prompt: 'x',
        loras: [{ name: 'anything.safetensors' }],
    })).toEqual({
        ok: true,
        value: { prompt: 'x', loras: [{ name: 'anything.safetensors', weight: 1 }] },
    });
});

test('validation rejects a LoRA name outside the available list with the helper message', () => {
    const loras = [{ name: 'b.safetensors' }];
    expect(validateAddImagePromptArgs({
        prompt: 'x',
        insert_after: 'a',
        insert_before: 'b',
        loras,
    }, { availableLoras: LORA_NAMES })).toEqual({
        ok: false,
        error: 'unknown LoRA \'b.safetensors\'',
    });
    expect(validateGenerateImageArgs({ prompt: 'x', loras }, { availableLoras: LORA_NAMES })).toEqual({
        ok: false,
        error: 'unknown LoRA \'b.safetensors\'',
    });
});

test('dedupes, filters names and checks anchors', () => {
    const text = 'alpha beta gamma delta';
    const call = (prompt, after, before) => ({ name: 'add_image_prompt', args: { prompt, insert_after: after, insert_before: before } });
    const result = selectPromptCalls([
        call('p1', 'alpha', 'beta'),
        call('p1', 'alpha', 'beta'),
        { name: 'other', args: {} },
        call('p2', 'missing', 'none'),
        call('p3', 'gamma', 'delta'),
    ], { messageText: text });
    expect(result.accepted).toEqual([
        { prompt: 'p1', insertAfter: 'alpha', insertBefore: 'beta', loras: [] },
        { prompt: 'p3', insertAfter: 'gamma', insertBefore: 'delta', loras: [] },
    ]);
    expect(result.rejected).toHaveLength(2);
});

test('selectPromptCalls carries LoRA selections and rejects unknown names', () => {
    const text = 'alpha beta gamma delta';
    const call = loras => ({
        name: 'add_image_prompt',
        args: { prompt: 'p', insert_after: 'alpha', insert_before: 'beta', loras },
    });
    const options = { messageText: text, availableLoras: LORA_NAMES, includeWeight: true };

    const accepted = selectPromptCalls([call([{ name: 'a.safetensors', weight: 0.8 }])], options);
    expect(accepted.accepted).toEqual([{
        prompt: 'p',
        insertAfter: 'alpha',
        insertBefore: 'beta',
        loras: [{ name: 'a.safetensors', weight: 0.8 }],
    }]);

    const rejected = selectPromptCalls([call([{ name: 'b.safetensors' }])], options);
    expect(rejected.accepted).toEqual([]);
    expect(rejected.rejected).toHaveLength(1);
    expect(rejected.rejected[0].reason).toBe('unknown LoRA \'b.safetensors\'');
});

test('calls that differ only in LoRA selection are all kept', () => {
    const text = 'alpha beta gamma delta';
    const call = loras => ({
        name: 'add_image_prompt',
        args: { prompt: 'p', insert_after: 'alpha', insert_before: 'beta', loras },
    });
    const result = selectPromptCalls([
        call([{ name: 'a.safetensors' }]),
        call([]),
        call([{ name: 'a.safetensors' }]),
    ], { messageText: text, availableLoras: LORA_NAMES, includeWeight: true });

    expect(result.accepted.map(value => value.loras)).toEqual([
        [{ name: 'a.safetensors', weight: 1 }],
        [],
    ]);
});

test('character_refs and source_image_id tool schemas gate on preset capability switches while keeping v1 outfit_id', () => {
    const promptWithChar = buildAddImagePromptTool([], {
        capabilities: { supportsCharacterReference: true, maxCharacterReferences: 2 },
    });
    const promptCharProps = promptWithChar.function.parameters.properties.character_refs.items.properties;
    expect(promptCharProps).toHaveProperty('profile_id');
    expect(promptCharProps).toHaveProperty('outfit_id');

    const promptNoChar = buildAddImagePromptTool([], {
        capabilities: { supportsCharacterReference: false },
    });
    expect(promptNoChar.function.parameters.properties).not.toHaveProperty('character_refs');

    const disabledArchiveTools = buildIllustrationAgentTools({
        includeArchiveTools: true,
        capabilities: { characterReferenceEnabled: false, supportsCharacterReference: false },
    });
    expect(disabledArchiveTools.map(t => t.function.name)).toEqual(['add_image_prompt']);

    const studioWithChar = buildGenerateImageTool([], {
        includeStudioFields: true,
        capabilities: { supportsCharacterReference: true, supportsSourceImage: false, maxCharacterReferences: 3 },
    });
    expect(studioWithChar.function.parameters.properties.character_refs.items.properties).toHaveProperty('outfit_id');
    expect(studioWithChar.function.parameters.properties).not.toHaveProperty('source_image_id');

    const studioNoChar = buildGenerateImageTool([], {
        includeStudioFields: true,
        capabilities: { supportsCharacterReference: false, supportsSourceImage: true },
    });
    expect(studioNoChar.function.parameters.properties).not.toHaveProperty('character_refs');
    expect(studioNoChar.function.parameters.properties).not.toHaveProperty('character_image_ids');
    expect(studioNoChar.function.parameters.properties).toHaveProperty('source_image_id');
});

test('resolvePromptCharacterRefs and selectPromptCalls enforce switches, v1 outfits, 0-image profiles, and missing profileMap', () => {
    const profileMap = new Map([
        ['char_lyra', {
            id: 'char_lyra',
            name: 'Lyra',
            negativeTags: ['glasses'],
            outfits: [
                { id: 'outfit_coat', name: 'Coat', referenceImages: ['/user/images/_references/lyra_1.png', '/user/images/_references/lyra_2.png'] },
                { id: 'outfit_empty', name: 'Empty', referenceImages: [] },
            ],
            defaultOutfitId: 'outfit_coat',
        }],
    ]);
    const caps = { source: 'google', supportsCharacterReference: true, maxCharacterReferences: 2 };

    expect(resolvePromptCharacterRefs([{ profile_id: 'char_lyra', outfit_id: 'outfit_coat' }], { profileMap, capabilities: caps })).toEqual({
        ok: true,
        references: [
            { imagePath: '/user/images/_references/lyra_1.png', role: 'character', label: 'Lyra — Coat' },
            { imagePath: '/user/images/_references/lyra_2.png', role: 'character', label: 'Lyra — Coat' },
        ],
        negativeTags: ['glasses'],
    });

    expect(resolvePromptCharacterRefs([{ profile_id: 'char_lyra', outfit_id: 'outfit_empty' }], { profileMap, capabilities: caps }).ok).toBe(false);
    expect(resolvePromptCharacterRefs([{ profile_id: 'char_lyra' }], {
        profileMap,
        capabilities: { source: 'comfy', supportsCharacterReference: true, maxCharacterReferences: 1 },
    }).ok).toBe(false);
    expect(resolvePromptCharacterRefs([{ profile_id: 'char_lyra' }], {
        profileMap,
        capabilities: { source: 'google', supportsCharacterReference: false },
    }).ok).toBe(false);

    const unresolvedWithoutMap = selectPromptCalls([{
        name: 'add_image_prompt',
        args: { prompt: '1girl', insert_after: 'alpha', insert_before: 'beta', character_refs: [{ profile_id: 'char_lyra' }] },
    }], { messageText: 'alpha beta', capabilities: caps, profileMap: null });
    expect(unresolvedWithoutMap.accepted).toEqual([]);
    expect(unresolvedWithoutMap.rejected).toHaveLength(1);

    const filtered = filterReplayReferences([
        { imagePath: '/user/images/c.png', role: 'character' },
        { imagePath: '/user/images/s.png', role: 'source' },
        { imagePath: '/user/images/st.png', role: 'style' },
    ], { supportsCharacterReference: false, supportsSourceImage: true, supportsStyleReference: false });
    expect(filtered.references).toEqual([{ imagePath: '/user/images/s.png', role: 'source' }]);
    expect(filtered.skipped).toHaveLength(2);
});
