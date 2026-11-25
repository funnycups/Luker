/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

const openHostPopupSpy = jest.fn(async ({ onSubmit }) => onSubmit());

jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/popup-host.js', () => ({
    openHostPopup: openHostPopupSpy,
}));

const { runIterateTurn } = await import('../../public/scripts/workbench/model/iterate.js');
const { diffUnits } = await import('../../public/scripts/workbench/model/units.js');
const { createCardTarget } = await import('../../public/scripts/workbench/targets/card.js');
const { createWorldTarget } = await import('../../public/scripts/workbench/targets/world.js');

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function createMockRuntime({
    character = null,
    books = {},
    globalSelection = [],
    auxWorlds = {},
    chatWorlds = [],
    extensionSettings = {},
    chat = [{ is_user: true, mes: 'Earlier turn' }],
} = {}) {
    const characters = character ? [clone(character)] : [];
    const bookStore = clone(books);
    const worldInfoCache = new Map(Object.entries(bookStore).map(([k, v]) => [k, clone(v)]));

    const ctx = {
        characters,
        characterId: character ? 0 : -1,
        groupId: null,
        chat: clone(chat),
        chatMetadata: {},
        mainApi: 'openai',
        extensionSettings: clone(extensionSettings),
        chatWorldInfo: {
            globalSelection: [...globalSelection],
            getNames: () => [...chatWorlds],
        },
        getCharaFilename: (_ignored, opts = {}) => String(opts?.manualAvatarKey || '').replace(/\.[^.]+$/, ''),
        getCharaAuxWorlds: (fileName) => [...(auxWorlds[fileName] || [])],
        getWorldInfoNames: () => Object.keys(bookStore),
        loadWorldInfo: jest.fn(async (name) => (worldInfoCache.has(name) ? clone(worldInfoCache.get(name)) : null)),
        readWorldInfoDocument: jest.fn(async (name) => clone(bookStore[name])),
        saveWorldInfo: jest.fn(async (name, data) => {
            bookStore[name] = clone(data);
            worldInfoCache.set(name, clone(data));
        }),
        worldInfoCache,
        updateCharacterData: jest.fn(async (idx, patch) => {
            const c = characters[idx];
            c.data ||= {};
            for (const [k, v] of Object.entries(patch || {})) {
                if (v === undefined) delete c.data[k];
                else c.data[k] = clone(v);
            }
        }),
        writeExtensionField: jest.fn(async () => {}),
        resolveWorldInfoForMessages: jest.fn(async () => ({
            worldInfoBeforeEntries: ['Lore before'],
            worldInfoAfterEntries: [],
            worldInfoDepth: [],
            activatedEntries: [{ world: Object.keys(bookStore)[0] || 'Book', comment: 'Activated' }],
        })),
        buildPresetAwarePromptMessages: jest.fn(({ messages }) => [
            { role: 'system', content: 'Assembled system prompt' },
            ...messages,
        ]),
        generateQuietPrompt: jest.fn(async () => 'Simulated character reply.'),
        eventSource: { on: () => {}, makeLast: () => {}, removeListener: () => {} },
        eventTypes: { CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready' },
        translate: (s) => String(s ?? ''),
        getCurrentLocale: () => 'en',
    };
    return { ctx, characters, bookStore };
}

beforeEach(() => {
    openHostPopupSpy.mockClear();
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('card target v2 fields projection, validation, and commit', () => {
    test('loads, reads, str_replaces, and commits system_prompt, post_history_instructions, creator_notes, alternate_greetings without value_drifted', async () => {
        // Luker runtime character keeps the 4 v2 fields in character.data.*, NOT at root character.*
        const { ctx, characters } = createMockRuntime({
            character: {
                avatar: 'V2Card.png',
                name: 'Lyra',
                description: 'Archivist.',
                data: {
                    name: 'Lyra',
                    description: 'Archivist.',
                    system_prompt: 'Stay in first-person present tense.',
                    post_history_instructions: 'End scenes with a sensory detail.',
                    creator_notes: 'Author note: originally written for slow-burn mystery.',
                    alternate_greetings: ['Greeting alpha at the harbor.', 'Greeting beta in the archive.'],
                },
            },
        });

        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);

        // 1. Loaded live.character projects all 4 v2 fields
        expect(loaded.live.character.system_prompt).toBe('Stay in first-person present tense.');
        expect(loaded.live.character.post_history_instructions).toBe('End scenes with a sensory detail.');
        expect(loaded.live.character.creator_notes).toBe('Author note: originally written for slow-burn mystery.');
        expect(loaded.live.character.alternate_greetings).toEqual([
            'Greeting alpha at the harbor.',
            'Greeting beta in the archive.',
        ]);

        // 2. cea_read_card_fields reads all 4 without missing_fields
        const readOut = await card.runRead({
            id: 'r1',
            name: 'cea_read_card_fields',
            args: { fields: ['system_prompt', 'post_history_instructions', 'creator_notes', 'alternate_greetings'] },
        }, loaded.live);
        expect(readOut.missing_fields).toEqual([]);
        expect(readOut.system_prompt).toBe('Stay in first-person present tense.');
        expect(readOut.post_history_instructions).toBe('End scenes with a sensory detail.');
        expect(readOut.creator_notes).toBe('Author note: originally written for slow-burn mystery.');
        expect(readOut.alternate_greetings).toEqual([
            'Greeting alpha at the harbor.',
            'Greeting beta in the archive.',
        ]);

        // 3. cea_str_replace_card_field works on all 4 v2 fields (preserving string[] for alternate_greetings)
        let ai = clone(loaded.live);
        ai = await card.runEdit({
            id: 'e1',
            name: 'cea_str_replace_card_field',
            args: { field: 'system_prompt', oldString: 'first-person', newString: 'third-person' },
        }, ai);
        ai = await card.runEdit({
            id: 'e2',
            name: 'cea_str_replace_card_field',
            args: { field: 'post_history_instructions', oldString: 'sensory detail', newString: 'quiet beat' },
        }, ai);
        ai = await card.runEdit({
            id: 'e3',
            name: 'cea_str_replace_card_field',
            args: { field: 'creator_notes', oldString: 'slow-burn mystery', newString: 'maritime mystery' },
        }, ai);
        ai = await card.runEdit({
            id: 'e4',
            name: 'cea_str_replace_card_field',
            args: { field: 'alternate_greetings', oldString: 'in the archive', newString: 'on the breakwater' },
        }, ai);

        expect(ai.character.alternate_greetings).toEqual([
            'Greeting alpha at the harbor.',
            'Greeting beta on the breakwater.',
        ]);

        const keys = diffUnits(card.units(loaded.live), card.units(ai)).map((c) => c.key);
        expect(keys.sort()).toEqual([
            'card:alternate_greetings',
            'card:creator_notes',
            'card:post_history_instructions',
            'card:system_prompt',
        ]);

        // 4. Commit succeeds with zero conflicts and writes to character.data.*
        const rebuilt = card.rebuild(loaded.live, ai, keys);
        const handle = await card.commit(loaded.target, loaded.live, rebuilt, keys);
        expect(handle.skipped).toEqual([]);
        expect(handle.applied.sort()).toEqual(keys.sort());
        expect(characters[0].data.system_prompt).toBe('Stay in third-person present tense.');
        expect(characters[0].data.post_history_instructions).toBe('End scenes with a quiet beat.');
        expect(characters[0].data.creator_notes).toBe('Author note: originally written for maritime mystery.');
        expect(characters[0].data.alternate_greetings).toEqual([
            'Greeting alpha at the harbor.',
            'Greeting beta on the breakwater.',
        ]);

        // 5. Undo reverts all 4 fields cleanly in character.data.*
        await handle.undo();
        expect(characters[0].data.system_prompt).toBe('Stay in first-person present tense.');
        expect(characters[0].data.post_history_instructions).toBe('End scenes with a sensory detail.');
        expect(characters[0].data.creator_notes).toBe('Author note: originally written for slow-burn mystery.');
        expect(characters[0].data.alternate_greetings).toEqual([
            'Greeting alpha at the harbor.',
            'Greeting beta in the archive.',
        ]);
    });

    test('cea_set_card_field accepts string[] or JSON string[] for alternate_greetings and rejects non-array values cleanly', async () => {
        const { ctx } = createMockRuntime({
            character: {
                avatar: 'Alt.png',
                name: 'Alt',
                data: {
                    name: 'Alt',
                    alternate_greetings: ['Initial greeting'],
                },
            },
        });
        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);

        // Rejects plain non-array string
        await expect(card.runEdit({
            id: 'bad1',
            name: 'cea_set_card_field',
            args: { field: 'alternate_greetings', value: 'just a malformed string' },
        }, loaded.live)).rejects.toThrow(/alternate_greetings/i);

        // Rejects JSON object string
        await expect(card.runEdit({
            id: 'bad2',
            name: 'cea_set_card_field',
            args: { field: 'alternate_greetings', value: '{"not":"an array"}' },
        }, loaded.live)).rejects.toThrow(/alternate_greetings/i);

        // Rejects array with non-string items
        await expect(card.runEdit({
            id: 'bad3',
            name: 'cea_set_card_field',
            args: { field: 'alternate_greetings', value: [123, { a: 1 }] },
        }, loaded.live)).rejects.toThrow(/alternate_greetings/i);

        // Original draft remains untouched
        expect(loaded.live.character.alternate_greetings).toEqual(['Initial greeting']);

        // Accepts JSON-encoded string[]
        const next1 = await card.runEdit({
            id: 'ok1',
            name: 'cea_set_card_field',
            args: { field: 'alternate_greetings', value: '["One", "Two"]' },
        }, loaded.live);
        expect(next1.character.alternate_greetings).toEqual(['One', 'Two']);

        // Accepts native string[]
        const next2 = await card.runEdit({
            id: 'ok2',
            name: 'cea_set_card_field',
            args: { field: 'alternate_greetings', value: ['Three', 'Four'] },
        }, next1);
        expect(next2.character.alternate_greetings).toEqual(['Three', 'Four']);
    });
});

describe('multi-turn lorebook_* reads against live.lorebooks draft', () => {
    test('card target: adding/updating/removing entries in turn 1 is visible to lorebook_get/query/list in turn 2 (not stale cache)', async () => {
        const { ctx } = createMockRuntime({
            character: {
                avatar: 'Mage.png',
                name: 'Mage',
                data: { name: 'Mage', extensions: { world: 'Arcana' } },
            },
            books: {
                Arcana: {
                    entries: {
                        1: { uid: 1, comment: 'Mana', key: ['mana'], content: 'Old mana rule', disable: false },
                        2: { uid: 2, comment: 'Obsolete', key: ['obsolete'], content: 'Remove me', disable: false },
                    },
                },
            },
        });

        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);

        // Poison loadWorldInfo to prove reads do NOT touch global cache for active draft books
        ctx.loadWorldInfo.mockClear();

        let round = 0;
        const turnRes = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'add and inspect lorebook' }],
            live: clone(loaded.live),
            tools: await card.tools(loaded.live, 'character', ctx),
            isRead: (n) => card.isRead(n),
            runRead: (call, live) => card.runRead(call, live),
            runEdit: (call, live) => card.runEdit(call, live),
            request: async (messages) => {
                round++;
                if (round === 1) {
                    return {
                        text: '',
                        calls: [
                            {
                                id: 'add_1',
                                name: 'cea_add_lorebook_entry',
                                args: {
                                    book_name: 'Arcana',
                                    entry: { uid: 99, comment: 'Obsidian Spire', key: ['obsidian', 'spire'], content: 'A tower of obsidian glass.', disable: false },
                                },
                            },
                            {
                                id: 'upd_1',
                                name: 'cea_update_lorebook_entry',
                                args: { book_name: 'Arcana', uid: 1, patch: { content: 'New mana rule' } },
                            },
                            {
                                id: 'del_1',
                                name: 'cea_remove_lorebook_entry',
                                args: { book_name: 'Arcana', uid: 2 },
                            },
                        ],
                    };
                }
                if (round === 2) {
                    return {
                        text: '',
                        calls: [
                            { id: 'get_1', name: 'lorebook_get', args: { book_name: 'Arcana', uids: [99, 1, 2] } },
                            { id: 'qry_1', name: 'lorebook_query', args: { book_name: 'Arcana', text: 'obsidian' } },
                            { id: 'lst_1', name: 'lorebook_list', args: { book_name: 'Arcana' } },
                        ],
                    };
                }
                // Round 3: verify tool results fed back to the model reflect the live draft
                const toolResults = messages.filter((m) => m.role === 'tool').slice(-3).map((m) => JSON.parse(m.content));
                const [getRes, qryRes, lstRes] = toolResults;
                expect(getRes.entries.map((e) => e.uid)).toEqual([99, 1]);
                expect(getRes.entries[0].content).toBe('A tower of obsidian glass.');
                expect(getRes.entries[1].content).toBe('New mana rule');
                expect(getRes.missing_uids).toEqual([2]);
                expect(qryRes.total_hits).toBe(1);
                expect(qryRes.entries[0].uid).toBe(99);
                expect(lstRes.entries.map((e) => e.uid)).toEqual([1, 99]);
                return { text: 'Verified draft entries.', calls: [] };
            },
        });

        expect(turnRes.text).toBe('Verified draft entries.');
        expect(ctx.loadWorldInfo).not.toHaveBeenCalled();
    });

    test('world target: adding entry in turn 1 is visible to lorebook_get/query/list in turn 2', async () => {
        const { ctx } = createMockRuntime({
            books: {
                GlobalLore: {
                    entries: {
                        5: { uid: 5, comment: 'Harbor', key: ['harbor'], content: 'Foggy harbor', disable: false },
                    },
                },
            },
            globalSelection: ['GlobalLore'],
        });

        const world = createWorldTarget({ getContext: () => ctx });
        const loaded = await world.load('global', ctx);
        ctx.loadWorldInfo.mockClear();

        let round = 0;
        const turnRes = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'add and read back' }],
            live: clone(loaded.live),
            tools: await world.tools(loaded.live, 'global', ctx),
            isRead: (n) => world.isRead(n),
            runRead: (call, live) => world.runRead(call, live),
            runEdit: (call, live) => world.runEdit(call, live),
            request: async (messages) => {
                round++;
                if (round === 1) {
                    return {
                        text: '',
                        calls: [{
                            id: 'add_w',
                            name: 'cea_add_lorebook_entry',
                            args: {
                                book_name: 'GlobalLore',
                                entry: { uid: 77, comment: 'Lighthouse', key: ['beacon'], content: 'Salt-crusted beacon.', disable: false },
                            },
                        }],
                    };
                }
                if (round === 2) {
                    return {
                        text: '',
                        calls: [
                            { id: 'get_w', name: 'lorebook_get', args: { book_name: 'GlobalLore', uids: [77] } },
                            { id: 'qry_w', name: 'lorebook_query', args: { book_name: 'GlobalLore', text: 'beacon' } },
                            { id: 'lst_w', name: 'lorebook_list', args: { book_name: 'GlobalLore' } },
                            { id: 'wbl_w', name: 'world_book_list', args: {} },
                        ],
                    };
                }
                const toolResults = messages.filter((m) => m.role === 'tool').slice(-4).map((m) => JSON.parse(m.content));
                expect(toolResults[0].entries[0].content).toBe('Salt-crusted beacon.');
                expect(toolResults[1].total_hits).toBe(1);
                expect(toolResults[2].entries.map((e) => e.uid)).toEqual([5, 77]);
                expect(toolResults[3].books).toEqual(['GlobalLore']);
                return { text: 'Done.', calls: [] };
            },
        });

        expect(turnRes.text).toBe('Done.');
        expect(ctx.loadWorldInfo).not.toHaveBeenCalled();
    });
});

