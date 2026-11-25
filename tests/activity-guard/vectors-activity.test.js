/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { createActivityGuardRegistry } from '../../public/scripts/activity-guard.js';

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

let registry;
let activeGuardApi = null;
let capturedWorkerCallback = null;
let currentChatId = 'chat-vec-1';
let currentChat = [];
let embeddingProfile = { id: 'emb-1', source: 'openai', model: 'text-embedding-3-small' };
let extensionSettingsMock;

const embeddingServiceMock = {
    listHashes: jest.fn(async () => []),
    insert: jest.fn(async () => {}),
    deleteByHashes: jest.fn(async () => {}),
    query: jest.fn(async () => ({ hashes: [], metadata: [] })),
    queryMulti: jest.fn(async () => ({})),
    rerank: jest.fn(async ({ documents }) => documents),
    purgeCollection: jest.fn(async () => {}),
};

beforeAll(async () => {
    const noop = () => {};
    extensionSettingsMock = {
        vectors: {
            embeddingProfileId: 'emb-1',
            enabled_chats: true,
            enabled_files: true,
            size_threshold: 0,
            chunk_size: 500,
            chunk_count: 2,
            overlap_percent: 0,
            summary_prompt: 'Summarize',
        },
    };

    const eventSourceMock = {
        on: jest.fn(),
        off: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(async () => {}),
    };

    const contextMock = {
        get chat() {
            return currentChat;
        },
        get activityGuard() {
            return activeGuardApi;
        },
    };

    globalThis.toastr = {
        info: jest.fn(() => ({})),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        clear: jest.fn(),
    };

    const jqChain = new Proxy(function () {}, {
        get(_t, prop) {
            if (prop === 'then') return undefined;
            if (prop === 'length') return 0;
            return () => jqChain;
        },
        apply() { return jqChain; },
    });
    globalThis.jQuery = Object.assign(() => jqChain, { __chain: jqChain });
    globalThis.$ = globalThis.jQuery;

    jest.unstable_mockModule('../../public/script.js', () => ({
        eventSource: eventSourceMock,
        event_types: {
            MESSAGE_DELETED: 'message_deleted',
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_SENT: 'message_sent',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_SWIPED: 'message_swiped',
            CHAT_DELETED: 'chat_deleted',
            GROUP_CHAT_DELETED: 'group_chat_deleted',
            FILE_ATTACHMENT_DELETED: 'file_attachment_deleted',
            CONNECTION_PROFILE_CREATED: 'connection_profile_created',
            CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
            CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
        },
        extension_prompt_types: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
        extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        getCurrentChatId: () => currentChatId,
        getRequestHeaders: () => ({}),
        is_send_press: false,
        saveSettingsDebounced: noop,
        setExtensionPrompt: noop,
        substituteParams: (s) => String(s ?? ''),
        generateRaw: async () => 'summary',
        substituteParamsExtended: (s) => String(s ?? ''),
    }));

    jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
        ModuleWorkerWrapper: class {
            constructor(callback) {
                capturedWorkerCallback = callback;
            }
            async update(...args) {
                return await capturedWorkerCallback(...args);
            }
        },
        extension_settings: extensionSettingsMock,
        getContext: () => contextMock,
        renderExtensionTemplateAsync: async () => '',
    }));

    jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
        collapseNewlines: (s) => String(s ?? ''),
        registerDebugFunction: noop,
    }));

    jest.unstable_mockModule('../../public/scripts/chats.js', () => ({
        getDataBankAttachments: () => [],
        getDataBankAttachmentsForSource: () => [],
        getFileAttachment: async () => 'File body',
    }));

    jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
        debounce: (fn) => fn,
        getStringHash: (s) => {
            let h = 0;
            for (const ch of String(s ?? '')) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
            return h;
        },
        waitUntilCondition: async () => {},
        onlyUnique: (v, i, a) => a.indexOf(v) === i,
        splitRecursive: (text) => [String(text ?? '')],
        trimToStartSentence: (s) => s,
        trimToEndSentence: (s) => s,
        escapeHtml: (s) => String(s ?? ''),
        isTrueBoolean: (v) => v === true || v === 'true',
        uuidv4: () => 'uuid-v4',
    }));

    jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
        getSortedEntries: async () => [],
    }));

    jest.unstable_mockModule('../../public/scripts/textgen-settings.js', () => ({
        textgen_types: {},
        textgenerationwebui_settings: { server_urls: {} },
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
        SlashCommandParser: { addCommandObject: noop },
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
        SlashCommand: { fromProps: (x) => x },
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
        ARGUMENT_TYPE: {},
        SlashCommandArgument: Object.assign(class {}, { fromProps: (x) => x }),
        SlashCommandNamedArgument: Object.assign(class {}, { fromProps: (x) => x }),
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
        SlashCommandEnumValue: class {},
        enumTypes: {},
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
        commonEnumProviders: { boolean: () => () => [] },
    }));

    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandReturnHelper.js', () => ({
        slashCommandReturnHelper: { enumList: () => [], doReturn: (_t, x) => x },
    }));

    jest.unstable_mockModule('../../public/scripts/extensions/shared.js', () => ({
        generateWebLlmChatPrompt: async () => '',
        isWebLlmSupported: () => false,
    }));

    jest.unstable_mockModule('../../public/scripts/extensions/vectors/webllm.js', () => ({
        WebLlmVectorProvider: class {},
    }));

    jest.unstable_mockModule('../../public/scripts/reasoning.js', () => ({
        removeReasoningFromString: (s) => s,
    }));

    jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
        oai_settings: {},
    }));

    jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/embed-rerank.js', () => ({
        listEmbeddingProfiles: () => [embeddingProfile],
        getEmbeddingProfileById: (id) => (id === embeddingProfile.id ? embeddingProfile : null),
        listRerankProfiles: () => [],
        getRerankProfileById: () => null,
        upsertEmbeddingProfile: noop,
        upsertRerankProfile: noop,
        renderProfileSelect: noop,
    }));

    jest.unstable_mockModule('../../public/scripts/embedding-service.js', () => ({
        EmbeddingService: embeddingServiceMock,
    }));

    jest.unstable_mockModule('../../public/scripts/lib/prompt-values.js', () => ({
        initializePromptDefaults: () => false,
        requireStoredPrompt: (v) => v,
    }));

    jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
        t: (strings, ...values) => strings.reduce((out, str, idx) => out + str + (values[idx] ?? ''), ''),
    }));

    const vectorsMod = await import('../../public/scripts/extensions/vectors/index.js');
    await vectorsMod.init();
});

