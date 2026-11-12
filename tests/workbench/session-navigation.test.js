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
});
