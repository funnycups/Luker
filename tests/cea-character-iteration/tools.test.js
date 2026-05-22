// tests/cea-character-iteration/tools.test.js
import { describe, test, expect } from '@jest/globals';
import {
    TOOL_DEFS,
    TOOL_DISPLAY,
    normalizeToolCallToEdit,
} from '../../public/scripts/extensions/character-editor-assistant/character-iteration/tools.js';

const live = {
    card: { name: 'Alice', description: 'A character.' },
    lorebook: {
        bookName: 'AliceLore',
        entries: {
            5: { uid: 5, comment: 'origin', content: 'once upon a time' },
        },
    },
};

const call = (name, args) => ({
    function: { name, arguments: JSON.stringify(args) },
});

describe('CEA Character — tools', () => {
    test('TOOL_DEFS has 6 entries with matching display labels', () => {
        expect(TOOL_DEFS).toHaveLength(6);
        for (const def of TOOL_DEFS) {
            expect(def.type).toBe('function');
            expect(TOOL_DISPLAY[def.function.name]).toBeTruthy();
        }
    });

    test('cea_set_card_field → set edit on card.<field>', async () => {
        const edits = await normalizeToolCallToEdit(call('cea_set_card_field', { field: 'name', value: 'Bob' }), { live });
        expect(edits).toEqual([{
            op: 'set', path: 'card.name', oldValue: 'Alice', newValue: 'Bob',
        }]);
    });

    test('cea_str_replace_card_field → str_replace edit', async () => {
        const edits = await normalizeToolCallToEdit(call('cea_str_replace_card_field', { field: 'description', find: 'A', replace: 'Z' }), { live });
        expect(edits).toEqual([{
            op: 'str_replace', path: 'card.description', find: 'A', replace: 'Z',
        }]);
    });

    test('cea_add_lorebook_entry → lorebook_entry_add edit', async () => {
        const newEntry = { uid: 7, comment: 'fresh', content: 'new lore' };
        const edits = await normalizeToolCallToEdit(call('cea_add_lorebook_entry', { entry: newEntry }), { live });
        expect(edits).toEqual([{
            op: 'lorebook_entry_add', path: 'lorebook.entries', uid: 7, entry: newEntry,
        }]);
    });

    test('cea_update_lorebook_entry → patch + before snapshot', async () => {
        const edits = await normalizeToolCallToEdit(call('cea_update_lorebook_entry', { uid: 5, patch: { content: 'tomorrow' } }), { live });
        expect(edits).toEqual([{
            op: 'lorebook_entry_update', path: 'lorebook.entries', uid: 5,
            patch: { content: 'tomorrow' },
            before: { content: 'once upon a time' },
        }]);
    });

    test('cea_remove_lorebook_entry → remove with cloned entry', async () => {
        const edits = await normalizeToolCallToEdit(call('cea_remove_lorebook_entry', { uid: 5 }), { live });
        expect(edits[0].op).toBe('lorebook_entry_remove');
        expect(edits[0].entry).toEqual({ uid: 5, comment: 'origin', content: 'once upon a time' });
        expect(edits[0].entry).not.toBe(live.lorebook.entries[5]); // clone, not reference
    });

    test('cea_set_lorebook_metadata → set on lorebook.<key>', async () => {
        const edits = await normalizeToolCallToEdit(call('cea_set_lorebook_metadata', { key: 'bookName', value: 'NewLore' }), { live });
        expect(edits).toEqual([{
            op: 'set', path: 'lorebook.bookName', oldValue: 'AliceLore', newValue: 'NewLore',
        }]);
    });

    test('malformed JSON arguments → returns null', async () => {
        const bad = { function: { name: 'cea_set_card_field', arguments: '{not json' } };
        const edits = await normalizeToolCallToEdit(bad, { live });
        expect(edits).toBeNull();
    });

    test('unknown tool name → returns []', async () => {
        const edits = await normalizeToolCallToEdit(call('cea_unknown', {}), { live });
        expect(edits).toEqual([]);
    });
});
