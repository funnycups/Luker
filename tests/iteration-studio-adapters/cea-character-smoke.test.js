/**
 * CEA Character Editor adapter — v2 contract smoke tests.
 *
 * NOT a full LLM-loop test. Verifies:
 *   1. The adapter object returned by `createCharacterEditorAdapter` conforms
 *      to the shell's required hook surface (v2 contract) and additionally
 *      exposes `registerCustomOps` (wired in by Task 1 of SP-3).
 *   2. `sessionScope()` returns a per-character key (`char_<avatar>`).
 *   3. `live()` returns `{ card, lorebook }` with uid-keyed entries.
 *   4. `live()` returns fresh deep-cloned data on every call so callers can
 *      mutate the returned value without affecting subsequent reads.
 *
 * Mocks `iteration-studio/index.js` (heavy DOM-touching transitive imports)
 * and `utils.js` (large module with browser deps), routing through pure
 * session.js / studio.js for the bits we still need (`defineAdapter`,
 * `makeCustomOpsRegistryFacade`). Mirrors the memory-graph-smoke pattern.
 */

import { describe, test, expect, beforeAll, jest } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/iteration-studio/index.js', async () => {
    const session = await import('../../public/scripts/iteration-studio/session.js');
    return {
        defineAdapter: session.defineAdapter,
    };
});
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    escapeHtml: (s) => String(s ?? ''),
}));

let createCharacterEditorAdapter;

function makeDeps(overrides = {}) {
    const persisted = { card: { name: 'Alice', description: 'desc' }, lorebookData: { entries: { 17: { uid: 17, content: 'White rabbit' } } } };
    const calls = { card: [], lorebook: [] };
    return {
        avatar: 'alice.png',
        i18n: (s) => s,
        i18nFormat: (s) => s,
        escapeHtml: (s) => String(s ?? ''),
        // Read helpers
        readCard: () => structuredClone(persisted.card),
        readLorebook: async () => ({ bookName: 'Wonderland', ...structuredClone(persisted.lorebookData) }),
        // Write helpers
        mergeCharacterAttributes: async (_ctx, _avatar, patch) => { Object.assign(persisted.card, patch); calls.card.push(patch); },
        saveLorebook: async (bookName, data) => { persisted.lorebookData = structuredClone(data); calls.lorebook.push({ bookName, data }); },
        // Session storage
        getSettings: () => ({ characterEditorSessionsV2: {} }),
        saveSettingsDebounced: () => {},
        getContext: () => ({ characterId: 0, characters: [{ avatar: 'alice.png' }] }),
        renderConversationItem: (m) => `<div>${m.content || ''}</div>`,
        ...overrides,
        _persisted: persisted,
        _calls: calls,
    };
}

beforeAll(async () => {
    globalThis.SillyTavern = { getContext: () => ({ characterId: 0, characters: [{ avatar: 'alice.png' }] }) };
    globalThis.saveSettingsDebounced = () => {};
    const mod = await import('../../public/scripts/extensions/character-editor-assistant/character-editor-adapter.js');
    createCharacterEditorAdapter = mod.createCharacterEditorAdapter;
});

describe('CEA Character Editor adapter — contract surface', () => {
    test('exposes all required v2 hooks + registerCustomOps', () => {
        const a = createCharacterEditorAdapter(makeDeps());
        for (const k of [
            'id', 'title', 'mode', 'layout', 'live', 'commit', 'sessionScope',
            'listSessions', 'loadSession', 'saveSession', 'deleteSession',
            'buildToolCatalog', 'normalizeToolCallToEdit',
            'buildSystemPrompt', 'buildUserPrompt',
            'renderMessageCard', 'renderHistoryItem', 'renderPreviewPane',
            'renderToolbarSlots', 'handleAction',
            'registerCustomOps',
        ]) {
            expect(a[k]).toBeDefined();
        }
        expect(a.layout).toBe('split');
        expect(a.id).toMatch(/^cea_character/);
    });

    test('sessionScope is per-character (avatar-based)', () => {
        const a = createCharacterEditorAdapter(makeDeps());
        expect(a.sessionScope()).toMatch(/^char_/);
    });
});

