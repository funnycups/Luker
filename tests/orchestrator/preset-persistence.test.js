// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import {
    bumpCharacterWriteEpoch,
    bumpGlobalWriteEpoch,
    captureCharacterOrchestratorMutation,
    captureGlobalPresetMutation,
    persistGlobalLibraryWithLifecycle,
    restoreCharacterOrchestratorState,
    restoreGlobalPresetState,
    snapshotCharacterOrchestratorState,
    snapshotGlobalPresetState,
} from '../../public/scripts/extensions/orchestrator/preset-persistence.js';

describe('orchestrator unified preset persistence and epoch rollback coordinator', () => {
    test('character rollback restores prior state on matching epoch and skips when a newer write advanced the epoch', () => {
        const ctx = {
            characters: [{
                avatar: 'alice.png',
                data: {
                    extensions: {
                        orchestrator: {
                            activePresetIds: { spec: 'a' },
                            presetLibraries: { spec: { a: { name: 'Alpha' }, b: { name: 'Beta' } } },
                        },
                    },
                },
            }],
        };

        // Write 1 mutates active preset to 'b', then fails before any other write -> rollback succeeds.
        const snap1 = snapshotCharacterOrchestratorState(ctx, 'alice.png');
        ctx.characters[0].data.extensions.orchestrator.activePresetIds.spec = 'b';
        captureCharacterOrchestratorMutation(snap1, ctx);
        expect(restoreCharacterOrchestratorState(ctx, snap1)).toBe(true);
        expect(ctx.characters[0].data.extensions.orchestrator.activePresetIds.spec).toBe('a');

        // Write 2 starts, mutates to 'b', then concurrent Write 3 advances epoch -> Write 2 rollback MUST NOT clobber Write 3.
        const snap2 = snapshotCharacterOrchestratorState(ctx, 'alice.png');
        ctx.characters[0].data.extensions.orchestrator.activePresetIds.spec = 'b';
        captureCharacterOrchestratorMutation(snap2, ctx);

        bumpCharacterWriteEpoch('alice.png');
        expect(restoreCharacterOrchestratorState(ctx, snap2)).toBe(false);
        expect(ctx.characters[0].data.extensions.orchestrator.activePresetIds.spec).toBe('b');
    });

    test('global rollback respects shared write epochs bumped by external global writers', () => {
        const settings = {
            activePresetIds: { loop: 'a' },
            presetLibraries: { loop: { a: { name: 'A' }, b: { name: 'B' } } },
        };

        const snap = snapshotGlobalPresetState(settings, 'loop');
        settings.activePresetIds.loop = 'b';
        captureGlobalPresetMutation(snap, settings);

        // Another surface (e.g. editor-persist) writes to loop and bumps the shared epoch.
        bumpGlobalWriteEpoch('loop');
        expect(restoreGlobalPresetState(settings, snap)).toBe(false);
        expect(settings.activePresetIds.loop).toBe('b');
    });

    test('persistGlobalLibraryWithLifecycle propagates saveSettings rejections instead of swallowing them', async () => {
        const settings = {
            activePresetIds: { spec: 'a' },
            presetLibraries: { spec: { a: { name: 'A' } } },
        };
        const ctx = {
            saveSettings: async () => {
                throw new Error('disk full');
            },
        };
        await expect(persistGlobalLibraryWithLifecycle(ctx, settings, 'spec')).rejects.toThrow('disk full');
    });

    test('persistGlobalLibraryWithLifecycle acknowledges equivalent saved libraries with different object key order', async () => {
        const settings = {
            activePresetIds: { spec: 'lit' },
            presetLibraries: {
                spec: {
                    watch: { name: 'Watch', presets: { lookout: { systemPrompt: 'P1', apiPresetName: '' } } },
                    lit: { name: 'Lit', presets: { lookout: { systemPrompt: 'P2', apiPresetName: '' } } },
                },
            },
        };
        const ctx = {
            saveSettings: async () => ({
                ok: true,
                status: 'saved',
                payload: {
                    extension_settings: {
                        orchestrator: {
                            activePresetIds: { spec: 'lit' },
                            presetLibraries: {
                                spec: {
                                    watch: { presets: { lookout: { apiPresetName: '', systemPrompt: 'P1' } }, name: 'Watch' },
                                    lit: { presets: { lookout: { apiPresetName: '', systemPrompt: 'P2' } }, name: 'Lit' },
                                },
                            },
                        },
                    },
                },
            }),
        };
        await expect(persistGlobalLibraryWithLifecycle(ctx, settings, 'spec')).resolves.toBe(true);
    });
});
