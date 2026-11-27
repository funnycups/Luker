// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { compare, applyPatch } from '../../public/scripts/util/fast-json-patch.js';
import { createSettingsSaveCoordinator } from '../../public/scripts/lib/settings-save-coordinator.js';
import { saveSettingsChecked } from '../../public/scripts/workbench/model/patch.js';

describe('settings-save-coordinator saveSettings onSaved ack chain', () => {
    let origFetch;
    let extensionSettings;
    let coordinator;

    beforeEach(() => {
        origFetch = globalThis.fetch;
        extensionSettings = {};
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        coordinator = createSettingsSaveCoordinator({
            buildSettingsPayload: () => structuredClone({ extension_settings: extensionSettings }),
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        });
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        jest.restoreAllMocks();
    });

    test('invokes onSaved when /api/settings/save succeeds so saveSettingsChecked resolves', async () => {
        const calls = [];
        globalThis.fetch = jest.fn(async (url) => {
            calls.push(url);
            return { ok: true, status: 200, statusText: 'OK' };
        });

        await expect(saveSettingsChecked({
            saveSettings: (lc, opts) => coordinator.saveSettings(lc, { ...opts, directSave: true }),
        })).resolves.toBeUndefined();
        expect(calls).toEqual(['/api/settings/save']);
    });

    test('does not invoke onSaved when /api/settings/save returns 500 or throws, so saveSettingsChecked rejects', async () => {
        globalThis.fetch = jest.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' }));
        await expect(saveSettingsChecked({
            saveSettings: (lc, opts) => coordinator.saveSettings(lc, { ...opts, directSave: true }),
        })).rejects.toMatchObject({ code: 'write-failed' });

        globalThis.fetch = jest.fn(async () => { throw new Error('network down'); });
        await expect(saveSettingsChecked({
            saveSettings: (lc, opts) => coordinator.saveSettings(lc, { ...opts, directSave: true }),
        })).rejects.toMatchObject({ code: 'write-failed' });
    });

    test('serializes overlapping saveSettings attempts and invokes each onSaved callback in completion order', async () => {
        const deferred = [];
        const started = Array.from({ length: 3 }, () => Promise.withResolvers());
        const fetchUrls = [];
        globalThis.fetch = jest.fn((url) => {
            fetchUrls.push(url);
            let resolve;
            const promise = new Promise((r) => { resolve = r; });
            deferred.push({ resolve });
            started[deferred.length - 1].resolve();
            return promise;
        });

        const order = [];
        const p1 = coordinator.saveSettings(0, { directSave: true, onSaved: () => order.push('ack1') });
        expect(fetchUrls).toHaveLength(1);

        extensionSettings.wb_queued = { step: 2 };
        const p2 = coordinator.saveSettings(0, { directSave: true, onSaved: () => order.push('ack2') });
        extensionSettings.wb_queued = { step: 3 };
        const p3 = coordinator.saveSettings(0, { directSave: true, onSaved: () => order.push('ack3') });

        expect(fetchUrls).toHaveLength(1);

        deferred[0].resolve({ ok: true, status: 200, statusText: 'OK' });
        await p1;
        await started[1].promise;
        expect(order).toEqual(['ack1']);
        expect(fetchUrls).toHaveLength(2);

        deferred[1].resolve({ ok: true, status: 200, statusText: 'OK' });
        await p2;
        await started[2].promise;
        expect(order).toEqual(['ack1', 'ack2']);
        expect(fetchUrls).toHaveLength(3);

        deferred[2].resolve({ ok: true, status: 200, statusText: 'OK' });
        await Promise.all([p1, p2, p3]);
        expect(order).toEqual(['ack1', 'ack2', 'ack3']);
    });

    test('queued save failure does not invoke failed attempt onSaved callbacks', async () => {
        const deferred = [];
        const started = Array.from({ length: 3 }, () => Promise.withResolvers());
        globalThis.fetch = jest.fn(() => {
            let resolve;
            const promise = new Promise((r) => { resolve = r; });
            deferred.push({ resolve });
            started[deferred.length - 1].resolve();
            return promise;
        });

        const order = [];
        const p1 = coordinator.saveSettings(0, { directSave: true, onSaved: () => order.push('ack1') });
        extensionSettings.wb_queued_fail = { step: 2 };
        const p2 = coordinator.saveSettings(0, { directSave: true, onSaved: () => order.push('ack2') });
        const p3 = coordinator.saveSettings(0, { directSave: true, onSaved: () => order.push('ack3') });

        deferred[0].resolve({ ok: true, status: 200, statusText: 'OK' });
        await p1;
        await started[1].promise;
        expect(order).toEqual(['ack1']);

        deferred[1].resolve({ ok: false, status: 500, statusText: 'Server Error' });
        await p2;
        await started[2].promise;
        expect(order).toEqual(['ack1']);

        deferred[2].resolve({ ok: false, status: 500, statusText: 'Server Error' });
        await Promise.all([p1, p2, p3]);
        expect(order).toEqual(['ack1']);
    });
});