describe('card.runEdit book_name validation', () => {
    test('omitting book_name when 2+ books exist throws explicit missing book_name error and never mutates live.lorebooks[undefined]', async () => {
        const { ctx } = createMockRuntime({
            character: {
                avatar: 'Multi.png',
                name: 'Multi',
                data: { name: 'Multi', extensions: { world: 'BookOne' } },
            },
            books: {
                BookOne: { entries: { 1: { uid: 1, key: ['a'], content: 'alpha' } } },
                BookTwo: { entries: { 1: { uid: 1, key: ['b'], content: 'beta' } } },
            },
            auxWorlds: { Multi: ['BookTwo'] },
        });

        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);
        const snapshotBefore = clone(loaded.live);

        await expect(card.runEdit({
            id: 'missing_book_1',
            name: 'cea_update_lorebook_entry',
            args: { uid: 1, patch: { content: 'mutated' } },
        }, loaded.live)).rejects.toThrow(/missing book_name/i);

        await expect(card.runEdit({
            id: 'missing_book_2',
            name: 'cea_add_lorebook_entry',
            args: { entry: { uid: 2, key: ['x'], content: 'new' } },
        }, loaded.live)).rejects.toThrow(/missing book_name/i);

        // Unknown / phantom book is also rejected
        await expect(card.runEdit({
            id: 'unknown_book',
            name: 'cea_add_lorebook_entry',
            args: { book_name: 'PhantomBook', entry: { uid: 2, key: ['x'], content: 'new' } },
        }, loaded.live)).rejects.toThrow(/BookOne/);

        // cea_str_replace_lorebook_entry_field must validate book_name BEFORE normalizeToolCallToEdit
        // (must throw missing book_name / allowed books, NOT not_found anchor miss)
        await expect(card.runEdit({
            id: 'missing_book_str_replace',
            name: 'cea_str_replace_lorebook_entry_field',
            args: { uid: 1, field: 'content', oldString: 'alpha', newString: 'omega' },
        }, loaded.live)).rejects.toThrow(/missing book_name/i);

        await expect(card.runEdit({
            id: 'unknown_book_str_replace',
            name: 'cea_str_replace_lorebook_entry_field',
            args: { book_name: 'PhantomBook', uid: 1, field: 'content', oldString: 'alpha', newString: 'omega' },
        }, loaded.live)).rejects.toThrow(/BookOne/);

        expect(Object.keys(loaded.live.lorebooks)).toEqual(['BookOne', 'BookTwo']);
        expect(loaded.live).toEqual(snapshotBefore);
    });
});

