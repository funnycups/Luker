// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createExtensionFieldWriter } from '../../public/scripts/lib/extension-field-writer.js';

function deleteByPath(obj, path) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!cur || typeof cur !== 'object') return;
        cur = cur[parts[i]];
    }
    if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}

function setByPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function makeResponse(ok, body = null, status = ok ? 200 : 500) {
    return {
        ok,
        status,
        statusText: ok ? 'OK' : 'Internal Server Error',
        json: async () => body,
    };
}

describe('extension-field-writer writeExtensionField & writeExtensionFieldBulk concurrency', () => {
    let liveState;
    let writeExtensionField;
    let writeExtensionFieldBulk;
    let origFetch;

    beforeEach(() => {
        origFetch = globalThis.fetch;
        liveState = {
            characters: [
                { avatar: 'alice.png', data: { extensions: { mod: { v: 0 } } } },
                { avatar: 'bob.png', data: { extensions: { mod: { v: 0 } } } },
            ],
            characterId: 0,
            menuType: '',
        };
        ({ writeExtensionField, writeExtensionFieldBulk } = createExtensionFieldWriter({
            getContext: () => liveState,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            cloneAsJsonWire: (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))),
            setValueByPath: setByPath,
            deleteValueByPath: deleteByPath,
        }));
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
    });

    test('writeExtensionField publishes locally even when character index shifts while request is in flight', async () => {
        const alice = liveState.characters[0];
        const bob = liveState.characters[1];
        const gate = deferred();

        globalThis.fetch = jest.fn(async () => {
            await gate.promise;
            return makeResponse(true);
        });

        const pending = writeExtensionField(0, 'mod', { v: 1 });
        // Shift characters array so Alice moves from index 0 -> 1 before ack
        liveState.characters.splice(0, 2, bob, alice);
        liveState.characterId = 1;

        gate.resolve();
        const ok = await pending;
        expect(ok).toBe(true);
        expect(alice.data.extensions.mod).toEqual({ v: 1 });
        expect(bob.data.extensions.mod).toEqual({ v: 0 });
    });

    test('writeExtensionField callback form survives index shift and still refuses removed/replaced character', async () => {
        const alice = liveState.characters[0];
        const bob = liveState.characters[1];
        globalThis.fetch = jest.fn(async () => makeResponse(true));

        const callbackGate = deferred();
        const pending = writeExtensionField(0, 'mod', async (cur) => {
            await callbackGate.promise;
            return { v: (cur?.v ?? 0) + 10 };
        });

        // Reindex Alice from 0 -> 1 during async callback
        liveState.characters.splice(0, 2, bob, alice);
        callbackGate.resolve();
        expect(await pending).toBe(true);
        expect(alice.data.extensions.mod).toEqual({ v: 10 });

        // Replace Alice with a freshly loaded object during another write -> must NOT publish onto stale object
        const staleAlice = alice;
        const freshAlice = { avatar: 'alice.png', data: { extensions: { mod: { v: 99 } } } };
        const removeGate = deferred();
        globalThis.fetch = jest.fn(async () => {
            await removeGate.promise;
            return makeResponse(true);
        });
        const stalePending = writeExtensionField(1, 'mod', { v: 20 });
        liveState.characters[1] = freshAlice;
        removeGate.resolve();
        await stalePending;
        expect(staleAlice.data.extensions.mod).toEqual({ v: 10 });
        expect(freshAlice.data.extensions.mod).toEqual({ v: 99 });
    });

    test('writeExtensionFieldBulk drains chained single persists until truly settled before issuing bulk fetch', async () => {
        const gate1 = deferred();
        const gate2 = deferred();
        const events = [];

        globalThis.fetch = jest.fn(async (_url, init) => {
            const parsed = JSON.parse(init.body);
            if (Array.isArray(parsed.avatars)) {
                events.push('bulk:start');
                return makeResponse(true, { updated: ['alice.png'], skipped: [], failed: [] });
            }
            const tag = parsed.data.extensions.mod.tag;
            events.push(`single:${tag}:start`);
            if (tag === 'first') await gate1.promise;
            if (tag === 'second') await gate2.promise;
            events.push(`single:${tag}:end`);
            return makeResponse(true);
        });

        const single1 = writeExtensionField(0, 'mod', { tag: 'first' });
        const bulk = writeExtensionFieldBulk(['alice.png'], 'mod', { tag: 'bulk' });

        // Queue a second single persist BEFORE single1 finishes (classic TOCTOU window)
        const single2 = writeExtensionField(0, 'mod', { tag: 'second' });

        gate1.resolve();
        await single1;
        // Let microtasks turn; single2 is now in flight, so bulk MUST NOT have started yet
        await Promise.resolve();
        await Promise.resolve();
        expect(events).not.toContain('bulk:start');

        gate2.resolve();
        await single2;
        await bulk;

        expect(events).toEqual([
            'single:first:start',
            'single:first:end',
            'single:second:start',
            'single:second:end',
            'bulk:start',
        ]);
        expect(liveState.characters[0].data.extensions.mod).toEqual({ tag: 'bulk' });
    });

    test('writeExtensionFieldBulk still publishes locally when a single write queues behind it', async () => {
        const bulkGate = deferred();
        const singleGate = deferred();
        let singleShouldFail = true;

        globalThis.fetch = jest.fn(async (_url, init) => {
            const parsed = JSON.parse(init.body);
            if (Array.isArray(parsed.avatars)) {
                await bulkGate.promise;
                return makeResponse(true, { updated: ['alice.png'], skipped: [], failed: [] });
            }
            await singleGate.promise;
            return makeResponse(!singleShouldFail);
        });

        const bulk = writeExtensionFieldBulk(['alice.png'], 'mod', { v: 'from-bulk' });
        // Wait a tick so bulk has claimed ownership and started fetch
        await Promise.resolve();

        // Queue a single write behind the in-flight bulk request (it overwrites `writes`, NOT `persistTokens`)
        const queuedSingle = writeExtensionField(0, 'mod', { v: 'from-failed-single' });

        // Bulk completes first; it MUST publish `{ v: 'from-bulk' }` locally even though `queuedSingle` is behind it
        bulkGate.resolve();
        await bulk;
        expect(liveState.characters[0].data.extensions.mod).toEqual({ v: 'from-bulk' });

        // Now queued single fails -> local state stays at server-acknowledged bulk value (not pre-bulk `{ v: 0 }`)
        singleGate.resolve();
        expect(await queuedSingle).toBe(false);
        expect(liveState.characters[0].data.extensions.mod).toEqual({ v: 'from-bulk' });
    });
});
