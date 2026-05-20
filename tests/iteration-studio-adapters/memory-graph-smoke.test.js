/**
 * Memory Graph schema-adapter — v2 contract smoke tests.
 *
 * NOT a full LLM-loop test. Verifies:
 *   1. The adapter object returned by `createSchemaIterationAdapter` conforms
 *      to the shell's required hook surface (v2 contract).
 *   2. `live()` returns the normalized schema array (per Task 19 the schema
 *      is an ARRAY of node-type entries, not an object).
 *   3. `normalizeToolCallToEdit` exercises one inlined tool path
 *      (`mg_schema_set_node_type`) end-to-end against a fake sandbox and
 *      emits a single coarse `set` edit at root path '' whose newValue is
 *      the mutated schema array.
 *   4. `sessionScope()` returns 'global' unconditionally.
 *
 * Mocks `iteration-studio/index.js` (heavy DOM-touching transitive imports)
 * and `utils.js` (large module with browser deps); both adapters under
 * test only need a couple of named exports from these.
 */

import { describe, test, expect, beforeAll, jest } from '@jest/globals';

// Mock heavy transitive imports. `defineAdapter` is re-routed through the
// pure `session.js` module so the v2 contract validation still runs.
jest.unstable_mockModule('../../public/scripts/iteration-studio/index.js', async () => {
    const session = await import('../../public/scripts/iteration-studio/session.js');
    return { defineAdapter: session.defineAdapter };
});

jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    escapeHtml: (s) => String(s ?? ''),
}));

const fakeContext = {
    extensionSettings: {
        memory_graph: {
            // The persisted node-type schema is an ARRAY of entries per Task 19.
            nodeTypeSchema: [
                { id: 'character_sheet', label: 'Character' },
                { id: 'event', label: 'Event' },
            ],
        },
    },
    characters: [],
    characterId: null,
};

globalThis.SillyTavern = { getContext: () => fakeContext };
globalThis.saveSettingsDebounced = () => {};

let createSchemaIterationAdapter;

beforeAll(async () => {
    ({ createSchemaIterationAdapter } = await import(
        '../../public/scripts/extensions/memory-graph/schema-adapter.js'
    ));
});

function makeDeps(overrides = {}) {
    return {
        i18n: (k) => k,
        i18nFormat: (k, ...args) => k + ':' + args.join('|'),
        normalizeNodeTypeSchema: (x) => (Array.isArray(x) ? structuredClone(x) : []),
        getEffectiveNodeTypeSchema: (_ctx, settings) => {
            const raw = settings?.nodeTypeSchema;
            return Array.isArray(raw) ? structuredClone(raw) : [];
        },
        persistCharacterSchemaOverride: async () => false,
        saveSettings: async () => {},
        refreshRootUi: () => {},
        ...overrides,
    };
}

describe('memory-graph schema adapter — v2 contract smoke', () => {
    test('has all required v2 hooks', () => {
        const a = createSchemaIterationAdapter(makeDeps());
        expect(a.id).toBe('mg_schema');
        expect(a.mode).toBe('mg_schema');
        expect(a.layout).toBe('split');
        for (const k of ['live', 'commit', 'sessionScope',
                          'listSessions', 'loadSession', 'saveSession', 'deleteSession',
                          'buildToolCatalog', 'normalizeToolCallToEdit',
                          'buildSystemPrompt', 'buildUserPrompt',
                          'renderMessageCard', 'renderHistoryItem', 'renderPreviewPane']) {
            expect(typeof a[k]).toBe('function');
        }
    });

    test('live() returns the normalized schema array', () => {
        const a = createSchemaIterationAdapter(makeDeps());
        const live = a.live();
        expect(Array.isArray(live)).toBe(true);
        expect(live).toEqual([
            { id: 'character_sheet', label: 'Character' },
            { id: 'event', label: 'Event' },
        ]);
    });

    test('sessionScope returns "global"', () => {
        const a = createSchemaIterationAdapter(makeDeps());
        expect(a.sessionScope()).toBe('global');
    });

    test('buildToolCatalog exposes the three editing tools', () => {
        const a = createSchemaIterationAdapter(makeDeps());
        const tools = a.buildToolCatalog({});
        const names = tools.map(t => t.function.name).sort();
        expect(names).toEqual([
            'mg_schema_remove_node_type',
            'mg_schema_reorder_node_types',
            'mg_schema_set_node_type',
        ]);
    });

    test('normalizeToolCallToEdit emits a coarse set edit for set_node_type', async () => {
        const a = createSchemaIterationAdapter(makeDeps());
        const before = a.live();
        const edits = await a.normalizeToolCallToEdit(
            {
                id: 't1',
                function: {
                    name: 'mg_schema_set_node_type',
                    arguments: JSON.stringify({
                        node_type: { id: 'location', label: 'Location' },
                    }),
                },
            },
            { session: {}, live: before },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits).toHaveLength(1);
        expect(edits[0]).toMatchObject({ op: 'set', path: '' });
        expect(Array.isArray(edits[0].newValue)).toBe(true);
        expect(edits[0].newValue.map(e => e.id)).toEqual(['character_sheet', 'event', 'location']);
        // oldValue must be the pre-mutation schema.
        expect(edits[0].oldValue).toEqual(before);
    });

    test('normalizeToolCallToEdit returns [] when the tool call is a no-op', async () => {
        const a = createSchemaIterationAdapter(makeDeps());
        const before = a.live();
        // remove_node_type with a non-existent id is a sandbox no-op.
        const edits = await a.normalizeToolCallToEdit(
            {
                id: 't2',
                function: {
                    name: 'mg_schema_remove_node_type',
                    arguments: JSON.stringify({ id: 'does_not_exist' }),
                },
            },
            { session: {}, live: before },
        );
        expect(edits).toEqual([]);
    });

    test('normalizeToolCallToEdit returns [] when live is not an array', async () => {
        const a = createSchemaIterationAdapter(makeDeps());
        const edits = await a.normalizeToolCallToEdit(
            { id: 't3', function: { name: 'mg_schema_set_node_type', arguments: '{}' } },
            { session: {}, live: null },
        );
        expect(edits).toEqual([]);
    });
});
