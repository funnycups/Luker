// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createExtensionFieldWriter } from '../../public/scripts/lib/extension-field-writer.js';
import { createCharacterPresetsApi } from '../../public/scripts/character/presets-core.js';

globalThis.Luker = {
    getContext: () => ({}),
};

const { ADVANCED_SETTING_DEFAULTS, normalizeAdvancedSettings } =
    await import('../../public/scripts/extensions/memory-graph/config-iteration/advanced-settings.js');
const {
    configure,
    persistCharacterSchemaOverride,
    persistCharacterAdvancedOverride,
    removeCharacterSchemaOverride,
    removeCharacterAdvancedOverride,
} = await import('../../public/scripts/extensions/memory-graph/character-overrides.js');

function setByPath(obj, path, value) {
    const keys = path.split('.');
    let cursor = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!cursor[keys[i]] || typeof cursor[keys[i]] !== 'object') cursor[keys[i]] = {};
        cursor = cursor[keys[i]];
    }
    cursor[keys[keys.length - 1]] = value;
}

function deleteByPath(obj, path) {
    const keys = path.split('.');
    let cursor = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!cursor[keys[i]] || typeof cursor[keys[i]] !== 'object') return;
        cursor = cursor[keys[i]];
    }
    delete cursor[keys[keys.length - 1]];
}

