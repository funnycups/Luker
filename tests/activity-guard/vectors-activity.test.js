// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createActivityGuardRegistry } from '../../public/scripts/activity-guard.js';
import { createVectorsSyncController } from '../../public/scripts/extensions/vectors/sync-controller.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function makeActivityGuardApi(reg) {
    return Object.freeze({
        acquire: reg.acquireActivityLease,
        run: reg.withActivityLease,
        hasUnloadGuard: reg.hasUnloadGuard,
        hasChatSwitchGuard: reg.hasChatSwitchGuard,
        hasKeepAliveHold: reg.hasKeepAliveHold,
        list: reg.getActiveActivities,
        subscribe: reg.subscribeActivityGuard,
    });
}

describe('Vectors sync controller activity guard leases', () => {
    let registry;
    let activeGuardApi;
    let currentChat;
    let settings;
    let getSavedHashesMock;
    let insertVectorItemsMock;
    let deleteVectorItemsMock;
    let controller;

    beforeEach(() => {
        registry = createActivityGuardRegistry();
        activeGuardApi = makeActivityGuardApi(registry);
        currentChat = [{ mes: 'Hello world', is_system: false }];
        settings = {
            enabled_chats: true,
            keep_hidden: false,
            summarize: false,
            translate_files: false,
            only_custom_boundary: false,
            force_chunk_delimiter: '',
        };
        getSavedHashesMock = jest.fn(async () => []);
        insertVectorItemsMock = jest.fn(async () => {});
        deleteVectorItemsMock = jest.fn(async () => {});

        const context = {
            get chat() {
                return currentChat;
            },
            get activityGuard() {
                return activeGuardApi;
            },
        };

        controller = createVectorsSyncController({
            getSettings: () => settings,
            getContext: () => context,
            getCurrentChatId: () => 'chat-vec-1',
            isSendPress: () => false,
            waitUntilCondition: async () => {},
            substituteParams: (s) => String(s ?? ''),
            getStringHash: (s) => {
                let h = 0;
                for (const ch of String(s ?? '')) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
                return h;
            },
            getSavedHashes: (...args) => getSavedHashesMock(...args),
            summarize: async () => {},
            splitByChunks: (batch) => batch,
            insertVectorItems: (...args) => insertVectorItemsMock(...args),
            deleteVectorItems: (...args) => deleteVectorItemsMock(...args),
            getBatchSize: () => 5,
            getChunkDelimiters: () => ['\n'],
            overlapChunks: (x) => x,
            splitRecursive: (text) => [String(text ?? '')],
            escapeHtml: (s) => String(s ?? ''),
            fatalCauses: new Set(['api_key_missing', 'profile_missing']),
            skippedHashes: new Set(),
            t: (strings, ...values) => strings.reduce((out, str, idx) => out + str + (values[idx] ?? ''), ''),
            getJQuery: () => () => ({ text: () => ({ text: () => {} }) }),
            getToastr: () => ({ info: jest.fn(() => ({})), error: jest.fn(), clear: jest.fn() }),
            getTranslate: () => undefined,
        });
    });

    afterEach(() => {
        const leftover = registry.getActiveActivities();
        if (leftover.length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
        }
    });

    test('synchronizeChat acquires vectors:chat chat-scoped lease and releases on completion and error', async () => {
        const listStarted = deferred();
        const listGate = deferred();
        getSavedHashesMock.mockImplementationOnce(() => {
            listStarted.resolve();
            return listGate.promise;
        });

        const syncPromise = controller.synchronizeChat(5);
        await listStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'vectors:chat',
                label: expect.stringMatching(/\S/),
                scope: 'chat',
                guardUnload: true,
                guardChatSwitch: true,
                keepAlive: true,
            }),
        ]);

        listGate.resolve([]);
        await syncPromise;
        expect(registry.getActiveActivities()).toEqual([]);

        const errStarted = deferred();
        const errGate = deferred();
        getSavedHashesMock.mockResolvedValueOnce([]);
        insertVectorItemsMock.mockImplementationOnce(() => {
            errStarted.resolve();
            return errGate.promise;
        });

        const failedPromise = controller.synchronizeChat(5);
        await errStarted.promise;
        expect(registry.getActiveActivities()).toHaveLength(1);

        errGate.reject(new Error('No embedding key', { cause: 'api_key_missing' }));
        const out = await failedPromise;
        expect(out).toBeNull();
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('vectorizeFile acquires vectors:file global lease and releases on completion and error', async () => {
        const insertStarted = deferred();
        const insertGate = deferred();
        insertVectorItemsMock.mockImplementationOnce(() => {
            insertStarted.resolve();
            return insertGate.promise;
        });

        const runPromise = controller.vectorizeFile('Attachment text', 'notes.txt', 'file_notes', 500, 0);
        await insertStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'vectors:file',
                label: expect.stringMatching(/\S/),
                scope: 'global',
                guardUnload: true,
                guardChatSwitch: false,
                keepAlive: true,
            }),
        ]);

        insertGate.resolve(undefined);
        await expect(runPromise).resolves.toBe(true);
        expect(registry.getActiveActivities()).toEqual([]);

        const errStarted = deferred();
        const errGate = deferred();
        insertVectorItemsMock.mockImplementationOnce(() => {
            errStarted.resolve();
            return errGate.promise;
        });

        const failPromise = controller.vectorizeFile('Attachment text', 'bad.txt', 'file_bad', 500, 0);
        await errStarted.promise;
        expect(registry.getActiveActivities()).toHaveLength(1);

        errGate.reject(new Error('insert failed'));
        await expect(failPromise).resolves.toBe(false);
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('tolerates null activityGuard without crashing', async () => {
        activeGuardApi = null;
        const result = await controller.synchronizeChat(5);
        expect(result).toBe(-4);
    });
});
