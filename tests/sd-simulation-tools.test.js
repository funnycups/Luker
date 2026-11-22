/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, test } from '@jest/globals';
import { createAnnotationEngine } from '../public/scripts/iteration-library/simulation-review/annotation-engine.js';
import { buildSimulationToolResult } from '../public/scripts/iteration-library/simulation-review/feedback-builder.js';
import {
    renderSdExploration,
    renderSdIllustration,
} from '../public/scripts/iteration-library/simulation-review/renderers/sd.js';
import {
    simulateSdExploration,
    simulateSdIllustration,
} from '../public/scripts/extensions/stable-diffusion/lens/simulate.js';
import { createSdIterateTarget } from '../public/scripts/extensions/stable-diffusion/lens/iterate-target.js';

const FAKE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeFakeTrackerFactory({ failCleanupOnIndex = null, failGeneratePrompt = null } = {}) {
    const trackers = [];
    let counter = 0;
    const createTracker = () => {
        counter += 1;
        const idx = counter;
        const sessionId = `00000000-0000-4000-8000-${String(idx).padStart(12, '0')}`;
        const stagedPaths = [];
        let cleaned = false;
        let readyCalls = 0;
        const tracker = {
            get sessionId() { return sessionId; },
            get cleaned() { return cleaned; },
            get stagedPaths() { return [...stagedPaths]; },
            get readyCalls() { return readyCalls; },
            async ready() {
                readyCalls += 1;
                return { sessionId };
            },
            async generate(prompt) {
                if (failGeneratePrompt && prompt.includes(failGeneratePrompt)) {
                    throw new Error(`Simulated backend failure for ${prompt}`);
                }
                const p = `/user/images/_sandbox_tmp/${sessionId}/gen_${stagedPaths.length + 1}.png`;
                stagedPaths.push(p);
                return p;
            },
            async fetchReferenceImage({ imageUrl }) {
                const p = `/user/images/_sandbox_tmp/${sessionId}/ref_${stagedPaths.length + 1}.png`;
                stagedPaths.push(p);
                return { ok: true, imagePath: p, sourceUrl: imageUrl, width: 512, height: 512 };
            },
            async preview(imagePath) {
                if (!stagedPaths.includes(imagePath)) {
                    throw new Error(`Unowned staged image: ${imagePath}`);
                }
                return FAKE_DATA_URL;
            },
            async waitForIdle() {},
            async cleanup() {
                if (failCleanupOnIndex === idx) {
                    throw new Error(`EACCES removing _sandbox_tmp/${sessionId}`);
                }
                cleaned = true;
            },
        };
        trackers.push(tracker);
        return tracker;
    };
    return { createTracker, trackers };
}

