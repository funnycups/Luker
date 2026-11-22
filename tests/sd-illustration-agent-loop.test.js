import { describe, expect, jest, test } from '@jest/globals';
import { createCharacterProfileStore } from '../public/scripts/extensions/stable-diffusion/character-archive/store.js';
import {
    DEFAULT_ILLUSTRATION_PROMPT,
    DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
    LEGACY_DEFAULT_ILLUSTRATION_PROMPT,
    LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
    V1_DEFAULT_ILLUSTRATION_PROMPT,
    V1_DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
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
        expect(DEFAULT_ILLUSTRATION_PROMPT).not.toBe(V1_DEFAULT_ILLUSTRATION_PROMPT);
        expect(DEFAULT_NATURAL_ILLUSTRATION_PROMPT).not.toBe(V1_DEFAULT_NATURAL_ILLUSTRATION_PROMPT);

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
                    id: 'preset_v1_tag',
                    name: 'V1 tag',
                    promptStyle: 'tag',
                    promptDefaultsInitialized: true,
                    illustrationPrompt: V1_DEFAULT_ILLUSTRATION_PROMPT,
                    studioPrompt: 'studio v1',
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
        expect(normalized.presets[2].illustrationPrompt).toBe(DEFAULT_ILLUSTRATION_PROMPT);
        expect(normalized.presets[3].illustrationPrompt).toBe(customPrompt);
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
                        characterReferenceEnabled: true,
                        characterReferenceMode: 'text_and_image',
                        supportsCharacterTextReference: true,
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

    test('(b) resolves v2 profile referenceImages with image_paths after read_character_profiles', async () => {
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
                            character_refs: [{
                                profile_id: 'char_lyra',
                                image_paths: ['/user/images/_references/lyra_coat.png'],
                            }],
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
            description: 'Silver braid, navy naval coat with brass buttons.',
            referenceImages: [
                { path: '/user/images/_references/lyra_coat.png', label: 'Naval Coat' },
                { path: '/user/images/_references/lyra_casual.png', label: 'Casual' },
            ],
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
                        characterReferenceEnabled: true,
                        characterReferenceMode: 'text_and_image',
                        supportsCharacterTextReference: true,
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
        expect(toolMessage.content).toContain('/user/images/_references/lyra_coat.png');

        expect(generated).toHaveLength(1);
        expect(generated[0].opts.aspectRatio).toBe('3:4');
        expect(generated[0].opts.references).toEqual([
            {
                imagePath: '/user/images/_references/lyra_coat.png',
                role: 'character',
                label: 'Lyra — Naval Coat',
            },
        ]);
        expect(generated[0].opts.negativePrompt).toBe('lowres');
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
                                    description: 'Crimson eyes, wearing a dark travel cloak.',
                                    reference_images: [
                                        { path: '/user/images/_references/vesper_cloak.png', label: 'Travel Cloak' },
                                    ],
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
                            character_refs: [{ profile_id: 'char_explored' }],
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
                        characterReferenceEnabled: true,
                        characterReferenceMode: 'text_and_image',
                        supportsCharacterTextReference: true,
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
            description: 'Blonde hair.',
            referenceImages: [{ path: '/user/images/_references/aria.png', label: 'Default' }],
        });
        await profileStore.upsertProfile({
            id: 'char_b',
            name: 'Bryn',
            description: 'Black hair.',
            referenceImages: [{ path: '/user/images/_references/bryn.png', label: 'Default' }],
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
                        characterReferenceEnabled: true,
                        characterReferenceMode: 'text_and_image',
                        supportsCharacterTextReference: true,
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
            description: 'Silver braid, navy naval coat.',
            referenceImages: [{ path: '/user/images/_references/lyra_coat.png', label: 'Naval Coat' }],
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
                                    description: 'Dark cloak.',
                                    reference_images: [
                                        { path: '/user/images/_sandbox_tmp/sess_sandbox_1/vesper.png', label: 'Cloak' },
                                    ],
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
                                character_refs: [{ profile_id: 'char_vesper' }],
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
                    characterReferenceEnabled: true,
                    characterReferenceMode: 'text_and_image',
                    supportsCharacterTextReference: true,
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

    test('gates archive tools and profile detail by characterReferenceEnabled and delivery mode, and fails fast before confirmReplace on conflict', async () => {
        const makeProfileContext = (chat, generateTask) => createMemoryGlobalStateContext({ chat, generateTask });

        // 1. Disabled: no archive tools, no <character_archive> or <character_reference_policy>, no character_refs prop.
        const chatDisabled = [makeMessage()];
        const disabledCalls = [];
        const ctxDisabled = makeProfileContext(chatDisabled, async opts => {
            disabledCalls.push(structuredClone(opts));
            return {
                toolCalls: [{
                    id: 'c_dis_1',
                    name: 'add_image_prompt',
                    args: {
                        prompt: '1girl, spyglass',
                        insert_after: 'laid the brass spyglass',
                        insert_before: 'on the chart table.',
                    },
                }],
                assistantText: '',
                finishReason: 'tool_calls',
            };
        });
        await createCharacterProfileStore(ctxDisabled).upsertProfile({
            id: 'char_lyra',
            name: 'Lyra',
            description: 'Silver braid. Navigator in tailored navy wool coat.',
            referenceImages: [{ path: '/user/images/_references/lyra.png', label: 'Coat' }],
        });

        const settings = normalizeIllustrationSettings(undefined);
        settings.enabled = true;
        const pipelineDisabled = createIllustrationPipeline({
            context: ctxDisabled,
            imageService: {
                async getAvailableLoras() { return { names: [], includeWeight: false }; },
                async getCapabilities() {
                    return {
                        source: 'google',
                        model: 'gemini-2.5-flash-image',
                        characterReferenceEnabled: false,
                        characterReferenceMode: 'text_only',
                        supportsCharacterTextReference: false,
                        supportsCharacterReference: false,
                        maxCharacterReferences: 0,
                        supportsStyleReference: false,
                        maxStyleReferences: 0,
                        supportsSourceImage: false,
                        supportsMultiCharacterPrompts: false,
                        supportsDynamicAspectRatio: true,
                        warnings: [],
                    };
                },
                async generate() { return '/user/images/Narrator/disabled.png'; },
            },
            settings,
            hooks: {
                toast: () => {},
                notifyError: err => { throw new Error(`Unexpected error: ${err}`); },
                saveChat: async () => {},
                updateMessageBlock: () => {},
                ensureSwipes: () => {},
                getChatId: () => 'chat_1',
                getChat: () => chatDisabled,
            },
        });
        await pipelineDisabled.runForMessage({ messageId: 0, source: 'manual' });
        expect(disabledCalls).toHaveLength(1);
        expect(disabledCalls[0].tools.map(t => t.function.name)).toEqual(['add_image_prompt']);
        expect(disabledCalls[0].tools[0].function.parameters.properties).not.toHaveProperty('character_refs');
        expect(disabledCalls[0].taskMessages[1].content).not.toContain('<character_archive>');
        expect(disabledCalls[0].taskMessages[1].content).not.toContain('<character_reference_policy>');

        // 2. text_only vs image_only formatting in read_character_profiles
        const runModeRead = async (mode) => {
            const chat = [makeMessage()];
            const calls = [];
            const ctx = makeProfileContext(chat, async opts => {
                calls.push(structuredClone(opts));
                if (calls.length === 1) {
                    return {
                        toolCalls: [{ id: 'r1', name: 'read_character_profiles', args: { ids: ['char_lyra'] } }],
                        assistantText: '',
                        finishReason: 'tool_calls',
                    };
                }
                return {
                    toolCalls: [{
                        id: 'p1',
                        name: 'add_image_prompt',
                        args: {
                            prompt: '1girl, brass spyglass',
                            insert_after: 'laid the brass spyglass',
                            insert_before: 'on the chart table.',
                            ...(mode === 'image_only' ? { character_refs: [{ profile_id: 'char_lyra' }] } : {}),
                        },
                    }],
                    assistantText: '',
                    finishReason: 'tool_calls',
                };
            });
            await createCharacterProfileStore(ctx).upsertProfile({
                id: 'char_lyra',
                name: 'Lyra',
                description: 'Silver braid. Navigator in tailored navy wool coat.',
                referenceImages: [{ path: '/user/images/_references/lyra.png', label: 'Coat' }],
            });
            const generated = [];
            const pipeline = createIllustrationPipeline({
                context: ctx,
                imageService: {
                    async getAvailableLoras() { return { names: [], includeWeight: false }; },
                    async getCapabilities() {
                        return {
                            source: 'google',
                            model: 'gemini-2.5-flash-image',
                            characterReferenceEnabled: true,
                            characterReferenceMode: mode,
                            supportsCharacterTextReference: mode !== 'image_only',
                            supportsCharacterReference: mode !== 'text_only',
                            maxCharacterReferences: mode === 'text_only' ? 0 : null,
                            supportsStyleReference: false,
                            maxStyleReferences: 0,
                            supportsSourceImage: false,
                            supportsMultiCharacterPrompts: false,
                            supportsDynamicAspectRatio: true,
                            warnings: [],
                        };
                    },
                    async generate(prompt, opts) {
                        generated.push({ prompt, opts });
                        return '/user/images/Narrator/mode.png';
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
            return { calls, generated };
        };

        const textOnlyRun = await runModeRead('text_only');
        const textToolBody = textOnlyRun.calls[1].taskMessages.find(m => m.role === 'tool').content;
        expect(textToolBody).toContain('description: Silver braid. Navigator in tailored navy wool coat.');
        expect(textToolBody).not.toContain('reference_images:');
        expect(textOnlyRun.calls[0].taskMessages[1].content).not.toContain('refs=');
        expect(textOnlyRun.calls[0].tools[0].function.parameters.properties).not.toHaveProperty('character_refs');

        const imageOnlyRun = await runModeRead('image_only');
        const imageToolBody = imageOnlyRun.calls[1].taskMessages.find(m => m.role === 'tool').content;
        expect(imageToolBody).toContain('path=/user/images/_references/lyra.png | label=Coat');
        expect(imageToolBody).not.toContain('description:');
        expect(imageToolBody).not.toContain('tailored navy wool coat');
        expect(imageOnlyRun.generated[0].opts.references).toEqual([
            { imagePath: '/user/images/_references/lyra.png', role: 'character', label: 'Lyra — Coat' },
        ]);

        // 3. Conflict fast-fail BEFORE confirmReplace preserves existing illustrations and skips LLM calls.
        const existingMsg = makeMessage('Before <img src="/user/images/keep.png" data-illustration-id="ill_keep"> after');
        existingMsg.extra.illustrations = [{ id: 'ill_keep', status: 'ready', imageUrl: '/user/images/keep.png' }];
        const conflictChat = [existingMsg];
        let confirmCalls = 0;
        let llmCalls = 0;
        const errors = [];
        const conflictCaps = {
            source: 'comfy',
            model: '',
            characterReferenceEnabled: true,
            characterReferenceMode: 'text_and_image',
            supportsCharacterTextReference: true,
            supportsCharacterReference: true,
            maxCharacterReferences: 0,
            warnings: [{
                code: 'comfy_missing_ref_slots',
                message: 'Current ComfyUI workflow does not contain any %ref_image% LoadImage nodes, so requests with reference images or img2img will fail.',
                affects: ['character_image'],
            }],
        };
        const conflictPipeline = createIllustrationPipeline({
            context: makeProfileContext(conflictChat, async () => {
                llmCalls += 1;
                return { toolCalls: [] };
            }),
            imageService: {
                async getAvailableLoras() { return { names: [], includeWeight: false }; },
                async getCapabilities() { return conflictCaps; },
                async generate() { throw new Error('must not generate'); },
            },
            settings,
            hooks: {
                toast: () => {},
                notifyError: msg => errors.push(String(msg)),
                confirmReplace: async () => { confirmCalls += 1; return true; },
                saveChat: async () => {},
                updateMessageBlock: () => {},
                ensureSwipes: () => {},
                getChatId: () => 'chat_1',
                getChat: () => conflictChat,
            },
        });
        await conflictPipeline.runForMessage({ messageId: 0, source: 'manual' });
        expect(confirmCalls).toBe(0);
        expect(llmCalls).toBe(0);
        expect(conflictChat[0].mes).toContain('ill_keep');
        expect(conflictChat[0].extra.illustrations).toHaveLength(1);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('%ref_image%');

        // Shared runIllustrationAgent also fails fast on character_image conflict.
        await expect(runIllustrationAgent({
            context: { generateTask: async () => { throw new Error('must not call LLM'); } },
            preset: { illustrationPrompt: 'TASK' },
            input: { current: 'Scene text', snapshotText: 'Scene text', capabilities: conflictCaps },
            media: { generate: async () => { throw new Error('must not generate'); } },
        })).rejects.toMatchObject({ code: 'ref_config_conflict' });
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