describe('CEA Character Editor adapter — live()', () => {
    test('live() returns { card, lorebook } with uid-keyed entries', async () => {
        const a = createCharacterEditorAdapter(makeDeps());
        const live = await a.live();
        expect(live.card.name).toBe('Alice');
        expect(live.lorebook.bookName).toBe('Wonderland');
        expect(live.lorebook.entries[17].content).toBe('White rabbit');
    });

    test('live() returns fresh copies (mutation does not propagate)', async () => {
        const deps = makeDeps();
        const a = createCharacterEditorAdapter(deps);
        const live = await a.live();
        live.card.name = 'Mutated';
        live.lorebook.entries[17].content = 'Mutated content';
        const live2 = await a.live();
        expect(live2.card.name).toBe('Alice');
        expect(live2.lorebook.entries[17].content).toBe('White rabbit');
    });
});

describe('CEA Character Editor adapter — buildToolCatalog + normalizeToolCallToEdit', () => {
    const callOf = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

    test('buildToolCatalog exposes 6 cea_* tools', () => {
        const a = createCharacterEditorAdapter(makeDeps());
        const tools = a.buildToolCatalog({});
        expect(tools).toHaveLength(6);
        const names = tools.map(t => t.function?.name).sort();
        expect(names).toEqual([
            'cea_add_lorebook_entry',
            'cea_remove_lorebook_entry',
            'cea_set_card_field',
            'cea_set_lorebook_metadata',
            'cea_str_replace_card_field',
            'cea_update_lorebook_entry',
        ]);
    });

    test('every tool def is a JSON-schema function with object parameters', () => {
        const a = createCharacterEditorAdapter(makeDeps());
        const tools = a.buildToolCatalog({});
        for (const tool of tools) {
            expect(tool.type).toBe('function');
            expect(tool.function).toBeDefined();
            expect(typeof tool.function.name).toBe('string');
            expect(typeof tool.function.description).toBe('string');
            expect(tool.function.parameters?.type).toBe('object');
            expect(tool.function.parameters?.properties).toBeDefined();
            expect(Array.isArray(tool.function.parameters?.required)).toBe(true);
        }
    });

    test('cea_set_card_field emits set on card.<field> capturing oldValue from live', async () => {
        const a = createCharacterEditorAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            callOf('cea_set_card_field', { field: 'description', value: 'New desc' }),
            { live, session: {} },
        );
        expect(edits).toEqual([
            { op: 'set', path: 'card.description', oldValue: 'desc', newValue: 'New desc' },
        ]);
    });

    test('cea_str_replace_card_field emits str_replace on card.<field>', async () => {
        const a = createCharacterEditorAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            callOf('cea_str_replace_card_field', { field: 'description', find: 'desc', replace: 'description' }),
            { live, session: {} },
        );
        expect(edits).toEqual([
            { op: 'str_replace', path: 'card.description', find: 'desc', replace: 'description' },
        ]);
    });

    test('cea_add_lorebook_entry emits lorebook_entry_add keyed by entry.uid', async () => {
        const a = createCharacterEditorAdapter(makeDeps());
        const live = await a.live();
        const newEntry = { uid: 42, key: ['queen'], content: 'Queen of Hearts', comment: '' };
        const edits = await a.normalizeToolCallToEdit(
            callOf('cea_add_lorebook_entry', { entry: newEntry }),
            { live, session: {} },
        );
        expect(edits).toEqual([{
            op: 'lorebook_entry_add',
            path: 'lorebook.entries',
            uid: 42,
            entry: newEntry,
        }]);
    });

    test('cea_update_lorebook_entry captures before from only patched fields', async () => {
        const a = createCharacterEditorAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            callOf('cea_update_lorebook_entry', { uid: 17, patch: { content: 'New content' } }),
            { live, session: {} },
        );
        expect(edits).toHaveLength(1);
        expect(edits[0]).toMatchObject({
            op: 'lorebook_entry_update',
            path: 'lorebook.entries',
            uid: 17,
            patch: { content: 'New content' },
        });
        // before captures ONLY the patched fields, from live state
        expect(edits[0].before).toEqual({ content: 'White rabbit' });
        // Ensure unrelated fields are NOT captured in before
        expect(Object.keys(edits[0].before)).toEqual(['content']);
    });

    test('cea_update_lorebook_entry: multi-field patch captures all patched fields in before', async () => {
        const deps = makeDeps();
        // Add comment to the seeded entry for this test
        deps._persisted.lorebookData.entries[17].comment = 'original-comment';
        const a = createCharacterEditorAdapter(deps);
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            callOf('cea_update_lorebook_entry', {
                uid: 17,
                patch: { content: 'NEW', comment: 'NEW_COMMENT' },
            }),
            { live, session: {} },
        );
        expect(edits[0].before).toEqual({
            content: 'White rabbit',
            comment: 'original-comment',
        });
    });

    test('cea_remove_lorebook_entry captures full entry snapshot from live', async () => {
        const a = createCharacterEditorAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            callOf('cea_remove_lorebook_entry', { uid: 17 }),
            { live, session: {} },
        );
        expect(edits).toHaveLength(1);
        expect(edits[0]).toMatchObject({
            op: 'lorebook_entry_remove',
            path: 'lorebook.entries',
            uid: 17,
        });
        // Full entry snapshot at the moment of normalization
        expect(edits[0].entry).toEqual({ uid: 17, content: 'White rabbit' });
        // The snapshot must be a clone (not the live entry)
        expect(edits[0].entry).not.toBe(live.lorebook.entries[17]);
    });

    test('cea_set_lorebook_metadata emits set on lorebook.<key>', async () => {
        const a = createCharacterEditorAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            callOf('cea_set_lorebook_metadata', { key: 'bookName', value: 'Underland' }),
            { live, session: {} },
        );
        expect(edits).toEqual([
            { op: 'set', path: 'lorebook.bookName', oldValue: 'Wonderland', newValue: 'Underland' },
        ]);
    });

    test('malformed JSON args returns null', async () => {
        const a = createCharacterEditorAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            { function: { name: 'cea_set_card_field', arguments: '{not json' } },
            { live, session: {} },
        );
        expect(edits).toBeNull();
    });

    test('unknown tool name returns empty array', async () => {
        const a = createCharacterEditorAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            callOf('cea_does_not_exist', { foo: 'bar' }),
            { live, session: {} },
        );
        expect(edits).toEqual([]);
    });
});