describe('review fixes: error propagation, bookName rejection, and null read unwrapping', () => {
    test('card.load and world.load propagate loadWorldInfo failures instead of silently skipping unreadable books', async () => {
        const { ctx } = createMockRuntime({
            character: {
                avatar: 'Broken.png',
                name: 'Broken',
                data: { name: 'Broken', extensions: { world: 'MissingBook' } },
            },
            books: {},
            globalSelection: ['MissingBook'],
        });
        ctx.loadWorldInfo.mockRejectedValue(new Error('disk read failure'));

        const card = createCardTarget({ getContext: () => ctx });
        await expect(card.load('character', ctx)).rejects.toMatchObject({ code: 'read-failed' });

        const world = createWorldTarget({ getContext: () => ctx });
        await expect(world.load('global', ctx)).rejects.toMatchObject({ code: 'read-failed' });

        // Returning null for a bound book must also throw rather than silently omitting it
        ctx.loadWorldInfo.mockResolvedValue(null);
        await expect(card.load('character', ctx)).rejects.toMatchObject({ code: 'read-failed' });
        await expect(world.load('global', ctx)).rejects.toMatchObject({ code: 'read-failed' });
    });

    test('cea_set_lorebook_metadata with key === "bookName" rejects immediately instead of returning a no-op pending_review', async () => {
        const { ctx } = createMockRuntime({
            character: {
                avatar: 'Meta.png',
                name: 'Meta',
                data: { name: 'Meta', extensions: { world: 'BookM' } },
            },
            books: { BookM: { entries: {} } },
            globalSelection: ['BookM'],
        });
        const card = createCardTarget({ getContext: () => ctx });
        const cardLoaded = await card.load('character', ctx);
        await expect(card.runEdit({
            id: 'meta_1',
            name: 'cea_set_lorebook_metadata',
            args: { book_name: 'BookM', key: 'bookName', value: 'Renamed' },
        }, cardLoaded.live)).rejects.toThrow(/bookName/i);

        const world = createWorldTarget({ getContext: () => ctx });
        const worldLoaded = await world.load('global', ctx);
        await expect(world.runEdit({
            id: 'meta_2',
            name: 'cea_set_lorebook_metadata',
            args: { book_name: 'BookM', key: 'bookName', value: 'Renamed' },
        }, worldLoaded.live)).rejects.toThrow(/bookName/i);
    });

    test('card.runRead unwraps result: null cleanly without leaking the { ok, result } wrapper', async () => {
        const { ctx } = createMockRuntime({
            character: {
                avatar: 'PresetRead.png',
                name: 'PresetRead',
                data: { name: 'PresetRead', extensions: {} },
            },
        });
        ctx.character = {
            presets: {
                list: () => [],
                get: () => null,
            },
        };
        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);
        const res = await card.runRead({
            id: 'insp_1',
            name: 'inspect_bound_preset',
            args: { action: 'get', name: 'NonExistent' },
        }, loaded.live);
        expect(res).toBeNull();
    });
});

