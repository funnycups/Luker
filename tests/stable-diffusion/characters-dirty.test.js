/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { createCharactersView } from '../../public/scripts/extensions/stable-diffusion/lens/views/characters-view.js';

function makeProfilesState(list) {
    let state = { profiles: Object.fromEntries(list.map(p => [p.id, JSON.parse(JSON.stringify(p))])) };
    return {
        getGlobalState: async () => ({ ok: true, state: JSON.parse(JSON.stringify(state)) }),
        setGlobalState: async (_ns, next) => { state = JSON.parse(JSON.stringify(next)); return { ok: true, state }; },
        updateGlobalState: async (_ns, updater) => {
            state = JSON.parse(JSON.stringify(await updater(JSON.parse(JSON.stringify(state)))));
            return { ok: true, state };
        },
        characters: [],
        extensionSettings: { sd: { illustration: { presets: [] } } },
        translate: (s) => s,
    };
}

describe('SD Lens Character Archive unsaved-changes guard and indicator', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        globalThis.Luker = {
            getContext: () => ({ translate: (s) => s }),
        };
    });

    test('tracks dirty edits, shows amber banner + Discard, preserves draft across show(), and blocks destructive switches while dirty', async () => {
        const ctx = makeProfilesState([
            {
                id: 'char_1',
                name: 'Alice',
                aliases: [],
                sourceWork: 'Demo',
                sourceCardAvatars: [],
                canonicalTags: ['blonde hair'],
                negativeTags: [],
                proseDescription: 'A knight.',
                defaultOutfitId: 'o1',
                outfits: [{ id: 'o1', name: 'Armor', tags: [], prose: '', referenceImages: [] }],
            },
            {
                id: 'char_2',
                name: 'Bob',
                aliases: [],
                sourceWork: 'Demo',
                sourceCardAvatars: [],
                canonicalTags: ['black hair'],
                negativeTags: [],
                proseDescription: 'A mage.',
                defaultOutfitId: 'o2',
                outfits: [{ id: 'o2', name: 'Robe', tags: [], prose: '', referenceImages: [] }],
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

        // Edit canonical name without losing focus
        const nameInput = view.el.querySelector('[data-sd-field="profile-name"]');
        nameInput.focus();
        nameInput.value = 'Alice Updated';
        nameInput.dispatchEvent(new Event('input'));

        expect(document.activeElement).toBe(nameInput);
        expect(view.isDirty()).toBe(true);
        expect(app.notifyDirty).toHaveBeenCalled();
        const banner = view.el.querySelector('.sdlens-dirty-bar');
        expect(banner).not.toBeNull();
        expect(banner.hidden).toBe(false);

        // Returning to the tab via show() without conflicting focusId must keep the draft
        view.show({});
        await new Promise(r => setTimeout(r, 0));
        expect(view.el.querySelector('[data-sd-field="profile-name"]').value).toBe('Alice Updated');
        expect(view.isDirty()).toBe(true);

        // Switching to another profile, + New, or Refine with AI is blocked with toast while dirty
        view.el.querySelector('[data-profile-id="char_2"]').click();
        expect(view.el.querySelector('[data-sd-field="profile-name"]').value).toBe('Alice Updated');
        expect(app.toast).toHaveBeenCalledWith(expect.stringContaining('Save or discard'), expect.objectContaining({ error: true }));

        app.toast.mockClear();
        view.el.querySelector('[data-sd-role="new-profile"]').click();
        expect(view.el.querySelector('[data-sd-field="profile-name"]').value).toBe('Alice Updated');
        expect(app.toast).toHaveBeenCalledWith(expect.stringContaining('Save or discard'), expect.objectContaining({ error: true }));

        app.toast.mockClear();
        view.el.querySelector('[data-sd-role="refine-with-ai"]').click();
        expect(app.openCharacterBuilderDialog).not.toHaveBeenCalled();
        expect(app.toast).toHaveBeenCalledWith(expect.stringContaining('Save or discard'), expect.objectContaining({ error: true }));

        // Discard restores saved snapshot and clears dirty state
        view.el.querySelector('[data-sd-role="discard-profile"]').click();
        expect(view.isDirty()).toBe(false);
        expect(view.el.querySelector('[data-sd-field="profile-name"]').value).toBe('Alice');
    });
});