describe('CEA Character Editor adapter — commit()', () => {
    test('commit calls mergeCharacterAttributes with card diff only', async () => {
        const deps = makeDeps();
        const a = createCharacterEditorAdapter(deps);
        await a.live();  // prime snapshot
        await a.commit({
            card: { name: 'Alice', description: 'NEW DESC' },
            lorebook: { bookName: 'Wonderland', entries: { 17: { uid: 17, content: 'White rabbit' } } },
        });
        expect(deps._calls.card).toHaveLength(1);
        expect(deps._calls.card[0]).toEqual({ description: 'NEW DESC' });   // only changed fields
    });

    test('commit calls saveLorebook only when lorebook changed', async () => {
        const deps = makeDeps();
        const a = createCharacterEditorAdapter(deps);
        await a.live();
        await a.commit({
            card: { name: 'Alice', description: 'desc' },   // unchanged
            lorebook: { bookName: 'Wonderland', entries: { 17: { uid: 17, content: 'White rabbit' }, 42: { uid: 42, content: 'New' } } },
        });
        expect(deps._calls.card).toHaveLength(0);
        expect(deps._calls.lorebook).toHaveLength(1);
        expect(deps._calls.lorebook[0].data.entries[42].content).toBe('New');
    });

    test('commit no-op when nothing changed', async () => {
        const deps = makeDeps();
        const a = createCharacterEditorAdapter(deps);
        await a.live();
        const live = await a.live();
        await a.commit(live);
        expect(deps._calls.card).toHaveLength(0);
        expect(deps._calls.lorebook).toHaveLength(0);
    });
});

