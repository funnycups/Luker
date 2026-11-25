import { describe, test, expect, jest } from '@jest/globals';
import {
    createCharacterPromptShareController,
    hasSharedCharacterPrompt,
} from '../public/scripts/extensions/stable-diffusion/character-prompt-sharing.js';

function createHarness() {
    const characters = [
        { avatar: 'watch-a.png', data: { extensions: { retained: 'a' } } },
        { avatar: 'watch-b.png', data: { extensions: { retained: 'b', sd_character_prompt: { positive: 'b-pos', negative: 'b-neg' } } } },
    ];
    let selectedIndex = 0;
    let isGroup = false;
    let shareChecked = false;
    const failures = [];
    const scheduled = [];
    let writeImpl = async (characterId, key, value, options = {}) => {
        if (options.isCurrent && !options.isCurrent()) return false;
        characters[characterId].data.extensions[key] = structuredClone(value);
        return true;
    };

    const controller = createCharacterPromptShareController({
        getCharacters: () => characters,
        getSelection: () => ({
            characterId: selectedIndex,
            character: selectedIndex === null ? null : characters[selectedIndex] ?? null,
            isGroup,
        }),
        writeExtensionField: (...args) => writeImpl(...args),
        debounceMs: 1000,
        setShareChecked: (checked) => { shareChecked = checked; },
        onFailure: (intent, details) => { failures.push({ intent, ...details }); },
        scheduleTimer: (fn) => {
            const entry = { fn, cancelled: false };
            scheduled.push(entry);
            return entry;
        },
        cancelTimer: (entry) => {
            if (entry) entry.cancelled = true;
        },
    });

    return {
        characters,
        controller,
        failures,
        scheduled,
        getShareChecked: () => shareChecked,
        setShareCheckedDirect: (v) => { shareChecked = v; },
        setSelectedIndex: (i) => { selectedIndex = i; },
        setIsGroup: (g) => { isGroup = g; },
        setWriteImpl: (fn) => { writeImpl = fn; },
        flushTimers: async () => {
            for (const entry of scheduled.splice(0, scheduled.length)) {
                if (!entry.cancelled) entry.fn();
            }
            await new Promise(resolve => setTimeout(resolve, 0));
        },
    };
}

