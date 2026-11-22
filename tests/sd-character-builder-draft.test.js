// SPDX-License-Identifier: AGPL-3.0-or-later

import { jest } from '@jest/globals';
import {
    commitCharacterDraft,
    createCharacterDraft,
} from '../public/scripts/extensions/stable-diffusion/exploration/dialog-draft.js';
import {
    runCharacterBuilderTurn,
} from '../public/scripts/extensions/stable-diffusion/exploration/dialog-agent.js';
import { CHARACTER_PROFILES_NAMESPACE, profileVersion } from '../public/scripts/extensions/stable-diffusion/character-archive/store.js';
import { createSandboxProfileStore } from '../public/scripts/extensions/stable-diffusion/lens/simulation-sandbox.js';

function makeInitialProfile(overrides = {}) {
    return {
        id: 'char_iris',
        name: 'Iris',
        aliases: ['Lamplighter'],
        sourceWork: 'Harbor Tales',
        canonicalTags: ['silver_hair', 'amber_eyes'],
        negativeTags: ['blurry'],
        proseDescription: 'A calm archivist with silver hair.',
        outfits: [
            {
                id: 'outfit_default',
                name: 'Archivist Coat',
                tags: ['navy_coat'],
                prose: 'Long navy coat with brass buttons.',
                referenceImages: ['/user/images/_references/iris_existing.png'],
            },
        ],
        defaultOutfitId: 'outfit_default',
        createdAt: 1000,
        updatedAt: 1000,
        ...overrides,
    };
}