function createSimContext({ chat = [], characterId = null, characters = [], generateTaskImpl } = {}) {
    const formalProfiles = {
        char_formal_1: {
            id: 'char_formal_1',
            name: 'Formal Archive Hero',
            aliases: [],
            sourceWork: 'Formal Work',
            canonicalTags: ['black_hair'],
            negativeTags: [],
            proseDescription: 'Stored formally on disk.',
            outfits: [{ id: 'outfit_default', name: 'Default', tags: [], prose: '', referenceImages: ['/user/images/_references/formal_1.png'] }],
            defaultOutfitId: 'outfit_default',
            createdAt: 100,
            updatedAt: 100,
        },
    };
    const formalImagePaths = ['/user/images/_references/formal_1.png'];
    const capturedScopes = [];
    const globalWrites = [];
    const chatState = clone(chat);

    const context = {
        chatId: characterId !== null ? 'chat_sim_1' : '',
        characterId,
        groupId: null,
        chat: chatState,
        characters: clone(characters),
        name1: 'Traveler',
        powerUserSettings: { persona_description: 'Amber-eyed wanderer.' },
        userAvatar: 'traveler.png',
        extensionSettings: {
            sd: {
                illustration: {
                    currentPresetId: 'preset_1',
                    contextMessageCount: 4,
                    presets: [{
                        id: 'preset_1',
                        name: 'Disk Preset',
                        promptStyle: 'tag',
                        promptDefaultsInitialized: true,
                        illustrationPrompt: 'DISK_ILLUSTRATION_PROMPT_DO_NOT_USE',
                        studioPrompt: 'DISK_STUDIO_PROMPT',
                        explorationPrompt: 'DISK_EXPLORATION_PROMPT_DO_NOT_USE',
                        llm: { apiPresetName: 'ConnA', llmPresetName: 'LlmA' },
                        explorationLlm: { apiPresetName: 'ConnExp', llmPresetName: 'LlmExp' },
                        visualInspection: true,
                    }],
                },
            },
        },
        translate: s => String(s ?? ''),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        getCharaFilename: (_id, opts) => String(opts?.manualAvatarKey || '').replace(/\.[^.]+$/, ''),
        getCharaAuxWorlds: () => [],
        imageGeneration: {
            async getAvailableLoras() {
                return { names: ['cinematic_v1.safetensors'], includeWeight: true };
            },
            async getCapabilities() {
                return {
                    source: 'comfy',
                    model: 'test-model',
                    supportsCharacterReference: true,
                    maxCharacterReferences: 4,
                    supportsStyleReference: false,
                    maxStyleReferences: 0,
                    supportsSourceImage: true,
                    supportsMultiCharacterPrompts: false,
                    supportsDynamicAspectRatio: true,
                    availableLoras: { names: ['cinematic_v1.safetensors'], includeWeight: true },
                };
            },
        },
        async captureTaskPromptContext(opts) {
            capturedScopes.push(clone(opts));
            return {
                scope: opts.scope,
                apiPresetName: opts.apiPresetName || '',
                llmPresetName: opts.llmPresetName || '',
                captured: true,
            };
        },
        async getGlobalState(ns) {
            if (ns === 'sd_character_profiles') {
                return { ok: true, state: { version: 1, profiles: clone(formalProfiles) } };
            }
            return { ok: true, state: {} };
        },
        async updateGlobalState(ns, updater) {
            globalWrites.push(ns);
            if (ns === 'sd_character_profiles') {
                const next = await updater({ version: 1, profiles: clone(formalProfiles) });
                if (next?.profiles) {
                    Object.keys(formalProfiles).forEach(k => delete formalProfiles[k]);
                    Object.assign(formalProfiles, clone(next.profiles));
                }
            }
            return { ok: true };
        },
        async generateTask(opts) {
            if (typeof generateTaskImpl === 'function') {
                return await generateTaskImpl(opts);
            }
            return { toolCalls: [], assistantText: 'No tool calls.' };
        },
    };

    const snapshotExternal = () => ({
        characterProfiles: clone(formalProfiles),
        chat: clone(context.chat),
        formalImagePaths: [...formalImagePaths],
        globalWrites: [...globalWrites],
    });

    return { context, capturedScopes, snapshotExternal };
}

function makeDraftLive() {
    return {
        presets: [{
            id: 'preset_1',
            name: 'Draft Preset',
            promptStyle: 'tag',
            promptDefaultsInitialized: true,
            illustrationPrompt: 'UNSAVED_DRAFT_ILLUSTRATION_PROMPT_TOKEN_8841',
            studioPrompt: 'UNSAVED_STUDIO_PROMPT',
            explorationPrompt: 'UNSAVED_DRAFT_EXPLORATION_PROMPT_TOKEN_9927',
            llm: { apiPresetName: 'ConnA', llmPresetName: 'LlmA' },
            explorationLlm: { apiPresetName: 'ConnExp', llmPresetName: 'LlmExp' },
            visualInspection: true,
        }],
        characters: [{
            id: 'char_draft_1',
            name: 'Draft Navigator',
            aliases: ['Starfinder'],
            sourceWork: 'Draft Chronicle',
            canonicalTags: ['silver_braid', 'amber_eyes'],
            negativeTags: ['blurry'],
            proseDescription: 'Uncommitted draft character wearing a brass astrolabe cloak.',
            outfits: [{
                id: 'outfit_cloak',
                name: 'Astrolabe Cloak',
                tags: ['navy_cloak', 'brass_compass'],
                prose: 'Deep navy cloak trimmed with brass compass charms.',
                referenceImages: ['/user/images/_references/draft_nav.png'],
            }],
            defaultOutfitId: 'outfit_cloak',
            createdAt: 200,
            updatedAt: 200,
        }],
        workflows: [],
        comfyConfig: { activeWorkflow: '', placeholders: [] },
    };
}

