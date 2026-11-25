// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

const mockStrip = jest.fn(x => {
    if (!x || typeof x !== 'object') return x;
    const copy = structuredClone(x);
    delete copy.custom_url;
    return copy;
});
const mockGetContext = jest.fn();

jest.unstable_mockModule('/scripts/openai.js', () => ({
    stripOpenAIConnectionFieldsFromPreset: mockStrip,
}));
jest.unstable_mockModule('/scripts/st-context.js', () => ({
    getContext: mockGetContext,
}));

const {
    writeCharacterBoundStateById,
    addCharacterBoundPreset,
    updateCharacterBoundPreset,
} = await import('/scripts/character/presets.js');

describe('character/presets.js synchronous snapshot & strip before async queue', () => {
    let character;
    let queuedRunners;

    beforeEach(() => {
        character = { avatar: 'a.png', data: { extensions: {} } };
        queuedRunners = [];
        mockStrip.mockClear();
        mockGetContext.mockReturnValue({
            characters: [character],
            writeExtensionField: jest.fn((id, ns, value) => new Promise((resolve) => {
                queuedRunners.push(async () => {
                    const card = character;
                    const resolved = typeof value === 'function'
                        ? await value(structuredClone(card.data.extensions[ns]))
                        : value;
                    card.data.extensions[ns] = resolved;
                    resolve(true);
                });
            })),
        });
    });

    async function flushAllQueued() {
        while (queuedRunners.length > 0) {
            const next = queuedRunners.shift();
            await next();
        }
    }

    test('writeCharacterBoundStateById snapshots presets synchronously before queued write runs', async () => {
        const input = {
            presets: [{ name: 'P1', preset: { temperature: 0.7, nested: { a: 1 } } }],
            defaultPresetName: 'P1',
        };

        const pending = writeCharacterBoundStateById(0, input);
        // Mutate caller input BEFORE queued write executes
        input.presets[0].preset.temperature = 9.9;
        input.presets[0].preset.nested.a = 999;
        input.presets.push({ name: 'Injected', preset: {} });

        await flushAllQueued();
        await pending;

        expect(character.data.extensions.luker.chat_completion_preset).toEqual({
            presets: [{ name: 'P1', preset: { temperature: 0.7, nested: { a: 1 } } }],
            defaultPresetName: 'P1',
        });
    });

    test('updateCharacterBoundPreset clones and strips synchronously at invocation time', async () => {
        const addPending = addCharacterBoundPreset(character, 'P1', { temperature: 0.5 });
        await flushAllQueued();
        await addPending;
        mockStrip.mockClear();

        const body = { temperature: 0.9, custom_url: 'https://secret.example', nested: { stop: ['END'] } };
        const updatePending = updateCharacterBoundPreset(character, 'P1', body);

        // Strip must already have happened synchronously before queued callback executes
        expect(mockStrip).toHaveBeenCalledTimes(1);

        // Mutate caller body AFTER invocation but BEFORE queued write executes
        body.temperature = 0.1;
        body.nested.stop.push('MUTATED');

        await flushAllQueued();
        await updatePending;

        expect(character.data.extensions.luker.chat_completion_preset.presets[0].preset).toEqual({
            temperature: 0.9,
            nested: { stop: ['END'] },
        });
    });

    test('addCharacterBoundPreset clones and strips synchronously at invocation time', async () => {
        const body = { temperature: 0.6, custom_url: 'https://secret.example', nested: { k: 'orig' } };
        const pending = addCharacterBoundPreset(character, 'P1', body);

        expect(mockStrip).toHaveBeenCalledTimes(1);
        body.nested.k = 'mutated';

        await flushAllQueued();
        await pending;

        expect(character.data.extensions.luker.chat_completion_preset.presets[0].preset).toEqual({
            temperature: 0.6,
            nested: { k: 'orig' },
        });
    });
});
