/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import {
    getActiveActivities,
    hasUnloadGuard,
    hasChatSwitchGuard,
    hasKeepAliveHold,
    cancelChatSwitchActivities,
} from '../../public/scripts/activity-guard.js';
import { createIteratePage } from '../../public/scripts/workbench/pages/iterate.js';
import { createAskPage } from '../../public/scripts/workbench/pages/ask.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function flushMicrotasks(ticks = 6) {
    for (let i = 0; i < ticks; i++) {
        await Promise.resolve();
    }
}

function createMemorySessionStore() {
    const byScope = new Map();
    const scopeKey = (opts = {}) => JSON.stringify(opts || { scope: 'global' });
    const ensure = (opts) => {
        const k = scopeKey(opts);
        if (!byScope.has(k)) byScope.set(k, []);
        return byScope.get(k);
    };
    return {
        list: jest.fn(async (kind = null, opts = {}) => ensure(opts)
            .filter(s => !kind || s.kind === kind)
            .map(s => JSON.parse(JSON.stringify(s)))),
        get: jest.fn(async (id, opts = {}) => {
            for (const list of (opts ? [ensure(opts)] : [...byScope.values()])) {
                const hit = list.find(s => s.id === id);
                if (hit) return JSON.parse(JSON.stringify(hit));
            }
            return null;
        }),
        create: jest.fn(async (fields, opts = {}) => {
            const now = Date.now();
            const s = {
                id: `wb_${Math.random().toString(36).slice(2, 8)}`,
                title: '',
                createdAt: now,
                updatedAt: now,
                turns: [],
                ...JSON.parse(JSON.stringify(fields)),
            };
            ensure(opts).unshift(s);
            return JSON.parse(JSON.stringify(s));
        }),
        update: jest.fn(async (id, patch, opts = {}) => {
            const buckets = opts ? [ensure(opts)] : [...byScope.values()];
            for (const list of buckets) {
                const idx = list.findIndex(s => s.id === id);
                if (idx >= 0) {
                    const next = { ...list[idx], ...JSON.parse(JSON.stringify(patch)), updatedAt: Date.now() };
                    list[idx] = next;
                    return JSON.parse(JSON.stringify(next));
                }
            }
            return null;
        }),
        remove: jest.fn(async (id, opts = {}) => {
            for (const list of (opts ? [ensure(opts)] : [...byScope.values()])) {
                const idx = list.findIndex(s => s.id === id);
                if (idx >= 0) list.splice(idx, 1);
            }
        }),
    };
}

beforeAll(() => {
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = (cb) => {
            queueMicrotask(cb);
            return 1;
        };
    }
    if (!globalThis.matchMedia) {
        globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    }
});

beforeEach(() => {
    document.body.innerHTML = '';
    globalThis.Luker = {
        getContext: () => ({
            translate: (text) => String(text ?? ''),
            getCurrentLocale: () => 'en',
            getCurrentChatId: () => 'chat-wb-1',
            resolveChatStateTarget: () => ({ is_group: false, avatar_url: 'alice.png', file_name: 'chat-wb-1.jsonl' }),
            characters: [{ avatar: 'alice.png', name: 'Alice', chat: 'chat-wb-1.jsonl' }],
            characterId: 0,
        }),
    };
});

afterEach(() => {
    delete globalThis.Luker;
    const leftover = getActiveActivities();
    if (leftover.length > 0) {
        throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
    }
});

