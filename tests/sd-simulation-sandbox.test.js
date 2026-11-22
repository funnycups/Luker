// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from '@jest/globals';
import {
    buildCompactProfileIndex,
    profileVersion,
} from '../public/scripts/extensions/stable-diffusion/character-archive/store.js';
import { createSandboxProfileStore } from '../public/scripts/extensions/stable-diffusion/lens/simulation-sandbox.js';
import { captureIllustrationInput } from '../public/scripts/extensions/stable-diffusion/illustration/execution-context.js';

describe('createSandboxProfileStore', () => {
    test('matchesProfileStoreAsyncShape', async () => {
        const seed = [
            {
                id: 'char_lyra',
                name: 'Lyra',
                aliases: ['Navigator'],
                sourceWork: 'Horizon',
                canonicalTags: ['1girl', 'silver braid'],
                negativeTags: ['glasses'],
                proseDescription: 'A calm navigator with a silver braid.',
                outfits: [{
                    id: 'outfit_coat',
                    name: 'Naval Coat',
                    tags: ['navy coat'],
                    prose: 'Heavy navy coat with brass buttons.',
                    referenceImages: ['/user/images/_references/lyra_coat.png'],
                }],
                defaultOutfitId: 'outfit_coat',
                createdAt: 1000,
                updatedAt: 2000,
            },
        ];

        const sandbox = createSandboxProfileStore(seed);

        const listPromise = sandbox.listProfiles();
        expect(typeof listPromise?.then).toBe('function');
        const listed = await listPromise;
        expect(listed).toHaveLength(1);
        expect(listed[0].id).toBe('char_lyra');

        // buildCompactProfileIndex must remain synchronous and match formal store output.
        const indexText = sandbox.buildCompactProfileIndex(listed);
        expect(typeof indexText).toBe('string');
        expect(indexText).toBe(buildCompactProfileIndex(listed));

        const getPromise = sandbox.getProfile('char_lyra');
        expect(typeof getPromise?.then).toBe('function');
        expect(await getPromise).toEqual(listed[0]);

        const byIdsPromise = sandbox.getProfilesByIds(['char_lyra', 'missing_id', 'char_lyra']);
        expect(typeof byIdsPromise?.then).toBe('function');
        expect(await byIdsPromise).toEqual([listed[0]]);

        // Creating a new profile with expectedVersion: null succeeds and permits _sandbox_tmp paths.
        const created = await sandbox.upsertProfile({
            id: 'char_vesper',
            name: 'Vesper',
            sourceWork: 'Starlight',
            canonicalTags: ['1girl', 'crimson eyes'],
            outfits: [{
                id: 'outfit_cloak',
                name: 'Travel Cloak',
                tags: ['dark cloak'],
                referenceImages: ['/user/images/_sandbox_tmp/sess_1/vesper.png'],
            }],
            defaultOutfitId: 'outfit_cloak',
        }, 3000, { expectedVersion: null });

        expect(await sandbox.getProfile(created.id)).toEqual(created);
        expect(sandbox.getRecordedChanges()).toEqual([created]);

        // Duplicate creation with expectedVersion: null must fail with version conflict.
        await expect(sandbox.upsertProfile({
            id: 'char_vesper',
            name: 'Vesper Duplicate',
        }, 4000, { expectedVersion: null })).rejects.toThrow(/changed|reload/i);

        // Stale expectedVersion on update must fail without modifying sandbox.
        await expect(sandbox.upsertProfile({
            id: 'char_vesper',
            name: 'Vesper Stale',
        }, 4000, { expectedVersion: 'stale-version' })).rejects.toThrow(/changed|reload/i);
        expect((await sandbox.getProfile('char_vesper')).name).toBe('Vesper');

        // Matching expectedVersion succeeds and updates recorded changes.
        const updated = await sandbox.upsertProfile({
            id: 'char_vesper',
            name: 'Vesper Updated',
        }, 4500, { expectedVersion: profileVersion(created) });
        expect(updated.name).toBe('Vesper Updated');
        expect(sandbox.getRecordedChanges()).toEqual([updated]);

        // Deleting checks expectedVersion as well.
        await expect(sandbox.deleteProfile('char_vesper', { expectedVersion: 'stale-version' }))
            .rejects.toThrow(/changed|reload/i);
        expect(await sandbox.deleteProfile('char_vesper', { expectedVersion: profileVersion(updated) })).toBe(true);
        expect(await sandbox.getProfile('char_vesper')).toBeNull();
        expect(sandbox.getRecordedChanges()).toEqual([]);
    });

    test('doesNotAliasDraftProfiles', async () => {
        const seed = [
            {
                id: 'char_lyra',
                name: 'Lyra',
                aliases: ['Navigator'],
                canonicalTags: ['silver braid'],
                outfits: [{
                    id: 'outfit_coat',
                    name: 'Naval Coat',
                    tags: ['navy coat'],
                    referenceImages: ['/user/images/_references/lyra.png'],
                }],
                defaultOutfitId: 'outfit_coat',
                createdAt: 100,
                updatedAt: 200,
            },
        ];
        const originalSeed = JSON.parse(JSON.stringify(seed));
        const sandbox = createSandboxProfileStore(seed);

        // Mutating original seed after store creation cannot alter sandbox.
        seed[0].name = 'Mutated Seed';
        seed[0].outfits[0].tags.push('mutated');

        const firstRead = await sandbox.getProfile('char_lyra');
        expect(firstRead.name).toBe('Lyra');
        expect(firstRead.outfits[0].tags).toEqual(['navy coat']);

        // Mutating returned objects cannot alter internal sandbox state.
        firstRead.name = 'Mutated Read';
        firstRead.outfits[0].tags.push('leaked');
        expect((await sandbox.getProfile('char_lyra')).name).toBe('Lyra');
        expect((await sandbox.getProfile('char_lyra')).outfits[0].tags).toEqual(['navy coat']);

        // Mutating upsert input and recordedChanges return value cannot alias store.
        const input = {
            id: 'char_orion',
            name: 'Orion',
            canonicalTags: ['1boy'],
            outfits: [{ id: 'def', name: 'Default', tags: ['cape'], referenceImages: [] }],
            defaultOutfitId: 'def',
        };
        const created = await sandbox.upsertProfile(input, 500);
        input.name = 'Mutated Input';
        input.canonicalTags.push('mutated');
        created.name = 'Mutated Output';

        const stored = await sandbox.getProfile('char_orion');
        expect(stored.name).toBe('Orion');
        expect(stored.canonicalTags).toEqual(['1boy']);

        const changes = sandbox.getRecordedChanges();
        expect(changes).toEqual([stored]);
        changes[0].name = 'Mutated Change';
        expect(sandbox.getRecordedChanges()[0].name).toBe('Orion');

        // Seed remains equal to its original pre-mutation snapshot if not touched by caller.
        expect(originalSeed[0].name).toBe('Lyra');
    });
});