function runRealDomReview({ kind, payload, worldInfoHits = [], annotateSnippet = '', comment = '', cancel = false, onRerun = null }) {
    const i18nFn = (_key, fallback) => fallback || _key;
    const render = kind === 'sd-illustration' ? renderSdIllustration : renderSdExploration;
    let currentPayload = payload;
    let currentHits = worldInfoHits;

    return {
        async run({ triggerRerun = false } = {}) {
            if (triggerRerun && typeof onRerun === 'function') {
                const next = await onRerun();
                if (next?.payload) currentPayload = next.payload;
                if (Array.isArray(next?.worldInfoHits)) currentHits = next.worldInfoHits;
            }
            const host = render(currentPayload, i18nFn);
            document.body.appendChild(host);
            try {
                const engine = createAnnotationEngine({ host, i18n: i18nFn });
                if (!cancel && annotateSnippet) {
                    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
                    let node;
                    while ((node = walker.nextNode())) {
                        const offset = node.nodeValue.indexOf(annotateSnippet);
                        if (offset >= 0) {
                            const range = document.createRange();
                            range.setStart(node, offset);
                            range.setEnd(node, offset + annotateSnippet.length);
                            const sel = window.getSelection();
                            sel.removeAllRanges();
                            sel.addRange(range);
                            engine.addAnnotationFromSelection(sel, comment);
                            break;
                        }
                    }
                }
                const annotations = cancel ? [] : engine.getAnnotations();
                const chainSegments = cancel
                    ? engine.buildChainSegments().map(s => ({ text: s.text }))
                    : engine.buildChainSegments();
                const toolResultText = buildSimulationToolResult({
                    kind,
                    cancelled: cancel,
                    error: null,
                    chainSegments,
                    annotations,
                    worldInfoHits: currentHits,
                });
                return {
                    ok: !cancel,
                    cancelled: cancel,
                    annotations,
                    toolResultText,
                    chainText: toolResultText,
                    renderedHtml: host.outerHTML,
                    renderedHost: host,
                };
            } finally {
                host.remove();
            }
        },
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('workbench sd simulation tools', () => {
    test('simulatesUnsavedIllustrationPrompts', async () => {
        const messageText = 'Lyra stepped onto the wet pier under amber lanterns. Waves rolled softly against the hull.';
        const seenRequests = [];
        const { context, capturedScopes, snapshotExternal } = createSimContext({
            chat: [
                { is_user: true, mes: 'Shall we depart at dusk?' },
                { is_user: false, name: 'Lyra', mes: messageText },
            ],
            characterId: 0,
            characters: [{
                name: 'Lyra',
                avatar: 'lyra.png',
                description: 'Harbor navigator.',
                data: { extensions: {} },
            }],
            generateTaskImpl: async (opts) => {
                seenRequests.push(clone(opts));
                opts.onPreparedRequest?.({
                    requestApi: 'openai',
                    payload: {
                        messages: clone(opts.taskMessages),
                        model: 'mock-model',
                    },
                });
                const toolNames = (opts.tools || []).map(t => t.function.name);
                if (toolNames.includes('save_character_profile')) {
                    const hasSaved = opts.taskMessages.some(m => m.role === 'tool');
                    if (!hasSaved) {
                        return {
                            toolCalls: [{
                                id: 'exp_save_1',
                                name: 'save_character_profile',
                                args: {
                                    id: 'char_sandbox_new',
                                    name: 'Harbor Keeper',
                                    canonical_tags: ['lantern', 'raincoat'],
                                    outfits: [{ id: 'outfit_rain', name: 'Raincoat', tags: ['yellow_raincoat'] }],
                                    default_outfit_id: 'outfit_rain',
                                },
                            }],
                            assistantText: '',
                        };
                    }
                    return { toolCalls: [], assistantText: 'Saved Harbor Keeper in sandbox.' };
                }
                const round = seenRequests.filter(r => (r.tools || []).some(t => t.function.name === 'add_image_prompt')).length;
                if (round === 1) {
                    return {
                        reasoning: 'Checking draft archive and exploring Harbor Keeper.',
                        toolCalls: [
                            { id: 'ill_read_1', name: 'read_character_profiles', args: { ids: ['char_draft_1'] } },
                            { id: 'ill_exp_1', name: 'explore_characters', args: { targets: [{ name: 'Harbor Keeper' }] } },
                        ],
                        assistantText: '',
                    };
                }
                return {
                    reasoning: 'Submitting two prompts (one succeeds, one fails generation).',
                    toolCalls: [
                        {
                            id: 'ill_add_1',
                            name: 'add_image_prompt',
                            args: {
                                prompt: '1girl, silver_braid, amber_eyes, navy_cloak, wet pier under amber lanterns',
                                negative_prompt: 'blurry',
                                aspect_ratio: '16:9',
                                insert_after: 'under amber lanterns.',
                                insert_before: ' Waves rolled softly',
                                character_refs: [{ profile_id: 'char_draft_1', outfit_id: 'outfit_cloak' }],
                            },
                        },
                        {
                            id: 'ill_add_2',
                            name: 'add_image_prompt',
                            args: {
                                prompt: 'FAIL_THIS_IMAGE_PROMPT waves against wooden hull',
                                insert_after: 'softly against',
                                insert_before: ' the hull.',
                            },
                        },
                    ],
                    assistantText: '',
                };
            },
        });

        const live = makeDraftLive();
        const originalLive = clone(live);
        const before = snapshotExternal();
        const { createTracker, trackers } = makeFakeTrackerFactory({ failGeneratePrompt: 'FAIL_THIS_IMAGE_PROMPT' });

        let capturedPayload = null;
        const result = await simulateSdIllustration({
            context,
            live,
            args: { allow_exploration: true },
            createTracker,
            openReview: async ({ kind, payload, worldInfoHits }) => {
                capturedPayload = payload;
                expect(kind).toBe('sd-illustration');
                return await runRealDomReview({ kind, payload, worldInfoHits }).run();
            },
        });

        expect(live).toEqual(originalLive);
        const after = snapshotExternal();
        expect(after.characterProfiles).toEqual(before.characterProfiles);
        expect(after.chat).toEqual(before.chat);
        expect(after.formalImagePaths).toEqual(before.formalImagePaths);
        expect(after.globalWrites).toEqual([]);
        expect(result).toContain('<simulation_result');
        expect(result).toContain('UNSAVED_DRAFT_ILLUSTRATION_PROMPT_TOKEN_8841');
        expect(result).toContain('Harbor Keeper');
        expect(result).toContain('Simulated backend failure');
        expect(trackers).toHaveLength(1);
        expect(trackers[0].cleaned).toBe(true);

        // Actual requests used unsaved draft prompts & unsaved draft character archive, never disk prompts.
        const illReq = seenRequests.find(r => (r.tools || []).some(t => t.function.name === 'add_image_prompt'));
        const expReq = seenRequests.find(r => (r.tools || []).some(t => t.function.name === 'save_character_profile'));
        expect(illReq.taskMessages[0].content).toContain('UNSAVED_DRAFT_ILLUSTRATION_PROMPT_TOKEN_8841');
        expect(illReq.taskMessages[0].content).not.toContain('DISK_ILLUSTRATION_PROMPT_DO_NOT_USE');
        expect(illReq.taskMessages[1].content).toContain('char_draft_1');
        expect(illReq.taskMessages[1].content).not.toContain('char_formal_1');
        expect(expReq.taskMessages[0].content).toContain('UNSAVED_DRAFT_EXPLORATION_PROMPT_TOKEN_9927');
        expect(expReq.taskMessages[0].content).not.toContain('DISK_EXPLORATION_PROMPT_DO_NOT_USE');
        expect(capturedScopes[0].scope).toBe('chat');
        expect(capturedPayload.illustrations).toHaveLength(2);
        expect(capturedPayload.illustrations[0].status).toBe('ready');
        expect(capturedPayload.illustrations[0].dataUrl).toBe(FAKE_DATA_URL);
        expect(capturedPayload.illustrations[1].status).toBe('failed');

        // Custom sample_message with no chat selected uses preset-scoped context and does not read background chat.
        const noChat = createSimContext({
            chat: [],
            characterId: null,
            generateTaskImpl: async (opts) => {
                opts.onPreparedRequest?.({ requestApi: 'openai', payload: { messages: clone(opts.taskMessages) } });
                return { toolCalls: [], assistantText: 'No illustration emitted for this sample.' };
            },
        });
        const sampleTrackers = makeFakeTrackerFactory();
        const sampleResult = await simulateSdIllustration({
            context: noChat.context,
            live,
            args: { sample_message: 'Snow drifted across the silent courtyard.' },
            createTracker: sampleTrackers.createTracker,
            openReview: async ({ kind, payload, worldInfoHits }) => {
                expect(payload.inputSnapshot.scope).toBe('preset');
                expect(payload.inputSnapshot.current).toContain('Snow drifted across the silent courtyard.');
                return await runRealDomReview({ kind, payload, worldInfoHits }).run();
            },
        });
        expect(noChat.capturedScopes[0].scope).toBe('preset');
        expect(sampleResult).toContain('No illustration emitted for this sample.');
        expect(sampleTrackers.trackers[0].cleaned).toBe(true);
    });

    test('simulatesBackgroundProfiles', async () => {
        const seenRequests = [];
        const { context, snapshotExternal } = createSimContext({
            characters: [{
                name: 'Lyra',
                avatar: 'lyra.png',
                description: 'Navigator.',
                data: { extensions: { world: 'HarborBook' } },
            }],
            generateTaskImpl: async (opts) => {
                seenRequests.push(clone(opts));
                opts.onPreparedRequest?.({ requestApi: 'openai', payload: { messages: clone(opts.taskMessages) } });
                const round = seenRequests.length;
                if (round === 1) {
                    return {
                        reasoning: 'Fetching reference and saving to sandbox profile store.',
                        toolCalls: [{
                            id: 'bg_1',
                            name: 'fetch_reference_image',
                            args: { image_url: 'https://example.org/lyra.png', profile_id: 'char_bg_1' },
                        }],
                        assistantText: '',
                    };
                }
                if (round === 2) {
                    const lastTool = opts.taskMessages.findLast(m => m.role === 'tool');
                    const stagedPath = JSON.parse(lastTool.content).imagePath;
                    return {
                        toolCalls: [{
                            id: 'bg_2',
                            name: 'save_character_profile',
                            args: {
                                id: 'char_bg_1',
                                name: 'Background Character',
                                canonical_tags: ['teal_eyes'],
                                outfits: [{ id: 'outfit_1', name: 'Coat', reference_images: [stagedPath] }],
                                default_outfit_id: 'outfit_1',
                            },
                        }],
                        assistantText: '',
                    };
                }
                return { toolCalls: [], assistantText: 'Archived Background Character.' };
            },
        });

        const live = makeDraftLive();
        const originalLive = clone(live);
        const before = snapshotExternal();
        const { createTracker, trackers } = makeFakeTrackerFactory();

        // Validation errors reject malformed inputs cleanly via SourceError before opening trackers.
        await expect(simulateSdExploration({ context, live, args: {}, createTracker }))
            .rejects.toMatchObject({ code: 'invalid_args' });
        await expect(simulateSdExploration({ context, live, args: { mode: 'background' }, createTracker }))
            .rejects.toMatchObject({ code: 'invalid_args' });
        await expect(simulateSdExploration({ context, live, args: { mode: 'dialog', user_turns: [] }, createTracker }))
            .rejects.toMatchObject({ code: 'invalid_args' });
        await expect(simulateSdExploration({ context, live, args: { mode: 'background', targets: [{ name: 'X' }], source: { kind: 'card', card_avatar: 'missing.png' } }, createTracker }))
            .rejects.toMatchObject({ code: 'not_found' });
        await expect(simulateSdIllustration({ context, live, args: { message_index: -1 }, createTracker }))
            .rejects.toMatchObject({ code: 'invalid_args' });
        expect(trackers).toHaveLength(0);

        const result = await simulateSdExploration({
            context,
            live,
            args: {
                mode: 'background',
                targets: [{ name: 'Background Character', work: 'Harbor Saga' }],
                user_hint: 'Focus on coat silhouette.',
            },
            createTracker,
            openReview: async ({ kind, payload, worldInfoHits }) => {
                expect(kind).toBe('sd-exploration');
                expect(payload.mode).toBe('background');
                expect(payload.savedProfiles).toHaveLength(1);
                return await runRealDomReview({ kind, payload, worldInfoHits }).run();
            },
        });

        expect(live).toEqual(originalLive);
        expect(snapshotExternal()).toEqual(before);
        expect(trackers).toHaveLength(1);
        expect(trackers[0].cleaned).toBe(true);
        expect(seenRequests[0].taskMessages[0].content).toContain('UNSAVED_DRAFT_EXPLORATION_PROMPT_TOKEN_9927');
        const toolNames = seenRequests[0].tools.map(t => t.function.name);
        expect(toolNames).toContain('save_character_profile');
        expect(toolNames).not.toContain('read_character_card');
        expect(toolNames).not.toContain('read_user_persona');
        expect(toolNames).not.toContain('world_book_list');
        expect(result).toContain('Background Character');
        expect(result).not.toContain(FAKE_DATA_URL);
    });

    test('simulatesDialogProfiles', async () => {
        const seenRequests = [];
        const { context, snapshotExternal } = createSimContext({
            generateTaskImpl: async (opts) => {
                seenRequests.push(clone(opts));
                opts.onPreparedRequest?.({ requestApi: 'openai', payload: { messages: clone(opts.taskMessages) } });
                const userTurnsCount = opts.taskMessages.filter(m => m.role === 'user' && typeof m.content === 'string').length;
                const toolMsgsCount = opts.taskMessages.filter(m => m.role === 'tool').length;

                if (userTurnsCount === 1 && toolMsgsCount === 0) {
                    return {
                        reasoning: 'Generating portrait for turn 1.',
                        toolCalls: [{
                            id: 'dlg_gen_1',
                            name: 'generate_image',
                            args: { prompt: '1girl, silver_braid, amber_eyes, astrolabe cloak' },
                        }],
                        assistantText: '',
                    };
                }
                if (userTurnsCount === 1 && toolMsgsCount === 1) {
                    const genResult = JSON.parse(opts.taskMessages.findLast(m => m.role === 'tool').content);
                    return {
                        toolCalls: [{
                            id: 'dlg_stage_1',
                            name: 'stage_character_profile',
                            args: {
                                outfits: [{
                                    id: 'outfit_cloak',
                                    name: 'Astrolabe Cloak',
                                    tags: ['navy_cloak'],
                                    reference_images: [genResult.imagePath],
                                }],
                            },
                        }],
                        assistantText: '',
                    };
                }
                if (userTurnsCount === 1) {
                    return { toolCalls: [], assistantText: 'Generated and staged the cloak portrait.' };
                }
                if (userTurnsCount === 2 && toolMsgsCount === 2) {
                    return {
                        toolCalls: [{
                            id: 'dlg_stage_2',
                            name: 'stage_character_profile',
                            args: { canonical_tags: ['silver_braid', 'amber_eyes', 'star_hairpin'] },
                        }],
                        assistantText: '',
                    };
                }
                return { toolCalls: [], assistantText: 'Added star hairpin to canonical tags.' };
            },
        });

        const live = makeDraftLive();
        const originalLive = clone(live);
        const before = snapshotExternal();
        const { createTracker, trackers } = makeFakeTrackerFactory();

        const result = await simulateSdExploration({
            context,
            live,
            args: {
                mode: 'dialog',
                initial_profile_id: 'char_draft_1',
                user_turns: [
                    'Generate a portrait for the Astrolabe Cloak outfit.',
                    'Also add a star hairpin to her core appearance tags.',
                ],
                source: { kind: 'none' },
            },
            createTracker,
            openReview: async ({ kind, payload, worldInfoHits }) => {
                expect(kind).toBe('sd-exploration');
                expect(payload.mode).toBe('dialog');
                expect(payload.turns).toHaveLength(2);
                expect(payload.finalDraft.canonicalTags).toContain('star_hairpin');
                expect(payload.finalDraft.outfits[0].referenceImages[0]).toMatch(/^\/user\/images\/_sandbox_tmp\//);
                return await runRealDomReview({ kind, payload, worldInfoHits }).run();
            },
        });

        expect(live).toEqual(originalLive);
        expect(snapshotExternal()).toEqual(before);
        expect(trackers).toHaveLength(1);
        expect(trackers[0].cleaned).toBe(true);
        const toolNames = seenRequests[0].tools.map(t => t.function.name);
        expect(toolNames).toContain('stage_character_profile');
        expect(toolNames).toContain('generate_image');
        expect(toolNames).not.toContain('save_character_profile');
        expect(result).toContain('star_hairpin');
        expect(result).toContain('Added star hairpin to canonical tags.');
        expect(result).not.toContain(FAKE_DATA_URL);
    });

    test('rerunsFromTheOriginalSnapshot', async () => {
        let attemptCount = 0;
        const observedExistingProfilesPerAttempt = [];
        const { context, snapshotExternal } = createSimContext({
            generateTaskImpl: async (opts) => {
                const isFirstRoundOfAttempt = !opts.taskMessages.some(m => m.role === 'tool');
                if (isFirstRoundOfAttempt) {
                    attemptCount += 1;
                    observedExistingProfilesPerAttempt.push(opts.taskMessages[1]?.content || opts.taskMessages[0]?.content || '');
                    return {
                        toolCalls: [{
                            id: `bg_rerun_${attemptCount}`,
                            name: 'save_character_profile',
                            args: {
                                id: `char_attempt_${attemptCount}`,
                                name: `Attempt ${attemptCount} Character`,
                                canonical_tags: [`tag_attempt_${attemptCount}`],
                            },
                        }],
                        assistantText: '',
                    };
                }
                return { toolCalls: [], assistantText: `Finished attempt ${attemptCount}.` };
            },
        });

        const live = makeDraftLive();
        const originalLive = clone(live);
        const before = snapshotExternal();
        const { createTracker, trackers } = makeFakeTrackerFactory();

        const result = await simulateSdExploration({
            context,
            live,
            args: {
                mode: 'background',
                targets: [{ name: 'Rerun Target' }],
            },
            createTracker,
            openReview: async ({ kind, payload, worldInfoHits, onRerun }) => {
                expect(payload.savedProfiles.map(p => p.id)).toEqual(['char_attempt_1']);
                const runner = runRealDomReview({ kind, payload, worldInfoHits, onRerun });
                return await runner.run({ triggerRerun: true });
            },
        });

        expect(attemptCount).toBe(2);
        expect(observedExistingProfilesPerAttempt[1]).not.toContain('char_attempt_1');
        expect(observedExistingProfilesPerAttempt[1]).toContain('char_draft_1');
        expect(trackers).toHaveLength(2);
        expect(trackers[0].sessionId).not.toBe(trackers[1].sessionId);
        expect(trackers[0].cleaned).toBe(true);
        expect(trackers[1].cleaned).toBe(true);
        expect(result).toContain('Attempt 2 Character');
        expect(result).not.toContain('Attempt 1 Character');
        expect(live).toEqual(originalLive);
        expect(snapshotExternal()).toEqual(before);
    });

    test('returnsAnnotatedTextWithoutLeakingState', async () => {
        const longDiagnosticTail = `LONG_DIAGNOSTIC_END_${'X'.repeat(12000)}_TAIL_MARKER`;
        const messageText = 'Rain fell across the glass conservatory while Lyra opened the brass case.';
        const { context, snapshotExternal } = createSimContext({
            chat: [{ is_user: false, name: 'Lyra', mes: messageText }],
            characterId: 0,
            generateTaskImpl: async (opts) => {
                opts.onPreparedRequest?.({
                    requestApi: 'openai',
                    payload: {
                        messages: [
                            { role: 'system', content: 'UNSAVED_DRAFT_ILLUSTRATION_PROMPT_TOKEN_8841' },
                            { role: 'user', content: [{ type: 'text', text: messageText }, { type: 'image_url', image_url: { url: FAKE_DATA_URL } }] },
                        ],
                    },
                });
                return {
                    reasoning: `Detailed reasoning: ${longDiagnosticTail}`,
                    toolCalls: [{
                        id: 'ann_1',
                        name: 'add_image_prompt',
                        args: {
                            prompt: '1girl, glass conservatory, brass case, warm lantern light',
                            insert_after: 'glass conservatory',
                            insert_before: ' while Lyra opened',
                        },
                    }],
                    assistantText: '',
                };
            },
        });

        const live = makeDraftLive();
        const originalLive = clone(live);
        const before = snapshotExternal();

        // 1. Annotated submit preserves full long diagnostics, excludes Base64 from <simulation_chain>, and renders <img data-sim-ignore="true">.
        const okTrackers = makeFakeTrackerFactory();
        let capturedHtml = '';
        const result = await simulateSdIllustration({
            context,
            live,
            args: { allow_exploration: false },
            createTracker: okTrackers.createTracker,
            openReview: async ({ kind, payload, worldInfoHits }) => {
                const outcome = await runRealDomReview({
                    kind,
                    payload,
                    worldInfoHits,
                    annotateSnippet: 'warm lantern light',
                    comment: 'Use cooler moonlight instead',
                }).run();
                capturedHtml = outcome.renderedHtml;
                return outcome;
            },
        });

        const after = snapshotExternal();
        expect(live).toEqual(originalLive);
        expect(after.characterProfiles).toEqual(before.characterProfiles);
        expect(after.chat).toEqual(before.chat);
        expect(after.formalImagePaths).toEqual(before.formalImagePaths);
        expect(result).toContain('<simulation_result');
        expect(result).toContain('ok="true"');
        expect(result).toContain('Use cooler moonlight instead');
        expect(result).toContain('<<<ANNOTATION id=1>>>warm lantern light<<</ANNOTATION>>>');
        expect(result).toContain(longDiagnosticTail);
        expect(result).not.toContain('data:image/');
        expect(capturedHtml).toContain('data-sim-ignore="true"');
        expect(capturedHtml).toContain(FAKE_DATA_URL);
        expect(okTrackers.trackers[0].cleaned).toBe(true);

        // 2. Cancelled review returns cancelled="true" and still cleans up temp media.
        const cancelTrackers = makeFakeTrackerFactory();
        const cancelResult = await simulateSdIllustration({
            context,
            live,
            args: { allow_exploration: false },
            createTracker: cancelTrackers.createTracker,
            openReview: async ({ kind, payload, worldInfoHits }) => (
                await runRealDomReview({ kind, payload, worldInfoHits, cancel: true }).run()
            ),
        });
        expect(cancelResult).toContain('cancelled="true"');
        expect(cancelTrackers.trackers[0].cleaned).toBe(true);

        // 3. Cleanup failure returns a cleanup_failed tool error result while preserving the review text and annotations.
        const failCleanTrackers = makeFakeTrackerFactory({ failCleanupOnIndex: 1 });
        const cleanupFailedResult = await simulateSdIllustration({
            context,
            live,
            args: { allow_exploration: false },
            createTracker: failCleanTrackers.createTracker,
            openReview: async ({ kind, payload, worldInfoHits }) => (
                await runRealDomReview({
                    kind,
                    payload,
                    worldInfoHits,
                    annotateSnippet: 'warm lantern light',
                    comment: 'Keep this annotation despite cleanup error',
                }).run()
            ),
        });
        expect(cleanupFailedResult).toContain('ok="false"');
        expect(cleanupFailedResult).toContain('cleanup_failed');
        expect(cleanupFailedResult).toContain('EACCES removing _sandbox_tmp/');
        expect(cleanupFailedResult).toContain('Keep this annotation despite cleanup error');

        // 4. IterateTarget registers both tools as read-only tools.
        const target = createSdIterateTarget(() => context);
        const toolNames = (await target.tools()).map(t => t.function.name);
        expect(toolNames).toContain('sd_simulate_illustration');
        expect(toolNames).toContain('sd_simulate_exploration');
        expect(target.isRead('sd_simulate_illustration')).toBe(true);
        expect(target.isRead('sd_simulate_exploration')).toBe(true);
    });
});