describe('CEA Character Editor adapter — session storage', () => {
    function withSettings(extra = {}) {
        const settings = { popupSessionsV2: {} };
        const saveCalls = { count: 0 };
        return makeDeps({
            getSettings: () => settings,
            saveSettingsDebounced: () => { saveCalls.count += 1; },
            _settings: settings,
            _saveCalls: saveCalls,
            ...extra,
        });
    }

    test('saveSession persists into settings.popupSessionsV2[scope]', async () => {
        const deps = withSettings();
        const a = createCharacterEditorAdapter(deps);
        const scope = a.sessionScope();
        await a.saveSession(scope, { id: 's1', title: 'first', updatedAt: 100, messages: [] });
        expect(deps._settings.popupSessionsV2[scope].s1.id).toBe('s1');
        expect(deps._saveCalls.count).toBe(1);
    });

    test('listSessions returns meta sorted by updatedAt desc', async () => {
        const deps = withSettings();
        const a = createCharacterEditorAdapter(deps);
        const scope = a.sessionScope();
        await a.saveSession(scope, { id: 'a', title: 'A', updatedAt: 100, messages: [] });
        await a.saveSession(scope, { id: 'b', title: 'B', updatedAt: 200, messages: [] });
        const list = await a.listSessions(scope);
        expect(list.map(s => s.id)).toEqual(['b', 'a']);
    });

    test('loadSession returns a clone (mutation does not affect storage)', async () => {
        const deps = withSettings();
        const a = createCharacterEditorAdapter(deps);
        const scope = a.sessionScope();
        await a.saveSession(scope, { id: 's1', title: 't', updatedAt: 0, messages: [{ role: 'user', content: 'hi' }] });
        const loaded = await a.loadSession(scope, 's1');
        loaded.messages[0].content = 'mutated';
        const reloaded = await a.loadSession(scope, 's1');
        expect(reloaded.messages[0].content).toBe('hi');
    });

    test('deleteSession removes from settings', async () => {
        const deps = withSettings();
        const a = createCharacterEditorAdapter(deps);
        const scope = a.sessionScope();
        await a.saveSession(scope, { id: 's1', title: 't', updatedAt: 0, messages: [] });
        await a.deleteSession(scope, 's1');
        const list = await a.listSessions(scope);
        expect(list).toEqual([]);
    });
});

describe('CEA Character Editor adapter — clearObsoleteSessions', () => {
    test('wipes lorebookSyncHistory and any pre-v2 session bucket, preserves V2', async () => {
        const settings = {
            lorebookSyncHistory: { something: 'legacy' },
            popupSessions: { 'char_alice.png': { old: {} } },   // pre-v2 if it existed
            popupSessionsV2: { 'char_alice.png': { keep: { id: 'keep' } } },
        };
        const saveCalls = { count: 0 };
        const deps = makeDeps({
            getSettings: () => settings,
            saveSettingsDebounced: () => { saveCalls.count += 1; },
        });
        const a = createCharacterEditorAdapter(deps);
        await a.clearObsoleteSessions(a.sessionScope());
        expect(settings.lorebookSyncHistory).toBeUndefined();
        expect(settings.popupSessions).toBeUndefined();
        expect(settings.popupSessionsV2['char_alice.png'].keep.id).toBe('keep');   // V2 preserved
        expect(saveCalls.count).toBe(1);
    });
});

describe('CEA Character Editor adapter — prompts', () => {
    test('buildSystemPrompt mentions the three surfaces and cea_* tools', () => {
        const a = createCharacterEditorAdapter(makeDeps());
        const sys = a.buildSystemPrompt({});
        expect(typeof sys).toBe('string');
        expect(sys.length).toBeGreaterThan(0);
        // Names the three editable surfaces
        expect(sys).toMatch(/card/i);
        expect(sys).toMatch(/lorebook/i);
        // Mentions the cea_* tool family
        expect(sys).toContain('cea_');
    });

    test('buildUserPrompt is a pass-through of userText', () => {
        const a = createCharacterEditorAdapter(makeDeps());
        expect(a.buildUserPrompt({}, 'hello world', {})).toBe('hello world');
    });
});

