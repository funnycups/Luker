// tests/mg-config-iteration/tools.test.js
//
// Covers the configuration workbench's write surface:
//   - the five configuration tools plus the three structure tools,
//   - the sandbox executor against `{ schema, settings }`,
//   - the tool-call → whole-document edit normalizer.
//
// Working state is built from the real `resolveSettingsForView({})` so the
// settings half reflects the same effective view the studio reads.

import { describe, test, expect } from '@jest/globals';

import {
    TOOL_DEFS,
    TOOL_DISPLAY,
    SESSIONS_BUCKET_KEY,
    CONTROL_TOOL_NAMES,
    buildToolCatalog,
    applyToolCallToSandbox,
    normalizeToolCallToEdit,
} from '../../public/scripts/extensions/memory-graph/config-iteration/tools.js';
import { resolveSettingsForView } from '../../public/scripts/extensions/memory-graph/config-iteration/fields.js';

const normalizeNodeTypeSchema = (schema) => (Array.isArray(schema) ? schema : []);

const BASE_SCHEMA = [{ id: 'event', label: 'Event', extractionInstructions: '' }];

function liveWithSettings(settings = {}) {
    return {
        schema: structuredClone(BASE_SCHEMA),
        settings: resolveSettingsForView(settings),
    };
}

function sandbox(settings = {}) {
    return { workingProfile: structuredClone(liveWithSettings(settings)) };
}

function ctx(overrides = {}) {
    return {
        normalizeNodeTypeSchema,
        resolveUnsetBaseline: () => undefined,
        ...overrides,
    };
}

function call(name, args) {
    return { name, args };
}

const apply = (name, args, box, context = ctx()) => applyToolCallToSandbox(call(name, args), box, context);

describe('MG config — tool catalog', () => {
    test('TOOL_DEFS carries the eight tools and the catalog adds the two reset controls', () => {
        expect(TOOL_DEFS).toHaveLength(8);
        const catalog = buildToolCatalog();
        expect(catalog).toHaveLength(10);
        const names = catalog.map(def => def.function.name);
        expect(names).toEqual(expect.arrayContaining([
            'mg_config_list_fields',
            'mg_config_read_fields',
            'mg_config_patch_prompt',
            'mg_config_set_fields',
            'mg_schema_patch_text',
            'mg_schema_set_node_type',
            'mg_schema_remove_node_type',
            'mg_schema_reorder_node_types',
            CONTROL_TOOL_NAMES.resetToBlank,
            CONTROL_TOOL_NAMES.resetToGlobal,
        ]));
        expect(new Set(names).size).toBe(10);
    });

    test('every catalog entry has a TOOL_DISPLAY label', () => {
        for (const def of buildToolCatalog()) {
            expect(TOOL_DISPLAY[def.function.name]).toBeTruthy();
        }
    });

    test('SESSIONS_BUCKET_KEY stays the legacy V2 bucket name', () => {
        expect(SESSIONS_BUCKET_KEY).toBe('iterStudioV2Schema');
    });

    test('mg_config_list_fields takes an optional group', () => {
        const def = TOOL_DEFS.find(item => item.function.name === 'mg_config_list_fields');
        const params = def.function.parameters;
        expect(params.properties.group.type).toBe('string');
        expect(params.required).toBeUndefined();
    });

    test('mg_config_read_fields requires paths and enumerates the read sources', () => {
        const def = TOOL_DEFS.find(item => item.function.name === 'mg_config_read_fields');
        const params = def.function.parameters;
        expect(params.required).toEqual(['paths']);
        expect(params.properties.paths.type).toBe('array');
        expect(params.properties.source.enum).toEqual(['working', 'global', 'default']);
    });

    test('mg_config_patch_prompt requires path oldString newString', () => {
        const def = TOOL_DEFS.find(item => item.function.name === 'mg_config_patch_prompt');
        expect(def.function.parameters.required).toEqual(['path', 'oldString', 'newString']);
    });

    test('mg_config_set_fields exposes set and unset without required keys', () => {
        const def = TOOL_DEFS.find(item => item.function.name === 'mg_config_set_fields');
        const params = def.function.parameters;
        expect(params.properties.set.type).toBe('object');
        expect(params.properties.unset.type).toBe('array');
        expect(params.required).toBeUndefined();
    });

    test('mg_schema_patch_text enumerates the four patchable node-type fields', () => {
        const def = TOOL_DEFS.find(item => item.function.name === 'mg_schema_patch_text');
        const params = def.function.parameters;
        expect(params.required).toEqual(['id', 'field', 'oldString', 'newString']);
        expect(params.properties.field.enum).toEqual([
            'extractionInstructions',
            'extractHint',
            'columnHints',
            'compression.summarizeInstruction',
        ]);
        expect(params.properties.column.type).toBe('string');
    });
});