describe('captureIllustrationInput', () => {
    test('captures preset-scoped snapshot for sampleMessage when no chat is selected', async () => {
        const captureCalls = [];
        const context = {
            chat: [],
            characterId: undefined,
            groupId: null,
            characters: [{ name: 'Background Card', avatar: 'bg.png' }],
            imageGeneration: {
                async getAvailableLoras() { return { names: ['style.safetensors'], includeWeight: true }; },
                async getCapabilities() {
                    return {
                        source: 'comfy',
                        model: 'wai',
                        supportsCharacterReference: true,
                        maxCharacterReferences: 2,
                        supportsMultiCharacterPrompts: false,
                        supportsDynamicAspectRatio: true,
                    };
                },
            },
            async captureTaskPromptContext(opts) {
                captureCalls.push(opts);
                return { scope: opts.scope, envelope: { version: 1 }, runtimeWorldInfo: {}, macroEnv: { names: { user: '', char: '' } } };
            },
        };
        const preset = {
            id: 'p1',
            illustrationPrompt: 'Illustrate scene.',
            llm: { apiPresetName: 'IllApi', llmPresetName: 'IllPreset' },
            explorationLlm: { apiPresetName: 'ExpApi', llmPresetName: 'ExpPreset' },
        };

        const snapshot = await captureIllustrationInput({
            context,
            preset,
            sampleMessage: 'A lantern glows over wet cobblestones.',
            contextMessageCount: 4,
        });

        expect(snapshot.current).toBe('A lantern glows over wet cobblestones.');
        expect(snapshot.snapshotText).toBe('A lantern glows over wet cobblestones.');
        expect(snapshot.context).toBe('');
        expect(snapshot.memoryRecall).toBe('');
        expect(snapshot.cardAvatar).toBe('');
        expect(snapshot.loras).toEqual({ names: ['style.safetensors'], includeWeight: true });
        expect(snapshot.capabilities.source).toBe('comfy');
        expect(snapshot.promptContext.scope).toBe('preset');
        expect(snapshot.explorationPromptContext.scope).toBe('preset');
        expect(captureCalls).toEqual([
            { scope: 'preset', apiPresetName: 'IllApi', llmPresetName: 'IllPreset' },
            { scope: 'preset', apiPresetName: 'ExpApi', llmPresetName: 'ExpPreset' },
        ]);
    });

    test('captures chat-scoped snapshot, memory recall, single-card avatar, and recent history', async () => {
        const captureCalls = [];
        const chat = [
            { name: 'User', is_user: true, mes: 'Open the chart.' },
            { name: 'Seraphina', is_user: false, mes: 'She unrolled the brass map across the deck.' },
        ];
        const context = {
            chat,
            chatId: 'chat_1',
            characterId: 0,
            groupId: null,
            characters: [{ name: 'Seraphina', avatar: 'seraphina.png' }],
            getExtensionApi(name) {
                if (name !== 'memory-graph') return null;
                return {
                    async getLastRecallProjection() {
                        return { blocks: { corePacket: 'Core memory', focusPacket: 'Focus detail' } };
                    },
                };
            },
            imageGeneration: {
                async getAvailableLoras() { return { names: [], includeWeight: false }; },
                async getCapabilities() { return { source: 'google', supportsCharacterReference: true }; },
            },
            async captureTaskPromptContext(opts) {
                captureCalls.push(opts);
                return { scope: opts.scope, envelope: { version: 1 }, runtimeWorldInfo: {}, macroEnv: { names: { user: 'User', char: 'Seraphina' } } };
            },
        };
        const preset = {
            id: 'p1',
            illustrationPrompt: 'Illustrate scene.',
            llm: { apiPresetName: 'MainApi', llmPresetName: 'MainPreset' },
            explorationLlm: { apiPresetName: '', llmPresetName: '' },
        };

        const snapshot = await captureIllustrationInput({
            context,
            preset,
            messageIndex: 1,
            contextMessageCount: 2,
        });

        expect(snapshot.messageIndex).toBe(1);
        expect(snapshot.characterName).toBe('Seraphina');
        expect(snapshot.context).toContain('Open the chart.');
        expect(snapshot.current).toBe('She unrolled the brass map across the deck.');
        expect(snapshot.memoryRecall).toBe('Core memory\n\nFocus detail');
        expect(snapshot.cardAvatar).toBe('seraphina.png');
        expect(snapshot.promptContext.scope).toBe('chat');
        expect(snapshot.explorationPromptContext.scope).toBe('preset');
        expect(captureCalls).toEqual([
            { scope: 'chat', apiPresetName: 'MainApi', llmPresetName: 'MainPreset' },
            { scope: 'preset', apiPresetName: 'MainApi', llmPresetName: 'MainPreset' },
        ]);
    });
});