describe('character extension-field mutation concurrency', () => {
    let origFetch;

    beforeEach(() => {
        origFetch = globalThis.fetch;
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        configure({
            MODULE_NAME: 'memory_graph',
            defaultSettings: ADVANCED_SETTING_DEFAULTS,
            normalizeNodeTypeSchema: schema => structuredClone(schema),
            normalizeAdvancedSettings,
            getSettings: () => ({ ...ADVANCED_SETTING_DEFAULTS }),
        });
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        jest.restoreAllMocks();
    });

    function createHarness() {
        const card = {
            avatar: 'mutation-watch.png',
            name: 'Keeper of the Changing Watch',
            data: {
                extensions: {
                    luker: { retained: 'sibling' },
                    memory_graph: { retained: 'sibling' },
                    orchestrator: { activePresetIds: { loop: 'a' } },
                },
            },
        };
        card.json_data = JSON.stringify({ data: structuredClone(card.data) });
        const persisted = structuredClone(card.data.extensions);
        const syncedJson = [];
        const ctx = {
            characters: [card],
            characterId: 0,
            menuType: 'edit',
        };
        const writer = createExtensionFieldWriter({
            getContext: () => ctx,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            cloneAsJsonWire: v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))),
            setValueByPath: setByPath,
            deleteValueByPath: deleteByPath,
            syncActiveCharacterJsonData: json => syncedJson.push(json),
        });
        ctx.writeExtensionField = writer.writeExtensionField;
        const presets = createCharacterPresetsApi({ getContext: () => ctx });
        return { ctx, card, persisted, syncedJson, presets };
    }

    test('concurrent distinct character preset additions compose the complete bound state', async () => {
        const { card, persisted, presets } = createHarness();
        globalThis.fetch = jest.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            Object.assign(persisted, body.data.extensions);
            return { ok: true, status: 200, statusText: 'OK' };
        });

        await Promise.all([
            presets.addCharacterBoundPreset(card, 'Reef', { temperature: 0.3 }),
            presets.addCharacterBoundPreset(card, 'Tide', { temperature: 0.7 }),
        ]);

        const expected = {
            retained: 'sibling',
            chat_completion_preset: {
                presets: [
                    { name: 'Reef', preset: { temperature: 0.3 } },
                    { name: 'Tide', preset: { temperature: 0.7 } },
                ],
                defaultPresetName: 'Reef',
            },
        };
        expect(persisted.luker).toEqual(expected);
        expect(card.data.extensions.luker).toEqual(expected);
        expect(JSON.parse(card.json_data).data.extensions.luker).toEqual(expected);
    });

    test('concurrent memory schema and advanced overrides preserve both siblings', async () => {
        const { ctx, card, persisted } = createHarness();
        globalThis.fetch = jest.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            Object.assign(persisted, body.data.extensions);
            return { ok: true, status: 200, statusText: 'OK' };
        });

        const schema = [{ id: 'watch', label: 'Watch', fields: [] }];
        const results = await Promise.all([
            persistCharacterSchemaOverride(ctx, card.avatar, schema),
            persistCharacterAdvancedOverride(ctx, card.avatar, { extractContextTurns: 8 }),
        ]);

        expect(results).toEqual([true, true]);
        expect(persisted.memory_graph.retained).toBe('sibling');
        expect(Object.keys(persisted.memory_graph).sort()).toEqual(['advancedOverride', 'retained', 'schemaOverride']);
        expect(persisted.memory_graph.schemaOverride).toEqual(schema);
        expect(persisted.memory_graph.advancedOverride.extractContextTurns).toBe(8);
        expect(card.data.extensions.memory_graph).toEqual(persisted.memory_graph);
        expect(JSON.parse(card.json_data).data.extensions.memory_graph).toEqual(persisted.memory_graph);
    });

    test('concurrent writes across different extension namespaces preserve both acknowledged values', async () => {
        const { ctx, card, persisted } = createHarness();
        const gates = [];
        globalThis.fetch = jest.fn((_url, init) => {
            const body = JSON.parse(init.body);
            const gate = Promise.withResolvers();
            gates.push({ body, gate });
            return gate.promise;
        });

        const p1 = persistCharacterAdvancedOverride(ctx, card.avatar, { extractContextTurns: 11 });
        const p2 = ctx.writeExtensionField(0, 'luker', prev => ({ ...prev, retained: 'Dawn watch' }));

        while (gates.length < 2) await Promise.resolve();
        // Complete out of order (second namespace resolves first).
        for (const item of gates.reverse()) {
            Object.assign(persisted, item.body.data.extensions);
            item.gate.resolve({ ok: true, status: 200, statusText: 'OK' });
        }

        await expect(Promise.all([p1, p2])).resolves.toEqual([true, true]);
        expect(persisted.memory_graph.advancedOverride.extractContextTurns).toBe(11);
        expect(persisted.luker).toEqual({ retained: 'Dawn watch' });
        expect(card.data.extensions).toEqual(persisted);
        expect(JSON.parse(card.json_data).data.extensions).toEqual(persisted);
    });

    test('failed first write cannot clobber a subsequent queued write, and replaced card object is not mutated', async () => {
        const { ctx, card, persisted } = createHarness();
        const gates = [];
        globalThis.fetch = jest.fn((_url, init) => {
            const body = JSON.parse(init.body);
            const gate = Promise.withResolvers();
            gates.push({ body, gate });
            return gate.promise;
        });

        const failedFirst = ctx.writeExtensionField(0, 'orchestrator', prev => ({ ...prev, activePresetIds: { loop: 'b' } }));
        const succeededSecond = ctx.writeExtensionField(0, 'orchestrator', prev => ({ ...prev, activePresetIds: { loop: 'b' } }));

        while (gates.length < 1) await Promise.resolve();
        gates[0].gate.resolve({ ok: false, status: 500, statusText: 'Internal Server Error' });
        expect(await failedFirst).toBe(false);

        while (gates.length < 2) await Promise.resolve();
        Object.assign(persisted, gates[1].body.data.extensions);
        gates[1].gate.resolve({ ok: true, status: 200, statusText: 'OK' });
        expect(await succeededSecond).toBe(true);
        expect(card.data.extensions.orchestrator).toEqual({ activePresetIds: { loop: 'b' } });

        // Replacing the character instance in ctx.characters prevents a stale in-flight write from mutating the replaced slot.
        const staleWrite = ctx.writeExtensionField(0, 'luker', prev => ({ ...prev, retained: 'stale' }));
        while (gates.length < 3) await Promise.resolve();
        const freshCard = structuredClone(card);
        ctx.characters[0] = freshCard;
        gates[2].gate.resolve({ ok: true, status: 200, statusText: 'OK' });
        await staleWrite;
        expect(freshCard.data.extensions.luker).toEqual({ retained: 'sibling' });
        expect(card.data.extensions.luker).toEqual({ retained: 'sibling' });
    });

    test('async preparation refuses direct, identical, local, and replace conflicts without writing stale state', async () => {
        for (const change of ['direct', 'identical', 'local', 'replace']) {
            const { ctx, card, persisted } = createHarness();
            card.data.extensions.watch_state = { bell: 'dusk' };
            card.json_data = JSON.stringify({ data: structuredClone(card.data) });
            persisted.watch_state = { bell: 'dusk' };

            const writes = [];
            globalThis.fetch = jest.fn(async (_url, init) => {
                const body = JSON.parse(init.body);
                writes.push(body);
                Object.assign(persisted, body.data.extensions);
                return { ok: true, status: 200, statusText: 'OK' };
            });

            const gate = Promise.withResolvers();
            let calls = 0;
            const prepared = ctx.writeExtensionField(0, 'watch_state', async (value) => {
                calls += 1;
                await gate.promise;
                return { ...value, prepared: true };
            });
            while (calls < 1) await Promise.resolve();

            if (change === 'direct') {
                await expect(ctx.writeExtensionField(0, 'watch_state', { bell: 'midnight' })).resolves.toBe(true);
            } else if (change === 'identical') {
                await expect(ctx.writeExtensionField(0, 'watch_state', card.data.extensions.watch_state)).resolves.toBe(true);
            } else if (change === 'local') {
                card.data.extensions.watch_state = { bell: 'unsent' };
            } else if (change === 'replace') {
                ctx.characters[0] = structuredClone(card);
            }

            const countBeforeRelease = writes.length;
            gate.resolve();
            await expect(prepared).resolves.toBe(false);
            expect(calls).toBe(1);
            expect(writes).toHaveLength(countBeforeRelease);
            expect(persisted.watch_state).toEqual(change === 'direct' ? { bell: 'midnight' } : { bell: 'dusk' });
            const expectedLive = change === 'local' ? { bell: 'unsent' } : persisted.watch_state;
            expect(ctx.characters[0].data.extensions.watch_state).toEqual(expectedLive);
        }
    });

    test('legacy single-preset read while addition is pending preserves the acknowledged new preset', async () => {
        const { ctx, card, persisted, presets } = createHarness();
        globalThis.fetch = jest.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            Object.assign(persisted, body.data.extensions);
            return { ok: true, status: 200, statusText: 'OK' };
        });

        await ctx.writeExtensionField(0, 'luker', {
            retained: 'sibling',
            chat_completion_preset: { name: 'Legacy', preset: { temperature: 0.2 } },
        });
        const pending = presets.addCharacterBoundPreset(card, 'New', { temperature: 0.8 });
        presets.listCharacterBoundPresets(card);
        await pending;
        await ctx.writeExtensionField(0, 'luker', value => value);

        const expected = {
            retained: 'sibling',
            chat_completion_preset: {
                presets: [
                    { name: 'Legacy', preset: { temperature: 0.2 } },
                    { name: 'New', preset: { temperature: 0.8 } },
                ],
                defaultPresetName: 'Legacy',
            },
        };
        expect(persisted.luker).toEqual(expected);
        expect(card.data.extensions.luker).toEqual(expected);
    });

    test('same-tick and pending memory-graph override save then remove leave the override absent', async () => {
        for (const kind of ['schema', 'advanced']) {
            for (const mode of ['same-tick', 'pending-http']) {
                const { ctx, card, persisted } = createHarness();
                const gates = [];
                globalThis.fetch = jest.fn((_url, init) => {
                    const body = JSON.parse(init.body);
                    if (mode === 'pending-http') {
                        const gate = Promise.withResolvers();
                        gates.push({ body, gate });
                        return gate.promise;
                    }
                    Object.assign(persisted, body.data.extensions);
                    return Promise.resolve({ ok: true, status: 200, statusText: 'OK' });
                });

                const schema = [{ id: 'watch', label: 'Watch', fields: [] }];
                const save = kind === 'schema'
                    ? persistCharacterSchemaOverride(ctx, card.avatar, schema)
                    : persistCharacterAdvancedOverride(ctx, card.avatar, { extractContextTurns: 9 });
                if (mode === 'pending-http') {
                    while (gates.length < 1) await Promise.resolve();
                }
                const remove = kind === 'schema'
                    ? removeCharacterSchemaOverride(ctx, card.avatar)
                    : removeCharacterAdvancedOverride(ctx, card.avatar);

                if (mode === 'pending-http') {
                    Object.assign(persisted, gates[0].body.data.extensions);
                    gates[0].gate.resolve({ ok: true, status: 200, statusText: 'OK' });
                    while (gates.length < 2) await Promise.resolve();
                    Object.assign(persisted, gates[1].body.data.extensions);
                    gates[1].gate.resolve({ ok: true, status: 200, statusText: 'OK' });
                }

                await expect(Promise.all([save, remove])).resolves.toEqual([true, true]);
                expect(persisted.memory_graph).toEqual({ retained: 'sibling' });
                expect(card.data.extensions.memory_graph).toEqual({ retained: 'sibling' });
            }
        }
    });

    test('preparation rejection releases queued mutations, distinct keys/characters do not block, and direct writes serialize cleanly', async () => {
        const { ctx, card, persisted } = createHarness();
        const otherCard = {
            avatar: 'independent-watch.png',
            name: 'Keeper of the Independent Watch',
            data: { extensions: { watch_state: { bell: 'dawn' } } },
            json_data: JSON.stringify({ data: { extensions: { watch_state: { bell: 'dawn' } } } }),
        };
        ctx.characters.push(otherCard);
        card.data.extensions.watch_state = { bell: 'dusk' };
        persisted.watch_state = { bell: 'dusk' };

        const gates = [];
        let holdFetch = false;
        globalThis.fetch = jest.fn((_url, init) => {
            const body = JSON.parse(init.body);
            if (holdFetch) {
                const gate = Promise.withResolvers();
                gates.push({ body, gate });
                return gate.promise;
            }
            if (body.avatar === card.avatar) Object.assign(persisted, body.data.extensions);
            return Promise.resolve({ ok: true, status: 200, statusText: 'OK' });
        });

        // Blocking preparation on watch_state must not block another key or another character.
        const prepGate = Promise.withResolvers();
        const held = ctx.writeExtensionField(0, 'watch_state', async (value) => {
            await prepGate.promise;
            return { ...value, prepared: true };
        });
        await expect(ctx.writeExtensionField(0, 'other_state', value => ({ ...value, saved: true }))).resolves.toBe(true);
        await expect(ctx.writeExtensionField(1, 'watch_state', value => ({ ...value, independent: true }))).resolves.toBe(true);
        expect(persisted.other_state).toEqual({ saved: true });
        expect(otherCard.data.extensions.watch_state).toEqual({ bell: 'dawn', independent: true });
        prepGate.resolve();
        await expect(held).resolves.toBe(true);

        // Rejection inside preparation releases the queue for the next mutation.
        const rejected = ctx.writeExtensionField(0, 'watch_state', () => { throw new Error('Preparation failed'); });
        const afterReject = ctx.writeExtensionField(0, 'watch_state', value => ({ ...value, next: true }));
        await expect(rejected).rejects.toThrow('Preparation failed');
        await expect(afterReject).resolves.toBe(true);
        expect(persisted.watch_state.next).toBe(true);

        // Queued updater waits for in-flight direct write before reading base; failed second direct write preserves first.
        holdFetch = true;
        const firstDirect = ctx.writeExtensionField(0, 'watch_state', { bell: 'reset' });
        let queuedRead = null;
        const queuedUpdater = ctx.writeExtensionField(0, 'watch_state', value => {
            queuedRead = structuredClone(value);
            return { ...value, queued: true };
        });
        while (gates.length < 1) await Promise.resolve();
        expect(queuedRead).toBeNull();
        Object.assign(persisted, gates[0].body.data.extensions);
        gates[0].gate.resolve({ ok: true, status: 200, statusText: 'OK' });
        while (gates.length < 2) await Promise.resolve();
        expect(queuedRead).toEqual({ bell: 'reset' });
        Object.assign(persisted, gates[1].body.data.extensions);
        gates[1].gate.resolve({ ok: true, status: 200, statusText: 'OK' });
        await expect(Promise.all([firstDirect, queuedUpdater])).resolves.toEqual([true, true]);
        expect(persisted.watch_state).toEqual({ bell: 'reset', queued: true });

        const okWrite = ctx.writeExtensionField(0, 'watch_state', { bell: 'first' });
        const failWrite = ctx.writeExtensionField(0, 'watch_state', { bell: 'second' });
        while (gates.length < 3) await Promise.resolve();
        Object.assign(persisted, gates[2].body.data.extensions);
        gates[2].gate.resolve({ ok: true, status: 200, statusText: 'OK' });
        while (gates.length < 4) await Promise.resolve();
        gates[3].gate.resolve({ ok: false, status: 500, statusText: 'Internal Server Error' });
        await expect(Promise.all([okWrite, failWrite])).resolves.toEqual([true, false]);
        expect(persisted.watch_state).toEqual({ bell: 'first' });
        expect(card.data.extensions.watch_state).toEqual({ bell: 'first' });
    });
});