describe('MG config — mg_config_patch_prompt', () => {
    test('a no-op patch returns false and leaves the sandbox unchanged', () => {
        const box = sandbox();
        const before = structuredClone(box.workingProfile);
        const changed = apply('mg_config_patch_prompt', {
            path: 'settings.extractTemplate',
            oldString: '{{nodes}}',
            newString: '{{nodes}}',
        }, box);
        expect(changed).toBe(false);
        expect(box.workingProfile).toEqual(before);
    });

    test('patches a settings text value', () => {
        const box = sandbox({ extractEdgeRules: 'alpha beta gamma' });
        const changed = apply('mg_config_patch_prompt', {
            path: 'settings.extractEdgeRules',
            oldString: 'beta',
            newString: 'BETA',
        }, box);
        expect(changed).toBe(true);
        expect(box.workingProfile.settings.extractEdgeRules).toBe('alpha BETA gamma');
    });

    test('trims the patched value before writing', () => {
        const box = sandbox({ extractEdgeRules: 'alpha beta' });
        const changed = apply('mg_config_patch_prompt', {
            path: 'settings.extractEdgeRules',
            oldString: 'alpha beta',
            newString: '  gamma  ',
        }, box);
        expect(changed).toBe(true);
        expect(box.workingProfile.settings.extractEdgeRules).toBe('gamma');
    });

    test('drops to not_found for an unregistered settings path', () => {
        expect(() => apply('mg_config_patch_prompt', {
            path: 'settings.notAField',
            oldString: 'a',
            newString: 'b',
        }, sandbox())).toThrow('mg_config_patch_prompt: not_found — ');
    });

    test('rejects a non-text settings field with invalid_args', () => {
        expect(() => apply('mg_config_patch_prompt', {
            path: 'settings.recallMaxIterations',
            oldString: '3',
            newString: '4',
        }, sandbox())).toThrow('mg_config_patch_prompt: invalid_args — ');
    });

    test('a missing anchor is not_found and leaves the sandbox unchanged', () => {
        const box = sandbox({ extractEdgeRules: 'alpha beta' });
        const before = structuredClone(box.workingProfile);
        expect(() => apply('mg_config_patch_prompt', {
            path: 'settings.extractEdgeRules',
            oldString: 'not present',
            newString: 'x',
        }, box)).toThrow('mg_config_patch_prompt: not_found — ');
        expect(box.workingProfile).toEqual(before);
    });

    test('a repeated anchor is multiple_matches unless replaceAll is set', () => {
        const box = sandbox({ extractEdgeRules: 'x y x' });
        expect(() => apply('mg_config_patch_prompt', {
            path: 'settings.extractEdgeRules',
            oldString: 'x',
            newString: 'z',
        }, box)).toThrow('mg_config_patch_prompt: multiple_matches — ');
        const changed = apply('mg_config_patch_prompt', {
            path: 'settings.extractEdgeRules',
            oldString: 'x',
            newString: 'z',
            replaceAll: true,
        }, box);
        expect(changed).toBe(true);
        expect(box.workingProfile.settings.extractEdgeRules).toBe('z y z');
    });

    test('rejects a patch that removes a required extractTemplate marker', () => {
        const box = sandbox();
        const before = structuredClone(box.workingProfile);
        expect(() => apply('mg_config_patch_prompt', {
            path: 'settings.extractTemplate',
            oldString: '{{nodes}}',
            newString: 'nodes',
        }, box)).toThrow('mg_config_patch_prompt: invalid_args — ');
        expect(box.workingProfile).toEqual(before);
    });
});

