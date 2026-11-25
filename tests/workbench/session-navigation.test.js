/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import { createAskPage } from '../../public/scripts/workbench/pages/ask.js';

function createMemorySessionStore() {
    const map = new Map();
    return {
        list: jest.fn(async (kind = null) => [...map.values()].filter(s => !kind || s.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt)),
        get: jest.fn(async (id) => {
            const s = map.get(id);
            return s ? JSON.parse(JSON.stringify(s)) : null;
        }),
        create: jest.fn(async (fields) => {
            const now = Date.now();
            const s = { id: `s_${map.size + 1}`, title: '', createdAt: now, updatedAt: now, turns: [], ...fields };
            map.set(s.id, JSON.parse(JSON.stringify(s)));
            return JSON.parse(JSON.stringify(s));
        }),
        update: jest.fn(async (id, patch) => {
            const cur = map.get(id);
            if (!cur) return null;
            const next = { ...cur, ...patch, updatedAt: Date.now() };
            map.set(id, JSON.parse(JSON.stringify(next)));
            return JSON.parse(JSON.stringify(next));
        }),
        remove: jest.fn(async (id) => { map.delete(id); }),
    };
}

function flushMicrotasks() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

beforeAll(() => {
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    }
    if (!globalThis.matchMedia) {
        globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    }
});

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('Ask page runId isolation across session switch & history cleanup', () => {
    test('switching sessions mid-flight isolates live progress/stop state by runId and omits failed turns from next history', async () => {
        const sessions = createMemorySessionStore();
        const sessionA = await sessions.create({ kind: 'ask', title: 'Session A', turns: [{ role: 'user', text: 'Old Q', at: 1 }, { role: 'ai', answer: 'Old A', at: 2 }] });
        const sessionB = await sessions.create({ kind: 'ask', title: 'Session B', turns: [{ role: 'user', text: 'B Q', at: 1 }, { role: 'ai', answer: 'B A', at: 2 }] });

        let resolveFirstRound;
        let resolveSecondRound;
        const aiRequests = [];

        const app = {
            sessions,
            snapshot: () => ({ chat: { chatId: 'c1', label: 'Chat 1', floors: 10 }, card: { name: 'Alice', books: [] }, preset: { name: 'P1' }, connection: 'OpenAI' }),
            settings: () => ({
                ask: { sources: { inspector: true, frontLogs: true, serverLogs: true, content: true, plugins: true }, floors: 2, previewBeforeSend: false, redact: true },
            }),
            suggestions: () => [],
            saveSettings: jest.fn(),
            go: jest.fn(),
            toast: jest.fn(),
            source: {
                listRequests: async () => [],
                frontendLogCount: async () => 0,
                debugLoggingOn: () => true,
                askOverview: async () => ({ chat: 'Chat 1' }),
                askReaders: () => ({ wb_list_requests: async () => [{ id: 'req1' }] }),
                aiRequest: jest.fn(async (_role, { messages }) => {
                    aiRequests.push(JSON.parse(JSON.stringify(messages)));
                    if (aiRequests.length === 1) {
                        return new Promise((resolve) => { resolveFirstRound = resolve; });
                    }
                    if (aiRequests.length === 2) {
                        return new Promise((resolve) => { resolveSecondRound = resolve; });
                    }
                    return { text: '', calls: [{ id: 'fail-ok', name: 'wb_answer', args: { text: 'Recovered answer' } }] };
                }),
            },
        };

        const page = createAskPage(app);
        document.body.appendChild(page.el);
        await page.show();
        await flushMicrotasks();

        // Select Session A
        const selectEl = () => page.el.querySelector('select.wb-chat-hist');
        selectEl().value = sessionA.id;
        selectEl().dispatchEvent(new Event('change'));
        await flushMicrotasks();
        expect(page.el.textContent).toContain('Old A');

        // Start a request in Session A
        const textarea = page.el.querySelector('textarea.wb-input');
        const sendBtn = page.el.querySelector('button.wb-send');
        textarea.value = 'Why did A fail?';
        sendBtn.click();
        await flushMicrotasks();

        // While Session A is in-flight, it shows Thinking/Stop and input is disabled
        expect(page.el.querySelector('.wb-reads.is-live')).not.toBeNull();
        expect(textarea.disabled).toBe(true);
        expect(sendBtn.disabled).toBe(true);

        // Switch to Session B mid-flight
        selectEl().value = sessionB.id;
        selectEl().dispatchEvent(new Event('change'));
        await flushMicrotasks();

        // Session B must NOT show Session A's live spinner/stop button and must allow composing
        expect(page.el.textContent).toContain('B A');
        expect(page.el.querySelector('.wb-reads.is-live')).toBeNull();
        expect(page.el.textContent).not.toContain('Stop answering');
        expect(textarea.disabled).toBe(false);
        expect(sendBtn.disabled).toBe(false);

        // Advance Session A to a read tool step while user is viewing Session B
        resolveFirstRound({ text: '', calls: [{ id: 'c1', name: 'wb_list_requests', args: {} }] });
        await flushMicrotasks();

        // Session B must still NOT display Session A's read step progress
        expect(page.el.querySelector('.wb-reads.is-live')).toBeNull();
        expect(page.el.textContent).not.toContain('Reading Request list');

        // Switch back to Session A while still in flight -> live step IS shown for Session A
        selectEl().value = sessionA.id;
        selectEl().dispatchEvent(new Event('change'));
        await flushMicrotasks();
        expect(page.el.querySelector('.wb-reads.is-live')).not.toBeNull();
        expect(page.el.textContent).toContain('Request list');
        expect(textarea.disabled).toBe(true);

        // Switch to Session B again before completing Session A with an error
        selectEl().value = sessionB.id;
        selectEl().dispatchEvent(new Event('change'));
        await flushMicrotasks();
        textarea.value = 'Draft in B';

        resolveSecondRound(Promise.reject(new Error('Upstream 502')));
        await flushMicrotasks();
        await flushMicrotasks();

        // Session B remains undisturbed with its draft intact
        expect(page.el.textContent).toContain('B A');
        expect(textarea.value).toBe('Draft in B');

        // Switch back to Session A: failed turn error is recorded on Session A
        selectEl().value = sessionA.id;
        selectEl().dispatchEvent(new Event('change'));
        await flushMicrotasks();
        expect(page.el.textContent).toContain('Upstream 502');

        // Ask a follow-up question in Session A: history must NOT contain empty assistant content from failed turn
        textarea.value = 'Follow-up after failure';
        sendBtn.click();
        await flushMicrotasks();
        await flushMicrotasks();

        const lastMessages = aiRequests[2];
        expect(lastMessages.some(m => m.role === 'assistant' && m.content === '')).toBe(false);
        expect(lastMessages.some(m => m.role === 'assistant' && m.content === 'Old A')).toBe(true);
    });

    test('switching away from a brand-new session while store.create is awaiting and switching Luker chats mid-flight isolate targets and views', async () => {
        const byChat = new Map();
        const keyOf = (scope) => (scope?.target ? `${scope.target.avatar_url}:${scope.target.file_name}` : 'active');
        const ensureBucket = (scope) => {
            const k = keyOf(scope);
            if (!byChat.has(k)) byChat.set(k, []);
            return byChat.get(k);
        };

        let resolveCreate;
        let resolveAi;
        let activeChat = {
            chatId: 'chat1.jsonl',
            label: 'Chat 1',
            floors: 3,
            target: { is_group: false, avatar_url: 'alice.png', file_name: 'chat1.jsonl' },
        };

        const chat1Existing = { id: 's_c1_existing', kind: 'ask', title: 'Existing C1', createdAt: 1, updatedAt: 10, turns: [{ role: 'user', text: 'Existing Q', at: 1 }, { role: 'ai', answer: 'Existing A', at: 2 }] };
        const chat2Existing = { id: 's_c2_existing', kind: 'ask', title: 'Existing C2', createdAt: 1, updatedAt: 20, turns: [{ role: 'user', text: 'C2 Q', at: 1 }, { role: 'ai', answer: 'C2 A', at: 2 }] };
        byChat.set('alice.png:chat1.jsonl', [chat1Existing]);
        byChat.set('alice.png:chat2.jsonl', [chat2Existing]);

        const sessions = {
            list: jest.fn(async (kind = null, scope = {}) => ensureBucket(scope).filter(s => !kind || s.kind === kind).map(s => JSON.parse(JSON.stringify(s)))),
            get: jest.fn(async (id, scope = {}) => {
                const hit = ensureBucket(scope).find(s => s.id === id);
                return hit ? JSON.parse(JSON.stringify(hit)) : null;
            }),
            create: jest.fn(async (fields, scope = {}) => {
                const created = { id: 's_new_c1', title: '', createdAt: 2, updatedAt: 30, turns: [], ...fields };
                await new Promise((r) => { resolveCreate = r; });
                ensureBucket(scope).unshift(JSON.parse(JSON.stringify(created)));
                return JSON.parse(JSON.stringify(created));
            }),
            update: jest.fn(async (id, patch, scope = {}) => {
                const list = ensureBucket(scope);
                const idx = list.findIndex(s => s.id === id);
                if (idx < 0) return null;
                const next = { ...list[idx], ...patch, updatedAt: Date.now() };
                list[idx] = JSON.parse(JSON.stringify(next));
                return JSON.parse(JSON.stringify(next));
            }),
        };

        const app = {
            sessions,
            snapshot: () => ({ chat: activeChat, card: { name: 'Alice', avatar: 'alice.png', books: [] }, preset: { name: 'P1' }, connection: 'OpenAI' }),
            settings: () => ({ ask: { sources: { inspector: true, frontLogs: true, serverLogs: true, content: true, plugins: true }, floors: 2, previewBeforeSend: false, redact: true } }),
            suggestions: () => [],
            saveSettings: jest.fn(),
            go: jest.fn(),
            toast: jest.fn(),
            source: {
                listRequests: async () => [],
                frontendLogCount: async () => 0,
                debugLoggingOn: () => true,
                askOverview: async () => ({ chat: activeChat.label }),
                askReaders: () => ({}),
                aiRequest: jest.fn(async () => new Promise((r) => { resolveAi = r; })),
            },
        };

        const page = createAskPage(app);
        document.body.appendChild(page.el);
        await page.show();
        await flushMicrotasks();

        // Start a brand-new conversation (session === null) on Chat 1
        const textarea = page.el.querySelector('textarea.wb-input');
        const sendBtn = page.el.querySelector('button.wb-send');
        textarea.value = 'New question on Chat 1';
        sendBtn.click();
        await flushMicrotasks();

        // While store.create is still awaiting, switch to chat1Existing
        const sel = page.el.querySelector('select.wb-chat-hist');
        sel.value = chat1Existing.id;
        sel.dispatchEvent(new Event('change'));
        await flushMicrotasks();
        expect(page.el.textContent).toContain('Existing A');

        // Resolve store.create: must NOT hijack the current view away from chat1Existing
        resolveCreate();
        await flushMicrotasks();
        await flushMicrotasks();
        expect(page.el.textContent).toContain('Existing A');
        expect(page.el.querySelector('.wb-reads.is-live')).toBeNull();

        // Simulate Luker switching chats mid-flight (CHAT_CHANGED -> onSnapshot)
        activeChat = {
            chatId: 'chat2.jsonl',
            label: 'Chat 2',
            floors: 1,
            target: { is_group: false, avatar_url: 'alice.png', file_name: 'chat2.jsonl' },
        };
        page.onSnapshot();
        await flushMicrotasks();
        await flushMicrotasks();

        // Session resets off Chat 1's old session and history dropdown now lists Chat 2's session
        expect(page.el.textContent).not.toContain('Existing A');
        const optionsAfterSwitch = [...page.el.querySelectorAll('select.wb-chat-hist option')].map(o => o.value);
        expect(optionsAfterSwitch).toContain('s_c2_existing');
        expect(optionsAfterSwitch).not.toContain('s_c1_existing');

        // Complete the in-flight AI request from Chat 1: must persist to Chat 1's explicit target, never Chat 2, and leave Chat 2 view clean
        resolveAi({ text: '', calls: [{ id: 'a1', name: 'wb_answer', args: { text: 'Answer for Chat 1' } }] });
        await flushMicrotasks();
        await flushMicrotasks();

        const chat1Stored = byChat.get('alice.png:chat1.jsonl').find(s => s.id === 's_new_c1');
        expect(chat1Stored?.turns?.at(-1)?.answer).toBe('Answer for Chat 1');
        expect(byChat.get('alice.png:chat2.jsonl').some(s => s.id === 's_new_c1')).toBe(false);
        expect(page.el.textContent).not.toContain('Answer for Chat 1');
    });

    test('syncScopeChange clears stale recentSessions before refreshRecent resolves', async () => {
        let activeChat = {
            chatId: 'chat1.jsonl',
            label: 'Chat 1',
            floors: 1,
            target: { is_group: false, avatar_url: 'alice.png', file_name: 'chat1.jsonl' },
        };
        let resolveChat2List;
        const sessions = {
            list: jest.fn(async (_kind, scope) => {
                if (scope?.target?.file_name === 'chat1.jsonl') {
                    return [{ id: 's_c1', kind: 'ask', title: 'Chat 1 Session', updatedAt: Date.now(), turns: [] }];
                }
                return new Promise((resolve) => { resolveChat2List = resolve; });
            }),
            get: jest.fn(async () => null),
        };
        const app = {
            sessions,
            snapshot: () => ({ chat: activeChat, card: { name: 'Alice', avatar: 'alice.png', books: [] }, preset: { name: 'P1' }, connection: 'OpenAI' }),
            settings: () => ({ ask: { sources: {} } }),
            suggestions: () => [],
            saveSettings: jest.fn(),
            go: jest.fn(),
            toast: jest.fn(),
            source: { listRequests: async () => [], frontendLogCount: async () => 0, debugLoggingOn: () => true },
        };

        const page = createAskPage(app);
        document.body.appendChild(page.el);
        await page.show();
        expect(page.el.querySelector('select.wb-chat-hist')).not.toBeNull();
        expect(page.el.textContent).toContain('Chat 1 Session');

        // Switch chat while store.list for Chat 2 is still pending
        activeChat = {
            chatId: 'chat2.jsonl',
            label: 'Chat 2',
            floors: 1,
            target: { is_group: false, avatar_url: 'alice.png', file_name: 'chat2.jsonl' },
        };
        page.onSnapshot();

        // Stale Chat 1 dropdown options must be cleared immediately before refreshRecent settles
        expect(page.el.querySelector('select.wb-chat-hist')).toBeNull();

        resolveChat2List([{ id: 's_c2', kind: 'ask', title: 'Chat 2 Session', updatedAt: Date.now(), turns: [] }]);
        await flushMicrotasks();
        expect(page.el.textContent).toContain('Chat 2 Session');
    });

    test('regenerate aborts without overwriting session or calling send if user switches sessions while store.update is pending', async () => {
        const sessions = createMemorySessionStore();
        const sessionA = await sessions.create({
            kind: 'ask',
            title: 'Session A',
            turns: [{ role: 'user', text: 'Question A', at: 1 }, { role: 'ai', answer: 'Answer A', at: 2 }],
        });
        const sessionB = await sessions.create({
            kind: 'ask',
            title: 'Session B',
            turns: [{ role: 'user', text: 'Question B', at: 1 }, { role: 'ai', answer: 'Answer B', at: 2 }],
        });

        let resolveUpdate;
        const origUpdate = sessions.update;
        sessions.update = jest.fn(async (id, patch, scope) => {
            if (id === sessionA.id) {
                await new Promise((r) => { resolveUpdate = r; });
            }
            return origUpdate(id, patch, scope);
        });

        const aiRequest = jest.fn(async () => ({ text: '', calls: [{ id: 'x', name: 'wb_answer', args: { text: 'New' } }] }));
        const app = {
            sessions,
            snapshot: () => ({ chat: { chatId: 'c1', label: 'Chat 1', floors: 2 }, card: { name: 'Alice', books: [] }, preset: { name: 'P1' }, connection: 'OpenAI' }),
            settings: () => ({ ask: { sources: {}, previewBeforeSend: false, redact: true } }),
            suggestions: () => [],
            saveSettings: jest.fn(),
            go: jest.fn(),
            toast: jest.fn(),
            source: {
                listRequests: async () => [],
                frontendLogCount: async () => 0,
                debugLoggingOn: () => true,
                askOverview: async () => ({ chat: 'Chat 1' }),
                askReaders: () => ({}),
                aiRequest,
            },
        };

        const page = createAskPage(app);
        document.body.appendChild(page.el);
        await page.show();
        await flushMicrotasks();

        // Select Session A
        const sel = page.el.querySelector('select.wb-chat-hist');
        sel.value = sessionA.id;
        sel.dispatchEvent(new Event('change'));
        await flushMicrotasks();

        // Click "Answer again" on Session A
        const regenBtn = [...page.el.querySelectorAll('.wb-msg-acts button')].find(b => b.textContent.includes('Answer again'));
        expect(regenBtn).toBeDefined();
        regenBtn.click();
        await flushMicrotasks();

        // Switch to Session B while store.update is pending and type a draft
        sel.value = sessionB.id;
        sel.dispatchEvent(new Event('change'));
        await flushMicrotasks();
        const textarea = page.el.querySelector('textarea.wb-input');
        textarea.value = 'Draft in B';

        resolveUpdate();
        await flushMicrotasks();
        await flushMicrotasks();

        // Must remain on Session B, preserve draft, and NOT call aiRequest
        expect(page.el.textContent).toContain('Answer B');
        expect(textarea.value).toBe('Draft in B');
        expect(aiRequest).not.toHaveBeenCalled();
    });

    test('hidden Ask page skips session reads on onSnapshot and awaits store.get() for lightweight index summaries', async () => {
        let activeChat = {
            chatId: 'chat1.jsonl',
            label: 'Chat 1',
            floors: 1,
            target: { is_group: false, avatar_url: 'alice.png', file_name: 'chat1.jsonl' },
        };
        let resolveGet;
        const sessions = {
            list: jest.fn(async () => [{ id: 's_summary', kind: 'ask', title: 'Summary Only', updatedAt: Date.now(), pendingCount: 0 }]),
            get: jest.fn(async () => new Promise((r) => { resolveGet = r; })),
        };
        const app = {
            sessions,
            isOpen: () => false,
            snapshot: () => ({ chat: activeChat, card: { name: 'Alice', avatar: 'alice.png', books: [] }, preset: { name: 'P1' }, connection: 'OpenAI' }),
            settings: () => ({ ask: { sources: {} } }),
            suggestions: () => [],
            saveSettings: jest.fn(),
            go: jest.fn(),
            toast: jest.fn(),
            source: { listRequests: async () => [], frontendLogCount: async () => 0, debugLoggingOn: () => true },
        };

        const page = createAskPage(app);
        // Not connected & workbench collapsed -> scope change onSnapshot must NOT read sessions
        activeChat = {
            chatId: 'chat2.jsonl',
            label: 'Chat 2',
            floors: 2,
            target: { is_group: false, avatar_url: 'alice.png', file_name: 'chat2.jsonl' },
        };
        page.onSnapshot();
        await flushMicrotasks();
        expect(sessions.list).not.toHaveBeenCalled();

        // Mount and open -> reads lightweight summary list, then selecting awaits full body from store.get()
        app.isOpen = () => true;
        document.body.appendChild(page.el);
        await page.show();
        expect(sessions.list).toHaveBeenCalledTimes(1);

        const sel = page.el.querySelector('select.wb-chat-hist');
        sel.value = 's_summary';
        sel.dispatchEvent(new Event('change'));
        expect(sessions.get).toHaveBeenCalledWith('s_summary', expect.any(Object));

        resolveGet({
            id: 's_summary',
            kind: 'ask',
            title: 'Summary Only',
            turns: [{ role: 'user', text: 'Full Q', at: 1 }, { role: 'ai', answer: 'Full lazy-loaded answer', at: 2 }],
        });
        await flushMicrotasks();
        expect(page.el.textContent).toContain('Full lazy-loaded answer');
    });
});
