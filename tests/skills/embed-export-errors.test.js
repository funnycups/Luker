// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    maybeAttachSkillsToPresetExport,
    maybeAttachSkillsToOrchPresetExport,
    confirmCharacterSkillsExport,
} from '../../public/scripts/skills/embed-export-hook.js';
import { registerSkillEmbedLifecycle } from '../../public/scripts/skills/embed-lifecycle.js';

describe('skills export/lifecycle surfaces listing and attachment failures loudly', () => {
    let origToastr;
    let errorSpy;

    beforeEach(() => {
        origToastr = globalThis.toastr;
        globalThis.toastr = {
            error: jest.fn(),
            warning: jest.fn(),
            success: jest.fn(),
            info: jest.fn(),
        };
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        globalThis.toastr = origToastr;
        errorSpy.mockRestore();
    });

    test('maybeAttachSkillsToPresetExport rejects when context.skills.list fails', async () => {
        const data = { extensions: { luker: { embedded_skills_source: { version: 1, items: [] } } } };
        const context = {
            skills: {
                list: jest.fn(async () => { throw new Error('preset list 500'); }),
            },
        };
        await expect(maybeAttachSkillsToPresetExport({ context, data, presetName: 'P1' }))
            .rejects.toThrow('preset list 500');
        // Stale embedded skills were still stripped before the failure
        expect(data.extensions.luker.embedded_skills_source).toBeUndefined();
    });

    test('maybeAttachSkillsToOrchPresetExport rejects when active-skill resolution or fallback list fails', async () => {
        const payload = { mode: 'director', name: 'RP1' };
        const contextWithOrch = {
            skills: { list: jest.fn(async () => []) },
            getExtensionApi: () => ({
                collectResolvedSkillsForOrchPreset: jest.fn(async () => { throw new Error('resolver exploded'); }),
            }),
        };
        await expect(maybeAttachSkillsToOrchPresetExport({ context: contextWithOrch, payload }))
            .rejects.toThrow('resolver exploded');

        const contextWithoutOrch = {
            skills: { list: jest.fn(async () => { throw new Error('legacy list 503'); }) },
        };
        await expect(maybeAttachSkillsToOrchPresetExport({ context: contextWithoutOrch, payload }))
            .rejects.toThrow('legacy list 503');
    });

    test('confirmCharacterSkillsExport rejects when character skills.list fails', async () => {
        const context = {
            skills: { list: jest.fn(async () => { throw new Error('char skills 500'); }) },
        };
        await expect(confirmCharacterSkillsExport({ context, characterFile: 'alice.png' }))
            .rejects.toThrow('char skills 500');
    });

    test('registerSkillEmbedLifecycle OAI_PRESET_EXPORT_READY logs console.error and toasts error on failure', async () => {
        const listeners = new Map();
        const context = {
            skills: { list: jest.fn(async () => { throw new Error('export list failed'); }) },
            eventSource: {
                on(event, fn) {
                    if (!listeners.has(event)) listeners.set(event, []);
                    listeners.get(event).push(fn);
                },
                async emit(event, payload) {
                    for (const fn of (listeners.get(event) || [])) {
                        await fn(payload);
                    }
                },
            },
            eventTypes: {
                OAI_PRESET_EXPORT_READY: 'oai_preset_export_ready',
            },
        };

        registerSkillEmbedLifecycle({ context, t: (s) => s });
        await context.eventSource.emit('oai_preset_export_ready', { data: {}, presetName: 'P1' });

        expect(errorSpy).toHaveBeenCalled();
        expect(globalThis.toastr.error).toHaveBeenCalledWith(expect.stringContaining('export list failed'));
    });

    test('maybeAttachSkillsToOrchPresetExport warns when some scopes fail to pack while others succeed', async () => {
        const payload = { mode: 'director', name: 'RP1' };
        const byScope = new Map([
            ['global', { scope: { kind: 'global' }, names: ['global-skill'] }],
            ['preset:P1', { scope: { kind: 'preset', name: 'P1' }, names: ['broken-skill'] }],
        ]);
        const context = {
            POPUP_TYPE: { CONFIRM: 2 },
            callGenericPopup: jest.fn(async () => 1),
            getExtensionApi: () => ({
                collectResolvedSkillsForOrchPreset: jest.fn(async () => byScope),
            }),
            skills: {
                packForEmbed: jest.fn(async ({ scope }) => {
                    if (scope.kind === 'preset') {
                        throw new Error('preset scope pack failed');
                    }
                    return {
                        version: 1,
                        items: [{
                            bundleFormat: 'inline-files-v1',
                            name: 'global-skill',
                            files: [{ path: 'SKILL.md', encoding: 'utf8', content: '# Global' }],
                        }],
                    };
                }),
            },
        };

        const attached = await maybeAttachSkillsToOrchPresetExport({ context, payload, t: (s) => s });

        expect(attached).toBe(true);
        expect(payload.extensions.luker.embedded_skills_source.items.map((item) => item.name)).toEqual(['global-skill']);
        expect(errorSpy).toHaveBeenCalled();
        expect(globalThis.toastr.success).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).toHaveBeenCalledWith(
            'Bundled 1 skill(s) with this preset, but 1 scope(s) failed to bundle.',
        );
    });
});