describe('MG config — mg_config_set_fields', () => {
    test('sets multiple fields in one call', () => {
        const box = sandbox();
        const changed = apply('mg_config_set_fields', {
            set: {
                'settings.recallMaxIterations': 5,
                'settings.extractMode': 'crawl',
            },
        }, box);
        expect(changed).toBe(true);
        expect(box.workingProfile.settings.recallMaxIterations).toBe(5);
        expect(box.workingProfile.settings.extractMode).toBe('crawl');
    });

    test('trims text values before writing', () => {
        const box = sandbox();
        const changed = apply('mg_config_set_fields', {
            set: { 'settings.extractEdgeRules': '  trimmed value  ' },
        }, box);
        expect(changed).toBe(true);
        expect(box.workingProfile.settings.extractEdgeRules).toBe('trimmed value');
    });

    test('a whole-value no-op returns false and leaves the sandbox unchanged', () => {
        const box = sandbox();
        const before = structuredClone(box.workingProfile);
        expect(apply('mg_config_set_fields', {
            set: { 'settings.recallMaxIterations': 3 },
        }, box)).toBe(false);
        expect(box.workingProfile).toEqual(before);
    });

    test('rejects the same path in set and unset without mutating anything', () => {
        const box = sandbox();
        const before = structuredClone(box.workingProfile);
        expect(() => apply('mg_config_set_fields', {
            set: { 'settings.recallMaxIterations': 5 },
            unset: ['settings.recallMaxIterations'],
        }, box)).toThrow('mg_config_set_fields: invalid_args — ');
        expect(box.workingProfile).toEqual(before);
    });

    test('rejects an unknown settings key with not_found', () => {
        expect(() => apply('mg_config_set_fields', {
            set: { 'settings.notAField': 1 },
        }, sandbox())).toThrow('mg_config_set_fields: not_found — ');
    });

    test('rejects a schema path with not_allowed', () => {
        expect(() => apply('mg_config_set_fields', {
            set: { 'schema[0].id': 'renamed' },
        }, sandbox())).toThrow('mg_config_set_fields: not_allowed — ');
    });

    test('validates integer bounds, booleans, and template markers', () => {
        expect(() => apply('mg_config_set_fields', {
            set: { 'settings.extractContextTurns': 33 },
        }, sandbox())).toThrow('mg_config_set_fields: invalid_args — ');
        expect(() => apply('mg_config_set_fields', {
            set: { 'settings.extractIncludeWorldInfo': 'true' },
        }, sandbox())).toThrow('mg_config_set_fields: invalid_args — ');
        expect(() => apply('mg_config_set_fields', {
            set: { 'settings.recallIncludeWorldInfo': 'false' },
        }, sandbox())).toThrow('mg_config_set_fields: invalid_args — ');
        expect(() => apply('mg_config_set_fields', {
            set: { 'settings.extractTemplate': 'no markers' },
        }, sandbox())).toThrow('mg_config_set_fields: invalid_args — ');
    });

    test('validates the whole batch before mutating any key', () => {
        const box = sandbox();
        expect(() => apply('mg_config_set_fields', {
            set: {
                'settings.recallMaxIterations': 5,
                'settings.extractContextTurns': 33,
            },
        }, box)).toThrow('mg_config_set_fields: invalid_args — ');
        expect(box.workingProfile.settings.recallMaxIterations).toBe(3);
    });

    test('unset restores the inherited baseline', () => {
        const box = sandbox({ recallMaxIterations: 6 });
        const changed = apply('mg_config_set_fields', {
            unset: ['settings.recallMaxIterations'],
        }, box, ctx({ resolveUnsetBaseline: () => 3 }));
        expect(changed).toBe(true);
        expect(box.workingProfile.settings.recallMaxIterations).toBe(3);
    });

    test('unset without a baseline throws invalid_args and names the path', () => {
        const box = sandbox();
        expect(() => apply('mg_config_set_fields', {
            unset: ['settings.recallMaxIterations'],
        }, box)).toThrow(/no inherited baseline for "settings\.recallMaxIterations"/);
    });

    test('unset validates the path like set does', () => {
        expect(() => apply('mg_config_set_fields', {
            unset: ['settings.notAField'],
        }, sandbox())).toThrow('mg_config_set_fields: not_found — ');
        expect(() => apply('mg_config_set_fields', {
            unset: ['schema[0].id'],
        }, sandbox())).toThrow('mg_config_set_fields: not_allowed — ');
    });

    test('rejects a call with neither set nor unset', () => {
        expect(() => apply('mg_config_set_fields', {}, sandbox()))
            .toThrow('mg_config_set_fields: invalid_args — ');
    });
});

