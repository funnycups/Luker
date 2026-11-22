import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    computeProtocolCapabilities,
    computeReferenceConfigWarnings,
    computeImageCapabilities,
    getCapabilities,
    resolveCharacterReferenceMode,
    assertReferencesSupportedByProtocol,
    mergePresetStyleReferences,
    prepareGenerationExtraOptions,
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
    test('computeImageCapabilities keeps user reference switches off by default while exposing protocol facts', async () => {
        for (const [settings, runtimeInfo] of [
            [{ source: 'google', model: 'gemini-3-pro-image' }, {}],
            [{ source: 'openrouter', model: 'google/gemini-2.5-flash-image' }, {}],
            [{ source: 'chat_image', model: 'gpt-image-relay' }, {}],
            [{ source: 'novel', model: 'nai-diffusion-4-5-full' }, {}],
            [{ source: 'comfy', comfy_type: 'standard', model: 'flux.safetensors' }, { comfyReferenceSlotCount: 2 }],
        ]) {
            const caps = await getCapabilities(settings, null, runtimeInfo);
            expect(caps).toMatchObject({
                characterReferenceEnabled: false,
                characterReferenceMode: 'text_only',
                supportsCharacterReference: false,
                supportsCharacterTextReference: false,
                maxCharacterReferences: 0,
                supportsStyleReference: false,
                maxStyleReferences: 0,
                supportsSourceImage: false,
                warnings: [],
            });
            expect(caps.protocol.supportsCharacterReference).toBe(true);
            expect(caps.protocol.supportsStyleReference).toBe(true);
            expect(caps.protocol.supportsSourceImage).toBe(true);
        }

        expect(computeImageCapabilities({ source: 'novel', model: 'nai-diffusion-4-5-full' })).toMatchObject({
            supportsMultiCharacterPrompts: true,
            supportsDynamicAspectRatio: true,
        });
        expect(computeImageCapabilities({ source: 'openai', model: 'dall-e-2' })).toMatchObject({
            supportsDynamicAspectRatio: false,
            protocol: {
                supportsCharacterReference: true,
                supportsStyleReference: true,
                supportsSourceImage: true,
                sharedReferenceSlots: true,
                maxTotalReferences: 1,
            },
        });
        expect(computeImageCapabilities(
            { source: 'comfy', comfy_type: 'standard', model: 'flux.safetensors' },
            { comfyReferenceSlotCount: 2, availableLoras: { names: ['detail.safetensors'], includeWeight: true } },
        ).availableLoras).toEqual({ names: ['detail.safetensors'], includeWeight: true });
    });

    test('text_only character reference mode enables text references with zero image warnings on every backend', () => {
        for (const [settings, runtimeInfo] of [
            [{ source: 'pollinations', model: 'flux' }, {}],
            [{ source: 'comfy', comfy_type: 'standard', model: 'flux' }, { comfyReferenceSlotCount: 0 }],
            [{ source: 'novel', model: 'nai-diffusion-4-full' }, {}],
            [{ source: 'google', model: 'imagen-4.0-generate-001' }, {}],
        ]) {
            const caps = computeImageCapabilities(
                { ...settings, character_reference_enabled: true, character_reference_mode: 'text_only' },
                runtimeInfo,
            );
            expect(caps).toMatchObject({
                characterReferenceEnabled: true,
                characterReferenceMode: 'text_only',
                supportsCharacterTextReference: true,
                supportsCharacterReference: false,
                maxCharacterReferences: 0,
                warnings: [],
            });
        }
    });

    test('shared-slot backends deduct enabled style references from maxCharacterReferences and warn when exhausted', () => {
        const oneStyleCaps = computeImageCapabilities(
            {
                source: 'comfy',
                comfy_type: 'standard',
                model: 'flux',
                character_reference_enabled: true,
                character_reference_mode: 'text_and_image',
                style_references_enabled: true,
                style_references: [{ imagePath: '/user/images/_style_references/s1.png', strength: 0.6 }],
            },
            { comfyReferenceSlotCount: 2 },
        );
        expect(oneStyleCaps).toMatchObject({
            supportsCharacterReference: true,
            supportsCharacterTextReference: true,
            maxCharacterReferences: 1,
            supportsStyleReference: true,
            maxStyleReferences: 2,
            warnings: [],
        });

        const twoStyleCaps = computeImageCapabilities(
            {
                source: 'comfy',
                comfy_type: 'standard',
                model: 'flux',
                character_reference_enabled: true,
                character_reference_mode: 'text_and_image',
                style_references_enabled: true,
                style_references: [
                    { imagePath: '/user/images/_style_references/s1.png', strength: 0.6 },
                    { imagePath: '/user/images/_style_references/s2.png', strength: 0.6 },
                ],
            },
            { comfyReferenceSlotCount: 2 },
        );
        expect(twoStyleCaps.maxCharacterReferences).toBe(0);
        expect(twoStyleCaps.warnings).toEqual([
            expect.objectContaining({
                code: 'shared_slots_exhausted_by_style',
                affects: ['character_image'],
            }),
        ]);

        const disabledStyleCaps = computeImageCapabilities(
            {
                source: 'comfy',
                comfy_type: 'standard',
                model: 'flux',
                character_reference_enabled: true,
                character_reference_mode: 'text_and_image',
                style_references_enabled: false,
                style_references: [
                    { imagePath: '/user/images/_style_references/s1.png', strength: 0.6 },
                    { imagePath: '/user/images/_style_references/s2.png', strength: 0.6 },
                ],
            },
            { comfyReferenceSlotCount: 2 },
        );
        expect(disabledStyleCaps.maxCharacterReferences).toBe(2);
        expect(disabledStyleCaps.warnings).toEqual([]);

        const dalle2NoStyle = computeImageCapabilities({
            source: 'openai',
            model: 'dall-e-2',
            character_reference_enabled: true,
            character_reference_mode: 'image_only',
        });
        expect(dalle2NoStyle.maxCharacterReferences).toBe(1);
        expect(dalle2NoStyle.warnings).toEqual([]);

        const dalle2OneStyle = computeImageCapabilities({
            source: 'openai',
            model: 'dall-e-2',
            character_reference_enabled: true,
            character_reference_mode: 'image_only',
            style_references_enabled: true,
            style_references: [{ imagePath: '/user/images/_style_references/s1.png', strength: 0.5 }],
        });
        expect(dalle2OneStyle.maxCharacterReferences).toBe(0);
        expect(dalle2OneStyle.warnings).toEqual([
            expect.objectContaining({ code: 'shared_slots_exhausted_by_style', affects: ['character_image'] }),
        ]);
    });

    test('computeReferenceConfigWarnings produces all conflict warning codes with accurate affects', () => {
        expect(computeReferenceConfigWarnings(
            { source: 'comfy', comfy_type: 'standard', character_reference_enabled: true, character_reference_mode: 'image_only', img2img_enabled: true },
            { comfyReferenceSlotCount: 0, comfyWorkflowError: 'Unexpected token in JSON' },
        )).toEqual([
            expect.objectContaining({ code: 'comfy_workflow_invalid', affects: ['character_image', 'source'] }),
        ]);

        expect(computeReferenceConfigWarnings(
            { source: 'comfy', comfy_type: 'standard', style_references_enabled: true },
            { comfyReferenceSlotCount: 0 },
        )).toEqual([
            expect.objectContaining({ code: 'comfy_missing_ref_slots', affects: ['style'] }),
        ]);

        expect(computeReferenceConfigWarnings(
            { source: 'comfy', comfy_type: 'runpod_serverless', img2img_enabled: true },
        )).toEqual([
            expect.objectContaining({ code: 'comfy_runpod_no_references', affects: ['source'] }),
        ]);

        expect(computeReferenceConfigWarnings(
            {
                source: 'comfy',
                comfy_type: 'standard',
                style_references_enabled: true,
                style_references: [
                    { imagePath: '/user/images/_style_references/1.png' },
                    { imagePath: '/user/images/_style_references/2.png' },
                    { imagePath: '/user/images/_style_references/3.png' },
                ],
            },
            { comfyReferenceSlotCount: 2 },
        )).toEqual([
            expect.objectContaining({ code: 'shared_style_exceeds_slots', affects: ['style'] }),
        ]);

        expect(computeReferenceConfigWarnings(
            {
                source: 'openai',
                model: 'dall-e-2',
                style_references_enabled: true,
                style_references: [{ imagePath: '/user/images/_style_references/1.png' }],
                img2img_enabled: true,
            },
        )).toEqual([
            expect.objectContaining({ code: 'shared_slots_exhausted_by_style', affects: ['source'] }),
        ]);

        for (const source of ['horde', 'pollinations']) {
            expect(computeReferenceConfigWarnings({
                source,
                character_reference_enabled: true,
                character_reference_mode: 'image_only',
                style_references_enabled: true,
            })).toEqual([
                expect.objectContaining({ code: 'backend_no_image_input', affects: ['character_image', 'style'] }),
            ]);
        }

        for (const source of ['auto', 'vlad']) {
            expect(computeReferenceConfigWarnings({
                source,
                character_reference_enabled: true,
                character_reference_mode: 'text_and_image',
                style_references_enabled: true,
                img2img_enabled: true,
            })).toEqual([
                expect.objectContaining({ code: 'webui_source_only', affects: ['character_image', 'style'] }),
            ]);
            expect(computeReferenceConfigWarnings({ source, img2img_enabled: true })).toEqual([]);
        }

        expect(computeReferenceConfigWarnings({
            source: 'novel',
            model: 'nai-diffusion-4-full',
            character_reference_enabled: true,
            character_reference_mode: 'image_only',
        })).toEqual([
            expect.objectContaining({ code: 'novel_char_ref_requires_v45', affects: ['character_image'] }),
        ]);

        expect(computeReferenceConfigWarnings({
            source: 'novel',
            model: 'nai-diffusion-2',
            style_references_enabled: true,
        })).toEqual([
            expect.objectContaining({ code: 'novel_style_ref_unsupported', affects: ['style'] }),
        ]);

        expect(computeReferenceConfigWarnings({
            source: 'novel',
            model: 'nai-diffusion-4-5-full',
            style_references_enabled: true,
            style_references: Array.from({ length: 5 }, (_, i) => ({ imagePath: `/user/images/_style_references/s${i}.png` })),
        })).toEqual([
            expect.objectContaining({ code: 'novel_style_exceeds_cap', affects: ['style'] }),
        ]);

        expect(computeReferenceConfigWarnings({
            source: 'google',
            model: 'imagen-4.0-generate-001',
            character_reference_enabled: true,
            character_reference_mode: 'image_only',
        })).toEqual([
            expect.objectContaining({ code: 'google_model_no_image_input', affects: ['character_image'] }),
        ]);

        expect(computeReferenceConfigWarnings({
            source: 'openai',
            model: 'dall-e-3',
            img2img_enabled: true,
        })).toEqual([
            expect.objectContaining({ code: 'openai_model_no_image_input', affects: ['source'] }),
        ]);
    });

    test('mergePresetStyleReferences, assertReferencesSupportedByProtocol, prepareGenerationExtraOptions, and resolveAttributionPayload enforce strict contracts', () => {
        const naiCaps = computeImageCapabilities({
            source: 'novel',
            model: 'nai-diffusion-4-5-full',
            style_references_enabled: true,
        });
        const merged = mergePresetStyleReferences(
            [{ imagePath: '/user/images/_references/char1.png', role: 'character', label: 'A' }],
            [{ imagePath: '/user/images/_style_references/vibe1.png', strength: 0.55 }],
            naiCaps,
        );
        expect(merged).toEqual([
            { imagePath: '/user/images/_references/char1.png', role: 'character', label: 'A' },
            { imagePath: '/user/images/_style_references/vibe1.png', role: 'style', strength: 0.55 },
        ]);

        // No silent truncation when style references exceed backend cap
        const fiveStyles = Array.from({ length: 5 }, (_, i) => ({ imagePath: `/user/images/_style_references/v${i}.png`, strength: 0.5 }));
        expect(mergePresetStyleReferences([], fiveStyles, naiCaps)).toHaveLength(5);

        const offCaps = computeImageCapabilities({ source: 'google', model: 'gemini-3-pro-image', style_references_enabled: false });
        expect(mergePresetStyleReferences([], [{ imagePath: '/user/images/_style_references/vibe1.png', strength: 0.5 }], offCaps)).toEqual([]);

        // prepareGenerationExtraOptions merges style_references ONLY when style_references_enabled is true and includePresetStyleReferences !== false
        const disabledStyleRes = prepareGenerationExtraOptions(
            {
                source: 'google',
                model: 'gemini-3-pro-image',
                style_references_enabled: false,
                style_references: [{ imagePath: '/user/images/_style_references/v1.png', strength: 0.6 }],
            },
            {},
        );
        expect(disabledStyleRes.extraOptions.references).toEqual([]);

        const skippedStyleRes = prepareGenerationExtraOptions(
            {
                source: 'google',
                model: 'gemini-3-pro-image',
                style_references_enabled: true,
                style_references: [{ imagePath: '/user/images/_style_references/v1.png', strength: 0.6 }],
            },
            { includePresetStyleReferences: false },
        );
        expect(skippedStyleRes.extraOptions.references).toEqual([]);

        // Explicit references on Google Gemini succeed even when preset toggles are false
        const explicitGemini = prepareGenerationExtraOptions(
            { source: 'google', model: 'custom-gemini-alias' },
            { references: [{ imagePath: '/user/images/_references/char1.png', role: 'character' }] },
        );
        expect(explicitGemini.extraOptions.references).toEqual([{ imagePath: '/user/images/_references/char1.png', role: 'character' }]);

        // Rejects explicit references on horde/pollinations instead of silently dropping
        for (const source of ['horde', 'pollinations']) {
            expect(() => prepareGenerationExtraOptions(
                { source, model: 'flux' },
                { references: [{ imagePath: '/user/images/_references/char1.png', role: 'character' }] },
            )).toThrow(/does not support character reference/i);
        }

        // Rejects NovelAI >4 merged style references rather than truncating
        expect(() => prepareGenerationExtraOptions(
            {
                source: 'novel',
                model: 'nai-diffusion-4-5-full',
                style_references_enabled: true,
                style_references: fiveStyles,
            },
            {},
        )).toThrow(/at most 4 style reference/i);

        // Enforces combined shared-slot total cap on ComfyUI standard and OpenAI dall-e-2
        expect(() => prepareGenerationExtraOptions(
            { source: 'comfy', comfy_type: 'standard', model: 'flux' },
            {
                references: [
                    { imagePath: '/user/images/_references/char1.png', role: 'character' },
                    { imagePath: '/user/images/_style_references/s1.png', role: 'style' },
                    { imagePath: '/user/images/_style_references/s2.png', role: 'style' },
                ],
            },
            { comfyReferenceSlotCount: 2 },
        )).toThrow(/at most 2 total reference/i);

        expect(() => prepareGenerationExtraOptions(
            { source: 'openai', model: 'dall-e-2' },
            {
                references: [
                    { imagePath: '/user/images/_references/char1.png', role: 'character' },
                    { imagePath: '/user/images/_style_references/s1.png', role: 'style' },
                ],
            },
        )).toThrow(/at most 1 total reference/i);

        // Enforces standard ComfyUI slotCount=0 and comfyWorkflowError instead of bypassing validation
        expect(() => prepareGenerationExtraOptions(
            { source: 'comfy', comfy_type: 'standard', model: 'flux' },
            { references: [{ imagePath: '/user/images/_references/char1.png', role: 'character' }] },
            { comfyReferenceSlotCount: 0 },
        )).toThrow(/does not support character reference/i);

        expect(() => prepareGenerationExtraOptions(
            { source: 'comfy', comfy_type: 'standard', model: 'flux' },
            { references: [{ imagePath: '/user/images/_references/char1.png', role: 'character' }] },
            { comfyReferenceSlotCount: 2, comfyWorkflowError: 'Unexpected end of JSON input' },
        )).toThrow(/Unexpected end of JSON input/);

        const pollProtocol = computeProtocolCapabilities({ source: 'pollinations', model: 'flux' });
        expect(() => assertReferencesSupportedByProtocol(
            [{ imagePath: '/user/images/_references/char1.png', role: 'character' }],
            pollProtocol,
            { source: 'pollinations', model: 'flux' },
        )).toThrow(/does not support character reference/i);

        const naiProtocol = computeProtocolCapabilities({ source: 'novel', model: 'nai-diffusion-4-5-full' });
        expect(() => assertReferencesSupportedByProtocol(
            Array.from({ length: 5 }, (_, i) => ({ imagePath: `/user/images/_references/c${i}.png`, role: 'character' })),
            naiProtocol,
            { source: 'novel', model: 'nai-diffusion-4-5-full' },
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

    test('settings.html exposes preset reference controls without source gating and index.js forwards comfyWorkflowError', () => {
        const settingsHtml = fs.readFileSync(
            path.join(REPO_ROOT, 'public/scripts/extensions/stable-diffusion/settings.html'),
            'utf8',
        );
        const sdIndexSrc = fs.readFileSync(
            path.join(REPO_ROOT, 'public/scripts/extensions/stable-diffusion/index.js'),
            'utf8',
        );
        const zhCn = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'public/locales/zh-tw.json'), 'utf8'));

        expect(settingsHtml).not.toContain('id="sd_style_references_block"');

        const sectionOpenMatch = /<div\b[^>]*\bid="sd_references_section"[^>]*>/.exec(settingsHtml);
        expect(sectionOpenMatch).not.toBeNull();
        expect(sectionOpenMatch[0]).not.toMatch(/\bdata-sd-source\s*=/);

        for (const id of [
            'sd_references_section',
            'sd_character_reference_enabled',
            'sd_character_reference_mode_row',
            'sd_character_reference_mode',
            'sd_img2img_enabled',
            'sd_style_references_enabled',
            'sd_style_ref_upload',
            'sd_style_ref_file',
            'sd_style_ref_list',
            'sd_reference_warnings',
        ]) {
            expect(settingsHtml).toContain(`id="${id}"`);
        }

        const modeSelectMatch = /<select\b[^>]*\bid="sd_character_reference_mode"[^>]*>([\s\S]*?)<\/select>/.exec(settingsHtml);
        expect(modeSelectMatch).not.toBeNull();
        expect(modeSelectMatch[1]).toContain('value="text_only"');
        expect(modeSelectMatch[1]).toContain('value="image_only"');
        expect(modeSelectMatch[1]).toContain('value="text_and_image"');

        const sectionIdx = settingsHtml.indexOf('id="sd_references_section"');
        const sectionTail = settingsHtml.slice(sectionIdx, settingsHtml.indexOf('id="sd_character_prompt_block"'));
        const i18nAttrs = [...sectionTail.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]);
        expect(i18nAttrs.length).toBeGreaterThan(0);
        for (const attr of i18nAttrs) {
            expect(attr).not.toMatch(/(?<!\\);/);
            expect(typeof zhCn[attr]).toBe('string');
            expect(typeof zhTw[attr]).toBe('string');
            expect(zhCn[attr].length).toBeGreaterThan(0);
            expect(zhTw[attr].length).toBeGreaterThan(0);
        }

        const capabilitiesCalls = [...sdIndexSrc.matchAll(/computeImageCapabilities\s*\(([\s\S]*?)\);/g)];
        expect(capabilitiesCalls.length).toBeGreaterThanOrEqual(2);
        for (const call of capabilitiesCalls) {
            expect(call[1]).toContain('comfyReferenceSlotCount');
            expect(call[1]).toContain('comfyWorkflowError');
        }

        const extraOptsCalls = [...sdIndexSrc.matchAll(/prepareGenerationExtraOptions\s*\(([\s\S]*?)\);/g)];
        expect(extraOptsCalls.length).toBeGreaterThanOrEqual(1);
        for (const call of extraOptsCalls) {
            expect(call[1]).toContain('comfyReferenceSlotCount');
            expect(call[1]).toContain('comfyWorkflowError');
        }
    });

    test('assertReferencesSupportedByProtocol attaches ref_* error codes and index.js exempts ref_ alongside lora_', () => {
        const catchError = (fn) => {
            try {
                fn();
                return null;
            } catch (err) {
                return err;
            }
        };

        const wfErr = catchError(() => assertReferencesSupportedByProtocol(
            [{ imagePath: '/user/images/_references/c1.png', role: 'character' }],
            { comfyWorkflowError: 'Malformed workflow JSON' },
            { source: 'comfy', model: 'flux' },
        ));
        expect(wfErr).toBeInstanceOf(Error);
        expect(wfErr.code).toBe('ref_workflow_error');
        expect(wfErr.code.startsWith('ref_')).toBe(true);

        const unknownRoleErr = catchError(() => assertReferencesSupportedByProtocol(
            [{ imagePath: '/user/images/_references/c1.png', role: 'mask' }],
            computeProtocolCapabilities({ source: 'google', model: 'gemini-3-pro-image' }),
            { source: 'google', model: 'gemini-3-pro-image' },
        ));
        expect(unknownRoleErr.code).toBe('ref_role_unsupported');

        const unsupportedCharErr = catchError(() => assertReferencesSupportedByProtocol(
            [{ imagePath: '/user/images/_references/c1.png', role: 'character' }],
            computeProtocolCapabilities({ source: 'pollinations', model: 'flux' }),
            { source: 'pollinations', model: 'flux' },
        ));
        expect(unsupportedCharErr.code).toBe('ref_role_unsupported');

        const unsupportedStyleErr = catchError(() => assertReferencesSupportedByProtocol(
            [{ imagePath: '/user/images/_style_references/s1.png', role: 'style' }],
            computeProtocolCapabilities({ source: 'novel', model: 'nai-diffusion-2' }),
            { source: 'novel', model: 'nai-diffusion-2' },
        ));
        expect(unsupportedStyleErr.code).toBe('ref_role_unsupported');

        const unsupportedSourceErr = catchError(() => assertReferencesSupportedByProtocol(
            [{ imagePath: '/user/images/_studio/src.png', role: 'source' }],
            computeProtocolCapabilities({ source: 'pollinations', model: 'flux' }),
            { source: 'pollinations', model: 'flux' },
        ));
        expect(unsupportedSourceErr.code).toBe('ref_role_unsupported');

        const charCapErr = catchError(() => assertReferencesSupportedByProtocol(
            Array.from({ length: 5 }, (_, i) => ({ imagePath: `/user/images/_references/c${i}.png`, role: 'character' })),
            computeProtocolCapabilities({ source: 'novel', model: 'nai-diffusion-4-5-full' }),
            { source: 'novel', model: 'nai-diffusion-4-5-full' },
        ));
        expect(charCapErr.code).toBe('ref_limit_exceeded');

        const styleCapErr = catchError(() => assertReferencesSupportedByProtocol(
            Array.from({ length: 5 }, (_, i) => ({ imagePath: `/user/images/_style_references/s${i}.png`, role: 'style' })),
            computeProtocolCapabilities({ source: 'novel', model: 'nai-diffusion-4-5-full' }),
            { source: 'novel', model: 'nai-diffusion-4-5-full' },
        ));
        expect(styleCapErr.code).toBe('ref_limit_exceeded');

        const sharedCapErr = catchError(() => assertReferencesSupportedByProtocol(
            [
                { imagePath: '/user/images/_references/c1.png', role: 'character' },
                { imagePath: '/user/images/_style_references/s1.png', role: 'style' },
            ],
            computeProtocolCapabilities({ source: 'openai', model: 'dall-e-2' }),
            { source: 'openai', model: 'dall-e-2' },
        ));
        expect(sharedCapErr.code).toBe('ref_limit_exceeded');

        const sdIndexSrc = fs.readFileSync(
            path.join(REPO_ROOT, 'public/scripts/extensions/stable-diffusion/index.js'),
            'utf8',
        );
        const genPicStart = sdIndexSrc.indexOf('async function generatePicture(');
        const genPicCatchSlice = sdIndexSrc.slice(genPicStart, sdIndexSrc.indexOf('SD prompt text generation failed.', genPicStart) + 60);
        expect(genPicCatchSlice).toContain('err.code.startsWith(\'lora_\')');
        expect(genPicCatchSlice).toContain('err.code.startsWith(\'ref_\')');
    });

    test('resolveCharacterReferenceMode falls back consistently for omitted and malformed modes', () => {
        expect(resolveCharacterReferenceMode({ characterReferenceMode: 'image_only', supportsCharacterReference: false })).toBe('image_only');
        expect(resolveCharacterReferenceMode({ characterReferenceMode: 'bogus_mode', supportsCharacterReference: true })).toBe('text_and_image');
        expect(resolveCharacterReferenceMode({ characterReferenceMode: 'bogus_mode', supportsCharacterReference: false })).toBe('text_only');
        expect(resolveCharacterReferenceMode({ supportsCharacterReference: true })).toBe('text_and_image');
        expect(resolveCharacterReferenceMode(null)).toBe('text_only');
    });
});