describe('Workbench iterate & ask activity guard leases', () => {
    function makeIterateTarget() {
        return {
            id: 'world',
            label: () => 'World book',
            isEnabled: () => true,
            scopes: async () => ({ global: true, character: true, chat: true }),
            load: async (scope) => ({ live: { entries: [] }, target: { scope }, title: `Target (${scope})` }),
            prompt: async () => 'system prompt',
            tools: async () => [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (_call, live) => live,
            units: () => new Map(),
            rebuild: (base) => base,
            commit: async () => ({ applied: [], skipped: [], failure: '', undo: async () => {} }),
        };
    }

    function makeIterateApp(aiRequestImpl) {
        const sessions = createMemorySessionStore();
        const target = makeIterateTarget();
        return {
            sessions,
            iterateTargets: () => [target],
            snapshot: () => ({
                chat: {
                    chatId: 'chat-wb-1.jsonl',
                    label: 'Chat 1',
                    floors: 4,
                    character: { avatar: 'alice.png', name: 'Alice' },
                    target: { is_group: false, avatar_url: 'alice.png', file_name: 'chat-wb-1.jsonl' },
                },
                card: { name: 'Alice', avatar: 'alice.png', books: [] },
                preset: { name: 'Main', ref: { collection: 'openai', name: 'Main' } },
            }),
            settings: () => ({ builtinPrompt: true, reviewChanges: true }),
            history: { record: jest.fn(() => 'h1'), canUndo: () => false, undo: jest.fn() },
            toast: jest.fn(),
            reload: jest.fn(),
            refreshBadges: jest.fn(),
            source: {
                aiRequest: aiRequestImpl,
            },
        };
    }

    test('iterate acquires global lease for global/character scope and releases on completion and error', async () => {
        const aiGate = deferred();
        const aiStarted = deferred();
        const app = makeIterateApp(jest.fn(() => {
            aiStarted.resolve();
            return aiGate.promise;
        }));

        const page = createIteratePage(app);
        document.body.appendChild(page.el);
        await page.show({ ws: 'world', scope: 'global' });

        const textarea = page.el.querySelector('textarea.wb-input');
        const sendBtn = page.el.querySelector('button.wb-send');
        textarea.value = 'Tighten rules';
        sendBtn.click();

        await aiStarted.promise;

        expect(getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'workbench:iterate',
                label: expect.stringMatching(/\S/),
                scope: 'global',
                guardUnload: true,
                guardChatSwitch: false,
                keepAlive: true,
            }),
        ]);
        expect(hasUnloadGuard()).toBe(true);
        expect(hasKeepAliveHold()).toBe(true);
        expect(hasChatSwitchGuard()).toBe(false);

        aiGate.resolve({ text: 'Done', calls: [] });
        await flushMicrotasks(12);

        expect(getActiveActivities()).toEqual([]);

        // Error path also releases the lease cleanly
        const failStarted = deferred();
        const failGate = deferred();
        app.source.aiRequest.mockImplementationOnce(() => {
            failStarted.resolve();
            return failGate.promise;
        });

        textarea.value = 'Trigger failure';
        sendBtn.click();
        await failStarted.promise;
        expect(getActiveActivities()).toHaveLength(1);

        failGate.reject(new Error('network boom'));
        await flushMicrotasks(12);
        expect(getActiveActivities()).toEqual([]);
    });

    test('iterate acquires chat-scoped lease when runScope is "chat" and aborts via onCancel', async () => {
        const aiStarted = deferred();
        let capturedSignal = null;
        const app = makeIterateApp(jest.fn((_ws, { signal }) => {
            capturedSignal = signal;
            aiStarted.resolve();
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')));
            });
        }));

        const page = createIteratePage(app);
        document.body.appendChild(page.el);
        await page.show({ ws: 'world', scope: 'chat' });

        const textarea = page.el.querySelector('textarea.wb-input');
        const sendBtn = page.el.querySelector('button.wb-send');
        textarea.value = 'Edit chat lorebook';
        sendBtn.click();

        await aiStarted.promise;

        expect(getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'workbench:iterate',
                label: expect.stringMatching(/\S/),
                scope: 'chat',
                guardUnload: true,
                guardChatSwitch: true,
                keepAlive: true,
            }),
        ]);
        expect(hasChatSwitchGuard()).toBe(true);
        expect(capturedSignal.aborted).toBe(false);

        cancelChatSwitchActivities();
        expect(capturedSignal.aborted).toBe(true);

        await flushMicrotasks(12);
        expect(getActiveActivities()).toEqual([]);
    });

    test('ask acquires global lease across multi-round runAsk and releases on completion and error', async () => {
        const round1Started = deferred();
        const round1Gate = deferred();
        const round2Started = deferred();
        const round2Gate = deferred();
        let callCount = 0;

        const app = {
            sessions: createMemorySessionStore(),
            snapshot: () => ({ chat: { chatId: 'c1', label: 'Chat 1', floors: 2 }, card: { name: 'Alice', books: [] }, preset: { name: 'Main' }, connection: 'OpenAI' }),
            settings: () => ({ ask: { sources: { inspector: true, frontLogs: true, serverLogs: true, content: true, plugins: true }, floors: 2, previewBeforeSend: false, redact: true } }),
            suggestions: () => [],
            saveSettings: jest.fn(),
            go: jest.fn(),
            toast: jest.fn(),
            source: {
                listRequests: async () => [],
                frontendLogCount: async () => 0,
                debugLoggingOn: () => true,
                askOverview: async () => ({ chat: 'Chat 1' }),
                askReaders: () => ({ wb_list_requests: async () => [{ id: 'req-1' }] }),
                aiRequest: jest.fn(() => {
                    callCount += 1;
                    if (callCount === 1) {
                        round1Started.resolve();
                        return round1Gate.promise;
                    }
                    round2Started.resolve();
                    return round2Gate.promise;
                }),
            },
        };

        const page = createAskPage(app);
        document.body.appendChild(page.el);
        await page.show();

        const textarea = page.el.querySelector('textarea.wb-input');
        const sendBtn = page.el.querySelector('button.wb-send');
        textarea.value = 'Why did this happen?';
        sendBtn.click();

        await round1Started.promise;

        expect(getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'workbench:ask',
                label: expect.stringMatching(/\S/),
                scope: 'global',
                guardUnload: true,
                guardChatSwitch: false,
                keepAlive: true,
            }),
        ]);

        round1Gate.resolve({ text: '', calls: [{ id: 'c1', name: 'wb_list_requests', args: {} }] });
        await round2Started.promise;

        // Same lease remains active through the second LLM round
        expect(getActiveActivities()).toHaveLength(1);
        expect(getActiveActivities()[0].source).toBe('workbench:ask');

        round2Gate.resolve({ text: '', calls: [{ id: 'c2', name: 'wb_answer', args: { text: 'Answer' } }] });
        await flushMicrotasks(12);

        expect(getActiveActivities()).toEqual([]);

        // Error path releases the lease
        const errStarted = deferred();
        const errGate = deferred();
        app.source.aiRequest.mockImplementationOnce(() => {
            errStarted.resolve();
            return errGate.promise;
        });

        textarea.value = 'Trigger failure';
        sendBtn.click();
        await errStarted.promise;
        expect(getActiveActivities()).toHaveLength(1);

        errGate.reject(new Error('ask failed'));
        await flushMicrotasks(12);
        expect(getActiveActivities()).toEqual([]);
    });
});
