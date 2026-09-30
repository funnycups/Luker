// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { jest } from '@jest/globals';

const {
    readMemoryGraphCardOverride,
    hasMemoryGraphCardOverride,
    summarizeMemoryGraphCardOverride,
    registerMemoryGraphCardBindingSlot,
} = await import('/scripts/extensions/memory-graph/card-binding-slot.js');

test('read keeps only the schema and advanced override keys', () => {
    const character = {
        data: {
            extensions: {
                memory_graph: {
                    unrelated: true,
                    schemaOverride: [{ id: 'tide' }],
                    advancedOverride: { recallTopN: 7 },
                },
            },
        },
    };
    expect(readMemoryGraphCardOverride(character)).toEqual({
        schemaOverride: [{ id: 'tide' }],
        advancedOverride: { recallTopN: 7 },
    });
});

test('read returns null when no override is present', () => {
    expect(readMemoryGraphCardOverride({})).toBeNull();
    expect(readMemoryGraphCardOverride({ data: { extensions: { memory_graph: { unrelated: 1 } } } })).toBeNull();
});

test('isPresent requires non-empty values', () => {
    expect(hasMemoryGraphCardOverride({ schemaOverride: [{ id: 'x' }] })).toBe(true);
    expect(hasMemoryGraphCardOverride({ advancedOverride: { recallTopN: 7 } })).toBe(true);
    expect(hasMemoryGraphCardOverride({ schemaOverride: [], advancedOverride: {} })).toBe(false);
    expect(hasMemoryGraphCardOverride(null)).toBe(false);
});

test('summarize distinguishes schema, advanced, and both', () => {
    expect(summarizeMemoryGraphCardOverride({ schemaOverride: [{}] })).toContain('schema');
    expect(summarizeMemoryGraphCardOverride({ advancedOverride: { a: 1 } })).toContain('advanced');
    expect(summarizeMemoryGraphCardOverride({ schemaOverride: [{}], advancedOverride: { a: 1 } })).toContain('+');
});

test('register wires a descriptor that persists each preserved key', async () => {
    const context = {
        registerCardBindingSlot: jest.fn(),
        characters: [{ avatar: 'a.png', data: { extensions: { memory_graph: {} } } }],
        writeExtensionField: jest.fn(async () => {}),
    };
    registerMemoryGraphCardBindingSlot(context);
    const descriptor = context.registerCardBindingSlot.mock.calls[0][0];
    expect(descriptor.id).toBe('memory-graph-override');

    await descriptor.write(0, { schemaOverride: [{ id: 'tide' }], advancedOverride: { recallTopN: 7 } });
    const writes = context.writeExtensionField.mock.calls.filter(call => call[1] === 'memory_graph');
    expect(writes).toHaveLength(2);
    expect(writes[0][2].schemaOverride).toEqual([{ id: 'tide' }]);
    expect(writes[1][2].advancedOverride).toEqual({ recallTopN: 7 });
});

test('write skips an empty schema override beside a non-empty advanced override', async () => {
    const context = {
        registerCardBindingSlot: jest.fn(),
        characters: [{ avatar: 'a.png', data: { extensions: { memory_graph: {} } } }],
        writeExtensionField: jest.fn(async () => {}),
    };
    registerMemoryGraphCardBindingSlot(context);
    const descriptor = context.registerCardBindingSlot.mock.calls[0][0];

    await descriptor.write(0, { schemaOverride: [], advancedOverride: { recallTopN: 7 } });
    const writes = context.writeExtensionField.mock.calls.filter(call => call[1] === 'memory_graph');
    expect(writes).toHaveLength(1);
    expect(writes[0][2].advancedOverride).toEqual({ recallTopN: 7 });
    expect(writes[0][2]).not.toHaveProperty('schemaOverride');
});

test('write skips an empty advanced override beside a non-empty schema override', async () => {
    const context = {
        registerCardBindingSlot: jest.fn(),
        characters: [{ avatar: 'a.png', data: { extensions: { memory_graph: {} } } }],
        writeExtensionField: jest.fn(async () => {}),
    };
    registerMemoryGraphCardBindingSlot(context);
    const descriptor = context.registerCardBindingSlot.mock.calls[0][0];

    await descriptor.write(0, { schemaOverride: [{ id: 'tide' }], advancedOverride: {} });
    const writes = context.writeExtensionField.mock.calls.filter(call => call[1] === 'memory_graph');
    expect(writes).toHaveLength(1);
    expect(writes[0][2].schemaOverride).toEqual([{ id: 'tide' }]);
    expect(writes[0][2]).not.toHaveProperty('advancedOverride');
});
