/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createCharactersView } from '../../public/scripts/extensions/stable-diffusion/lens/views/characters-view.js';

function makeProfilesState(list) {
    let state = {
        version: 2,
        profiles: Object.fromEntries(list.map(p => [p.id, JSON.parse(JSON.stringify(p))])),
    };
    return {
        getGlobalState: async () => ({ ok: true, state: JSON.parse(JSON.stringify(state)) }),
        setGlobalState: async (_ns, next) => {
            state = JSON.parse(JSON.stringify(next));
            return { ok: true, state };
        },
        updateGlobalState: async (_ns, updater) => {
            const next = await updater(JSON.parse(JSON.stringify(state)));
            if (next !== null && next !== undefined) {
                state = JSON.parse(JSON.stringify(next));
            }
            return { ok: true, state };
        },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        characters: [],
        extensionSettings: { sd: { illustration: { presets: [] } } },
        translate: s => s,
    };
}

describe('SD Lens Character Archive v2 UI, unsaved-changes guard, and upload safety', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        document.body.innerHTML = '';
        globalThis.Luker = {
            getContext: () => ({ translate: s => s }),
        };
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('tracks dirty edits on v2 fields, shows amber banner + Discard, preserves draft across show(), and blocks destructive switches while dirty', async () => {
        const ctx = makeProfilesState([
            {
                id: 'char_1',
                name: 'Alice',
                aliases: [],
                sourceWork: 'Demo',
                description: 'Blonde hair, armored knight.',
                referenceImages: [
                    { path: '/user/images/_references/alice_armor.png', label: 'Armor' },
                ],
                createdAt: 100,
                updatedAt: 100,
            },
            {
                id: 'char_2',
                name: 'Bob',
                aliases: [],
                sourceWork: 'Demo',
                description: 'Black hair, robed mage.',
                referenceImages: [],
                createdAt: 100,
                updatedAt: 100,
            },
        ]);

        const app = {
            getContext: () => ctx,
            toast: jest.fn(),
            notifyDirty: jest.fn(),
            openCharacterBuilderDialog: jest.fn(),
            recordHistory: jest.fn(),
        };

        const view = createCharactersView(app);
        document.body.appendChild(view.el);
        await view.reload();

        expect(view.isDirty()).toBe(false);
        expect(view.el.querySelector('.sdlens-dirty-bar').hidden).toBe(true);
        expect(view.el.querySelector('.sdlens-outfit-card')).toBeNull();
        expect(view.el.querySelector('[data-sd-role="open-ai-builder"]')).not.toBeNull();
        expect(view.el.querySelector('[data-profile-id="char_1"] .sdlens-char-sub').textContent)
            .toContain('1 reference image(s)');

        // Edit description and reference label without losing focus
        const descInput = view.el.querySelector('[data-sd-field="profile-description"]');
        descInput.focus();
        descInput.value = 'Blonde hair, silver armor, blue cloak.';
        descInput.dispatchEvent(new Event('input'));
        expect(document.activeElement).toBe(descInput);
        expect(view.isDirty()).toBe(true);
        expect(app.notifyDirty).toHaveBeenCalledWith(true);
        expect(view.el.querySelector('.sdlens-dirty-bar').hidden).toBe(false);

        const labelInput = view.el.querySelector('[data-sd-role="ref-label"]');
        labelInput.value = 'Full armor';
        labelInput.dispatchEvent(new Event('input'));

        // Returning to the tab via show() without conflicting focusId must keep the draft
        view.show({});
        await new Promise(r => setTimeout(r, 0));
        expect(view.el.querySelector('[data-sd-field="profile-description"]').value)
            .toBe('Blonde hair, silver armor, blue cloak.');
        expect(view.el.querySelector('[data-sd-role="ref-label"]').value).toBe('Full armor');
        expect(view.isDirty()).toBe(true);

        // Switching to another profile, + New, or Refine with AI is blocked with toast while dirty
        view.el.querySelector('[data-profile-id="char_2"]').click();
        expect(view.el.querySelector('[data-sd-field="profile-description"]').value)
            .toBe('Blonde hair, silver armor, blue cloak.');
        expect(app.toast).toHaveBeenCalledWith(expect.stringContaining('Save or discard'), expect.objectContaining({ error: true }));

        app.toast.mockClear();
        view.el.querySelector('[data-sd-role="new-profile"]').click();
        expect(view.el.querySelector('[data-sd-field="profile-description"]').value)
            .toBe('Blonde hair, silver armor, blue cloak.');
        expect(app.toast).toHaveBeenCalledWith(expect.stringContaining('Save or discard'), expect.objectContaining({ error: true }));

        app.toast.mockClear();
        view.el.querySelector('[data-sd-role="refine-with-ai"]').click();
        expect(app.openCharacterBuilderDialog).not.toHaveBeenCalled();
        expect(app.toast).toHaveBeenCalledWith(expect.stringContaining('Save or discard'), expect.objectContaining({ error: true }));

        // Discard restores saved snapshot and clears dirty state
        view.el.querySelector('[data-sd-role="discard-profile"]').click();
        expect(view.isDirty()).toBe(false);
        expect(view.el.querySelector('[data-sd-field="profile-description"]').value).toBe('Blonde hair, armored knight.');
        expect(view.el.querySelector('[data-sd-role="ref-label"]').value).toBe('Armor');
    });

    test('supports uploading labeled reference images, removing them, saving, and guards against stale async uploads after profile switch', async () => {
        const ctx = makeProfilesState([
            {
                id: 'char_1',
                name: 'Alice',
                aliases: [],
                sourceWork: 'Demo',
                description: 'Blonde hair.',
                referenceImages: [],
                createdAt: 100,
                updatedAt: 100,
            },
            {
                id: 'char_2',
                name: 'Bob',
                aliases: [],
                sourceWork: 'Demo',
                description: 'Black hair.',
                referenceImages: [],
                createdAt: 100,
                updatedAt: 100,
            },
        ]);

        let resolveSlowPromote = null;
        let uploadCount = 0;
        globalThis.fetch = jest.fn(async (url, init) => {
            if (url === '/api/images/upload') {
                uploadCount += 1;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ path: `/user/images/_references_staging/up_${uploadCount}.png` }),
                };
            }
            if (url === '/api/sd/character-sources/promote-local-image') {
                const body = JSON.parse(init.body);
                if (uploadCount === 2) {
                    return await new Promise(resolve => {
                        resolveSlowPromote = () => resolve({
                            ok: true,
                            status: 200,
                            json: async () => ({
                                imagePath: `/user/images/_references/${body.profileId}_late.png`,
                                width: 64,
                                height: 64,
                                mimeType: 'image/png',
                            }),
                        });
                    });
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        imagePath: `/user/images/_references/${body.profileId}_ref1.png`,
                        width: 64,
                        height: 64,
                        mimeType: 'image/png',
                    }),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const app = {
            getContext: () => ctx,
            toast: jest.fn(),
            notifyDirty: jest.fn(),
            recordHistory: jest.fn(),
        };

        const view = createCharactersView(app);
        document.body.appendChild(view.el);
        await view.reload();

        const fakeFile = {
            name: 'portrait.png',
            arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
        };

        // 1. Upload reference image to Alice, set label, save, and verify persisted v2 shape.
        const fileInput = view.el.querySelector('[data-sd-role="upload-ref-input"]');
        Object.defineProperty(fileInput, 'files', { value: [fakeFile], configurable: true });
        fileInput.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 30));

        expect(view.el.querySelectorAll('[data-sd-role="ref-item"]')).toHaveLength(1);
        const labelInput = view.el.querySelector('[data-sd-role="ref-label"]');
        labelInput.value = 'Portrait';
        labelInput.dispatchEvent(new Event('input'));

        view.el.querySelector('[data-sd-role="save-profile"]').click();
        await new Promise(r => setTimeout(r, 40));

        expect(view.isDirty()).toBe(false);
        const savedAfter = (await ctx.getGlobalState('sd_character_profiles')).state.profiles.char_1;
        expect(savedAfter.referenceImages).toEqual([
            { path: '/user/images/_references/char_1_ref1.png', label: 'Portrait' },
        ]);

        // 2. Start a second upload on Alice, switch to Bob before it finishes, then resolve -> must NOT leak into Bob!
        const fileInput2 = view.el.querySelector('[data-sd-role="upload-ref-input"]');
        Object.defineProperty(fileInput2, 'files', { value: [fakeFile], configurable: true });
        fileInput2.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 20));
        expect(typeof resolveSlowPromote).toBe('function');

        view.el.querySelector('[data-profile-id="char_2"]').click();
        expect(view.el.querySelector('[data-sd-field="profile-name"]').value).toBe('Bob');

        resolveSlowPromote();
        await new Promise(r => setTimeout(r, 30));
        expect(view.el.querySelectorAll('[data-sd-role="ref-item"]')).toHaveLength(0);
        expect(view.isDirty()).toBe(false);
    });
});
