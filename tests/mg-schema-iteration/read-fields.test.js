// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Pins the contract of `dispatchMgSchemaReadFields`, the executor helper
// for the MG schema iter-studio's `mg_schema_read_fields` tool. The
// dispatcher is a thin wrapper over the shared
// `iteration-library/read-fields-helper.js` and runs against the live
// schema array (an ordered list of node-type definitions).
//
// Tested here directly instead of through studio.js so we can pin
// contract without dragging studio.js's ST-context / jQuery import
// graph into jest (studio.js reads `Luker.getContext()` at module
// load).
//
// Path semantics: root is the schema array, so paths use lodash-style
// numeric-index notation (`[0].id`, `[1].tableColumns[0]`, `length`).

import { describe, test, expect } from '@jest/globals';
import { dispatchMgSchemaReadFields } from '../../public/scripts/extensions/memory-graph/schema-iteration/read-fields-dispatcher.js';

const sampleSchema = Object.freeze([
    Object.freeze({
        id: 'event',
        label: 'Event',
        tableName: 'events',
        tableColumns: ['title', 'when', 'summary'],
        keywords: ['event'],
        extractionInstructions: 'One event per meaningful moment.',
    }),
    Object.freeze({
        id: 'character_sheet',
        label: 'Character sheet',
        tableName: 'characters',
        tableColumns: ['name', 'aliases', 'personality'],
        primaryKeyColumns: ['name'],
        alwaysInject: false,
    }),
]);

function cloneSchema() {
    // structuredClone works but frozen entries survive; using JSON
    // round-trip gives a plain-object copy each test can mutate.
    return JSON.parse(JSON.stringify(sampleSchema));
}

describe('dispatchMgSchemaReadFields — schema-array shape', () => {
    test('reads simple, nested, and array-indexed paths', async () => {
        const out = await dispatchMgSchemaReadFields({
            liveSchema: cloneSchema(),
            args: { paths: ['[0].id', '[1].tableColumns', '[0].tableColumns[1]', 'length'] },
        });
        expect(out['[0].id']).toBe('event');
        expect(out['[1].tableColumns']).toEqual(['name', 'aliases', 'personality']);
        expect(out['[0].tableColumns[1]']).toBe('when');
        expect(out['length']).toBe(2);
        expect(out.missing_paths).toEqual([]);
    });

    test('unknown path returns null + adds to missing_paths', async () => {
        const out = await dispatchMgSchemaReadFields({
            liveSchema: cloneSchema(),
            args: { paths: ['[0].id', '[99].id', '[0].nonexistent_field'] },
        });
        expect(out['[0].id']).toBe('event');
        expect(out['[99].id']).toBeNull();
        expect(out['[0].nonexistent_field']).toBeNull();
        expect(out.missing_paths.sort()).toEqual(['[0].nonexistent_field', '[99].id'].sort());
    });

    test('value > 5KB is returned verbatim (no size-based truncation)', async () => {
        const schema = cloneSchema();
        schema[0].extractionInstructions = 'x'.repeat(6000);
        const out = await dispatchMgSchemaReadFields({
            liveSchema: schema,
            args: { paths: ['[0].extractionInstructions'] },
        });
        expect(out['[0].extractionInstructions']).toBe('x'.repeat(6000));
    });

    test('empty paths array returns empty map with missing_paths=[]', async () => {
        const out = await dispatchMgSchemaReadFields({
            liveSchema: cloneSchema(),
            args: { paths: [] },
        });
        expect(out.missing_paths).toEqual([]);
        expect(Object.keys(out).filter((k) => k !== 'missing_paths')).toEqual([]);
    });

    test('non-array paths throws invalid_args', async () => {
        await expect(
            dispatchMgSchemaReadFields({
                liveSchema: cloneSchema(),
                args: { paths: 'not an array' },
            }),
        ).rejects.toThrow(/invalid_args/);
    });

    test('missing liveSchema is treated as empty array (all paths miss)', async () => {
        const out = await dispatchMgSchemaReadFields({ args: { paths: ['[0].id', 'length'] } });
        expect(out['[0].id']).toBeNull();
        // `length` of an empty array is 0 — that's a real defined value,
        // not a miss.
        expect(out['length']).toBe(0);
        expect(out.missing_paths).toEqual(['[0].id']);
    });

    test('reads a whole node-type entry when path points at the array element', async () => {
        const out = await dispatchMgSchemaReadFields({
            liveSchema: cloneSchema(),
            args: { paths: ['[1]'] },
        });
        expect(out['[1]']).toEqual(expect.objectContaining({
            id: 'character_sheet',
            tableColumns: ['name', 'aliases', 'personality'],
        }));
    });
});
