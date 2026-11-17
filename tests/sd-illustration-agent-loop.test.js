import { describe, expect, jest, test } from '@jest/globals';
import { createCharacterProfileStore } from '../public/scripts/extensions/stable-diffusion/character-archive/store.js';
import {
    DEFAULT_ILLUSTRATION_PROMPT,
    DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
    LEGACY_DEFAULT_ILLUSTRATION_PROMPT,
    LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
} from '../public/scripts/extensions/stable-diffusion/illustration/presets.js';
import { normalizeIllustrationSettings } from '../public/scripts/extensions/stable-diffusion/illustration/settings.js';
import { createIllustrationPipeline } from '../public/scripts/extensions/stable-diffusion/illustration/pipeline.js';
import { createImageActivity, attachImageActivityDock } from '../public/scripts/extensions/stable-diffusion/activity.js';

function createMemoryGlobalStateContext(extra = {}) {
    const namespaces = new Map();
    return {
        chatId: 'chat_1',
        characterId: 0,
        characters: [{ name: 'Narrator', avatar: 'narrator.png', description: 'Chronicler', data: { extensions: {} } }],
        async getGlobalState(ns) {
            return {
                ok: true,
                state: namespaces.has(ns) ? structuredClone(namespaces.get(ns)) : {},
            };
        },
        async updateGlobalState(ns, updater) {
            const prev = namespaces.has(ns) ? structuredClone(namespaces.get(ns)) : {};
            const next = await updater(prev);
            if (next !== null && next !== undefined) {
                namespaces.set(ns, structuredClone(next));
            }
            return { ok: true, state: namespaces.get(ns) || {} };
        },
        ...extra,
    };
}

function makeMessage(mes = 'She laid the brass spyglass on the chart table.') {
    return {
        name: 'Narrator',
        is_user: false,
        is_system: false,
        send_date: '2026-11-17T10:00:00Z',
        mes,
        swipe_id: 0,
        swipes: [mes],
        swipe_info: [{ send_date: '2026-11-17T10:00:00Z', extra: {} }],
        extra: {},
    };
}

describe('normalizeIllustrationSettings legacy default prompt upgrade', () => {
    test('upgrades unmodified legacy default prompts by identity while preserving custom prompts', () => {
        expect(typeof LEGACY_DEFAULT_ILLUSTRATION_PROMPT).toBe('string');
        expect(typeof LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT).toBe('string');
        expect(DEFAULT_ILLUSTRATION_PROMPT).not.toBe(LEGACY_DEFAULT_ILLUSTRATION_PROMPT);
        expect(DEFAULT_NATURAL_ILLUSTRATION_PROMPT).not.toBe(LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT);

        const customPrompt = 'Custom user prompt crafted specifically for watercolor scenes.';
        const normalized = normalizeIllustrationSettings({
            initialized: true,
            currentPresetId: 'preset_tag',
            presets: [
                {
                    id: 'preset_tag',
                    name: 'Tag style',
                    illustrationPrompt: LEGACY_DEFAULT_ILLUSTRATION_PROMPT,
                    studioPrompt: 'studio a',
                    llm: { apiPresetName: '', llmPresetName: '' },
                },
                {
                    id: 'preset_natural',
                    name: 'Natural language style',
                    illustrationPrompt: LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
                    studioPrompt: 'studio b',
                    llm: { apiPresetName: '', llmPresetName: '' },
                },
                {
                    id: 'preset_custom',
                    name: 'Custom',
                    illustrationPrompt: customPrompt,
                    studioPrompt: 'studio c',
                    llm: { apiPresetName: '', llmPresetName: '' },
                },
            ],
        });

        expect(normalized.presets[0].illustrationPrompt).toBe(DEFAULT_ILLUSTRATION_PROMPT);
        expect(normalized.presets[1].illustrationPrompt).toBe(DEFAULT_NATURAL_ILLUSTRATION_PROMPT);
        expect(normalized.presets[2].illustrationPrompt).toBe(customPrompt);
    });
});

