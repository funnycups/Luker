import { describe, expect, jest, test } from '@jest/globals';
import { createCharacterProfileStore } from '../public/scripts/extensions/stable-diffusion/character-archive/store.js';
import {
    DEFAULT_ILLUSTRATION_PROMPT,
    DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
    LEGACY_DEFAULT_ILLUSTRATION_PROMPT,
    LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
} from '../public/scripts/extensions/stable-diffusion/illustration/presets.js';
import { migrateIllustrationPromptSettings, normalizeIllustrationSettings } from '../public/scripts/extensions/stable-diffusion/illustration/settings.js';
import { createIllustrationPipeline } from '../public/scripts/extensions/stable-diffusion/illustration/pipeline.js';
import { runIllustrationAgent } from '../public/scripts/extensions/stable-diffusion/illustration/agent.js';
import { createSandboxProfileStore } from '../public/scripts/extensions/stable-diffusion/lens/simulation-sandbox.js';
import { attachImageActivityDock } from '../public/scripts/extensions/stable-diffusion/activity.js';

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

describe('one-time illustration prompt migration', () => {
    test('upgrades unmodified legacy default prompts by identity while preserving custom prompts', () => {
        expect(typeof LEGACY_DEFAULT_ILLUSTRATION_PROMPT).toBe('string');
        expect(typeof LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT).toBe('string');
        expect(DEFAULT_ILLUSTRATION_PROMPT).not.toBe(LEGACY_DEFAULT_ILLUSTRATION_PROMPT);
        expect(DEFAULT_NATURAL_ILLUSTRATION_PROMPT).not.toBe(LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT);

        const customPrompt = 'Custom user prompt crafted specifically for watercolor scenes.';
        const { settings: normalized } = migrateIllustrationPromptSettings({
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

    test('(c) group illustration explores an explicit identity and binds its saved profile', async () => {
        const chat = [makeMessage()];
        const generated = [];
        let illustrationRound = 0;
        let explorationRound = 0;

        const context = createMemoryGlobalStateContext({
            chat,
            groupId: 'group_visual',
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

    test('preservesIllustrationToolFlow in shared runIllustrationAgent with sandbox store, deduplication, partial failures, and private trace', async () => {
        const messageText = 'She laid the brass spyglass on the chart table and watched the harbor lantern.';
        const seedProfiles = [{
            id: 'char_lyra',
            name: 'Lyra',
            canonicalTags: ['1girl', 'silver braid'],
            negativeTags: ['glasses'],
            outfits: [{
                id: 'outfit_coat',
                name: 'Naval Coat',
                tags: ['navy coat'],
                referenceImages: ['/user/images/_references/lyra_coat.png'],
            }],
            defaultOutfitId: 'outfit_coat',
        }];
        const sandboxStore = createSandboxProfileStore(seedProfiles);
        const generatedCalls = [];
        const fetchedRefs = [];
        const observedEvents = [];
        let globalStateTouched = false;
        let illRound = 0;
        let expRound = 0;

        const promptContext = { scope: 'chat', envelope: { version: 1 }, runtimeWorldInfo: {}, macroEnv: { names: { user: 'U', char: 'C' } } };
        const explorationPromptContext = { scope: 'preset', envelope: { version: 1 }, runtimeWorldInfo: {}, macroEnv: { names: { user: '', char: '' } } };

        const expPromptContexts = [];
        const illPromptContexts = [];
        const context = {
            async getGlobalState() { globalStateTouched = true; throw new Error('must not touch global state'); },
            async updateGlobalState() { globalStateTouched = true; throw new Error('must not touch global state'); },
            async generateTask(opts) {
                expect(opts.transientSessionId).toBe('sess_sandbox_1');
                const toolNames = (opts.tools || []).map(t => t.function.name);
                if (toolNames.includes('save_character_profile')) {
                    expPromptContexts.push(opts.promptContext);
                    expRound += 1;
                    opts.onPreparedRequest?.({ requestApi: 'openai', payload: { round: `exp-${expRound}`, messages: opts.taskMessages } });
                    if (expRound === 1) {
                        return {
                            toolCalls: [{
                                id: 'exp_fetch_1',
                                name: 'fetch_reference_image',
                                args: { image_url: 'https://example.test/vesper.png', profile_id: 'char_vesper' },
                            }],
                            assistantText: '',
                            reasoning: 'Looking up Vesper portrait.',
                        };
                    }
                    if (expRound === 2) {
                        return {
                            toolCalls: [{
                                id: 'exp_save_1',
                                name: 'save_character_profile',
                                args: {
                                    id: 'char_vesper',
                                    name: 'Vesper',
                                    outfits: [{
                                        id: 'outfit_cloak',
                                        name: 'Cloak',
                                        reference_images: ['/user/images/_sandbox_tmp/sess_sandbox_1/vesper.png'],
                                    }],
                                    default_outfit_id: 'outfit_cloak',
                                },
                            }],
                            assistantText: '',
                        };
                    }
                    return { toolCalls: [], assistantText: 'Saved Vesper to sandbox.' };
                }

                illPromptContexts.push(opts.promptContext);
                illRound += 1;
                opts.onPreparedRequest?.({ requestApi: 'openai', payload: { round: `ill-${illRound}`, messages: opts.taskMessages } });
                if (illRound === 1) {
                    // Round 1: explore a new character AND emit a bad-anchor call + one valid call
                    return {
                        toolCalls: [
                            { id: 'c_exp', name: 'explore_characters', args: { targets: [{ name: 'Vesper' }] } },
                            {
                                id: 'c_bad',
                                name: 'add_image_prompt',
                                args: { prompt: 'bad anchor prompt', insert_after: 'missing', insert_before: 'missing' },
                            },
                            {
                                id: 'c_ok_1',
                                name: 'add_image_prompt',
                                args: {
                                    prompt: '1girl, brass spyglass',
                                    insert_after: 'laid the brass spyglass',
                                    insert_before: 'on the chart table',
                                },
                            },
                        ],
                        assistantText: 'Exploring Vesper first.',
                        reasoning: 'Need Vesper reference.',
                        finishReason: 'tool_calls',
                    };
                }
                // Round 2: duplicate of c_ok_1 (must dedupe!) + second valid call referencing sandbox-saved Vesper
                return {
                    toolCalls: [
                        {
                            id: 'c_dup',
                            name: 'add_image_prompt',
                            args: {
                                prompt: '1girl, brass spyglass',
                                insert_after: 'laid the brass spyglass',
                                insert_before: 'on the chart table',
                            },
                        },
                        {
                            id: 'c_ok_2',
                            name: 'add_image_prompt',
                            args: {
                                prompt: '1girl, harbor lantern',
                                character_refs: [{ profile_id: 'char_vesper', outfit_id: 'outfit_cloak' }],
                                insert_after: 'watched the',
                                insert_before: 'harbor lantern.',
                            },
                        },
                    ],
                    assistantText: '',
                    finishReason: 'tool_calls',
                };
            },
        };

        const preset = {
            id: 'p_draft',
            illustrationPrompt: 'Draft illustration prompt',
            explorationPrompt: 'Draft exploration prompt',
            llm: { apiPresetName: 'Api', llmPresetName: 'Llm' },
            explorationLlm: { apiPresetName: '', llmPresetName: '' },
            visualInspection: false,
        };

        const output = await runIllustrationAgent({
            context,
            preset,
            input: {
                current: messageText,
                snapshotText: messageText,
                context: '',
                memoryRecall: '',
                characterName: 'Narrator',
                cardAvatar: '',
                loras: { names: [], includeWeight: false },
                capabilities: {
                    source: 'google',
                    model: 'gemini-image',
                    supportsCharacterReference: true,
                    maxCharacterReferences: null,
                    supportsMultiCharacterPrompts: false,
                    supportsDynamicAspectRatio: true,
                },
                promptContext,
                explorationPromptContext,
            },
            profileStore: sandboxStore,
            media: {
                async generate(prompt, opts) {
                    generatedCalls.push({ prompt, opts });
                    if (prompt.includes('harbor lantern')) {
                        throw new Error('backend timeout');
                    }
                    return '/user/images/_sandbox_tmp/sess_sandbox_1/spyglass.png';
                },
                async fetchReferenceImage(args) {
                    fetchedRefs.push(args);
                    return { imagePath: '/user/images/_sandbox_tmp/sess_sandbox_1/vesper.png' };
                },
            },
            observe: event => observedEvents.push(event),
            transientSessionId: 'sess_sandbox_1',
        });

        expect(globalStateTouched).toBe(false);
        expect(expPromptContexts).toEqual([explorationPromptContext, explorationPromptContext, explorationPromptContext]);
        expect(illPromptContexts).toEqual([promptContext, promptContext]);
        expect(fetchedRefs).toHaveLength(1);
        expect(output.savedProfiles.map(p => p.id)).toEqual(['char_vesper']);
        expect(sandboxStore.getRecordedChanges().map(p => p.id)).toEqual(['char_vesper']);
        expect(output.acceptedPrompts).toHaveLength(2);
        expect(generatedCalls).toHaveLength(2);
        expect(output.results).toEqual([
            expect.objectContaining({
                index: 0,
                status: 'ready',
                imageUrl: '/user/images/_sandbox_tmp/sess_sandbox_1/spyglass.png',
            }),
            expect.objectContaining({
                index: 1,
                status: 'failed',
                error: 'backend timeout',
            }),
        ]);
        expect(output.trace.rounds).toHaveLength(2);
        expect(output.trace.rounds[0].preparedRequests).toHaveLength(1);
        expect(output.trace.rounds[0].reasoning).toBe('Need Vesper reference.');
        expect(output.trace.rounds[0].toolCalls[0].subTrace.length).toBeGreaterThan(0);
        expect(observedEvents.some(e => e.type === 'prepared_request')).toBe(true);
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