describe('CEA Character Editor adapter — renders + actions', () => {
    function makeDepsWithRealEscape(overrides = {}) {
        return makeDeps({
            escapeHtml: (s) => String(s ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;'),
            ...overrides,
        });
    }

    test('renderMessageCard escapes content', () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const html = a.renderMessageCard({ role: 'user', content: '<x>' }, {});
        expect(html).toContain('&lt;x&gt;');
        expect(html).toContain('luker-studio-message-user');
    });

    test('renderMessageCard includes applied-edits summary when present', () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const html = a.renderMessageCard({
            role: 'assistant',
            content: 'ok',
            appliedEdits: [{ op: 'set' }, { op: 'set' }],
        }, {});
        expect(html).toContain('2');
        expect(html).toContain('luker-studio-message-edits');
    });

    test('renderMessageCard omits edits summary when none', () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const html = a.renderMessageCard({ role: 'assistant', content: 'plain' }, {});
        expect(html).not.toContain('luker-studio-message-edits');
    });

    test('renderHistoryItem includes load-history action + id + escaped title', () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const html = a.renderHistoryItem({ id: 's1', title: 'My <session>', updatedAt: 'now' });
        expect(html).toContain('data-iter-action="load-history"');
        expect(html).toContain('data-id="s1"');
        expect(html).toContain('My &lt;session&gt;');
        expect(html).toContain('now');
    });

    test('renderPreviewPane shows card tab by default with active class', () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const html = a.renderPreviewPane({
            session: { surfaceState: {} },
            live: { card: { name: 'Alice', description: 'd' }, lorebook: { entries: {} } },
        });
        expect(html).toContain('Card fields');
        expect(html).toContain('Alice');
        expect(html).toContain('class="active"');
    });

    test('renderPreviewPane has three tab buttons with cea-tab-* actions', () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const html = a.renderPreviewPane({
            session: { surfaceState: {} },
            live: { card: {}, lorebook: { entries: {} } },
        });
        expect(html).toContain('data-iter-action="cea-tab-card"');
        expect(html).toContain('data-iter-action="cea-tab-lorebook"');
        expect(html).toContain('data-iter-action="cea-tab-diff"');
    });

    test('renderPreviewPane lorebook tab lists entries by uid', () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const html = a.renderPreviewPane({
            session: { surfaceState: { activeTab: 'lorebook' } },
            live: {
                card: {},
                lorebook: { entries: { 17: { uid: 17, content: 'White rabbit' } } },
            },
        });
        expect(html).toContain('uid 17');
        expect(html).toContain('White rabbit');
        expect(html).toContain('cea_character_entry');
    });

    test('renderPreviewPane diff tab shows placeholder', () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const html = a.renderPreviewPane({
            session: { surfaceState: { activeTab: 'diff' } },
            live: { card: {}, lorebook: { entries: {} } },
        });
        expect(html).toContain('cea_character_diff_placeholder');
        expect(html).toContain('Pick a reference');
    });

    test('renderPreviewPane card fields escape values', () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const html = a.renderPreviewPane({
            session: { surfaceState: {} },
            live: { card: { description: '<script>' }, lorebook: { entries: {} } },
        });
        expect(html).toContain('&lt;script&gt;');
    });

    test('renderToolbarSlots returns object with slots (end/start ok)', () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const slots = a.renderToolbarSlots({ session: { surfaceState: {} } });
        expect(slots).toBeDefined();
        expect(typeof slots).toBe('object');
    });

    test('handleAction switches activeTab to lorebook in surfaceState', async () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const session = { surfaceState: {} };
        await a.handleAction('cea-tab-lorebook', { session, root: null });
        expect(session.surfaceState.activeTab).toBe('lorebook');
    });

    test('handleAction switches activeTab to card', async () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const session = { surfaceState: { activeTab: 'lorebook' } };
        await a.handleAction('cea-tab-card', { session, root: null });
        expect(session.surfaceState.activeTab).toBe('card');
    });

    test('handleAction switches activeTab to diff', async () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const session = { surfaceState: {} };
        await a.handleAction('cea-tab-diff', { session, root: null });
        expect(session.surfaceState.activeTab).toBe('diff');
    });

    test('handleAction preserves other surfaceState keys', async () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const session = { surfaceState: { selectedReference: 'r1' } };
        await a.handleAction('cea-tab-lorebook', { session, root: null });
        expect(session.surfaceState.selectedReference).toBe('r1');
        expect(session.surfaceState.activeTab).toBe('lorebook');
    });

    test('handleAction ignores unknown action', async () => {
        const a = createCharacterEditorAdapter(makeDepsWithRealEscape());
        const session = { surfaceState: { activeTab: 'card' } };
        await a.handleAction('not-a-tab', { session, root: null });
        expect(session.surfaceState.activeTab).toBe('card');
    });
});
