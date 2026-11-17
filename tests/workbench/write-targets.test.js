/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { initWorkbench, resetWorkbenchForTest } from '../../public/scripts/workbench/index.js';
import { getIterateTargets } from '../../public/scripts/workbench/registry.js';
import { createCardTarget } from '../../public/scripts/workbench/targets/card.js';
import { createWorldTarget } from '../../public/scripts/workbench/targets/world.js';
import { createPresetTarget } from '../../public/scripts/workbench/targets/preset.js';
import { diffUnits } from '../../public/scripts/workbench/model/units.js';

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function createMockCardWorldCtx({
    characters = [],
    characterId = 0,
    groupId = null,
    books = {},
    auxWorlds = {},
    chatWorlds = [],
    globalSelection = [],
    presets = {},
    selectedPreset = '',
    extensionSettings = {},
} = {}) {
    const charStore = clone(characters);
    const bookStore = clone(books);
    const worldInfoCache = new Map(Object.entries(bookStore).map(([k, v]) => [k, clone(v)]));
    const presetStore = new Map(
        Object.entries(presets).map(([name, body]) => [
            name,
            { ref: { collection: 'openai', name, origin: { kind: 'global' } }, body: clone(body) },
        ]),
    );

    const ctx = {
        characters: charStore,
        characterId,
        groupId,
        chatMetadata: {},
        extensionSettings: clone(extensionSettings),
        chatWorldInfo: {
            globalSelection: [...globalSelection],
            getNames: () => [...chatWorlds],
        },
        getCharaFilename: (_ignored, opts = {}) => String(opts?.manualAvatarKey || '').replace(/\.[^.]+$/, ''),
        getCharaAuxWorlds: (fileName) => [...(auxWorlds[fileName] || [])],
        getWorldInfoNames: () => Object.keys(bookStore),
        loadWorldInfo: jest.fn(async (name) => (worldInfoCache.has(name) ? clone(worldInfoCache.get(name)) : null)),
        readWorldInfoDocument: jest.fn(async (name) => {
            if (!Object.hasOwn(bookStore, name)) {
                const err = new Error('Not found');
                err.status = 404;
                throw err;
            }
            return clone(bookStore[name]);
        }),
        saveWorldInfo: jest.fn(async (name, data) => {
            bookStore[name] = clone(data);
            worldInfoCache.set(name, clone(data));
        }),
        worldInfoCache,
        updateCharacterData: jest.fn(async (idx, patch) => {
            const c = charStore[idx];
            if (!c) throw new Error(`Missing char ${idx}`);
            c.data ||= {};
            for (const [k, v] of Object.entries(patch || {})) {
                if (v === undefined) delete c.data[k];
                else c.data[k] = clone(v);
                if (['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'].includes(k)) {
                    c[k] = clone(v);
                }
            }
        }),
        writeExtensionField: jest.fn(async (idx, topKey, val) => {
            const c = charStore[idx];
            c.data ||= {};
            c.data.extensions ||= {};
            c.data.extensions[topKey] = clone(val);
        }),
        openai: {
            stripPresetConnectionFields: (body) => clone(body),
        },
        presets: {
            list: () => [...presetStore.keys()].map((name) => ({ collection: 'openai', name, origin: { kind: 'global' } })),
            getSelected: () => (selectedPreset && presetStore.has(selectedPreset) ? clone(presetStore.get(selectedPreset).ref) : null),
            getStored: (ref) => (presetStore.has(ref?.name) ? clone(presetStore.get(ref.name)) : null),
            save: jest.fn(async (ref, body) => {
                presetStore.set(ref.name, { ref: clone(ref), body: clone(body) });
                return { ok: true, ref: clone(ref) };
            }),
        },
        translate: (s) => String(s ?? ''),
        getCurrentLocale: () => 'en',
        eventSource: { on: () => {}, off: () => {} },
        eventTypes: { APP_READY: 'APP_READY' },
        listExtensionNames: () => [],
    };
    return { ctx, charStore, bookStore, presetStore };
}

beforeEach(() => {
    document.body.innerHTML = '';
    delete globalThis.Luker;
});

afterEach(() => {
    resetWorkbenchForTest();
    delete globalThis.Luker;
    jest.restoreAllMocks();
});