describe('dialog-draft', () => {
    test('mergesOnlyChangedDraftFields', () => {
        const seed = makeInitialProfile();
        const draft = createCharacterDraft(seed);
        const turn = draft.beginTurn();

        const result = draft.applyAgentPatch({
            canonical_tags: ['silver_hair', 'crimson_eyes'],
        }, turn);

        expect(result.conflicts).toEqual([]);
        expect(result.changes.map(item => item.path)).toEqual(['canonicalTags']);

        const snapshot = draft.getSnapshot();
        expect(snapshot.canonicalTags).toEqual(['silver_hair', 'crimson_eyes']);
        expect(snapshot.name).toBe('Iris');
        expect(snapshot.aliases).toEqual(['Lamplighter']);
        expect(snapshot.sourceWork).toBe('Harbor Tales');
        expect(snapshot.negativeTags).toEqual(['blurry']);
        expect(snapshot.proseDescription).toBe('A calm archivist with silver hair.');
        expect(snapshot.outfits).toEqual(seed.outfits);
        expect(snapshot.defaultOutfitId).toBe('outfit_default');

        // Mutating snapshot or original seed must not alias internal draft state.
        snapshot.canonicalTags.push('mutated');
        seed.name = 'Mutated Seed';
        expect(draft.getSnapshot().canonicalTags).toEqual(['silver_hair', 'crimson_eyes']);
        expect(draft.getSnapshot().name).toBe('Iris');
    });

    test('keepsManualEditsOnConflict', () => {
        const draft = createCharacterDraft(makeInitialProfile());
        const turn = draft.beginTurn();

        draft.edit('name', '手动名称');
        draft.edit('outfits', [
            {
                id: 'outfit_default',
                name: 'Archivist Coat',
                tags: ['navy_coat'],
                prose: 'Long navy coat with brass buttons.',
                referenceImages: [],
            },
        ]);

        const result = draft.applyAgentPatch({
            name: '候选名称',
            source_work: 'Updated Setting',
            outfits: [
                {
                    id: 'outfit_default',
                    name: 'Archivist Coat',
                    tags: ['navy_coat'],
                    prose: 'Long navy coat with brass buttons.',
                    reference_images: ['/user/images/_references/iris_existing.png'],
                },
            ],
        }, turn);

        expect(result.conflicts.map(c => c.path)).toEqual(['name', 'outfits']);
        expect(draft.getSnapshot().name).toBe('手动名称');
        // Deleted reference image must not be restored by stale agent patch.
        expect(draft.getSnapshot().outfits[0].referenceImages).toEqual([]);
        // Uncontested sibling field still merges cleanly.
        expect(draft.getSnapshot().sourceWork).toBe('Updated Setting');
        expect(draft.getConflicts()).toHaveLength(2);

        const nameConflict = result.conflicts.find(c => c.path === 'name');
        const outfitsConflict = result.conflicts.find(c => c.path === 'outfits');

        draft.resolveConflict(nameConflict.id, 'keep_manual');
        expect(draft.getSnapshot().name).toBe('手动名称');
        expect(draft.getConflicts().map(c => c.path)).toEqual(['outfits']);

        draft.resolveConflict(outfitsConflict.id, 'accept_agent');
        expect(draft.getSnapshot().outfits[0].referenceImages).toEqual(['/user/images/_references/iris_existing.png']);
        expect(draft.getConflicts()).toEqual([]);

        // Subsequent turn snapshot carries manual edits forward.
        const nextTurn = draft.beginTurn();
        expect(nextTurn.profile.name).toBe('手动名称');
    });

    test('allowsRepeatedAgentUpdatesWithinTurn', () => {
        const draft = createCharacterDraft(null);
        const turn = draft.beginTurn();

        const first = draft.applyAgentPatch({
            name: 'Candidate One',
            canonical_tags: ['short_hair'],
        }, turn);
        expect(first.conflicts).toEqual([]);
        expect(draft.getSnapshot().name).toBe('Candidate One');

        const second = draft.applyAgentPatch({
            name: 'Candidate Refined',
            canonical_tags: ['short_hair', 'green_eyes'],
            prose_description: 'Refined description.',
        }, turn);
        expect(second.conflicts).toEqual([]);
        expect(draft.getConflicts()).toEqual([]);
        expect(draft.getSnapshot().name).toBe('Candidate Refined');
        expect(draft.getSnapshot().canonicalTags).toEqual(['short_hair', 'green_eyes']);
        expect(draft.getSnapshot().proseDescription).toBe('Refined description.');
    });

    test('keepsDraftAfterFailedSave', async () => {
        const initial = makeInitialProfile();
        const draft = createCharacterDraft(initial);
        const tempPath = '/user/images/_sandbox_tmp/sess-1/draft_1.png';
        draft.edit('name', 'Iris Revised');
        draft.edit('outfits', [
            {
                id: 'outfit_default',
                name: 'Archivist Coat',
                tags: ['navy_coat'],
                prose: 'Long navy coat.',
                referenceImages: [tempPath],
            },
        ]);

        const store = {
            upsertProfile: jest.fn(async () => {
                throw new Error('The character profile changed. Reload it before continuing.');
            }),
        };
        const tracker = {
            sessionId: 'sess-1',
            ready: jest.fn(async () => ({ sessionId: 'sess-1' })),
            promote: jest.fn(async (paths) => ({
                promotionId: 'promo-1',
                images: paths.map((sourcePath, i) => ({
                    sourcePath,
                    imagePath: `/user/images/_references/promo-1-${i}.png`,
                })),
            })),
            rollback: jest.fn(async () => ({ retained: [] })),
            complete: jest.fn(async () => ({ retained: [] })),
            cleanup: jest.fn(async () => {}),
        };

        await expect(commitCharacterDraft({
            draft,
            initialVersion: profileVersion(initial),
            store,
            tracker,
        })).rejects.toThrow('The character profile changed.');

        expect(tracker.promote).toHaveBeenCalledWith([tempPath], {
            profileId: 'char_iris',
            namespace: CHARACTER_PROFILES_NAMESPACE,
        });
        expect(tracker.rollback).toHaveBeenCalledWith('promo-1');
        expect(tracker.complete).not.toHaveBeenCalled();
        expect(tracker.cleanup).not.toHaveBeenCalled();
        // Draft and temporary staged path stay intact for retry.
        expect(draft.getSnapshot().name).toBe('Iris Revised');
        expect(draft.getSnapshot().outfits[0].referenceImages).toEqual([tempPath]);
    });

    test('commitsOnlyRetainedImages', async () => {
        const draft = createCharacterDraft(null);
        const removedTemp = '/user/images/_sandbox_tmp/sess-2/discarded.png';
        const retainedTemp = '/user/images/_sandbox_tmp/sess-2/kept.png';

        const turn = draft.beginTurn();
        draft.applyAgentPatch({
            name: 'Nora',
            outfits: [
                {
                    id: 'outfit_default',
                    name: 'Default',
                    tags: ['red_scarf'],
                    prose: 'Warm red scarf.',
                    reference_images: [removedTemp, retainedTemp],
                },
            ],
            default_outfit_id: 'outfit_default',
        }, turn);

        // User removes discarded temp image before confirming.
        draft.edit('outfits', [
            {
                id: 'outfit_default',
                name: 'Default',
                tags: ['red_scarf'],
                prose: 'Warm red scarf.',
                referenceImages: [retainedTemp],
            },
        ]);

        const store = createSandboxProfileStore([]);
        const upsertSpy = jest.spyOn(store, 'upsertProfile');
        const tracker = {
            sessionId: 'sess-2',
            ready: jest.fn(async () => ({ sessionId: 'sess-2' })),
            promote: jest.fn(async (paths) => ({
                promotionId: 'promo-2',
                images: paths.map((sourcePath, i) => ({
                    sourcePath,
                    imagePath: `/user/images/_references/promo-2-${i}.png`,
                })),
            })),
            rollback: jest.fn(async () => ({ retained: [] })),
            complete: jest.fn(async () => ({ retained: ['/user/images/_references/promo-2-0.png'] })),
            cleanup: jest.fn(async () => {}),
        };

        const committed = await commitCharacterDraft({
            draft,
            initialVersion: null,
            store,
            tracker,
        });

        expect(tracker.promote).toHaveBeenCalledWith([retainedTemp], {
            profileId: committed.saved.id,
            namespace: CHARACTER_PROFILES_NAMESPACE,
        });
        expect(upsertSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'Nora',
                outfits: [
                    expect.objectContaining({
                        referenceImages: ['/user/images/_references/promo-2-0.png'],
                    }),
                ],
            }),
            expect.any(Number),
            { expectedVersion: null, transientSessionId: 'sess-2' },
        );
        expect(tracker.complete).toHaveBeenCalledWith('promo-2');
        expect(tracker.rollback).not.toHaveBeenCalled();
        expect(committed.saved.outfits[0].referenceImages).toEqual(['/user/images/_references/promo-2-0.png']);

        // Text-only save still authorizes an empty promotion batch.
        const textDraft = createCharacterDraft(null);
        textDraft.edit('name', 'Text Only');
        const textTracker = {
            sessionId: 'sess-3',
            ready: jest.fn(async () => ({ sessionId: 'sess-3' })),
            promote: jest.fn(async () => ({ promotionId: 'promo-3', images: [] })),
            rollback: jest.fn(async () => ({ retained: [] })),
            complete: jest.fn(async () => ({ retained: [] })),
            cleanup: jest.fn(async () => {}),
        };
        const textCommitted = await commitCharacterDraft({
            draft: textDraft,
            initialVersion: null,
            store,
            tracker: textTracker,
        });
        expect(textTracker.promote).toHaveBeenCalledWith([], {
            profileId: textCommitted.saved.id,
            namespace: CHARACTER_PROFILES_NAMESPACE,
        });
        expect(textTracker.complete).toHaveBeenCalledWith('promo-3');
    });

    test('preserves saved profile result and returns cleanupWarning if tracker.complete fails after upsertProfile succeeds', async () => {
        const draft = createCharacterDraft(null);
        draft.edit('name', 'Saved Despite Cleanup Glitch');
        const store = {
            upsertProfile: jest.fn(async (profile, now) => ({
                ...profile,
                updatedAt: now,
            })),
        };
        const tracker = {
            sessionId: 'sess-warn',
            ready: jest.fn(async () => ({ sessionId: 'sess-warn' })),
            promote: jest.fn(async () => ({ promotionId: 'promo-warn', images: [] })),
            rollback: jest.fn(async () => ({ retained: [] })),
            complete: jest.fn(async () => { throw new Error('Transient completion network drop'); }),
            cleanup: jest.fn(async () => {}),
        };
        const committed = await commitCharacterDraft({
            draft,
            initialVersion: null,
            store,
            tracker,
        });
        expect(committed.saved.name).toBe('Saved Despite Cleanup Glitch');
        expect(committed.cleanupWarning).toContain('Transient completion network drop');
        expect(tracker.rollback).not.toHaveBeenCalled();
    });
});