describe('MG config — mg_schema_patch_text', () => {
    test('addresses the node type by id, not by array index', () => {
        const box = {
            workingProfile: {
                schema: [
                    { id: 'character', extractionInstructions: 'keep me' },
                    { id: 'event', extractionInstructions: 'One event per moment.' },
                ],
                settings: resolveSettingsForView({}),
            },
        };
        const changed = apply('mg_schema_patch_text', {
            id: 'event',
            field: 'extractionInstructions',
            oldString: 'moment',
            newString: 'beat',
        }, box);
        expect(changed).toBe(true);
        expect(box.workingProfile.schema[1].extractionInstructions).toBe('One event per beat.');
        expect(box.workingProfile.schema[0].extractionInstructions).toBe('keep me');
    });

    test('an empty target with an empty oldString is not_found and points at the structure tool', () => {
        const box = sandbox();
        const before = structuredClone(box.workingProfile);
        let error;
        try {
            apply('mg_schema_patch_text', {
                id: 'event',
                field: 'extractionInstructions',
                oldString: '',
                newString: 'x',
            }, box);
        } catch (err) {
            error = err;
        }
        expect(error?.message).toContain('mg_schema_patch_text: not_found — ');
        expect(error?.message).toContain('mg_schema_set_node_type');
        expect(box.workingProfile).toEqual(before);
    });

    test('an absent id is not_found', () => {
        expect(() => apply('mg_schema_patch_text', {
            id: 'ghost',
            field: 'extractionInstructions',
            oldString: 'a',
            newString: 'b',
        }, sandbox())).toThrow('mg_schema_patch_text: not_found — ');
    });

    test('a duplicated id is multiple_matches', () => {
        const box = {
            workingProfile: {
                schema: [
                    { id: 'event', extractionInstructions: 'a' },
                    { id: 'event', extractionInstructions: 'a' },
                ],
                settings: resolveSettingsForView({}),
            },
        };
        expect(() => apply('mg_schema_patch_text', {
            id: 'event',
            field: 'extractionInstructions',
            oldString: 'a',
            newString: 'b',
        }, box)).toThrow('mg_schema_patch_text: multiple_matches — ');
    });

    test('columnHints requires a column', () => {
        const box = {
            workingProfile: {
                schema: [{ id: 'event', columnHints: { summary: 'short' } }],
                settings: resolveSettingsForView({}),
            },
        };
        expect(() => apply('mg_schema_patch_text', {
            id: 'event',
            field: 'columnHints',
            oldString: 'short',
            newString: 'long',
        }, box)).toThrow('mg_schema_patch_text: invalid_args — ');
    });

    test('columnHints with an unknown column is not_found', () => {
        const box = {
            workingProfile: {
                schema: [{ id: 'event', columnHints: { summary: 'short' } }],
                settings: resolveSettingsForView({}),
            },
        };
        expect(() => apply('mg_schema_patch_text', {
            id: 'event',
            field: 'columnHints',
            column: 'title',
            oldString: 'short',
            newString: 'long',
        }, box)).toThrow('mg_schema_patch_text: not_found — ');
    });

    test('patches a column hint in place', () => {
        const box = {
            workingProfile: {
                schema: [{ id: 'event', columnHints: { summary: 'short note' } }],
                settings: resolveSettingsForView({}),
            },
        };
        const changed = apply('mg_schema_patch_text', {
            id: 'event',
            field: 'columnHints',
            column: 'summary',
            oldString: 'short',
            newString: 'long',
        }, box);
        expect(changed).toBe(true);
        expect(box.workingProfile.schema[0].columnHints).toEqual({ summary: 'long note' });
    });

    test('a missing compression.summarizeInstruction is not_found', () => {
        const box = {
            workingProfile: {
                schema: [{ id: 'event', compression: { mode: 'flat' } }],
                settings: resolveSettingsForView({}),
            },
        };
        expect(() => apply('mg_schema_patch_text', {
            id: 'event',
            field: 'compression.summarizeInstruction',
            oldString: 'a',
            newString: 'b',
        }, box)).toThrow('mg_schema_patch_text: not_found — ');
    });

    test('patches compression.summarizeInstruction without dropping sibling fields', () => {
        const box = {
            workingProfile: {
                schema: [{ id: 'event', compression: { mode: 'flat', threshold: 4, summarizeInstruction: 'old text' } }],
                settings: resolveSettingsForView({}),
            },
        };
        const changed = apply('mg_schema_patch_text', {
            id: 'event',
            field: 'compression.summarizeInstruction',
            oldString: 'old',
            newString: 'new',
        }, box);
        expect(changed).toBe(true);
        expect(box.workingProfile.schema[0].compression).toEqual({
            mode: 'flat',
            threshold: 4,
            summarizeInstruction: 'new text',
        });
    });

    test('a missing target field is not_found and a non-string target is invalid_args', () => {
        const missing = {
            workingProfile: {
                schema: [{ id: 'event' }],
                settings: resolveSettingsForView({}),
            },
        };
        expect(() => apply('mg_schema_patch_text', {
            id: 'event',
            field: 'extractionInstructions',
            oldString: 'a',
            newString: 'b',
        }, missing)).toThrow('mg_schema_patch_text: not_found — ');

        const nonString = {
            workingProfile: {
                schema: [{ id: 'event', extractionInstructions: 42 }],
                settings: resolveSettingsForView({}),
            },
        };
        expect(() => apply('mg_schema_patch_text', {
            id: 'event',
            field: 'extractionInstructions',
            oldString: '4',
            newString: '5',
        }, nonString)).toThrow('mg_schema_patch_text: invalid_args — ');
    });

    test('an unknown field is invalid_args', () => {
        expect(() => apply('mg_schema_patch_text', {
            id: 'event',
            field: 'label',
            oldString: 'a',
            newString: 'b',
        }, sandbox())).toThrow('mg_schema_patch_text: invalid_args — ');
    });

    test('an unknown anchor is not_found and leaves the sandbox unchanged', () => {
        const box = sandbox();
        box.workingProfile.schema[0].extractionInstructions = 'a b c';
        const before = structuredClone(box.workingProfile);
        expect(() => apply('mg_schema_patch_text', {
            id: 'event',
            field: 'extractionInstructions',
            oldString: 'zzz',
            newString: 'x',
        }, box)).toThrow('mg_schema_patch_text: not_found — ');
        expect(box.workingProfile).toEqual(before);
    });

    test('a repeated anchor is multiple_matches unless replaceAll is set', () => {
        const box = sandbox();
        box.workingProfile.schema[0].extractionInstructions = 'x y x';
        expect(() => apply('mg_schema_patch_text', {
            id: 'event',
            field: 'extractionInstructions',
            oldString: 'x',
            newString: 'z',
        }, box)).toThrow('mg_schema_patch_text: multiple_matches — ');
        expect(apply('mg_schema_patch_text', {
            id: 'event',
            field: 'extractionInstructions',
            oldString: 'x',
            newString: 'z',
            replaceAll: true,
        }, box)).toBe(true);
        expect(box.workingProfile.schema[0].extractionInstructions).toBe('z y z');
    });
});

