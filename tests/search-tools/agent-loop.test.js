// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { loadManagedEntries, resetFloorStateInstanceForTesting } from '../../public/scripts/extensions/search-tools/persistence.js';

function makeLorebookContext() {
    const books = { __SEARCH_TOOLS__: { entries: {} } };
    let floorState = { entries: {} };
    const context = {
        eventSource: { on() {} },
        eventTypes: {},
        constants: { promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 }, wiPosition: {} },
        getRequestHeaders: () => ({}),
        saveSettings: () => {},
        saveSettingsDebounced: () => {},
        extensionSettings: { search_tools: {} },
        secrets: { KEYS: {}, state: {} },
        escapeHtml: (s) => String(s ?? ''),
        getStringHash: (s) => String(s).length,
        worldInfoEntry: { template: {}, setGlobalSelection: async () => false },
        POPUP_TYPE: {},
        Popup: class {},
        translate: (s) => String(s ?? ''),
        addLocaleData: () => {},
        chat: [],
        loadWorldInfo: async (name) => (books[name] ? structuredClone(books[name]) : null),
        saveWorldInfo: async (name, data) => { books[name] = structuredClone(data); },
        createFloorState: async () => ({
            ready: async () => ({ ok: true }),
            get: async () => ({ ok: true, state: structuredClone(floorState) }),
            update: async (reducer) => {
                floorState = reducer(structuredClone(floorState));
                return { ok: true };
            },
        }),
    };
    return {
        context,
        books,
        getFloorState: () => structuredClone(floorState),
    };
}

globalThis.Luker = { getContext: () => makeLorebookContext().context };

// main.js transitively imports browser-only modules (`profile-resolver.js` ->
// `openai.js` -> `textgen-models.js`, and `settings-ui.js` -> `preset-help.js`)
// that touch `document` at load time. Stub those two edges so the module graph
// loads under the node test environment.
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: async () => [],
}));
jest.unstable_mockModule('../../public/scripts/extensions/preset-help.js', () => ({
    renderPresetHelpButton: () => '',
}));

let mod;
beforeAll(async () => {
    mod = await import('../../public/scripts/extensions/search-tools/main.js');
});

beforeEach(() => {
    resetFloorStateInstanceForTesting();
});

function scriptedContext(responses) {
    const { context, books, getFloorState } = makeLorebookContext();
    context.chat = structuredClone(payload.coreChat);
    let i = 0;
    context.generateTask = jest.fn(async () => {
        const r = responses[Math.min(i, responses.length - 1)];
        i += 1;
        if (r.throws) {
            throw new Error(r.throws);
        }
        return {
            toolCalls: r.toolCalls || [],
            assistantText: r.assistantText || '',
        };
    });
    return { context, books, getFloorState, callCount: () => i };
}

const settings = { agentSystemPrompt: '', agentPresetName: '', agentApiPresetName: '', includeWorldInfoWithPreset: false, toolCallRetryMax: 0, lorebookPosition: 0, lorebookDepth: 9999, lorebookRole: 0, lorebookEntryOrder: 9800 };
const payload = { type: 'normal', coreChat: [{ is_user: true, mes: 'who is X' }], signal: null };

describe('search agent program-driven loop', () => {
    test('stops when a round returns no tool calls', async () => {
        const { context, callCount } = scriptedContext([
            { toolCalls: [{ name: 'luker_search_agent_upsert_lorebook_entry', args: { entry_id: 'x', title: 'X', content: 'body', always_inject: true } }] },
            { toolCalls: [], assistantText: 'done' },
        ]);
        const result = await mod.runPreRequestSearchAgent(context, settings, payload);
        expect(callCount()).toBe(2);
        expect(result.mutationCount).toBe(1);
    });

    test('has no round cap: keeps going while tool calls keep arriving', async () => {
        const responses = [];
        for (let n = 0; n < 12; n += 1) {
            responses.push({ toolCalls: [{ name: 'luker_search_agent_get_lorebook_entries', args: { entry_ids: ['x'] } }] });
        }
        responses.push({ toolCalls: [], assistantText: 'stop' });
        const { context, callCount } = scriptedContext(responses);
        await mod.runPreRequestSearchAgent(context, settings, payload);
        expect(callCount()).toBe(13);
    });

    test('commits entries written before a later round fails', async () => {
        const { context, books, getFloorState } = scriptedContext([
            { toolCalls: [{ name: 'luker_search_agent_upsert_lorebook_entry', args: { entry_id: 'x', title: 'X', content: 'body', always_inject: true } }] },
            { throws: 'Model response did not contain any matching tool calls.' },
        ]);
        await expect(mod.runPreRequestSearchAgent(context, settings, payload))
            .rejects.toThrow('Model response did not contain any matching tool calls.');
        const committed = getFloorState();
        expect(committed.entries.x).toBeTruthy();
        expect(String(committed.entries.x.content || '')).toContain('body');
        const persisted = await loadManagedEntries(context);
        expect(persisted.x).toBeTruthy();
        expect(String(persisted.x.content || '')).toContain('body');
        const entries = Object.values(books.__SEARCH_TOOLS__?.entries || {});
        expect(entries.some(entry => String(entry?.content || '').includes('body'))).toBe(true);
    });

    test('buildAgentTools exposes no finalize tool', () => {
        const names = mod.buildAgentTools().map((t) => t.function.name);
        expect(names).not.toContain('luker_search_agent_finalize');
    });
});
