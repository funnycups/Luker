// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { jest } from '@jest/globals';

const {
    readOrchestratorCardOverride,
    hasOrchestratorCardOverride,
    summarizeOrchestratorCardOverride,
    buildOrchestratorOverlay,
    registerOrchestratorCardBindingSlot,
} = await import('/scripts/extensions/orchestrator/card-binding-slot.js');

test('read keeps only override keys and ignores siblings', () => {
    const character = {
        data: {
            extensions: {
                orchestrator: {
                    customTools: [{ name: 'x' }],
                    presetLibraries: { spec: { default: { name: 'P' } } },
                    activePresetIds: { spec: 'default' },
                },
            },
        },
    };
    expect(readOrchestratorCardOverride(character)).toEqual({
        presetLibraries: { spec: { default: { name: 'P' } } },
        activePresetIds: { spec: 'default' },
    });
});

test('read returns null when the card has no override content', () => {
    expect(readOrchestratorCardOverride({})).toBeNull();
    expect(readOrchestratorCardOverride({ data: { extensions: { orchestrator: { customTools: [] } } } })).toBeNull();
});

test('isPresent detects new and legacy shapes', () => {
    expect(hasOrchestratorCardOverride({ presetLibraries: { spec: { default: {} } } })).toBe(true);
    expect(hasOrchestratorCardOverride({ activePresetIds: { agenda: 'a1' } })).toBe(true);
    expect(hasOrchestratorCardOverride({ override: { mode: 'spec' } })).toBe(true);
    expect(hasOrchestratorCardOverride({ override: { spec: { systemPrompt: 'x' } } })).toBe(true);
    expect(hasOrchestratorCardOverride({ overrideEnabled: { loop: true } })).toBe(true);
    expect(hasOrchestratorCardOverride({ presetLibraries: { spec: {} }, activePresetIds: {} })).toBe(false);
    expect(hasOrchestratorCardOverride(null)).toBe(false);
});

test('summarize lists the configured mode names', () => {
    const summary = summarizeOrchestratorCardOverride({
        presetLibraries: { spec: { default: {} }, agenda: { a: {} } },
    });
    expect(summary).toContain('spec');
    expect(summary).toContain('agenda');
});

test('overlay keeps new-card siblings and copies only preserved keys', () => {
    const next = buildOrchestratorOverlay({ customTools: [{ name: 'new' }] }, { override: { mode: 'spec' } });
    expect(next.customTools).toEqual([{ name: 'new' }]);
    expect(next.override).toEqual({ mode: 'spec' });
    expect(next.presetLibraries).toBeUndefined();
});

test('register wires a working descriptor', async () => {
    const context = {
        registerCardBindingSlot: jest.fn(),
        characters: [{
            avatar: 'a.png',
            data: { extensions: { orchestrator: { customTools: [{ name: 'keep' }] } } },
        }],
        writeExtensionField: jest.fn(async () => {}),
    };
    registerOrchestratorCardBindingSlot(context);
    expect(context.registerCardBindingSlot).toHaveBeenCalledTimes(1);
    const descriptor = context.registerCardBindingSlot.mock.calls[0][0];
    expect(descriptor.id).toBe('orchestrator-override');

    await descriptor.write(0, { override: { mode: 'spec' } });
    expect(context.writeExtensionField).toHaveBeenCalledWith(0, 'orchestrator', expect.objectContaining({
        customTools: [{ name: 'keep' }],
        override: { mode: 'spec' },
    }));
});