describe('dual-agent illustration loop and deterministic reference binding', () => {
    test('(a) exits after a single LLM call when turn 1 returns only valid add_image_prompt calls', async () => {
        const chat = [makeMessage()];
        const taskCalls = [];
        const generated = [];

        const context = createMemoryGlobalStateContext({
            chat,
            async generateTask(opts) {
                taskCalls.push(structuredClone(opts));
                return {
                    toolCalls: [{
                        id: 'call_direct_1',
                        name: 'add_image_prompt',
                        args: {
                            prompt: '1girl, brass spyglass, wooden chart table',
                            insert_after: 'laid the brass spyglass',
                            insert_before: 'on the chart table.',
                        },
                    }],
                    assistantText: '',
                    finishReason: 'tool_calls',
                };
            },
        });

        const settings = normalizeIllustrationSettings(undefined);
        settings.enabled = true;
        settings.autoGenerate = true;

        const pipeline = createIllustrationPipeline({
            context,
            imageService: {
                async getAvailableLoras() { return { names: [], includeWeight: false }; },
                async getCapabilities() {
                    return {
                        source: 'google',
                        model: 'gemini-2.5-flash-image',
                        supportsCharacterReference: true,
                        maxCharacterReferences: null,
                        supportsStyleReference: true,
                        maxStyleReferences: null,
                        supportsSourceImage: true,
                        supportsMultiCharacterPrompts: false,
                        supportsDynamicAspectRatio: true,
                        availableLoras: { names: [], includeWeight: false },
                    };
                },
                async generate(prompt, opts) {
                    generated.push({ prompt, opts });
                    return '/user/images/Narrator/direct.png';
                },
            },
            settings,
            hooks: {
                toast: () => {},
                notifyError: err => { throw new Error(`Unexpected error: ${err}`); },
                saveChat: async () => {},
                updateMessageBlock: () => {},
                ensureSwipes: () => {},
                getChatId: () => 'chat_1',
                getChat: () => chat,
            },
        });

        await pipeline.runForMessage({ messageId: 0, source: 'manual' });

        expect(taskCalls).toHaveLength(1);
        expect(taskCalls[0].tools[0].function.name).toBe('add_image_prompt');
        expect(taskCalls[0].tools.map(t => t.function.name)).toEqual(
            expect.arrayContaining(['add_image_prompt', 'read_character_profiles', 'explore_characters']),
        );
        expect(generated).toHaveLength(1);
        expect(chat[0].extra.illustrations).toHaveLength(1);
        expect(chat[0].extra.illustrations[0].status).toBe('ready');
    });

    test('(b) resolves outfit referenceImages and merges negativeTags after read_character_profiles', async () => {
        const chat = [makeMessage()];
        const taskCalls = [];
        const generated = [];

        const context = createMemoryGlobalStateContext({
            chat,
            async generateTask(opts) {
                taskCalls.push(structuredClone(opts));
                if (taskCalls.length === 1) {
                    return {
                        toolCalls: [{
                            id: 'call_read_1',
                            name: 'read_character_profiles',
                            args: { ids: ['char_lyra'] },
                        }],
                        assistantText: '',
                        finishReason: 'tool_calls',
                    };
                }
                return {
                    toolCalls: [{
                        id: 'call_prompt_2',
                        name: 'add_image_prompt',
                        args: {
                            prompt: '1girl, silver braid, navy coat, holding brass spyglass',
                            negative_prompt: 'lowres',
                            aspect_ratio: '3:4',
                            character_refs: [{ profile_id: 'char_lyra', outfit_id: 'outfit_coat' }],
                            insert_after: 'laid the brass spyglass',
                            insert_before: 'on the chart table.',
                        },
                    }],
                    assistantText: '',
                    finishReason: 'tool_calls',
                };
            },
        });

        const profileStore = createCharacterProfileStore(context);
        await profileStore.upsertProfile({
            id: 'char_lyra',
            name: 'Lyra',
            sourceWork: 'Horizon',
            canonicalTags: ['1girl', 'silver braid'],
            negativeTags: ['glasses', 'modern_clothes'],
            outfits: [{
                id: 'outfit_coat',
                name: 'Naval Coat',
                tags: ['navy coat', 'brass buttons'],
                referenceImages: ['/user/images/_references/lyra_coat.png'],
            }],
            defaultOutfitId: 'outfit_coat',
        });

        const settings = normalizeIllustrationSettings(undefined);
        settings.enabled = true;

        const pipeline = createIllustrationPipeline({
            context,
            imageService: {
                async getAvailableLoras() { return { names: [], includeWeight: false }; },
                async getCapabilities() {
                    return {
                        source: 'google',
                        model: 'gemini-2.5-flash-image',
                        supportsCharacterReference: true,
                        maxCharacterReferences: null,
                        supportsStyleReference: true,
                        maxStyleReferences: null,
                        supportsSourceImage: true,
                        supportsMultiCharacterPrompts: false,
                        supportsDynamicAspectRatio: true,
                        availableLoras: { names: [], includeWeight: false },
                    };
                },
                async generate(prompt, opts) {
                    generated.push({ prompt, opts });
                    return '/user/images/Narrator/lyra.png';
                },
            },
            settings,
            hooks: {
                toast: () => {},
                notifyError: err => { throw new Error(`Unexpected error: ${err}`); },
                saveChat: async () => {},
                updateMessageBlock: () => {},
                ensureSwipes: () => {},
                getChatId: () => 'chat_1',
                getChat: () => chat,
            },
        });

        await pipeline.runForMessage({ messageId: 0, source: 'manual' });

        expect(taskCalls).toHaveLength(2);
        const toolMessage = taskCalls[1].taskMessages.find(m => m.role === 'tool');
        expect(toolMessage).toBeDefined();
        expect(toolMessage.content).toContain('Naval Coat');

        expect(generated).toHaveLength(1);
        expect(generated[0].opts.aspectRatio).toBe('3:4');
        expect(generated[0].opts.references).toEqual([
            {
                imagePath: '/user/images/_references/lyra_coat.png',
                role: 'character',
                label: 'Lyra — Naval Coat',
            },
        ]);
        expect(generated[0].opts.negativePrompt).toContain('lowres');
        expect(generated[0].opts.negativePrompt).toContain('glasses');
        expect(generated[0].opts.negativePrompt).toContain('modern_clothes');
        expect(chat[0].extra.illustrations[0].references).toEqual(generated[0].opts.references);
        expect(chat[0].extra.illustrations[0].aspectRatio).toBe('3:4');
    });

    test('(c) invokes exploration agent via explore_characters and binds newly saved profile on next turn', async () => {
        const chat = [makeMessage()];
        const generated = [];
        let illustrationRound = 0;
        let explorationRound = 0;

        const context = createMemoryGlobalStateContext({
            chat,
            async generateTask(opts) {
                const toolNames = (opts.tools || []).map(t => t.function.name);
                const isExploration = toolNames.includes('save_character_profile');
                if (isExploration) {
                    explorationRound += 1;
                    if (explorationRound === 1) {
                        return {
                            toolCalls: [{
                                id: 'exp_save_1',
                                name: 'save_character_profile',
                                args: {
                                    id: 'char_explored',
                                    name: 'Vesper',
                                    source_work: 'Starlight',
                                    canonical_tags: ['1girl', 'crimson eyes'],
                                    outfits: [{
                                        id: 'outfit_cloak',
                                        name: 'Travel Cloak',
                                        tags: ['dark cloak'],
                                        reference_images: ['/user/images/_references/vesper_cloak.png'],
                                    }],
                                    default_outfit_id: 'outfit_cloak',
                                },
                            }],
                            assistantText: '',
                        };
                    }
                    return {
                        toolCalls: [],
                        assistantText: 'Saved Vesper profile.',
                    };
                }

                illustrationRound += 1;
                if (illustrationRound === 1) {
                    return {
                        toolCalls: [{
                            id: 'ill_exp_1',
                            name: 'explore_characters',
                            args: {
                                targets: [{ name: 'Vesper', work: 'Starlight', hint: 'Cartographer' }],
                            },
                        }],
                        assistantText: '',
                        finishReason: 'tool_calls',
                    };
                }
                return {
                    toolCalls: [{
                        id: 'ill_prompt_2',
                        name: 'add_image_prompt',
                        args: {
                            prompt: '1girl, crimson eyes, dark cloak, brass spyglass',
                            character_refs: [{ profile_id: 'char_explored', outfit_id: 'outfit_cloak' }],
                            insert_after: 'laid the brass spyglass',
                            insert_before: 'on the chart table.',
                        },
                    }],
                    assistantText: '',
                    finishReason: 'tool_calls',
                };
            },
        });

        const settings = normalizeIllustrationSettings(undefined);
        settings.enabled = true;
        const runStore = (await import('../public/scripts/run-panel/store.js')).createRunStore();
        const addedSections = [];
        const updatedSections = [];
        const beginActivityJob = () => {
            const runId = runStore.startRun({ mode: 'image', chatKey: 'chat_1' });
            const roundId = 'image-job-1';
            runStore.appendRound({ runId, round: { id: roundId, label: 'Message #1' } });
            return {
                id: roundId,
                addSection(key, spec) {
                    addedSections.push({ key, spec });
                    const sectionId = `${roundId}-${key}`;
                    runStore.ensureSection({ runId, roundId, section: { id: sectionId, kind: spec.kind, title: spec.title, meta: spec.meta ?? null } });
                    if (spec.body) runStore.appendToSection({ runId, roundId, sectionId, delta: String(spec.body) });
                    return sectionId;
                },
                updateSection(key, patch = {}) {
                    updatedSections.push({ key, patch });
                    runStore.setSectionStatus({ runId, roundId, sectionId: `${roundId}-${key}`, status: patch.status || 'done', meta: patch.meta });
                },
                setPrompt() {},
                setImage() {},
                setError() {},
                finish(status = 'done') {
                    runStore.setRoundStatus({ runId, roundId, status });
                    runStore.finishRun({ runId, status: status === 'done' ? 'committed' : 'error' });
                },
            };
        };

        const pipeline = createIllustrationPipeline({
            context,
            imageService: {
                async getAvailableLoras() { return { names: [], includeWeight: false }; },
                async getCapabilities() {
                    return {
                        source: 'openrouter',
                        model: 'google/gemini-2.5-flash-image',
                        supportsCharacterReference: true,
                        maxCharacterReferences: null,
                        supportsStyleReference: true,
                        maxStyleReferences: null,
                        supportsSourceImage: true,
                        supportsMultiCharacterPrompts: false,
                        supportsDynamicAspectRatio: true,
                        availableLoras: { names: [], includeWeight: false },
                    };
                },
                async generate(prompt, opts) {
                    generated.push({ prompt, opts });
                    return '/user/images/Narrator/vesper.png';
                },
            },
            settings,
            hooks: {
                toast: () => {},
                notifyError: err => { throw new Error(`Unexpected error: ${err}`); },
                saveChat: async () => {},
                updateMessageBlock: () => {},
                ensureSwipes: () => {},
                getChatId: () => 'chat_1',
                getChat: () => chat,
                beginActivityJob,
            },
        });

        await pipeline.runForMessage({ messageId: 0, source: 'manual' });

        expect(explorationRound).toBe(2);
        expect(illustrationRound).toBe(2);
        expect(addedSections.some(s => s.spec?.title?.includes('explore_characters'))).toBe(true);
        expect(updatedSections.some(s => s.patch?.status === 'done')).toBe(true);
        const profileStore = createCharacterProfileStore(context);
        const saved = await profileStore.getProfile('char_explored');
        expect(saved?.name).toBe('Vesper');
        expect(generated).toHaveLength(1);
        expect(generated[0].opts.references).toEqual([
            {
                imagePath: '/user/images/_references/vesper_cloak.png',
                role: 'character',
                label: 'Vesper — Travel Cloak',
            },
        ]);
    });

    test('(d) feeds actionable errors on anchor mismatch or maxCharacterReferences overflow and self-heals on next round', async () => {
        const chat = [makeMessage()];
        const taskCalls = [];
        const generated = [];

        const context = createMemoryGlobalStateContext({
            chat,
            async generateTask(opts) {
                taskCalls.push(structuredClone(opts));
                if (taskCalls.length === 1) {
                    return {
                        toolCalls: [{
                            id: 'call_bad_1',
                            name: 'add_image_prompt',
                            args: {
                                prompt: '2girls, chart room',
                                character_refs: [
                                    { profile_id: 'char_a' },
                                    { profile_id: 'char_b' },
                                ],
                                insert_after: 'nonexistent anchor before',
                                insert_before: 'nonexistent anchor after',
                            },
                        }],
                        assistantText: '',
                        finishReason: 'tool_calls',
                    };
                }
                return {
                    toolCalls: [{
                        id: 'call_healed_2',
                        name: 'add_image_prompt',
                        args: {
                            prompt: '2girls, chart room',
                            character_refs: [{ profile_id: 'char_a' }],
                            character_captions: [
                                { prompt: '1girl, blonde hair', negative_prompt: 'hat', center: { x: 0.3, y: 0.5 } },
                                { prompt: '1girl, black hair', center: { x: 0.7, y: 0.5 } },
                            ],
                            insert_after: 'laid the brass spyglass',
                            insert_before: 'on the chart table.',
                        },
                    }],
                    assistantText: '',
                    finishReason: 'tool_calls',
                };
            },
        });

        const profileStore = createCharacterProfileStore(context);
        await profileStore.upsertProfile({
            id: 'char_a',
            name: 'Aria',
            outfits: [{ id: 'def', name: 'Default', referenceImages: ['/user/images/_references/aria.png'] }],
        });
        await profileStore.upsertProfile({
            id: 'char_b',
            name: 'Bryn',
            outfits: [{ id: 'def', name: 'Default', referenceImages: ['/user/images/_references/bryn.png'] }],
        });

        const settings = normalizeIllustrationSettings(undefined);
        settings.enabled = true;

        const pipeline = createIllustrationPipeline({
            context,
            imageService: {
                async getAvailableLoras() { return { names: [], includeWeight: false }; },
                async getCapabilities() {
                    return {
                        source: 'novel',
                        model: 'nai-diffusion-4-5-full',
                        supportsCharacterReference: true,
                        maxCharacterReferences: 1,
                        supportsStyleReference: true,
                        maxStyleReferences: 4,
                        supportsSourceImage: true,
                        supportsMultiCharacterPrompts: true,
                        supportsDynamicAspectRatio: true,
                        availableLoras: { names: [], includeWeight: false },
                    };
                },
                async generate(prompt, opts) {
                    generated.push({ prompt, opts });
                    return '/user/images/Narrator/healed.png';
                },
            },
            settings,
            hooks: {
                toast: () => {},
                notifyError: err => { throw new Error(`Unexpected error: ${err}`); },
                saveChat: async () => {},
                updateMessageBlock: () => {},
                ensureSwipes: () => {},
                getChatId: () => 'chat_1',
                getChat: () => chat,
            },
        });

        await pipeline.runForMessage({ messageId: 0, source: 'manual' });

        expect(taskCalls).toHaveLength(2);
        const toolErrorMsg = taskCalls[1].taskMessages.find(m => m.role === 'tool');
        expect(toolErrorMsg).toBeDefined();
        expect(toolErrorMsg.content).toMatch(/1|anchor/i);

        expect(generated).toHaveLength(1);
        expect(generated[0].opts.references).toHaveLength(1);
        expect(generated[0].opts.characterPrompts).toEqual([
            { prompt: '1girl, blonde hair', negativePrompt: 'hat', center: { x: 0.3, y: 0.5 } },
            { prompt: '1girl, black hair', negativePrompt: '', center: { x: 0.7, y: 0.5 } },
        ]);
    });
});