describe('workbench write targets (preset, card, world)', () => {
    test('initWorkbench registers built-in preset, card, and world targets and reset cleans them up', () => {
        const { ctx } = createMockCardWorldCtx();
        globalThis.Luker = { getContext: () => ctx };

        initWorkbench();
        const ids = getIterateTargets().map((t) => t.id);
        expect(ids).toContain('preset');
        expect(ids).toContain('card');
        expect(ids).toContain('world');

        resetWorkbenchForTest();
        expect(getIterateTargets()).toEqual([]);
    });

    test('a pending preset proposal writes and undoes X while Y stays selected', async () => {
        let selected = 'X';
        const presets = { X: { temperature: 1 }, Y: { temperature: 2 } };
        const { ctx, presetStore } = createMockCardWorldCtx({ presets, selectedPreset: 'X' });
        ctx.presets.getSelected = () => ({ collection: 'openai', name: selected, origin: { kind: 'global' } });

        const target = createPresetTarget({ getContext: () => ctx });
        const original = await target.load('preset', ctx);
        selected = 'Y';
        const next = await target.load('preset', ctx);
        expect(next.target.ref.name).toBe('Y');

        const handle = await target.commit(original.target, original.live, { temperature: 3 }, ['settings']);
        expect(presetStore.get('X').body).toEqual({ temperature: 3 });
        expect(presetStore.get('Y').body).toEqual({ temperature: 2 });

        await handle.undo();
        expect(presetStore.get('X').body).toEqual({ temperature: 1 });
        expect(presetStore.get('Y').body).toEqual({ temperature: 2 });
        expect(selected).toBe('Y');
    });

    test('card target scopes, loads, edits card + bound world book, commits, and undoes', async () => {
        const { ctx, charStore, bookStore } = createMockCardWorldCtx({
            characters: [{
                avatar: 'Alice.png',
                name: 'Alice',
                description: 'A quiet alchemist.',
                data: {
                    name: 'Alice',
                    description: 'A quiet alchemist.',
                    extensions: { world: 'MainBook' },
                },
            }],
            books: {
                MainBook: { entries: { 1: { uid: 1, key: ['lab'], content: 'Old lab notes', comment: 'Lab' } } },
                AuxBook: { entries: { 2: { uid: 2, key: ['guild'], content: 'Guild rules', comment: 'Guild' } } },
            },
            auxWorlds: { Alice: ['AuxBook'] },
        });

        const card = createCardTarget({ getContext: () => ctx });
        expect(await card.scopes(ctx)).toEqual({ character: true });

        const loaded = await card.load('character', ctx);
        expect(Object.keys(loaded.live.lorebooks).sort()).toEqual(['AuxBook', 'MainBook']);

        let ai = clone(loaded.live);
        ai = await card.runEdit({
            id: 'e1',
            name: 'cea_str_replace_card_field',
            args: { field: 'description', oldString: 'quiet', newString: 'bold' },
        }, ai);
        ai = await card.runEdit({
            id: 'e2',
            name: 'cea_str_replace_lorebook_entry_field',
            args: { book_name: 'MainBook', uid: 1, field: 'content', oldString: 'Old lab', newString: 'Updated lab' },
        }, ai);

        const keys = diffUnits(card.units(loaded.live), card.units(ai)).map((c) => c.key);
        expect(keys).toEqual(['card:description', 'wi:MainBook:1']);

        const rebuilt = card.rebuild(loaded.live, ai, keys);
        const handle = await card.commit(loaded.target, loaded.live, rebuilt, keys);

        expect(charStore[0].data.description).toBe('A bold alchemist.');
        expect(bookStore.MainBook.entries[1].content).toBe('Updated lab notes');

        await handle.undo();
        expect(charStore[0].data.description).toBe('A quiet alchemist.');
        expect(bookStore.MainBook.entries[1].content).toBe('Old lab notes');
    });

    test('world target supports global and character scopes, blocks card tools, commits and undoes', async () => {
        const { ctx, bookStore } = createMockCardWorldCtx({
            characters: [{
                avatar: 'Bob.png',
                name: 'Bob',
                data: { extensions: { world: 'CharBook' } },
            }],
            books: {
                CharBook: { entries: { 1: { uid: 1, key: ['bob'], content: 'Char lore', comment: 'Bob' } } },
                GlobalBook: { entries: { 10: { uid: 10, key: ['world'], content: 'Global lore', comment: 'World' } } },
            },
            globalSelection: ['GlobalBook'],
        });

        const world = createWorldTarget({ getContext: () => ctx });
        expect(await world.scopes(ctx)).toEqual({ global: true, character: true });

        const toolNames = (await world.tools()).map((d) => d.function.name);
        expect(toolNames).not.toContain('cea_set_card_field');
        expect(toolNames).not.toContain('cea_read_card_fields');
        expect(toolNames).toContain('cea_update_lorebook_entry');
        expect(toolNames).toContain('simulate_prompt');

        const loadedGlobal = await world.load('global', ctx);
        expect(Object.keys(loadedGlobal.live.lorebooks)).toEqual(['GlobalBook']);

        const ai = await world.runEdit({
            id: 'w1',
            name: 'cea_update_lorebook_entry',
            args: { book_name: 'GlobalBook', uid: 10, patch: { content: 'Revised global lore' } },
        }, loadedGlobal.live);

        const keys = diffUnits(world.units(loadedGlobal.live), world.units(ai)).map((c) => c.key);
        expect(keys).toEqual(['wi:GlobalBook:10']);

        const rebuilt = world.rebuild(loadedGlobal.live, ai, keys);
        const handle = await world.commit(loadedGlobal.target, loadedGlobal.live, rebuilt, keys);
        expect(bookStore.GlobalBook.entries[10].content).toBe('Revised global lore');

        await handle.undo();
        expect(bookStore.GlobalBook.entries[10].content).toBe('Global lore');
    });
});
