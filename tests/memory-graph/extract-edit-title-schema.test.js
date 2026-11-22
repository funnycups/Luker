// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll } from '@jest/globals';
import './_mocks/main-module-stack.js';
import { validateParsedToolCalls } from '../../public/scripts/extensions/function-call-runtime.js';

let buildDynamicExtractTools;

beforeAll(async () => {
    ({ buildDynamicExtractTools } = await import('../../public/scripts/extensions/memory-graph/main.js'));
});

const toolNamed = (tools, name) => tools.find(tool => tool.function.name === name);

describe('extract edit tool schema excludes title from set_fields and clear_fields', () => {
    const THREAD_SCHEMA = [{
        id: 'thread',
        editable: true,
        tableColumns: ['title', 'status', 'note'],
        requiredColumns: ['title', 'status', 'note'],
        extractionInstructions: '',
    }];

    test('title is top-level only and absent from set_fields and clear_fields', () => {
        const { tools } = buildDynamicExtractTools(THREAD_SCHEMA, { activeTypes: new Set(['thread']) });
        const edit = toolNamed(tools, 'luker_rpg_extract_thread_edit');
        const props = edit.function.parameters.properties;

        expect(props.title).toEqual({ type: 'string' });
        expect(Object.keys(props.set_fields.properties)).toEqual(['status', 'note']);
        expect(props.set_fields.properties).not.toHaveProperty('title');
        expect(props.clear_fields.items.enum).toEqual(['status', 'note']);
        expect(props.clear_fields.items.enum).not.toContain('title');
    });

    test('real tool validator rejects set_fields.title and accepts top-level title', () => {
        const { tools } = buildDynamicExtractTools(THREAD_SCHEMA, { activeTypes: new Set(['thread']) });

        const badErr = validateParsedToolCalls([{
            name: 'luker_rpg_extract_thread_edit',
            args: { node_id: 'n1', set_fields: { title: 'Renamed' } },
        }], tools);
        expect(badErr).toMatch(/unexpected property/i);

        const okErr = validateParsedToolCalls([{
            name: 'luker_rpg_extract_thread_edit',
            args: { node_id: 'n1', title: 'Renamed', set_fields: { status: 'resolved' } },
        }], tools);
        expect(okErr).toBeNull();
    });

    test('title-only schema omits set_fields and clear_fields so enum is never empty', () => {
        const { tools } = buildDynamicExtractTools([{
            id: 'tag',
            editable: true,
            tableColumns: ['title'],
            requiredColumns: ['title'],
            extractionInstructions: '',
        }], { activeTypes: new Set(['tag']) });

        const edit = toolNamed(tools, 'luker_rpg_extract_tag_edit');
        const props = edit.function.parameters.properties;

        expect(props.title).toEqual({ type: 'string' });
        expect(props.set_fields).toBeUndefined();
        expect(props.clear_fields).toBeUndefined();

        const okErr = validateParsedToolCalls([{
            name: 'luker_rpg_extract_tag_edit',
            args: { node_id: 'n1', title: 'Renamed' },
        }], tools);
        expect(okErr).toBeNull();
    });
});