describe('character prompt sharing ownership controller', () => {
    test('hasSharedCharacterPrompt always returns a strict boolean even when field is undefined or null', () => {
        expect(hasSharedCharacterPrompt(null)).toBe(false);
        expect(hasSharedCharacterPrompt({ data: { extensions: {} } })).toBe(false);
        expect(hasSharedCharacterPrompt({ data: { extensions: { sd_character_prompt: null } } })).toBe(false);
        expect(hasSharedCharacterPrompt({ data: { extensions: { sd_character_prompt: { positive: 'a', negative: '' } } } })).toBe(true);
    });

    test('scheduleSharedPromptUpdate does not schedule card writes while share checkbox is unchecked', async () => {
        const h = createHarness();
        const writes = jest.fn();
        h.setWriteImpl(writes);

        const didSchedule = h.controller.scheduleSharedPromptUpdate({
            shareChecked: false,
            positive: 'lantern glow',
            negative: 'blurry',
        });

        expect(didSchedule).toBe(false);
        await h.flushTimers();
        expect(writes).not.toHaveBeenCalled();
    });

    test('failed share enable and disable revert checkbox only when still selected and report failure', async () => {
        const h = createHarness();
        h.setWriteImpl(async () => false);
        h.setShareCheckedDirect(true);

        const shareResult = await h.controller.setShareEnabled({
            shouldShare: true,
            positive: 'cloak',
            negative: 'haze',
        });
        expect(shareResult).toBe(false);
        expect(h.getShareChecked()).toBe(false);
        expect(h.failures).toHaveLength(1);
        expect(h.failures[0].intent).toBe('share');

        // Transport rejection on unshare of shared character B reverts B's checkbox to true.
        h.setSelectedIndex(1);
        h.setShareCheckedDirect(false);
        h.setWriteImpl(async () => { throw new TypeError('Failed to fetch'); });

        const unshareResult = await h.controller.setShareEnabled({
            shouldShare: false,
            positive: 'b-pos',
            negative: 'b-neg',
        });
        expect(unshareResult).toBe(false);
        expect(h.getShareChecked()).toBe(true);
        expect(h.failures).toHaveLength(2);
        expect(h.failures[1].intent).toBe('unshare');
    });

    test('unshare cancels a pending debounced edit and writes literal null without republishing', async () => {
        const h = createHarness();
        h.setSelectedIndex(1);
        h.setShareCheckedDirect(true);
        const writes = [];
        h.setWriteImpl(async (characterId, key, value) => {
            writes.push({ characterId, key, value: structuredClone(value) });
            h.characters[characterId].data.extensions[key] = structuredClone(value);
            return true;
        });

        expect(h.controller.scheduleSharedPromptUpdate({
            shareChecked: true,
            positive: 'new draft before unshare',
            negative: 'haze',
        })).toBe(true);

        const unshared = await h.controller.setShareEnabled({
            shouldShare: false,
            positive: 'new draft before unshare',
            negative: 'haze',
        });
        expect(unshared).toBe(true);

        await h.flushTimers();
        expect(writes).toEqual([{ characterId: 1, key: 'sd_character_prompt', value: null }]);
        expect(h.characters[1].data.extensions.sd_character_prompt).toBeNull();
    });

    test('pending debounced write follows character object across reindexing and skips replaced character objects', async () => {
        const h = createHarness();
        h.setSelectedIndex(1);
        h.setShareCheckedDirect(true);
        const calls = [];
        h.setWriteImpl(async (characterId, key, value) => {
            calls.push({ characterId, avatar: h.characters[characterId].avatar, value: structuredClone(value) });
            h.characters[characterId].data.extensions[key] = structuredClone(value);
            return true;
        });

        h.controller.scheduleSharedPromptUpdate({
            shareChecked: true,
            positive: 'reindexed harbor prompt',
            negative: 'glare',
        });

        // Reindex: swap slot 0 and slot 1 so watch-b moves from index 1 to index 0.
        const [charA, charB] = h.characters;
        h.characters.splice(0, 2, charB, charA);
        await h.flushTimers();

        expect(calls).toEqual([{
            characterId: 0,
            avatar: 'watch-b.png',
            value: { positive: 'reindexed harbor prompt', negative: 'glare' },
        }]);

        // Now schedule another edit on charB, then replace all objects in characters[].
        h.setSelectedIndex(0);
        h.controller.scheduleSharedPromptUpdate({
            shareChecked: true,
            positive: 'should not land on replaced object',
            negative: 'glare',
        });
        h.characters.splice(0, 2,
            { avatar: 'watch-b.png', data: { extensions: { sd_character_prompt: { positive: 'fresh', negative: 'glare' } } } },
            { avatar: 'watch-a.png', data: { extensions: {} } },
        );
        await h.flushTimers();

        expect(calls).toHaveLength(1);
        expect(h.characters[0].data.extensions.sd_character_prompt.positive).toBe('fresh');
    });

    test('late failure after switching to another character never alters the newly selected character checkbox', async () => {
        const h = createHarness();
        let rejectPending;
        h.setWriteImpl(() => new Promise((_, reject) => { rejectPending = reject; }));
        h.setShareCheckedDirect(true);

        const pendingShareA = h.controller.setShareEnabled({
            shouldShare: true,
            positive: 'a-pos',
            negative: 'a-neg',
        });

        // User switches to shared Character B before A's request fails.
        h.setSelectedIndex(1);
        h.setShareCheckedDirect(true);

        rejectPending(new TypeError('Connection reset'));
        expect(await pendingShareA).toBe(false);
        expect(h.getShareChecked()).toBe(true);
        expect(h.failures).toHaveLength(1);
        expect(h.failures[0].character.avatar).toBe('watch-a.png');
    });

    test('in-flight write remains owned across character reindexing and loses ownership when character object is replaced', async () => {
        const h = createHarness();
        h.setSelectedIndex(1);
        h.setShareCheckedDirect(true);

        const ownershipChecks = [];
        h.setWriteImpl(async (_characterId, key, value, options = {}) => {
            // Reindex while write is in flight: move watch-b from index 1 to index 0.
            const [charA, charB] = h.characters;
            h.characters.splice(0, 2, charB, charA);
            h.setSelectedIndex(0);

            const stillOwnedAfterReindex = options.isCurrent();
            ownershipChecks.push(stillOwnedAfterReindex);
            if (!stillOwnedAfterReindex) {
                return false;
            }
            charB.data.extensions[key] = structuredClone(value);
            return true;
        });

        const saved = await h.controller.setShareEnabled({
            shouldShare: true,
            positive: 'reindexed while in flight',
            negative: 'blur',
        });

        expect(saved).toBe(true);
        expect(ownershipChecks).toEqual([true]);
        expect(h.failures).toHaveLength(0);
        expect(h.characters[0].data.extensions.sd_character_prompt).toEqual({
            positive: 'reindexed while in flight',
            negative: 'blur',
        });

        // Replacing the character object in-flight must revoke ownership.
        h.setWriteImpl(async (_characterId, _key, _value, options = {}) => {
            h.characters.splice(0, 1, {
                avatar: 'watch-b.png',
                data: { extensions: { sd_character_prompt: { positive: 'fresh-card', negative: '' } } },
            });
            const stillOwnedAfterReplace = options.isCurrent();
            ownershipChecks.push(stillOwnedAfterReplace);
            return stillOwnedAfterReplace;
        });

        const savedAfterReplace = await h.controller.setShareEnabled({
            shouldShare: false,
            positive: '',
            negative: '',
        });

        expect(savedAfterReplace).toBe(false);
        expect(ownershipChecks).toEqual([true, false]);
        expect(h.characters[0].data.extensions.sd_character_prompt).toEqual({
            positive: 'fresh-card',
            negative: '',
        });
    });
});
