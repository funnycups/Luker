// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { createCharacterPresetsApi } from '/scripts/character/presets-core.js';

describe('character/presets.js synchronous snapshot & strip before async queue', () => {
    let character;
    let queuedRunners;
    let api;

    beforeEach(() => {
        character = { avatar: 'a.png', data: { extensions: {} } };
        queuedRunners = [];
        const ctx = {
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
        };
        api = createCharacterPresetsApi({ getContext: () => ctx });
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

        const pending = api.writeCharacterBoundStateById(0, input);
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
        const addPending = api.addCharacterBoundPreset(character, 'P1', { temperature: 0.5 });
        await flushAllQueued();
        await addPending;

        let getterReads = 0;
        const body = {
            temperature: 0.9,
            nested: { stop: ['END'] },
            get custom_url() {
                getterReads += 1;
                return 'https://secret.example';
            },
        };
        const updatePending = api.updateCharacterBoundPreset(character, 'P1', body);

        // Snapshot & strip must already have read and cloned body synchronously before queued callback executes
        expect(getterReads).toBe(1);

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
        let getterReads = 0;
        const body = {
            temperature: 0.6,
            nested: { k: 'orig' },
            get custom_url() {
                getterReads += 1;
                return 'https://secret.example';
            },
        };
        const pending = api.addCharacterBoundPreset(character, 'P1', body);

        expect(getterReads).toBe(1);
        body.nested.k = 'mutated';

        await flushAllQueued();
        await pending;

        expect(character.data.extensions.luker.chat_completion_preset.presets[0].preset).toEqual({
            temperature: 0.6,
            nested: { k: 'orig' },
        });
    });
});
