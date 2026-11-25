// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';

describe('character visual exploration agent', () => {
    test('exposes selected card readers alongside archive tools without image generation', async () => {
        const { buildExplorationToolDefs } = await import('../public/scripts/extensions/stable-diffusion/exploration/tools.js');
        const defs = buildExplorationToolDefs({
            sourcePolicy: { kind: 'card', card: { avatar: 'selected-source.png' }, worldBooks: [] },
        });
        const names = defs.map(t => t.function.name);

        expect(names).toEqual(expect.arrayContaining([
            'read_character_card',
            'world_book_list',
            'lorebook_list',
            'lorebook_query',
            'lorebook_get',
            'list_character_profiles',
            'read_character_profiles',
            'search_character_sources',
            'visit_character_page',
            'fetch_reference_image',
            'save_character_profile',
        ]));
        expect(names).not.toContain('generate_image');
        expect(names).not.toContain('generate_reference_image');

        const saveDef = defs.find(t => t.function.name === 'save_character_profile');
        const saveProps = saveDef.function.parameters.properties;
        expect(saveDef.function.parameters.required).toEqual(['name']);
        expect(Object.keys(saveProps)).toEqual(expect.arrayContaining([
            'id',
            'name',
            'aliases',
            'source_work',
            'description',
            'reference_images',
        ]));
        expect(saveProps).not.toHaveProperty('source_card_avatars');
        expect(saveProps).not.toHaveProperty('canonical_tags');
        expect(saveProps).not.toHaveProperty('negative_tags');
        expect(saveProps).not.toHaveProperty('prose_description');
        expect(saveProps).not.toHaveProperty('outfits');
        expect(saveProps).not.toHaveProperty('default_outfit_id');
        expect(saveProps.reference_images.type).toBe('array');
        expect(saveProps.reference_images.items.required).toEqual(['path']);
        expect(Object.keys(saveProps.reference_images.items.properties)).toEqual(expect.arrayContaining(['path', 'label']));
    });

    test('resolveExplorationLlm inherits preset.llm as a pair when empty and avoids mixing completion presets across connections', async () => {
        const { resolveExplorationLlm } = await import('../public/scripts/extensions/stable-diffusion/exploration/agent.js');

        expect(resolveExplorationLlm({
            llm: { apiPresetName: 'main-conn', llmPresetName: 'main-completion' },
            explorationLlm: { apiPresetName: '', llmPresetName: '' },
        })).toEqual({
            apiPresetName: 'main-conn',
            llmPresetName: 'main-completion',
        });

        expect(resolveExplorationLlm({
            llm: { apiPresetName: 'original-conn', llmPresetName: 'original-completion' },
            explorationLlm: { apiPresetName: 'overridden-conn', llmPresetName: '' },
        })).toEqual({
            apiPresetName: 'overridden-conn',
            llmPresetName: '',
        });
    });

    test('propagates AbortSignal cancellation before accessing dependencies', async () => {
        const { runExplorationAgent } = await import('../public/scripts/extensions/stable-diffusion/exploration/agent.js');
        const controller = new AbortController();
        controller.abort();

        await expect(runExplorationAgent({
            abortSignal: controller.signal,
        })).rejects.toThrow(/abort/i);
    });

    test('routes media, promptContext, transientSessionId, and onTrace while preserving savedProfiles/finalText contract', async () => {
        const { runExplorationAgent } = await import('../public/scripts/extensions/stable-diffusion/exploration/agent.js');
        const { createSandboxProfileStore } = await import('../public/scripts/extensions/stable-diffusion/lens/simulation-sandbox.js');

        const sandbox = createSandboxProfileStore();
        const mediaFetchCalls = [];
        const previewCalls = [];
        const traceEvents = [];
        const promptContext = { scope: 'preset', envelope: { version: 1 }, runtimeWorldInfo: {}, macroEnv: { names: { user: '', char: '' } } };
        let round = 0;

        const seenPreviewRounds = [];
        const context = {
            async generateTask(opts) {
                expect(opts.promptContext).toBe(promptContext);
                expect(opts.transientSessionId).toBe('sess_exp_1');
                expect(opts.includeCharacterCard).toBe(false);
                round += 1;
                opts.onPreparedRequest?.({ requestApi: 'openai', payload: { round, messages: opts.taskMessages } });
                if (round === 1) {
                    return {
                        toolCalls: [{
                            id: 'call_fetch',
                            name: 'fetch_reference_image',
                            args: { image_url: 'https://example.test/portrait.png', profile_id: 'char_iris' },
                        }],
                        assistantText: 'Fetching candidate reference.',
                        reasoning: 'Checking candidate image.',
                    };
                }
                if (round === 2) {
                    const hasPreviewImg = opts.taskMessages.some(m => Array.isArray(m.content)
                        && m.content.some(p => p.type === 'image_url' && p.image_url?.url === 'data:image/png;base64,PREVIEW'));
                    seenPreviewRounds.push(hasPreviewImg);
                    return {
                        toolCalls: [{
                            id: 'call_save',
                            name: 'save_character_profile',
                            args: {
                                id: 'char_iris',
                                name: 'Iris',
                                description: 'Danbooru character tag: iris\nSilver-haired archivist wearing a navy coat.',
                                reference_images: [{
                                    path: '/user/images/_sandbox_tmp/sess_exp_1/iris.png',
                                    label: 'Default',
                                }],
                            },
                        }],
                        assistantText: '',
                    };
                }
                return { toolCalls: [], assistantText: 'Archived Iris.' };
            },
        };

        const result = await runExplorationAgent({
            context,
            profileStore: sandbox,
            targets: [{ name: 'Iris' }],
            sourcePolicy: { kind: 'none' },
            preset: {
                explorationPrompt: 'Build accurate profiles.',
                visualInspection: true,
                llm: { apiPresetName: 'Api', llmPresetName: 'Preset' },
            },
            media: {
                async fetchReferenceImage(args) {
                    mediaFetchCalls.push(args);
                    return { imagePath: '/user/images/_sandbox_tmp/sess_exp_1/iris.png' };
                },
                async preview(imagePath) {
                    previewCalls.push(imagePath);
                    return 'data:image/png;base64,PREVIEW';
                },
            },
            promptContext,
            transientSessionId: 'sess_exp_1',
            onTrace: event => traceEvents.push(event),
        });

        expect(result.finalText).toBe('Archived Iris.');
        expect(seenPreviewRounds).toEqual([true]);
        expect(result.savedProfiles.map(p => p.id)).toEqual(['char_iris']);
        expect(result.savedProfiles[0]).toMatchObject({
            id: 'char_iris',
            name: 'Iris',
            description: 'Danbooru character tag: iris\nSilver-haired archivist wearing a navy coat.',
            referenceImages: [{ path: '/user/images/_sandbox_tmp/sess_exp_1/iris.png', label: 'Default' }],
        });
        expect(mediaFetchCalls).toHaveLength(1);
        expect(previewCalls).toEqual(['/user/images/_sandbox_tmp/sess_exp_1/iris.png']);
        expect(traceEvents.some(e => e.type === 'prepared_request')).toBe(true);
        expect(traceEvents.some(e => e.type === 'tool_result' && e.name === 'save_character_profile')).toBe(true);
        expect(traceEvents.some(e => e.type === 'visual_preview')).toBe(true);
    });

    test('rejects empty explorationPrompt without hidden default fallback', async () => {
        const { runExplorationAgent } = await import('../public/scripts/extensions/stable-diffusion/exploration/agent.js');
        const { createSandboxProfileStore } = await import('../public/scripts/extensions/stable-diffusion/lens/simulation-sandbox.js');

        await expect(runExplorationAgent({
            context: {},
            profileStore: createSandboxProfileStore(),
            targets: [{ name: 'Iris' }],
            sourcePolicy: { kind: 'none' },
            preset: { explorationPrompt: '   ' },
        })).rejects.toThrow(/prompt|reset/i);
    });

    test('preserves provider-native replay fields and call signatures across exploration tool rounds', async () => {
        const { runExplorationAgent } = await import('../public/scripts/extensions/stable-diffusion/exploration/agent.js');
        const { createSandboxProfileStore } = await import('../public/scripts/extensions/stable-diffusion/lens/simulation-sandbox.js');

        const capturedRounds = [];
        const nativeParts = [{ functionCall: { name: 'list_character_profiles', args: {} }, thoughtSignature: 'sig-exp-g' }];
        const nativeContentBlocks = [{ type: 'tool_use', id: 'call_list_1', name: 'list_character_profiles', input: {} }];
        const responsesOutputItems = [{ type: 'function_call', call_id: 'call_list_1', name: 'list_character_profiles', arguments: '{}' }];
        const context = {
            async generateTask(opts) {
                capturedRounds.push(structuredClone(opts.taskMessages));
                if (capturedRounds.length === 1) {
                    return {
                        assistantText: 'Checking archive',
                        reasoning: 'check existing entries',
                        signature: 'sig-exp-c',
                        nativeParts,
                        nativeContentBlocks,
                        responsesOutputItems,
                        toolCalls: [{
                            id: 'call_list_1',
                            name: 'list_character_profiles',
                            args: {},
                            signature: 'sig-exp-g',
                            extra_content: { google: { thought_signature: 'sig-exp-g' } },
                        }],
                    };
                }
                return { toolCalls: [], assistantText: 'Done.' };
            },
        };

        await runExplorationAgent({
            context,
            profileStore: createSandboxProfileStore(),
            targets: [{ name: 'Iris' }],
            sourcePolicy: { kind: 'none' },
            preset: { explorationPrompt: 'Inspect profiles.' },
        });

        expect(capturedRounds).toHaveLength(2);
        const replayedAssistant = capturedRounds[1].find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
        expect(replayedAssistant).toMatchObject({
            signature: 'sig-exp-c',
            native_parts: nativeParts,
            native_content_blocks: nativeContentBlocks,
            responses_output_items: responsesOutputItems,
        });
        expect(replayedAssistant.tool_calls[0]).toMatchObject({
            id: 'call_list_1',
            signature: 'sig-exp-g',
            extra_content: { google: { thought_signature: 'sig-exp-g' } },
        });
    });
});
