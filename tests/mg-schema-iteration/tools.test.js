// tests/mg-schema-iteration/tools.test.js
import { describe, test, expect, beforeAll } from '@jest/globals';

let TOOL_DEFS, TOOL_DISPLAY, normalizeToolCallToEdit, applyToolCallToSandbox, SESSIONS_BUCKET_KEY;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/memory-graph/schema-iteration/tools.js');
    ({ TOOL_DEFS, TOOL_DISPLAY, normalizeToolCallToEdit, applyToolCallToSandbox, SESSIONS_BUCKET_KEY } = mod);
});

const identity = (s) => s;
const callFn = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

describe('MG Schema — tools', () => {
    test('TOOL_DEFS has 3 entries with matching display labels', () => {
        expect(TOOL_DEFS).toHaveLength(3);
        for (const def of TOOL_DEFS) {
            expect(def.type).toBe('function');
            expect(TOOL_DISPLAY[def.function.name]).toBeTruthy();
        }
    });

    test('SESSIONS_BUCKET_KEY is a non-empty string', () => {
        expect(typeof SESSIONS_BUCKET_KEY).toBe('string');
        expect(SESSIONS_BUCKET_KEY.length).toBeGreaterThan(0);
    });

    test('mg_set_node_type adds a new entry', async () => {
        const live = [{ id: 'character', tableColumns: ['name'] }];
        const setTool = TOOL_DEFS.find(d => d.function.name.includes('set'));
        const edits = await normalizeToolCallToEdit(
            callFn(setTool.function.name, { node_type: { id: 'event', tableColumns: ['summary'] } }),
            { live, normalizeNodeTypeSchema: identity },
        );
        expect(edits).toHaveLength(1);
        expect(edits[0].op).toBe('set');
        expect(edits[0].path).toBe('');
        expect(edits[0].newValue.map(t => t.id)).toEqual(['character', 'event']);
    });

    test('mg_remove_node_type drops an entry', async () => {
        const live = [{ id: 'a' }, { id: 'b' }];
        const removeTool = TOOL_DEFS.find(d => d.function.name.includes('remove'));
        const edits = await normalizeToolCallToEdit(
            callFn(removeTool.function.name, { id: 'a' }),
            { live, normalizeNodeTypeSchema: identity },
        );
        expect(edits[0].newValue.map(e => e.id)).toEqual(['b']);
    });

    test('mg_remove_node_type refuses to leave the schema empty', async () => {
        const live = [{ id: 'a' }];
        const removeTool = TOOL_DEFS.find(d => d.function.name.includes('remove'));
        const edits = await normalizeToolCallToEdit(
            callFn(removeTool.function.name, { id: 'a' }),
            { live, normalizeNodeTypeSchema: identity },
        );
        expect(edits).toEqual([]);
    });

    test('mg_reorder_node_types reorders by full id list', async () => {
        const live = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const reorderTool = TOOL_DEFS.find(d => d.function.name.includes('reorder'));
        const edits = await normalizeToolCallToEdit(
            callFn(reorderTool.function.name, { ids: ['c', 'a', 'b'] }),
            { live, normalizeNodeTypeSchema: identity },
        );
        expect(edits[0].newValue.map(e => e.id)).toEqual(['c', 'a', 'b']);
    });

    test('reorder with same single id is a no-op (returns [])', async () => {
        const live = [{ id: 'a' }];
        const reorderTool = TOOL_DEFS.find(d => d.function.name.includes('reorder'));
        const edits = await normalizeToolCallToEdit(
            callFn(reorderTool.function.name, { ids: ['a'] }),
            { live, normalizeNodeTypeSchema: identity },
        );
        expect(edits).toEqual([]);
    });

    test('non-array live returns [] (defensive)', async () => {
        const setTool = TOOL_DEFS.find(d => d.function.name.includes('set'));
        const edits = await normalizeToolCallToEdit(
            callFn(setTool.function.name, { node_type: { id: 'x' } }),
            { live: null, normalizeNodeTypeSchema: identity },
        );
        expect(edits).toEqual([]);
    });
});
