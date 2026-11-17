import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    computeImageCapabilities,
    getCapabilities,
    assertReferencesSupportedByCapabilities,
    mergePresetStyleReferences,
    resolveAttributionPayload,
} from '../public/scripts/extensions/stable-diffusion/capabilities.js';
import {
    createImageGenerationRegistry,
} from '../public/scripts/image-generation/registry.js';
import {
    findPluginViolations,
    findReverseViolations,
} from '../scripts/check-plugin-imports.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('SD capabilities, attribution isolation, and three-layer imageGeneration API', () => {
    test('computeImageCapabilities accurately reflects backend and model reference/caption support', async () => {
        expect(await getCapabilities({ source: 'google', model: 'gemini-3-pro-image' })).toMatchObject({
            source: 'google',
            model: 'gemini-3-pro-image',
            supportsCharacterReference: true,
            maxCharacterReferences: null,
            supportsStyleReference: true,
            supportsSourceImage: true,
            supportsMultiCharacterPrompts: false,
            supportsDynamicAspectRatio: true,
        });

        expect(await getCapabilities({ source: 'google', model: 'imagen-4.0-generate-001' })).toMatchObject({
            supportsCharacterReference: false,
            supportsStyleReference: false,
            supportsSourceImage: false,
            supportsDynamicAspectRatio: true,
        });

        expect(computeImageCapabilities({ source: 'novel', model: 'nai-diffusion-4-5-full' })).toMatchObject({
            supportsCharacterReference: true,
            maxCharacterReferences: 4,
            supportsStyleReference: true,
            maxStyleReferences: 4,
            supportsSourceImage: true,
            supportsMultiCharacterPrompts: true,
        });

        expect(computeImageCapabilities({ source: 'novel', model: 'nai-diffusion-4-full' })).toMatchObject({
            supportsCharacterReference: false,
            maxCharacterReferences: 0,
            supportsStyleReference: true,
            maxStyleReferences: 4,
            supportsMultiCharacterPrompts: true,
        });

        expect(computeImageCapabilities({ source: 'openai', model: 'gpt-image-1' })).toMatchObject({
            supportsCharacterReference: true,
            supportsStyleReference: true,
            supportsSourceImage: true,
        });

        expect(computeImageCapabilities({ source: 'openai', model: 'dall-e-3' })).toMatchObject({
            supportsCharacterReference: false,
            supportsStyleReference: false,
            supportsSourceImage: false,
        });

        expect(computeImageCapabilities(
            { source: 'comfy', comfy_type: 'standard', model: 'flux.safetensors' },
            { comfyReferenceSlotCount: 2, availableLoras: { names: ['detail.safetensors'], includeWeight: true } },
        )).toMatchObject({
            supportsCharacterReference: true,
            maxCharacterReferences: 2,
            supportsStyleReference: true,
            maxStyleReferences: 2,
            supportsSourceImage: true,
            availableLoras: { names: ['detail.safetensors'], includeWeight: true },
        });

        expect(computeImageCapabilities({ source: 'auto', model: 'anything-v5' })).toMatchObject({
            supportsCharacterReference: false,
            supportsStyleReference: false,
            supportsSourceImage: true,
        });

        expect(computeImageCapabilities({ source: 'pollinations', model: 'flux' })).toMatchObject({
            supportsCharacterReference: false,
            supportsStyleReference: false,
            supportsSourceImage: false,
        });
    });

    test('mergePresetStyleReferences, assertReferencesSupportedByCapabilities, and resolveAttributionPayload enforce strict contracts', () => {
        const naiCaps = computeImageCapabilities({ source: 'novel', model: 'nai-diffusion-4-5-full' });
        const merged = mergePresetStyleReferences(
            [{ imagePath: '/user/images/_references/char1.png', role: 'character', label: 'A' }],
            [{ imagePath: '/user/images/_style_references/vibe1.png', strength: 0.55 }],
            naiCaps,
        );
        expect(merged).toEqual([
            { imagePath: '/user/images/_references/char1.png', role: 'character', label: 'A' },
            { imagePath: '/user/images/_style_references/vibe1.png', role: 'style', strength: 0.55 },
        ]);

        const pollCaps = computeImageCapabilities({ source: 'pollinations', model: 'flux' });
        expect(mergePresetStyleReferences([], [{ imagePath: '/user/images/_style_references/vibe1.png', strength: 0.5 }], pollCaps)).toEqual([]);
        expect(() => assertReferencesSupportedByCapabilities(
            [{ imagePath: '/user/images/_references/char1.png', role: 'character' }],
            pollCaps,
        )).toThrow(/does not support character reference/i);

        expect(() => assertReferencesSupportedByCapabilities(
            Array.from({ length: 5 }, (_, i) => ({ imagePath: `/user/images/_references/c${i}.png`, role: 'character' })),
            naiCaps,
        )).toThrow(/at most 4 character reference/i);

        const fakeContext = {
            chatId: 'Heroine - 2026-11-17',
            characterId: 0,
            groupId: null,
            characters: [{ avatar: 'Heroine.png' }],
        };
        expect(resolveAttributionPayload('none', fakeContext)).toBeNull();
        expect(resolveAttributionPayload('active_chat', fakeContext)).toEqual({
            char_dir: 'Heroine',
            chat_name: 'Heroine - 2026-11-17',
            is_group: false,
        });
    });

    test('createImageGenerationRegistry normalizes generate calls and surfaces missing provider errors', async () => {
        const reg = createImageGenerationRegistry();
        await expect(reg.api.generate('a starry sky')).rejects.toThrow(/not initialized|not available/i);

        const received = [];
        reg.setProvider({
            async generate(req) {
                received.push(req);
                return { imagePath: '/user/images/_studio/out.png', format: 'png', prompt: req.prompt, negativePrompt: req.negativePrompt || '' };
            },
            async getCapabilities() {
                return computeImageCapabilities({ source: 'chat_image', model: 'gpt-image-relay' });
            },
            listPresets: () => [{ id: 'p1', name: 'Default', source: 'chat_image', model: 'gpt-image-relay' }],
            getCurrentPreset: () => ({ id: 'p1', name: 'Default' }),
            async switchPreset(idOrName) { return { id: 'p1', name: idOrName }; },
            async getAvailableLoras() { return { names: [], includeWeight: false }; },
        });

        const res1 = await reg.api.generate('sunset beach', { aspectRatio: '16:9', attribution: 'none' });
        expect(res1.imagePath).toBe('/user/images/_studio/out.png');
        expect(received[0]).toMatchObject({
            prompt: 'sunset beach',
            aspectRatio: '16:9',
            attribution: 'none',
        });

        const res2 = await reg.api.generate({
            prompt: 'rainy street',
            references: [{ imagePath: '/user/images/_references/c1.png', role: 'character' }],
        });
        expect(res2.imagePath).toBe('/user/images/_studio/out.png');
        expect(received[1]).toMatchObject({
            prompt: 'rainy street',
            references: [{ imagePath: '/user/images/_references/c1.png', role: 'character' }],
        });
    });

    test('imageGeneration is wired across st-context.js, card-app/context.js, and stable-diffusion/index.js with zero plugin boundary violations', () => {
        const stContextSrc = fs.readFileSync(path.join(REPO_ROOT, 'public/scripts/st-context.js'), 'utf8');
        const cardAppSrc = fs.readFileSync(path.join(REPO_ROOT, 'public/scripts/extensions/card-app/context.js'), 'utf8');
        const sdIndexSrc = fs.readFileSync(path.join(REPO_ROOT, 'public/scripts/extensions/stable-diffusion/index.js'), 'utf8');

        expect(stContextSrc).toMatch(/\bimageGeneration\s*:/);
        expect(cardAppSrc).toMatch(/\bget\s+imageGeneration\s*\(/);
        expect(sdIndexSrc).toMatch(/registerExtensionApi\(\s*['"]sd['"]/);

        const { coreViolations, pluginViolations } = findPluginViolations(REPO_ROOT);
        const reverseViolations = findReverseViolations(REPO_ROOT);
        expect(coreViolations.size).toBe(0);
        expect(pluginViolations.size).toBe(0);
        expect(reverseViolations).toEqual([]);
    });
});