describe('simulate_prompt & custom CEA prompts', () => {
    test('simulate_prompt invokes openSimulationReview cleanly in both card and world targets', async () => {
        const { ctx } = createMockRuntime({
            character: {
                avatar: 'Sim.png',
                name: 'Sim',
                data: { name: 'Sim', extensions: { world: 'SimBook' } },
            },
            books: {
                SimBook: { entries: { 1: { uid: 1, key: ['hello'], content: 'Sim lore' } } },
            },
            globalSelection: ['SimBook'],
        });

        const card = createCardTarget({ getContext: () => ctx });
        const cardLoaded = await card.load('character', ctx);
        expect(card.isRead('simulate_prompt')).toBe(true);
        const cardSim = await card.runRead({ id: 's1', name: 'simulate_prompt', args: { text: 'Hello Sim' } }, cardLoaded.live);
        expect(openHostPopupSpy).toHaveBeenCalledTimes(1);
        expect(String(cardSim)).toContain('<simulation_result kind="cea"');
        expect(String(cardSim)).toContain('Simulated character reply.');

        const world = createWorldTarget({ getContext: () => ctx });
        const worldLoaded = await world.load('global', ctx);
        expect(world.isRead('simulate_prompt')).toBe(true);
        const worldSim = await world.runRead({ id: 's2', name: 'simulate_prompt', args: { text: 'Hello World' } }, worldLoaded.live);
        expect(openHostPopupSpy).toHaveBeenCalledTimes(2);
        expect(String(worldSim)).toContain('<simulation_result kind="cea"');
        expect(String(worldSim)).toContain('Simulated character reply.');
    });

    test('honors custom extensionSettings.character_editor_assistant.editorIterationSystemPrompt and exposes getNativeAi', async () => {
        const { ctx } = createMockRuntime({
            character: {
                avatar: 'PromptChar.png',
                name: 'PromptChar',
                data: { name: 'PromptChar', extensions: { world: 'Book1' } },
            },
            books: { Book1: { entries: {} } },
            extensionSettings: {
                character_editor_assistant: {
                    editorIterationSystemPrompt: 'CUSTOM CEA ITERATION PROMPT',
                    requestApiPresetName: 'MyConn',
                    requestLlmPresetName: 'MyPreset',
                },
            },
        });

        const card = createCardTarget({ getContext: () => ctx });
        const world = createWorldTarget({ getContext: () => ctx });

        const cardLoaded = await card.load('character', ctx);
        const worldLoaded = await world.load('character', ctx);

        expect(await card.prompt(cardLoaded.live, 'character', ctx)).toBe('CUSTOM CEA ITERATION PROMPT');
        const worldPrompt = await world.prompt(worldLoaded.live, 'character', ctx);
        expect(worldPrompt).toContain('CUSTOM CEA ITERATION PROMPT');
        expect(worldPrompt).toContain('Book1');

        const cardInfo = await card.promptInfo(ctx);
        expect(cardInfo.custom).toBe(true);
        expect(cardInfo.text).toBe('CUSTOM CEA ITERATION PROMPT');

        const worldInfo = await world.promptInfo(ctx);
        expect(worldInfo.custom).toBe(true);
        expect(worldInfo.text).toContain('CUSTOM CEA ITERATION PROMPT');

        expect(card.getNativeAi(ctx)).toEqual({ connection: 'MyConn', preset: 'MyPreset' });
        expect(world.getNativeAi(ctx)).toEqual({ connection: 'MyConn', preset: 'MyPreset' });
    });

    test('in-flight card.runRead uses captured session target avatar even after live character switches', async () => {
        const { ctx } = createMockRuntime({
            character: {
                avatar: 'Alice.png',
                name: 'Alice',
                data: { name: 'Alice', extensions: { world: 'AliceBook' } },
            },
            books: {
                AliceBook: { entries: {} },
                AliceAux: { entries: {} },
                BobBook: { entries: {} },
                BobAux: { entries: {} },
            },
            auxWorlds: { Alice: ['AliceAux'], Bob: ['BobAux'] },
        });
        ctx.characters.push({
            avatar: 'Bob.png',
            name: 'Bob',
            data: { name: 'Bob', extensions: { world: 'BobBook' } },
        });
        ctx.character = {
            presets: {
                list: (ch) => (ch?.avatar === 'Alice.png' ? [{ name: 'AlicePreset', isDefault: true, preset: {} }] : [{ name: 'BobPreset', isDefault: true, preset: {} }]),
                get: () => null,
            },
        };

        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);

        // User switches active character to Bob mid-turn
        ctx.characterId = 1;

        const booksOut = await card.runRead(
            { id: 'wbl_1', name: 'world_book_list', args: {} },
            loaded.live,
            { target: loaded.target },
        );
        expect(booksOut.books).toContain('AliceBook');
        expect(booksOut.books).toContain('AliceAux');
        expect(booksOut.books).not.toContain('BobBook');
        expect(booksOut.books).not.toContain('BobAux');

        const presetOut = await card.runRead(
            { id: 'insp_2', name: 'inspect_bound_preset', args: { action: 'list' } },
            loaded.live,
            { target: loaded.target },
        );
        expect(presetOut).toEqual([{ name: 'AlicePreset', isDefault: true, hasBody: true }]);
    });

    test('card target draft lorebook_query returns all >20 matches when limit is omitted and honors limit > 20', async () => {
        const entries = {};
        for (let i = 0; i < 28; i++) {
            entries[i] = { uid: i, comment: `rule-${i}`, key: ['rule'], content: `Body ${i}`, disable: false };
        }
        const { ctx } = createMockRuntime({
            character: {
                avatar: 'Many.png',
                name: 'Many',
                data: { name: 'Many', extensions: { world: 'BigLore' } },
            },
            books: { BigLore: { entries } },
        });
        const card = createCardTarget({ getContext: () => ctx });
        const loaded = await card.load('character', ctx);

        const allRes = await card.runRead(
            { id: 'q_all', name: 'lorebook_query', args: { book_name: 'BigLore', text: 'rule' } },
            loaded.live,
            { target: loaded.target },
        );
        expect(allRes.total_hits).toBe(28);
        expect(allRes.entries).toHaveLength(28);

        const lim25 = await card.runRead(
            { id: 'q_25', name: 'lorebook_query', args: { book_name: 'BigLore', text: 'rule', limit: 25 } },
            loaded.live,
            { target: loaded.target },
        );
        expect(lim25.total_hits).toBe(28);
        expect(lim25.entries).toHaveLength(25);
    });
});
