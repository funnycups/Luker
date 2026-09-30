import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../public/scripts/lib/edits/engine.js';
import { createCardAppPatchFileOp } from '../../public/scripts/extensions/character-editor-assistant/studio/cardapp-patch-op.js';
import { createCardAppRenameFileOp } from '../../public/scripts/extensions/character-editor-assistant/studio/cardapp-rename-op.js';

const deps = {
    get: lodash.get,
    set: lodash.set,
    unset: lodash.unset,
    isEqual: lodash.isEqual,
    cloneDeep: lodash.cloneDeep,
};

// Exact-match stand-in for the Studio's 3-tier fuzzy matcher. The op only
// requires a `(content, oldText, newText) => string|null` shape.
function applyPatchExactOnly(content, oldText, newText) {
    if (content.includes(oldText)) return content.replace(oldText, newText);
    return null;
}

function buildEngine() {
    const engine = createEngine(deps);
    engine.registerOp('cardapp_patch_file', createCardAppPatchFileOp({ applyPatch: applyPatchExactOnly }));
    engine.registerOp('cardapp_rename_file', createCardAppRenameFileOp());
    return engine;
}

// These exercise the ops through the engine's real dispatch, which is the
// only path that exists in production. Calling `op.apply(...)` directly
// would bypass the `(deps, edit, live)` handler contract.
describe('cardapp_patch_file through the edits engine', () => {
    test('replaces old_text with new_text and keeps the file map', () => {
        const engine = buildEngine();
        const live = { files: { 'index.js': 'console.log("hi");', 'style.css': '.a{}' } };
        const result = engine.applyEdits(
            [{ op: 'cardapp_patch_file', path: 'index.js', old_text: 'console.log("hi");', new_text: 'console.log("hello");' }],
            live,
        );

        expect(result.conflicts).toEqual([]);
        expect(result.clean).toHaveLength(1);
        expect(result.newLive.files['index.js']).toBe('console.log("hello");');
        expect(result.newLive.files['style.css']).toBe('.a{}');
    });

    test('patches a multi-line anchor that spans several lines', () => {
        const engine = buildEngine();
        const content = 'const DEFAULT_STATE = {\n    aw_hp: 100,\n    aw_maxHp: 100,\n};';
        const live = { files: { 'index.js': content } };
        const result = engine.applyEdits(
            [{
                op: 'cardapp_patch_file',
                path: 'index.js',
                old_text: '    aw_hp: 100,\n    aw_maxHp: 100,\n',
                new_text: '    aw_hp: 120,\n    aw_maxHp: 120,\n',
            }],
            live,
        );

        expect(result.conflicts).toEqual([]);
        expect(result.newLive.files['index.js']).toContain('aw_hp: 120,');
        expect(result.newLive.files['index.js']).toContain('aw_maxHp: 120,');
    });

    test('reports a conflict when the anchor is absent from the live file', () => {
        const engine = buildEngine();
        const live = { files: { 'index.js': 'unrelated content' } };
        const result = engine.applyEdits(
            [{ op: 'cardapp_patch_file', path: 'index.js', old_text: 'not in the file', new_text: 'X' }],
            live,
        );

        expect(result.clean).toEqual([]);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].reason).toBe('patch_target_missing');
        expect(result.newLive.files['index.js']).toBe('unrelated content');
    });

    test('inverse swaps old_text and new_text', () => {
        const engine = buildEngine();
        const edit = { op: 'cardapp_patch_file', path: 'index.js', old_text: 'A', new_text: 'B' };
        expect(engine.inverseEdit(edit)).toEqual({
            op: 'cardapp_patch_file',
            path: 'index.js',
            old_text: 'B',
            new_text: 'A',
        });
    });
});

describe('cardapp_rename_file through the edits engine', () => {
    test('moves content to the new path and drops the old one', () => {
        const engine = buildEngine();
        const live = { files: { 'old.js': 'body', 'keep.js': 'keep' } };
        const result = engine.applyEdits(
            [{ op: 'cardapp_rename_file', from: 'old.js', to: 'new.js' }],
            live,
        );

        expect(result.conflicts).toEqual([]);
        expect(result.newLive.files['new.js']).toBe('body');
        expect(result.newLive.files['old.js']).toBeUndefined();
        expect(result.newLive.files['keep.js']).toBe('keep');
    });

    test('reports a conflict when the rename source is absent', () => {
        const engine = buildEngine();
        const result = engine.applyEdits(
            [{ op: 'cardapp_rename_file', from: 'missing.js', to: 'new.js' }],
            { files: {} },
        );

        expect(result.clean).toEqual([]);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].reason).toBe('rename_source_missing');
    });

    test('reports a conflict when the rename target already exists', () => {
        const engine = buildEngine();
        const result = engine.applyEdits(
            [{ op: 'cardapp_rename_file', from: 'a.js', to: 'b.js' }],
            { files: { 'a.js': 'A', 'b.js': 'B' } },
        );

        expect(result.clean).toEqual([]);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].reason).toBe('rename_target_exists');
    });
});