beforeEach(() => {
    registry = createActivityGuardRegistry();
    activeGuardApi = makeActivityGuardApi(registry);
    currentChatId = 'chat-vec-1';
    currentChat = [{ mes: 'Hello world', is_system: false }];
    embeddingServiceMock.listHashes.mockReset().mockResolvedValue([]);
    embeddingServiceMock.insert.mockReset().mockResolvedValue(undefined);
    embeddingServiceMock.deleteByHashes.mockReset().mockResolvedValue(undefined);
    embeddingServiceMock.query.mockReset().mockResolvedValue({ hashes: [], metadata: [] });
});

afterEach(() => {
    const leftover = registry.getActiveActivities();
    if (leftover.length > 0) {
        throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
    }
});

describe('Vectors extension activity guard leases', () => {
    test('synchronizeChat acquires vectors:chat chat-scoped lease and releases on completion and error', async () => {
        const listStarted = deferred();
        const listGate = deferred();
        embeddingServiceMock.listHashes.mockImplementationOnce(() => {
            listStarted.resolve();
            return listGate.promise;
        });

        const syncPromise = capturedWorkerCallback(5);
        await listStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'vectors:chat',
                label: 'Chat vectorization',
                scope: 'chat',
                guardUnload: true,
                guardChatSwitch: true,
                keepAlive: true,
            }),
        ]);

        listGate.resolve([]);
        await syncPromise;

        expect(registry.getActiveActivities()).toEqual([]);

        // Error path (e.g. fatal insert error) also releases the lease
        const errStarted = deferred();
        const errGate = deferred();
        embeddingServiceMock.listHashes.mockResolvedValueOnce([]);
        embeddingServiceMock.insert.mockImplementationOnce(() => {
            errStarted.resolve();
            return errGate.promise;
        });

        const failedPromise = capturedWorkerCallback(5);
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
        embeddingServiceMock.listHashes.mockResolvedValueOnce([]);
        embeddingServiceMock.insert.mockImplementationOnce(() => {
            insertStarted.resolve();
            return insertGate.promise;
        });

        const chatWithFiles = [{
            mes: 'Attachment text\nUser message',
            is_system: false,
            extra: {
                fileLength: 'Attachment text'.length,
                files: [{ name: 'notes.txt', url: '/user/files/notes.txt', text: 'Attachment text' }],
            },
        }];

        const runPromise = globalThis.vectors_rearrangeChat(chatWithFiles, 4096, null, 'normal');
        await insertStarted.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'vectors:file',
                label: 'File vectorization',
                scope: 'global',
                guardUnload: true,
                guardChatSwitch: false,
                keepAlive: true,
            }),
        ]);

        insertGate.resolve(undefined);
        await runPromise;
        expect(registry.getActiveActivities()).toEqual([]);

        // Error inside insert releases lease cleanly
        const errStarted = deferred();
        const errGate = deferred();
        embeddingServiceMock.listHashes.mockResolvedValueOnce([]);
        embeddingServiceMock.insert.mockImplementationOnce(() => {
            errStarted.resolve();
            return errGate.promise;
        });

        const failChat = [{
            mes: 'Attachment text\nUser message',
            is_system: false,
            extra: {
                fileLength: 'Attachment text'.length,
                files: [{ name: 'bad.txt', url: '/user/files/bad.txt', text: 'Attachment text' }],
            },
        }];
        const failPromise = globalThis.vectors_rearrangeChat(failChat, 4096, null, 'normal');
        await errStarted.promise;
        expect(registry.getActiveActivities()).toHaveLength(1);

        errGate.reject(new Error('insert failed'));
        await failPromise;
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('tolerates null activityGuard without crashing', async () => {
        activeGuardApi = null;
        const result = await capturedWorkerCallback(5);
        expect(result).toBe(-4);
    });
});
