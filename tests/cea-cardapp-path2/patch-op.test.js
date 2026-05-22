import { describe, test, expect } from '@jest/globals';
import { createCardAppPatchFileOp } from '../../public/scripts/extensions/character-editor-assistant/studio/cardapp-patch-op.js';

function applyPatchExactOnly(content, oldText, newText) {
    if (content === oldText) return newText;
    if (content.includes(oldText)) return content.replace(oldText, newText);
    return null;
}

const op = createCardAppPatchFileOp({ applyPatch: applyPatchExactOnly });

describe('cardapp_patch_file op', () => {
    test('apply: replaces old_text with new_text on exact match', () => {
        const live = { files: { 'index.js': 'console.log("hi");' } };
        const next = op.apply(live, { op: 'cardapp_patch_file', path: 'index.js', old_text: 'console.log("hi");', new_text: 'console.log("hello");' });
        expect(next.files['index.js']).toBe('console.log("hello");');
    });

    test('apply: substring match (includes-based)', () => {
        const live = { files: { 'index.js': 'foo BAR baz' } };
        const next = op.apply(live, { op: 'cardapp_patch_file', path: 'index.js', old_text: 'BAR', new_text: 'qux' });
        expect(next.files['index.js']).toBe('foo qux baz');
    });

    test('inverse: swaps old_text and new_text', () => {
        const edit = { op: 'cardapp_patch_file', path: 'index.js', old_text: 'A', new_text: 'B' };
        const inv = op.inverse(edit);
        expect(inv).toEqual({ op: 'cardapp_patch_file', path: 'index.js', old_text: 'B', new_text: 'A' });
    });

    test('detectConflict: returns null when old_text matches', () => {
        const live = { files: { 'index.js': 'hello' } };
        const conflict = op.detectConflict({}, { op: 'cardapp_patch_file', path: 'index.js', old_text: 'hello', new_text: 'world' }, live);
        expect(conflict).toBeNull();
    });

    test('detectConflict: emits patch_target_missing when old_text absent', () => {
        const live = { files: { 'index.js': 'something else' } };
        const conflict = op.detectConflict({}, { op: 'cardapp_patch_file', path: 'index.js', old_text: 'absent', new_text: 'X' }, live);
        expect(conflict).toMatchObject({ reason: 'patch_target_missing' });
    });

    test('detectConflict: returns null when file absent and old_text empty (patch-as-create)', () => {
        const live = { files: {} };
        const conflict = op.detectConflict({}, { op: 'cardapp_patch_file', path: 'new.js', old_text: '', new_text: 'X' }, live);
        expect(conflict).toBeNull();
    });

    test('detectConflict: emits patch_target_missing when file absent and old_text non-empty', () => {
        const live = { files: {} };
        const conflict = op.detectConflict({}, { op: 'cardapp_patch_file', path: 'absent.js', old_text: 'something', new_text: 'X' }, live);
        expect(conflict).toMatchObject({ reason: 'patch_target_missing' });
    });

    test('apply: throws when patch matcher returns null', () => {
        const live = { files: { 'index.js': 'unrelated' } };
        expect(() => op.apply(live, { op: 'cardapp_patch_file', path: 'index.js', old_text: 'absent', new_text: 'X' })).toThrow();
    });
});
