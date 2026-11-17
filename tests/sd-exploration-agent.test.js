// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest } from '@jest/globals';
import { createCharacterProfileStore } from '../public/scripts/extensions/stable-diffusion/character-archive/store.js';
import { createRunStore } from '../public/scripts/run-panel/store.js';

function createMemoryGlobalState() {
    const bucket = new Map();
    return {
        getGlobalState: async (ns) => ({ ok: true, state: bucket.has(ns) ? structuredClone(bucket.get(ns)) : null }),
        updateGlobalState: async (ns, updater) => {
            const cur = bucket.has(ns) ? structuredClone(bucket.get(ns)) : {};
            const next = await updater(cur, { attempt: 0, namespace: ns });
            if (next) bucket.set(ns, structuredClone(next));
            return { ok: true, state: bucket.get(ns) ?? cur, updated: true };
        },
    };
}

describe('character visual exploration agent', () => {
    test('exposes card, lorebook, archive, source search, download, and save tools while excluding any image generation tool', async () => {
        const { buildExplorationToolDefs } = await import('../public/scripts/extensions/stable-diffusion/exploration/tools.js');
        const defs = buildExplorationToolDefs();
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
    });

    test('resolveExplorationLlm inherits preset.llm as a pair when empty and avoids mixing preset.llm.llmPresetName onto an overridden apiPresetName', async () => {
        const { resolveExplorationLlm } = await import('../public/scripts/extensions/stable-diffusion/exploration/agent.js');

        expect(resolveExplorationLlm({
            llm: { apiPresetName: 'main-conn', llmPresetName: 'main-completion' },
            explorationLlm: { apiPresetName: '', llmPresetName: '' },
        })).toEqual({
            apiPresetName: 'main-conn',
            llmPresetName: 'main-completion',
        });

        expect(resolveExplorationLlm({
            llm: { apiPresetName: 'claude-conn', llmPresetName: 'claude-prefill-preset' },
            explorationLlm: { apiPresetName: 'gemini-vision-conn', llmPresetName: '' },
        })).toEqual({
            apiPresetName: 'gemini-vision-conn',
            llmPresetName: '',
        });
    });

    test('executes multi-turn card + lorebook + source search + fetch + save loop and appends adjacent role:user preview only when visualInspection is enabled', async () => {
        const { runExplorationAgent } = await import('../public/scripts/extensions/stable-diffusion/exploration/agent.js');

        const gs = createMemoryGlobalState();
        const taskCaptures = [];
        let turn = 0;

        const scriptedTurns = [
            {
                assistantText: 'Reading card and worldbooks.',
                toolCalls: [
                    { id: 'c1', name: 'read_character_card', args: {} },
                    { id: 'c2', name: 'lorebook_get', args: { book_name: 'SkyLore', uids: [1] } },
                ],
            },
            {
                assistantText: 'Searching Bangumi and downloading portrait.',
                toolCalls: [
                    { id: 'c3', name: 'search_character_sources', args: { source: 'bangumi', query: 'Celeste Vance', work: 'Sky Chronicles' } },
                    { id: 'c4', name: 'fetch_reference_image', args: { image_url: 'https://img.example.org/celeste.png', profile_id: 'char_celeste' } },
                ],
            },
            {
                assistantText: 'Saving verified character profile.',
                toolCalls: [
                    {
                        id: 'c5',
                        name: 'save_character_profile',
                        args: {
                            id: 'char_celeste',
                            name: 'Celeste Vance',
                            aliases: ['Navigator'],
                            source_work: 'Sky Chronicles',
                            canonical_tags: ['1girl', 'silver_hair', 'amber_eyes'],
                            prose_description: 'Silver-haired airship navigator with amber eyes.',
                            outfits: [{
                                id: 'outfit_coat',
                                name: 'Uniform',
                                tags: ['navy_coat'],
                                prose: 'Navy officer coat.',
                                referenceImages: ['/user/images/_references/char_celeste_1122334455667788.png'],
                            }],
                            default_outfit_id: 'outfit_coat',
                        },
                    },
                ],
            },
            {
                assistantText: 'Exploration complete.',
                toolCalls: [],
            },
        ];

        globalThis.fetch = jest.fn(async (url) => {
            if (String(url).startsWith('/api/sprites/get')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => [{ label: 'joy', path: '/characters/Seraphina/joy.png?t=20261117' }],
                };
            }
            if (url === '/api/sd/character-sources/search') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        source: 'bangumi',
                        query: 'Celeste Vance',
                        candidates: [{ name: 'Celeste Vance', imageUrls: ['https://img.example.org/celeste.png'] }],
                        formattedLines: '1: [bangumi] Celeste Vance | images=https://img.example.org/celeste.png',
                    }),
                };
            }
            if (url === '/api/sd/character-sources/fetch-image') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        imagePath: '/user/images/_references/char_celeste_1122334455667788.png',
                        width: 512,
                        height: 768,
                        mimeType: 'image/png',
                    }),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const context = {
            ...gs,
            characterId: 0,
            characters: [{
                name: 'Seraphina',
                avatar: 'Seraphina.png',
                description: 'Companion of Celeste Vance.',
                data: { extensions: { world: 'SkyLore' } },
            }],
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            loadWorldInfo: async (name) => (name === 'SkyLore' ? {
                entries: {
                    1: { uid: 1, key: ['Celeste'], comment: 'Celeste Bio', content: 'Silver hair, amber eyes, navy coat.', constant: false, disable: false },
                },
            } : null),
            generateTask: jest.fn(async (opts) => {
                taskCaptures.push(structuredClone(opts.taskMessages));
                return scriptedTurns[turn++];
            }),
        };

        const profileStore = createCharacterProfileStore(context);
        const previewLoader = jest.fn(async (imagePath) => `data:image/jpeg;base64,PREVIEW_${imagePath.split('/').pop()}`);
        const runStore = createRunStore();
        const activeRunId = runStore.startRun({ mode: 'image', chatKey: 'chat_exp_1' });

        const result = await runExplorationAgent({
            context,
            profileStore,
            targets: [{ name: 'Celeste Vance', hint: 'Airship navigator' }],
            preset: {
                llm: { apiPresetName: 'base-api', llmPresetName: 'base-llm' },
                explorationPrompt: '',
                explorationLlm: { apiPresetName: '', llmPresetName: '' },
                visualInspection: true,
            },
            runStore,
            runId: activeRunId,
            loadVisualPreviewDataUrl: previewLoader,
        });
        runStore.finishRun({ runId: activeRunId, status: 'committed' });

        const recordedRun = runStore.getCurrentRun();
        expect(recordedRun.rounds).toHaveLength(4);
        expect(recordedRun.rounds.every(r => r.status === 'done')).toBe(true);
        expect(recordedRun.rounds[0].sections.some(s => s.kind === 'tool' && s.title.includes('read_character_card'))).toBe(true);
        expect(recordedRun.rounds[3].sections.some(s => s.body.includes('Exploration complete.'))).toBe(true);

        expect(result.finalText).toBe('Exploration complete.');
        expect(result.savedProfiles).toHaveLength(1);
        expect(result.savedProfiles[0].id).toBe('char_celeste');
        expect((await profileStore.listProfiles())).toHaveLength(1);
        expect(previewLoader).toHaveBeenCalledWith('/user/images/_references/char_celeste_1122334455667788.png', context);

        // Turn 3's taskMessages (index 2) must have pure string tool results followed by an adjacent role:'user' multimodal preview!
        const turn3Messages = taskCaptures[2];
        const toolMsgs = turn3Messages.filter(m => m.role === 'tool');
        expect(toolMsgs.every(m => typeof m.content === 'string')).toBe(true);
        const lastMsgBeforeTurn3 = turn3Messages.at(-1);
        expect(lastMsgBeforeTurn3.role).toBe('user');
        expect(Array.isArray(lastMsgBeforeTurn3.content)).toBe(true);
        expect(lastMsgBeforeTurn3.content.some(p => p.type === 'image_url')).toBe(true);

        // When visualInspection is false, no multimodal preview is loaded or appended.
        previewLoader.mockClear();
        taskCaptures.length = 0;
        let nonVisualTurn = 0;
        context.generateTask = jest.fn(async (opts) => {
            taskCaptures.push(structuredClone(opts.taskMessages));
            if (nonVisualTurn++ === 0) {
                return {
                    assistantText: 'Downloading without visual inspection.',
                    toolCalls: [{ id: 'nv1', name: 'fetch_reference_image', args: { image_url: 'https://img.example.org/celeste.png', profile_id: 'char_celeste' } }],
                };
            }
            return { assistantText: 'Done.', toolCalls: [] };
        });

        await runExplorationAgent({
            context,
            profileStore,
            preset: {
                llm: { apiPresetName: 'base-api', llmPresetName: 'base-llm' },
                visualInspection: false,
            },
            loadVisualPreviewDataUrl: previewLoader,
        });
        expect(previewLoader).not.toHaveBeenCalled();
        expect(taskCaptures[1].at(-1).role).toBe('tool');
    });

    test('propagates AbortSignal cancellation immediately', async () => {
        const { runExplorationAgent } = await import('../public/scripts/extensions/stable-diffusion/exploration/agent.js');
        const gs = createMemoryGlobalState();
        const controller = new AbortController();
        controller.abort();

        const context = {
            ...gs,
            characters: [],
            generateTask: jest.fn(),
        };
        const profileStore = createCharacterProfileStore(context);

        await expect(runExplorationAgent({
            context,
            profileStore,
            preset: {},
            abortSignal: controller.signal,
        })).rejects.toThrow(/abort/i);
        expect(context.generateTask).not.toHaveBeenCalled();
    });
});