describe('runCharacterBuilderTurn', () => {
    test('uses stage_character_profile without formal upsert and respects sourcePolicy and visualInspection', async () => {
        const draft = createCharacterDraft(null);
        draft.edit('name', 'Manual Seed Name');
        const store = createSandboxProfileStore([]);
        const upsertSpy = jest.spyOn(store, 'upsertProfile');

        const recordedCalls = [];
        let round = 0;
        const context = {
            imageGeneration: {
                getCapabilities: jest.fn(async () => ({
                    source: 'comfy',
                    model: 'test-model',
                    supportsCharacterReference: true,
                    supportsSourceImage: true,
                    supportsDynamicAspectRatio: true,
                    availableLoras: { names: ['style_lora'], includeWeight: true },
                })),
            },
            generateTask: jest.fn(async (opts) => {
                recordedCalls.push(JSON.parse(JSON.stringify(opts)));
                opts.onPreparedRequest?.({ endpoint: '/api/backends/chat-completions/generate', payload: { messages: opts.taskMessages } });
                round += 1;
                if (round === 1) {
                    return {
                        assistantText: 'Generating candidate portrait.',
                        toolCalls: [
                            {
                                id: 'call_gen_1',
                                name: 'generate_image',
                                args: { prompt: '1girl, silver hair, navy coat, neutral background' },
                            },
                        ],
                    };
                }
                if (round === 2) {
                    return {
                        assistantText: 'Staging profile draft.',
                        toolCalls: [
                            {
                                id: 'call_stage_1',
                                name: 'stage_character_profile',
                                args: {
                                    canonical_tags: ['silver_hair', 'amber_eyes'],
                                    outfits: [
                                        {
                                            id: 'outfit_default',
                                            name: 'Default',
                                            tags: ['navy_coat'],
                                            reference_images: ['/user/images/_sandbox_tmp/sess-a/gen_1.png'],
                                        },
                                    ],
                                    default_outfit_id: 'outfit_default',
                                },
                            },
                        ],
                    };
                }
                return {
                    assistantText: 'Draft updated with generated portrait.',
                    toolCalls: [],
                };
            }),
        };

        const media = {
            sessionId: 'sess-a',
            generate: jest.fn(async () => '/user/images/_sandbox_tmp/sess-a/gen_1.png'),
            fetchReferenceImage: jest.fn(async () => ({ imagePath: '/user/images/_sandbox_tmp/sess-a/ref_1.png' })),
            preview: jest.fn(async () => 'data:image/png;base64,AAAA'),
        };

        const result = await runCharacterBuilderTurn({
            context,
            preset: {
                explorationPrompt: 'Build reusable visual profiles.',
                visualInspection: true,
                llm: { apiPresetName: 'MainConn', llmPresetName: 'MainPreset' },
                explorationLlm: { apiPresetName: 'ExpConn', llmPresetName: 'ExpPreset' },
            },
            messages: [{ role: 'user', content: 'Please design an archivist portrait.' }],
            draft,
            sourcePolicy: { kind: 'none' },
            profileStore: store,
            media,
            transientSessionId: 'sess-a',
        });

        expect(result.finalText).toBe('Draft updated with generated portrait.');
        expect(upsertSpy).not.toHaveBeenCalled();
        expect(draft.getSnapshot().name).toBe('Manual Seed Name');
        expect(draft.getSnapshot().canonicalTags).toEqual(['silver_hair', 'amber_eyes']);
        expect(draft.getSnapshot().outfits[0].referenceImages).toEqual(['/user/images/_sandbox_tmp/sess-a/gen_1.png']);

        // Round 1 tool surface: no card/persona/lorebook tools when sourcePolicy is none, and never save_character_profile.
        const toolNames = recordedCalls[0].tools.map(t => t.function.name);
        expect(toolNames).toContain('generate_image');
        expect(toolNames).toContain('stage_character_profile');
        expect(toolNames).toContain('list_character_profiles');
        expect(toolNames).toContain('search_character_sources');
        expect(toolNames).not.toContain('save_character_profile');
        expect(toolNames).not.toContain('read_character_card');
        expect(toolNames).not.toContain('read_user_persona');
        expect(toolNames).not.toContain('world_book_list');

        // Uses resolveExplorationLlm pair and passes includeCharacterCard: false and transientSessionId.
        expect(recordedCalls[0].apiPresetName).toBe('ExpConn');
        expect(recordedCalls[0].llmPresetName).toBe('ExpPreset');
        expect(recordedCalls[0].includeCharacterCard).toBe(false);
        expect(recordedCalls[0].transientSessionId).toBe('sess-a');
        // System message includes latest manual draft snapshot.
        expect(recordedCalls[0].taskMessages[0].content).toContain('Manual Seed Name');

        // Visual preview injected after generate_image when visualInspection is true.
        expect(media.preview).toHaveBeenCalledWith('/user/images/_sandbox_tmp/sess-a/gen_1.png');
        const hasPreviewPart = recordedCalls[1].taskMessages.some(
            msg => msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(p => p.type === 'image_url' && p.image_url.url === 'data:image/png;base64,AAAA'),
        );
        expect(hasPreviewPart).toBe(true);
    });

    test('rejects empty explorationPrompt before contacting model', async () => {
        const generateTask = jest.fn();
        await expect(runCharacterBuilderTurn({
            context: { generateTask },
            preset: { explorationPrompt: '   ' },
            messages: [{ role: 'user', content: 'Design a character' }],
            draft: createCharacterDraft(null),
            sourcePolicy: { kind: 'none' },
            profileStore: createSandboxProfileStore([]),
            media: { generate: jest.fn(), fetchReferenceImage: jest.fn(), preview: jest.fn() },
        })).rejects.toThrow();
        expect(generateTask).not.toHaveBeenCalled();
    });
});
