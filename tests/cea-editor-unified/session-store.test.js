import { jest } from '@jest/globals';

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

let createUnifiedCeaEditorSessionStore;
let makeMessageId;
let normalizeMessageShape;

beforeAll(async () => {
    ({ createUnifiedCeaEditorSessionStore, makeMessageId, normalizeMessageShape } = await import(
        '../../public/scripts/extensions/character-editor-assistant/editor-iteration/session-store.js'
    ));
});

describe('unified CEA editor session-store', () => {
    it('exports the canonical 3 helpers', () => {
        expect(typeof createUnifiedCeaEditorSessionStore).toBe('function');
        expect(typeof makeMessageId).toBe('function');
        expect(typeof normalizeMessageShape).toBe('function');
    });

    it('makeMessageId returns a unique string per call', () => {
        const a = makeMessageId();
        const b = makeMessageId();
        expect(typeof a).toBe('string');
        expect(a).not.toBe(b);
        expect(a.length).toBeGreaterThan(0);
    });

    it('normalizeMessageShape gives default fields when input is sparse', () => {
        const m = normalizeMessageShape({ role: 'user', content: 'hi' });
        expect(m.role).toBe('user');
        expect(m.content).toBe('hi');
        expect(typeof m.id).toBe('string');
        expect(Array.isArray(m.toolCalls)).toBe(true);
        expect(Array.isArray(m.toolResults)).toBe(true);
        expect(Array.isArray(m.edits)).toBe(true);
        expect(typeof m.at).toBe('number');
    });

    it('normalizeMessageShape preserves toolCalls and toolResults with tool_call_id linkage', () => {
        const input = {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'lorebook_query', args: { book_name: 'a', query: 'x' } }],
            toolResults: [{ tool_call_id: 'c1', content: { hits: 0 } }],
            edits: [],
        };
        const m = normalizeMessageShape(input);
        expect(m.toolCalls).toHaveLength(1);
        expect(m.toolCalls[0].id).toBe('c1');
        expect(m.toolResults).toHaveLength(1);
        expect(m.toolResults[0].tool_call_id).toBe('c1');
        expect(m.toolResults[0].content).toEqual({ hits: 0 });
    });

    it('normalizeMessageShape preserves edits with target.kind and bookName', () => {
        const input = {
            role: 'assistant',
            edits: [
                { op: 'set', path: 'description', oldValue: 'old', newValue: 'new', target: { kind: 'character' } },
                { op: 'set', path: 'entries.0.content', oldValue: 'a', newValue: 'b', target: { kind: 'lorebook', bookName: 'BookA' } },
            ],
        };
        const m = normalizeMessageShape(input);
        expect(m.edits).toHaveLength(2);
        expect(m.edits[0].target.kind).toBe('character');
        expect(m.edits[1].target.kind).toBe('lorebook');
        expect(m.edits[1].target.bookName).toBe('BookA');
    });

    it('normalizeMessageShape preserves appliedAt, appliedTarget, rolledBackAt, auto flags', () => {
        const now = Date.now();
        const m = normalizeMessageShape({
            role: 'assistant',
            content: 'x',
            appliedAt: now,
            appliedTarget: 'character',
            rolledBackAt: now + 100,
            auto: true,
        });
        expect(m.appliedAt).toBe(now);
        expect(m.appliedTarget).toBe('character');
        expect(m.rolledBackAt).toBe(now + 100);
        expect(m.auto).toBe(true);
    });

    it('normalizeMessageShape preserves op-specific fields on lorebook_entry_update edits (CEA-1)', () => {
        // CEA-1 regression: the legacy normalizeEdit only kept op/path/oldValue
        // /newValue/target, dropping `patch` and `before`. After persist +
        // reload, the diff card rendered empty and rollback couldn't rebuild
        // the inverse op. This test pins the round-trip behavior.
        const before = { content: 'old', comment: 'old comment' };
        const patch = { content: 'new', comment: 'new comment' };
        const input = {
            role: 'assistant',
            edits: [
                {
                    op: 'lorebook_entry_update',
                    path: 'lorebook.entries',
                    uid: 42,
                    patch,
                    before,
                    target: { kind: 'lorebook', bookName: 'BookA' },
                },
            ],
        };
        const m = normalizeMessageShape(input);
        expect(m.edits).toHaveLength(1);
        expect(m.edits[0].op).toBe('lorebook_entry_update');
        expect(m.edits[0].uid).toBe(42);
        expect(m.edits[0].patch).toEqual(patch);
        expect(m.edits[0].before).toEqual(before);
        expect(m.edits[0].target.bookName).toBe('BookA');
    });

    it('normalizeMessageShape preserves str_replace find/replace fields (CEA-1)', () => {
        const m = normalizeMessageShape({
            role: 'assistant',
            edits: [{
                op: 'str_replace',
                path: 'description',
                find: 'foo',
                replace: 'bar',
                target: { kind: 'character' },
            }],
        });
        expect(m.edits[0].find).toBe('foo');
        expect(m.edits[0].replace).toBe('bar');
    });

    it('normalizeMessageShape preserves lorebook_entry_add entry payload (CEA-1)', () => {
        const entry = { uid: 7, comment: 'new entry', key: ['foo'], content: 'body' };
        const m = normalizeMessageShape({
            role: 'assistant',
            edits: [{
                op: 'lorebook_entry_add',
                path: 'lorebook.entries',
                uid: 7,
                entry,
                target: { kind: 'lorebook', bookName: 'BookA' },
            }],
        });
        expect(m.edits[0].uid).toBe(7);
        expect(m.edits[0].entry).toEqual(entry);
    });

    it('normalizeMessageShape preserves lorebook_entry_remove entry snapshot (CEA-1)', () => {
        // The remove op carries the live entry as `entry` so the inverse
        // (`lorebook_entry_add`) can faithfully restore it on rollback.
        const removed = { uid: 5, comment: 'doomed', content: 'gone' };
        const m = normalizeMessageShape({
            role: 'assistant',
            edits: [{
                op: 'lorebook_entry_remove',
                path: 'lorebook.entries',
                uid: 5,
                entry: removed,
                target: { kind: 'lorebook', bookName: 'BookA' },
            }],
        });
        expect(m.edits[0].uid).toBe(5);
        expect(m.edits[0].entry).toEqual(removed);
    });

    it('createUnifiedCeaEditorSessionStore returns a store with the expected methods', () => {
        // Stub the storage dep at module load time. The store factory takes a
        // ctx + options object — match the sibling signature.
        const fakeCtx = {
            extensionSettings: {},
            saveSettings: () => {},
            saveSettingsDebounced: () => {},
        };
        const store = createUnifiedCeaEditorSessionStore({
            context: fakeCtx,
            avatar: 'avatar.png',
            computeScope: () => 'character',
        });
        // Mirror the sibling stores' interface — common methods.
        expect(typeof store.saveSession === 'function' || typeof store.save === 'function').toBe(true);
        expect(typeof store.loadSession === 'function' || typeof store.load === 'function').toBe(true);
        expect(typeof store.listSessions === 'function' || typeof store.list === 'function').toBe(true);
        expect(typeof store.deleteSession === 'function' || typeof store.remove === 'function').toBe(true);
    });
});
