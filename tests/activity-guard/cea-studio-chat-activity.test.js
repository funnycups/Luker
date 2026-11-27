// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
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
let generateTaskImpl = null;
let readFileDeferred = null;

let sendAIMessage;
let TOOL_NAMES;
let origFetch;

beforeAll(async () => {
    origFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async (url) => {
        const target = String(url);
        if (target.endsWith('/files')) {
            return { ok: true, status: 200, json: async () => ({ files: ['index.js'] }) };
        }
        if (target.includes('/index.js')) {
            const content = readFileDeferred ? await readFileDeferred.promise : 'export function init() {}';
            return { ok: true, status: 200, text: async () => content };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
    });

    globalThis.Luker = {
        getContext: () => ({
            characters: [{ name: 'Card', data: { extensions: {} } }],
            characterId: 0,
            getRequestHeaders: () => ({}),
            uuidv4: () => 'uuid-1',
            extensionSettings: { regex: [] },
            edits: {
                applyEdits: () => ({ clean: [], conflicts: [], newLive: {} }),
                showConflictResolution: async () => [],
            },
            worldInfoEntry: { create: () => ({}), delete: () => {} },
            chatWorldInfo: { getNames: () => [] },
            loadWorldInfo: async () => ({}),
            saveWorldInfo: async () => {},
            createWorldBook: async () => {},
            charUpdatePrimaryWorld: async () => {},
            getCharaAuxWorlds: () => [],
            importEmbeddedWorldInfo: async () => ({}),
            getCharacterEmbeddedWorld: () => ({}),
            getCharaFilename: () => 'Card',
            SlashCommandParser: { commands: {} },
            writeExtensionField: async () => true,
            getExtensionApi: () => ({}),
            getCharacterState: async () => ({ ok: true, state: null }),
            updateCharacterState: async () => ({ ok: true, state: null, updated: false }),
            translate: (text) => String(text ?? ''),
            lib: {},
            get activityGuard() {
                return activeGuardApi;
            },
            generateTask: (...args) => generateTaskImpl(...args),
            regex: {
                SCRIPT_TYPES: { GLOBAL: 0, PRESET: 1, SCOPED: 2 },
                getScriptsByType: () => [],
                saveScriptsByType: async () => {},
                getPluginLanes: () => [],
                omitLegacyPluginScope: (s) => s,
                normalizePluginScriptRecord: (s) => s,
            },
        }),
    };

    ({ sendAIMessage, TOOL_NAMES } = await import('../../public/scripts/extensions/character-editor-assistant/studio/ai-chat.js'));
});

afterAll(() => {
    globalThis.fetch = origFetch;
});

beforeEach(() => {
    registry = createActivityGuardRegistry();
    activeGuardApi = makeActivityGuardApi(registry);
    readFileDeferred = null;
    generateTaskImpl = null;
});

afterEach(() => {
    const leftover = registry.getActiveActivities();
    if (leftover.length > 0) {
        throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
    }
});

describe('CardApp Studio ai-chat activity guard leases', () => {
    test('holds a single cea:studio-chat global lease across multi-round tool calls and gaps', async () => {
        const round1Started = deferred();
        const round1Gate = deferred();
        const toolStarted = deferred();
        readFileDeferred = deferred();
        const round2Started = deferred();
        const round2Gate = deferred();

        let round = 0;
        generateTaskImpl = jest.fn(async () => {
            round += 1;
            if (round === 1) {
                round1Started.resolve();
                return round1Gate.promise;
            }
            round2Started.resolve();
            return round2Gate.promise;
        });

        const history = [];
        const promise = sendAIMessage('char-1', history, 'Read index.js', {
            systemPrompt: 'Studio prompt',
            onToolCall: () => {},
        });

        await round1Started.promise;

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'cea:studio-chat',
                label: expect.stringMatching(/\S/),
                scope: 'global',
                guardUnload: true,
                guardChatSwitch: false,
                keepAlive: true,
            }),
        ]);

        // Finish round 1 with a tool call — lease must stay active while tool executes between rounds
        round1Gate.resolve({
            assistantText: 'Reading...',
            toolCalls: [{ raw: { id: 'tc1' }, name: TOOL_NAMES.READ_FILE, args: { path: 'index.js' } }],
        });

        // Wait until round 1 resolves into executeTool -> fetchFileContent
        await Promise.resolve();
        await Promise.resolve();
        toolStarted.resolve();
        await toolStarted.promise;

        expect(registry.getActiveActivities()).toHaveLength(1);
        expect(registry.getActiveActivities()[0].source).toBe('cea:studio-chat');

        readFileDeferred.resolve('export function init() {}');
        await round2Started.promise;

        expect(registry.getActiveActivities()).toHaveLength(1);
        expect(registry.getActiveActivities()[0].source).toBe('cea:studio-chat');

        round2Gate.resolve({
            assistantText: 'All done.',
            toolCalls: [],
        });

        const result = await promise;
        expect(result.assistantText).toBe('All done.');
        expect(registry.getActiveActivities()).toEqual([]);
    });

    test('releases cea:studio-chat lease on generateTask rejection and tolerates null activityGuard', async () => {
        generateTaskImpl = jest.fn(async () => {
            expect(registry.getActiveActivities()).toHaveLength(1);
            throw new Error('upstream failure');
        });

        await expect(sendAIMessage('char-1', [], 'hi', { systemPrompt: 'Studio prompt' }))
            .rejects.toThrow('upstream failure');
        expect(registry.getActiveActivities()).toEqual([]);

        // Stripped unit-test context with activityGuard: null still works
        activeGuardApi = null;
        generateTaskImpl = jest.fn(async () => ({ assistantText: 'No guard ok', toolCalls: [] }));
        const result = await sendAIMessage('char-1', [], 'hi', { systemPrompt: 'Studio prompt' });
        expect(result.assistantText).toBe('No guard ok');
    });
});