describe('settings-save-coordinator patch authority, deferrals, and refusal contracts', () => {
    let origFetch;

    beforeEach(() => {
        origFetch = globalThis.fetch;
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        jest.restoreAllMocks();
    });

    function createStatefulHarness(overrides = {}) {
        const live = { extension_settings: { ledger: { value: 'baseline' } }, oai_settings: { extensions: {} } };
        let snapshot = null;
        let persisted = null;
        let ready = true;
        let blocked = false;
        let tempOverridden = false;
        let readPublications = 0;
        const scheduled = [];
        const notifications = [];
        const events = [];
        let restoredTemp = 0;

        const coord = createSettingsSaveCoordinator({
            isBlockedForImport: () => blocked,
            isSettingsReady: () => ready,
            scheduleDebouncedSave: (lc, opts) => scheduled.push({ lc, opts }),
            isTempResponseLengthCustomized: () => tempOverridden,
            restoreTempResponseLength: () => {
                restoredTemp += 1;
                tempOverridden = false;
            },
            buildSettingsPayload: () => JSON.parse(JSON.stringify(live)),
            getSettingsSnapshot: () => snapshot,
            rememberSettingsSnapshot: (next) => {
                snapshot = next ? JSON.parse(JSON.stringify(next)) : null;
            },
            onSettingsPersisted: (next) => {
                persisted = next;
            },
            buildObjectPatchOperations: (prev, next) => compare(prev, next),
            applyCommittedSnapshotOperations: (prev, ops) => applyPatch(JSON.parse(JSON.stringify(prev)), ops, true, false).newDocument,
            shouldUseSettingsPatch: (ops) => ops.length > 0,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            incrementReadPublication: () => { readPublications += 1; },
            emitSettingsUpdated: async (info) => {
                events.push(info);
                if (overrides.onEmitSettingsUpdated) {
                    await overrides.onEmitSettingsUpdated(info);
                }
            },
            notifySaveError: (err) => notifications.push(err),
            ...overrides,
        });

        return {
            live,
            coord,
            getSnapshot: () => snapshot,
            getPersisted: () => persisted,
            setReady: (v) => { ready = v; },
            setBlocked: (v) => { blocked = v; },
            setTempOverridden: (v) => { tempOverridden = v; },
            getRestoredTemp: () => restoredTemp,
            getReadPublications: () => readPublications,
            scheduled,
            notifications,
            events,
        };
    }

    test('defers with not_ready, data_import, and temporary_response_length without firing onSaved', async () => {
        const h = createStatefulHarness();
        const fetchMock = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK' }));
        globalThis.fetch = fetchMock;
        const onSaved = jest.fn();

        h.setBlocked(true);
        await expect(h.coord.saveSettings(0, { onSaved })).resolves.toEqual({ ok: false, status: 'deferred', reason: 'data_import' });
        h.setBlocked(false);

        h.setReady(false);
        await expect(h.coord.saveSettings(0, { onSaved })).resolves.toEqual({ ok: false, status: 'deferred', reason: 'not_ready' });
        expect(h.scheduled).toHaveLength(1);
        h.setReady(true);

        h.setTempOverridden(true);
        await expect(h.coord.saveSettings(0, { onSaved })).resolves.toEqual({ ok: false, status: 'deferred', reason: 'temporary_response_length' });
        expect(h.scheduled).toHaveLength(2);
        expect(h.scheduled[1].lc).toBe(1);
        expect(onSaved).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();

        // Reaching retry limit restores temporary override and persists normally.
        const finalOutcome = await h.coord.saveSettings(3, { onSaved });
        expect(h.getRestoredTemp()).toBe(1);
        expect(finalOutcome.ok).toBe(true);
        expect(onSaved).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('preserves repeated/shared object references and isolates returned payloads from stored snapshot', async () => {
        const h = createStatefulHarness();
        const requests = [];
        globalThis.fetch = jest.fn(async (url, init) => {
            requests.push({ url, body: JSON.parse(init.body) });
            return { ok: true, status: 200, statusText: 'OK' };
        });

        const schema = { type: 'object', properties: { ledger: { type: 'string' } } };
        h.live.extension_settings.shared = { first: schema, second: schema };

        const baseline = await h.coord.saveSettings(0, { directSave: true });
        expect(baseline.ok).toBe(true);
        expect(baseline.payload.extension_settings.shared).toEqual({ first: schema, second: schema });
        expect(requests[0].url).toBe('/api/settings/save');

        // Mutating caller's returned outcome.payload or onSettingsPersisted copy must not corrupt coordinator baseline.
        baseline.payload.oai_settings.extensions.sibling = 'tampered';
        h.getPersisted().oai_settings.extensions.sibling = 'tampered-persisted';
        h.live.oai_settings.extensions.sibling = 'tampered';

        const next = await h.coord.saveSettings(0, { asyncDiff: false });
        expect(next.ok).toBe(true);
        expect(requests[1].url).toBe('/api/settings/patch');
        expect(requests[1].body.operations).toContainEqual({ op: 'add', path: '/oai_settings/extensions/sibling', value: 'tampered' });

        // Explicit directSave persists unchanged payload rather than treating it as a no-op.
        const forced = await h.coord.saveSettings(0, { directSave: true });
        expect(forced.ok).toBe(true);
        expect(requests[2].url).toBe('/api/settings/save');
    });

    test('lost response invalidates snapshot so next write sends full /api/settings/save even when reverting to baseline', async () => {
        const h = createStatefulHarness();
        const calls = [];
        let failNext = false;
        globalThis.fetch = jest.fn(async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            if (failNext) {
                failNext = false;
                throw new Error('ConnectionReset');
            }
            return { ok: true, status: 200, statusText: 'OK' };
        });

        // Establish baseline snapshot.
        expect((await h.coord.saveSettings(0, { directSave: true })).ok).toBe(true);
        expect(calls[0].url).toBe('/api/settings/save');

        // Patch request fails after network drop -> snapshot authority cleared.
        h.live.extension_settings.ledger = { value: 'committed' };
        failNext = true;
        const failed = await h.coord.saveSettings(0, { asyncDiff: false });
        expect(failed).toMatchObject({ ok: false, status: 'failed' });
        expect(calls[1].url).toBe('/api/settings/patch');
        expect(h.getSnapshot()).toBeNull();

        // Reverting live state to baseline must send a full /api/settings/save rather than a no-op.
        h.live.extension_settings.ledger = { value: 'baseline' };
        const repaired = await h.coord.saveSettings(0, { asyncDiff: false });
        expect(repaired.ok).toBe(true);
        expect(calls[2].url).toBe('/api/settings/save');
        expect(calls[2].body.extension_settings.ledger).toEqual({ value: 'baseline' });
    });

    test('409 missing-parent patch falls back to full save, while 409 world_deleted/world_deletion_unknown aborts without fallback or losing snapshot', async () => {
        const h = createStatefulHarness();
        const urls = [];
        const queue = [
            async () => ({ ok: true, status: 200, statusText: 'OK' }),
            // Missing-parent 409 (not world_deleted) -> falls back to full save
            async () => ({ ok: false, status: 409, statusText: 'Conflict', json: async () => ({ code: 'patch_conflict' }) }),
            async () => ({ ok: true, status: 200, statusText: 'OK' }),
            // Typed world_deleted 409 -> refuses immediately without full-save retry and preserves snapshot
            async () => ({ ok: false, status: 409, statusText: 'Conflict', json: async () => ({ code: 'world_deleted', details: { name: 'owned-book' } }) }),
            // Typed world_deletion_unknown 409 -> refuses immediately without full-save retry and preserves snapshot
            async () => ({ ok: false, status: 409, statusText: 'Conflict', json: async () => ({ code: 'world_deletion_unknown', details: { name: 'owned-book' } }) }),
        ];
        globalThis.fetch = jest.fn(async (url) => {
            urls.push(url);
            return queue.shift()();
        });

        expect((await h.coord.saveSettings(0, { directSave: true })).ok).toBe(true);

        h.live.extension_settings.ledger = { value: 'fallback' };
        const fallbackRes = await h.coord.saveSettings(0, { asyncDiff: false });
        expect(fallbackRes.ok).toBe(true);
        expect(urls.slice(1)).toEqual(['/api/settings/patch', '/api/settings/save']);

        const ackBeforeRefusal = structuredClone(h.getSnapshot());
        const pubsBeforeRefusal = h.getReadPublications();

        h.live.extension_settings.ledger = { value: 'dangling-1' };
        const deletedRes = await h.coord.saveSettings(0, { asyncDiff: false });
        expect(deletedRes).toMatchObject({ ok: false, status: 'failed' });
        expect(deletedRes.error).toContain('owned-book');
        expect(urls).toEqual(['/api/settings/save', '/api/settings/patch', '/api/settings/save', '/api/settings/patch']);
        expect(h.getSnapshot()).toEqual(ackBeforeRefusal);
        expect(h.getReadPublications()).toBe(pubsBeforeRefusal + 1);

        h.live.extension_settings.ledger = { value: 'dangling-2' };
        const unknownRes = await h.coord.saveSettings(0, { asyncDiff: false });
        expect(unknownRes).toMatchObject({ ok: false, status: 'failed' });
        expect(unknownRes.error).toContain('owned-book');
        expect(urls).toHaveLength(5);
        expect(h.getSnapshot()).toEqual(ackBeforeRefusal);
    });

    test('mixed queued patch/direct and async/sync saves retain per-call options and allow recursive SETTINGS_UPDATED saves', async () => {
        const workerCalls = [];
        let triggeredNested = false;
        let nestedOutcome = null;
        const h = createStatefulHarness({
            diffSerializedSettingsWithWorker: async (prev, serialized) => {
                workerCalls.push(JSON.parse(serialized).extension_settings.ledger.value);
                const next = JSON.parse(serialized);
                return {
                    operations: compare(prev, next),
                    commit: () => {},
                    discard: () => {},
                };
            },
            onEmitSettingsUpdated: async () => {
                if (triggeredNested) return;
                triggeredNested = true;
                h.live.extension_settings.ledger = { value: 'nested' };
                nestedOutcome = await h.coord.saveSettings(0, { asyncDiff: false });
            },
        });

        const urls = [];
        globalThis.fetch = jest.fn(async (url) => {
            urls.push(url);
            return { ok: true, status: 200, statusText: 'OK' };
        });

        // Prime baseline and trigger recursive save inside SETTINGS_UPDATED without deadlocking.
        const outer = await h.coord.saveSettings(0, { directSave: true });
        expect(outer.ok).toBe(true);
        expect(nestedOutcome.ok).toBe(true);
        expect(nestedOutcome.payload.extension_settings.ledger).toEqual({ value: 'nested' });

        // Queue mixed options while first write is in flight.
        urls.length = 0;
        const gates = [];
        globalThis.fetch = jest.fn((url) => {
            urls.push(url);
            const gate = Promise.withResolvers();
            gates.push(gate);
            return gate.promise;
        });

        h.live.extension_settings.ledger = { value: 'async-patch' };
        const p1 = h.coord.saveSettings(0, { directSave: false, asyncDiff: true });
        h.live.extension_settings.ledger = { value: 'sync-full' };
        const p2 = h.coord.saveSettings(0, { directSave: true, asyncDiff: false });
        h.live.extension_settings.ledger = { value: 'sync-patch' };
        const p3 = h.coord.saveSettings(0, { directSave: false, asyncDiff: false });
        h.live.extension_settings.ledger = { value: 'async-full' };
        const p4 = h.coord.saveSettings(0, { directSave: true, asyncDiff: true });

        for (let i = 0; i < 4; i++) {
            while (gates.length <= i) await Promise.resolve();
            gates[i].resolve({ ok: true, status: 200, statusText: 'OK' });
            await Promise.resolve();
        }
        const results = await Promise.all([p1, p2, p3, p4]);
        expect(urls).toEqual(['/api/settings/patch', '/api/settings/save', '/api/settings/patch', '/api/settings/save']);
        expect(results.map(r => r.payload.extension_settings.ledger.value)).toEqual(['async-patch', 'sync-full', 'sync-patch', 'async-full']);
        expect(workerCalls).toEqual(['async-patch']);
    });
});
