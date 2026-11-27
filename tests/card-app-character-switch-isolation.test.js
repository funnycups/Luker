// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, afterAll, jest } from '@jest/globals';

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('CardApp character switch isolation (context.js + index.js)', () => {
    const origLuker = globalThis.Luker;
    const origFetch = globalThis.fetch;
    const origWindow = globalThis.window;

    let listeners;
    let characters;
    let activeCharacterId;
    let updateCharacterDataMock;
    let writeExtensionFieldMock;
    let getCharacterStateMock;
    let setCharacterStateMock;
    let updateCharacterStateMock;
    let deleteCharacterStateMock;
    let deleteCharacterChatMock;
    let getPastCharacterChatsMock;
    let containerCount;
    let mountedContainer;
    let loadEntryModuleMock;
    let showErrorMock;
    let injectScopedCSSMock;
    let destroyContainerMock;
    let createContainerMock;
    let cardAppApi;
    let buildContext;

    beforeAll(async () => {
        listeners = new Map();
        characters = [];
        activeCharacterId = 0;

        updateCharacterDataMock = jest.fn(async () => {});
        writeExtensionFieldMock = jest.fn(async () => true);
        getCharacterStateMock = jest.fn(async () => ({ ok: true, state: null }));
        setCharacterStateMock = jest.fn(async () => ({ ok: true, state: {} }));
        updateCharacterStateMock = jest.fn(async () => ({ ok: true, state: {}, updated: true }));
        deleteCharacterStateMock = jest.fn(async () => ({ ok: true }));
        deleteCharacterChatMock = jest.fn(async () => {});
        getPastCharacterChatsMock = jest.fn(async () => []);

        const eventSource = {
            on(event, fn) {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event).add(fn);
            },
            removeListener(event, fn) {
                listeners.get(event)?.delete(fn);
            },
            async emit(event, ...args) {
                for (const fn of [...(listeners.get(event) || [])]) {
                    await fn(...args);
                }
            },
        };

        globalThis.fetch = jest.fn(async () => ({ ok: false, status: 404, text: async () => '' }));
        globalThis.window = {
            addEventListener: () => {},
            removeEventListener: () => {},
            clearInterval: globalThis.clearInterval,
            clearTimeout: globalThis.clearTimeout,
        };

        globalThis.Luker = {
            getContext: () => ({
                eventSource,
                eventTypes: {
                    CHAT_CHANGED: 'chat_changed',
                    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
                    USER_MESSAGE_RENDERED: 'user_message_rendered',
                    MESSAGE_UPDATED: 'message_updated',
                    MESSAGE_DELETED: 'message_deleted',
                    STREAM_TOKEN_RECEIVED: 'stream_token_received',
                    MESSAGE_SWIPED: 'message_swiped',
                },
                get characterId() {
                    return activeCharacterId;
                },
                characters,
                chat: [],
                chatMetadata: {},
                extensionSettings: {},
                getRequestHeaders: () => ({}),
                registerExtensionApi: (name, api) => {
                    if (name === 'card-app') cardAppApi = api;
                },
                registerCardBindingSlot: () => {},
                getExtensionApi: () => null,
                updateCharacterData: updateCharacterDataMock,
                writeExtensionField: writeExtensionFieldMock,
                getCharacterState: getCharacterStateMock,
                setCharacterState: setCharacterStateMock,
                updateCharacterState: updateCharacterStateMock,
                deleteCharacterState: deleteCharacterStateMock,
                deleteCharacterChat: deleteCharacterChatMock,
                getPastCharacterChats: getPastCharacterChatsMock,
                openCharacterChat: async () => {},
                doNewChat: async () => {},
                closeCurrentChat: async () => {},
                deleteMessage: async () => {},
                deleteLastMessage: async () => {},
                swipe: { right: () => {} },
                saveMetadata: async () => {},
                messageFormatting: (x) => String(x || ''),
                getChatState: async () => ({ ok: true, state: null }),
                updateChatState: async () => ({ ok: true, state: {} }),
                patchChatState: async () => ({ ok: true }),
                deleteChatState: async () => ({ ok: true }),
                renameChat: async () => {},
                setVariable: () => {},
                presets: { listDocuments: () => [], readDocument: async () => null },
                executeSlashCommandsWithOptions: async () => '',
                removeReasoningFromString: (x) => x,
                loadWorldInfo: async () => null,
                worldInfoEntry: { create: () => ({}), delete: () => {} },
                saveWorldInfo: async () => {},
                createWorldBook: async () => {},
                chatWorldInfo: { getNames: () => [], setSelection: () => {} },
                getCharaAuxWorlds: () => [],
                uuidv4: () => 'uuid',
                getCharaFilename: (chid) => String(characters[chid]?.avatar || '').replace(/\.png$/i, ''),
            }),
        };

        containerCount = 0;
        mountedContainer = null;
        createContainerMock = jest.fn(() => {
            containerCount += 1;
            mountedContainer = { id: `container-${containerCount}` };
            return mountedContainer;
        });
        destroyContainerMock = jest.fn(() => {
            mountedContainer = null;
        });
        injectScopedCSSMock = jest.fn();
        loadEntryModuleMock = jest.fn();
        showErrorMock = jest.fn();

        await jest.unstable_mockModule('../public/scripts/extensions/card-app/loader.js', () => ({
            createContainer: createContainerMock,
            destroyContainer: destroyContainerMock,
            injectScopedCSS: injectScopedCSSMock,
            loadEntryModule: loadEntryModuleMock,
            showError: showErrorMock,
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/card-app/i18n.js', () => ({
            i18n: (key) => key,
        }));

        ({ buildContext } = await import('../public/scripts/extensions/card-app/context.js'));
        await import('../public/scripts/extensions/card-app/index.js');
    });

    afterAll(() => {
        globalThis.Luker = origLuker;
        globalThis.fetch = origFetch;
        if (origWindow === undefined) {
            delete globalThis.window;
        } else {
            globalThis.window = origWindow;
        }
    });

    beforeEach(async () => {
        characters.splice(0, characters.length,
            {
                name: 'Alice',
                avatar: 'alice.png',
                data: {
                    name: 'Alice',
                    description: 'Alice original description',
                    extensions: { card_app: { enabled: true, entry: 'index.js' } },
                },
            },
            {
                name: 'Bob',
                avatar: 'bob.png',
                data: {
                    name: 'Bob',
                    description: 'Bob original description',
                    extensions: {},
                },
            },
        );
        activeCharacterId = 1;
        // Reset card-app active state cleanly via CHAT_CHANGED to non-CardApp character
        await globalThis.Luker.getContext().eventSource.emit('chat_changed', 'bob-chat');

        activeCharacterId = 0;
        updateCharacterDataMock.mockClear();
        writeExtensionFieldMock.mockClear();
        getCharacterStateMock.mockClear();
        setCharacterStateMock.mockClear();
        updateCharacterStateMock.mockClear();
        deleteCharacterStateMock.mockClear();
        deleteCharacterChatMock.mockClear();
        getPastCharacterChatsMock.mockClear();
        createContainerMock.mockClear();
        destroyContainerMock.mockClear();
        injectScopedCSSMock.mockClear();
        loadEntryModuleMock.mockReset();
        showErrorMock.mockClear();
    });

    test('ctx.updateCharacterFields and character-scoped helpers target the bound charId even after active character switches', async () => {
        const ctxAlice = buildContext({}, 'alice', {});

        // Switch live characterId to Bob while Alice's ctx is still referenced
        activeCharacterId = 1;

        expect(ctxAlice.getCharacterData()?.avatar).toBe('alice.png');

        await ctxAlice.updateCharacterFields({
            description: 'Alice updated description',
            talkativeness: 0.8,
        });

        expect(updateCharacterDataMock).toHaveBeenCalledTimes(1);
        expect(updateCharacterDataMock).toHaveBeenCalledWith(0, { description: 'Alice updated description' });
        expect(writeExtensionFieldMock).toHaveBeenCalledTimes(1);
        expect(writeExtensionFieldMock).toHaveBeenCalledWith(0, 'talkativeness', 0.8);

        await ctxAlice.setCharacterState('ns', { a: 1 });
        expect(setCharacterStateMock).toHaveBeenCalledWith('alice.png', 'ns', { a: 1 });

        await ctxAlice.updateCharacterState('ns', () => ({ a: 2 }));
        expect(updateCharacterStateMock).toHaveBeenCalledWith('alice.png', 'ns', expect.any(Function), {});

        await ctxAlice.deleteCharacterState('ns');
        expect(deleteCharacterStateMock).toHaveBeenCalledWith('alice.png', 'ns');

        await ctxAlice.deleteChat('chat-1');
        expect(deleteCharacterChatMock).toHaveBeenCalledWith('0', 'chat-1');

        ctxAlice._dispose();
    });

    test('disposed CardApp ctx refuses character writes and never touches any character', async () => {
        const ctxAlice = buildContext({}, 'alice', {});
        ctxAlice._dispose();

        activeCharacterId = 1;

        await expect(ctxAlice.updateCharacterFields({ description: 'stale write' }))
            .rejects.toThrow(/disposed/i);
        await expect(ctxAlice.setCharacterState('ns', { stale: true }))
            .rejects.toThrow(/disposed/i);
        await expect(ctxAlice.updateCharacterState('ns', () => ({ stale: true })))
            .rejects.toThrow(/disposed/i);
        await expect(ctxAlice.deleteCharacterState('ns'))
            .rejects.toThrow(/disposed/i);
        await expect(ctxAlice.deleteChat('chat-1'))
            .rejects.toThrow(/disposed/i);

        expect(updateCharacterDataMock).not.toHaveBeenCalled();
        expect(writeExtensionFieldMock).not.toHaveBeenCalled();
        expect(setCharacterStateMock).not.toHaveBeenCalled();
        expect(updateCharacterStateMock).not.toHaveBeenCalled();
        expect(deleteCharacterStateMock).not.toHaveBeenCalled();
        expect(deleteCharacterChatMock).not.toHaveBeenCalled();
    });

    test('switching to a non-CardApp character while Alice is still loading cancels activation and leaves no container mounted', async () => {
        const aliceModuleDeferred = createDeferred();
        const aliceInit = jest.fn();
        loadEntryModuleMock.mockImplementation(() => aliceModuleDeferred.promise);

        const eventSource = globalThis.Luker.getContext().eventSource;
        activeCharacterId = 0;
        const switchToAlice = eventSource.emit('chat_changed', 'alice-chat');

        // Wait until loadEntryModule is in-flight for Alice
        for (let i = 0; i < 10 && loadEntryModuleMock.mock.calls.length === 0; i++) {
            await Promise.resolve();
        }
        expect(loadEntryModuleMock).toHaveBeenCalledWith('alice', 'index.js');
        expect(mountedContainer).not.toBeNull();

        // Switch to Bob (who has no CardApp) before Alice finishes loading
        activeCharacterId = 1;
        await eventSource.emit('chat_changed', 'bob-chat');

        expect(mountedContainer).toBeNull();
        expect(cardAppApi.isActive()).toBe(false);

        // Now Alice's stale module load finishes
        aliceModuleDeferred.resolve({ init: aliceInit });
        await switchToAlice;

        expect(aliceInit).not.toHaveBeenCalled();
        expect(cardAppApi.isActive()).toBe(false);
        expect(mountedContainer).toBeNull();
    });

    test('switching from CardApp Alice (slow init) to CardApp Bob disposes Alice without tearing down Bob', async () => {
        characters[1].data.extensions.card_app = { enabled: true, entry: 'index.js' };

        const aliceInitDeferred = createDeferred();
        let aliceCtx = null;
        let bobCtx = null;
        const aliceDisposed = jest.fn();
        const bobDisposed = jest.fn();

        loadEntryModuleMock.mockImplementation(async (charId) => {
            if (charId === 'alice') {
                return {
                    init: async (ctx) => {
                        aliceCtx = ctx;
                        ctx.onDispose(aliceDisposed);
                        await aliceInitDeferred.promise;
                    },
                };
            }
            return {
                init: async (ctx) => {
                    bobCtx = ctx;
                    ctx.onDispose(bobDisposed);
                },
            };
        });

        const eventSource = globalThis.Luker.getContext().eventSource;
        activeCharacterId = 0;
        const switchToAlice = eventSource.emit('chat_changed', 'alice-chat');

        // Wait until Alice enters module.init(ctx)
        for (let i = 0; i < 6 && !aliceCtx; i++) {
            await Promise.resolve();
        }
        expect(aliceCtx).not.toBeNull();

        // Switch to Bob while Alice's init() is still awaiting
        activeCharacterId = 1;
        await eventSource.emit('chat_changed', 'bob-chat');

        expect(bobCtx).not.toBeNull();
        expect(cardAppApi.isActive()).toBe(true);
        const bobContainer = mountedContainer;
        expect(bobContainer).not.toBeNull();
        expect(aliceDisposed).toHaveBeenCalledTimes(1);

        // Now Alice's init() finally resolves late
        aliceInitDeferred.resolve();
        await switchToAlice;

        // Bob must stay active and intact; Alice must NOT tear down Bob's container
        expect(cardAppApi.isActive()).toBe(true);
        expect(mountedContainer).toBe(bobContainer);
        expect(bobDisposed).not.toHaveBeenCalled();

        // Even if Alice's stale code still tries to write fields after init resolves, it must be rejected
        await expect(aliceCtx.updateCharacterFields({ description: 'late Alice write' }))
            .rejects.toThrow(/disposed/i);
        expect(updateCharacterDataMock).not.toHaveBeenCalled();
    });
});