describe('attachImageActivityDock shared Run Dock integration', () => {
    test('attaches image activity store to context.runPanel.attachDock with source sd and workbench handlers', () => {
        const attachDock = jest.fn();
        const openWorkbench = jest.fn();
        const fakeStore = { subscribe: jest.fn(), getCurrentRun: () => null };
        const fakeContext = {
            chatId: 'chat_42',
            name2: 'Lyra',
            runPanel: { attachDock },
            workbench: { open: openWorkbench },
        };

        attachImageActivityDock(fakeStore, fakeContext);

        expect(attachDock).toHaveBeenCalledTimes(1);
        const [storeArg, opts] = attachDock.mock.calls[0];
        expect(storeArg).toBe(fakeStore);
        expect(opts.source).toBe('sd');
        expect(opts.getRunContext()).toEqual({ chatId: 'chat_42', chatLabel: 'Lyra' });

        opts.onInspect('sd:run_1');
        expect(openWorkbench).toHaveBeenCalledWith({ ws: 'sd', subview: 'run', runKey: 'sd:run_1' });

        opts.onDiagnose('sd:run_1');
        expect(openWorkbench).toHaveBeenCalledWith(expect.objectContaining({
            page: 'ai',
            ws: 'sd',
            draft: expect.stringContaining('sd:run_1'),
        }));
    });
});