describe('MG config — unknown tools', () => {
    test('throws a tool-prefixed unknown_tool error', () => {
        expect(() => apply('mg_something_unsupported', {}, sandbox()))
            .toThrow('mg_something_unsupported: unknown_tool — ');
    });
});

describe('MG config — normalizeToolCallToEdit', () => {
    const live = liveWithSettings({});

    test('emits one whole-document edit for a settings write', async () => {
        const edits = await normalizeToolCallToEdit(
            { name: 'mg_config_set_fields', args: { set: { 'settings.recallMaxIterations': 5 } } },
            { live, normalizeNodeTypeSchema, resolveUnsetBaseline: () => 3 },
        );
        expect(edits).toHaveLength(1);
        expect(edits[0]).toMatchObject({ op: 'set', path: '' });
        expect(edits[0].oldValue.settings.recallMaxIterations).toBe(3);
        expect(edits[0].newValue.settings.recallMaxIterations).toBe(5);
        expect(live.settings.recallMaxIterations).toBe(3);
    });

    test('keeps the schema half when a settings write is normalized', async () => {
        const edits = await normalizeToolCallToEdit(
            { name: 'mg_config_set_fields', args: { set: { 'settings.extractMode': 'crawl' } } },
            { live, normalizeNodeTypeSchema, resolveUnsetBaseline: () => undefined },
        );
        expect(edits).toHaveLength(1);
        expect(edits[0].newValue.schema).toEqual(live.schema);
    });

    test('keeps the settings half when a schema write is normalized', async () => {
        const edits = await normalizeToolCallToEdit(
            { name: 'mg_schema_set_node_type', args: { node_type: { id: 'place', tableColumns: ['name'] } } },
            { live, normalizeNodeTypeSchema, resolveUnsetBaseline: () => undefined },
        );
        expect(edits).toHaveLength(1);
        expect(edits[0].newValue.settings).toEqual(live.settings);
        expect(edits[0].newValue.schema.map(entry => entry.id)).toEqual(['event', 'place']);
    });

    test('a no-op call returns an empty edit list', async () => {
        const edits = await normalizeToolCallToEdit(
            { name: 'mg_config_set_fields', args: { set: { 'settings.recallMaxIterations': 3 } } },
            { live, normalizeNodeTypeSchema, resolveUnsetBaseline: () => 3 },
        );
        expect(edits).toEqual([]);
    });

    test('a non-object live value returns an empty edit list', async () => {
        const edits = await normalizeToolCallToEdit(
            { name: 'mg_config_set_fields', args: { set: { 'settings.recallMaxIterations': 5 } } },
            { live: null, normalizeNodeTypeSchema, resolveUnsetBaseline: () => 3 },
        );
        expect(edits).toEqual([]);
    });

    test('executor failures propagate to the caller', async () => {
        await expect(normalizeToolCallToEdit(
            { name: 'mg_config_set_fields', args: { set: { 'settings.notAField': 1 } } },
            { live, normalizeNodeTypeSchema, resolveUnsetBaseline: () => undefined },
        )).rejects.toThrow('mg_config_set_fields: not_found — ');
    });
});
