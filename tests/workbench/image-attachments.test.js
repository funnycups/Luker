/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

import { createSessionStore, titleFrom } from '../../public/scripts/workbench/model/sessions.js';
import { buildAskHistory, runAsk } from '../../public/scripts/workbench/model/ask.js';
import { trimMessages } from '../../public/scripts/workbench/model/iterate.js';
import { createIteratePage } from '../../public/scripts/workbench/pages/iterate.js';
import { createAskPage } from '../../public/scripts/workbench/pages/ask.js';

function flushMicrotasks() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function createFakeImageServer() {
    const files = new Map();
    let seq = 0;
    const deletedBatches = [];
    const copyCalls = [];

    const fetchFn = jest.fn(async (url, init = {}) => {
        if (url === '/api/images/upload' && init.method === 'POST') {
            const body = JSON.parse(init.body);
            seq += 1;
            const p = `/user/images/${body.ch_name}/img_${seq}.${body.format}`;
            files.set(p, { bytes: Buffer.from(body.image, 'base64'), mime: `image/${body.format === 'jpg' ? 'jpeg' : body.format}` });
            return { ok: true, status: 200, json: async () => ({ path: p }) };
        }
        if (url === '/api/images/copy' && init.method === 'POST') {
            const body = JSON.parse(init.body);
            copyCalls.push(body.paths);
            const copies = {};
            const missing = [];
            for (const src of body.paths) {
                const entry = files.get(src);
                if (!entry) {
                    missing.push(src);
                    continue;
                }
                seq += 1;
                const ext = src.split('.').pop();
                const dst = `/user/images/_ai_attachments/copy_${seq}.${ext}`;
                files.set(dst, { bytes: Buffer.from(entry.bytes), mime: entry.mime });
                copies[src] = dst;
            }
            return { ok: true, status: 200, json: async () => ({ copies, missing }) };
        }
        if (url === '/api/images/delete-batch' && init.method === 'POST') {
            const body = JSON.parse(init.body);
            deletedBatches.push(body.paths);
            const deleted = [];
            const missing = [];
            for (const p of body.paths) {
                if (files.delete(p)) deleted.push(p);
                else missing.push(p);
            }
            return { ok: true, status: 200, json: async () => ({ deleted, missing, failed: [] }) };
        }
        if ((!init.method || init.method === 'GET') && files.has(url)) {
            const entry = files.get(url);
            return {
                ok: true,
                status: 200,
                blob: async () => new Blob([entry.bytes], { type: entry.mime }),
            };
        }
        return { ok: false, status: 404, statusText: 'Not Found', text: async () => 'Not Found' };
    });

    return { files, fetchFn, deletedBatches, copyCalls };
}

function createMemoryGlobalCtx() {
    const state = new Map();
    return {
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'tok' }),
        getGlobalState: jest.fn(async (ns) => ({ ok: true, state: state.has(ns) ? JSON.parse(JSON.stringify(state.get(ns))) : null })),
        updateGlobalState: jest.fn(async (ns, updater) => {
            const cur = state.has(ns) ? JSON.parse(JSON.stringify(state.get(ns))) : null;
            const next = await updater(cur);
            if (next === null || next === undefined) return { ok: true, state: cur };
            state.set(ns, JSON.parse(JSON.stringify(next)));
            return { ok: true, state: JSON.parse(JSON.stringify(next)) };
        }),
        deleteGlobalState: jest.fn(async (ns) => {
            state.delete(ns);
            return { ok: true };
        }),
    };
}

describe('Workbench AI image attachments (sessions, Ask, Iterate)', () => {
    let origFetch;
    let origLuker;
    let origCreateObjectUrl;
    let origRevokeObjectUrl;
    let fakeImg;

    beforeEach(() => {
        origFetch = globalThis.fetch;
        origLuker = globalThis.Luker;
        origCreateObjectUrl = URL.createObjectURL;
        origRevokeObjectUrl = URL.revokeObjectURL;
        fakeImg = createFakeImageServer();
        globalThis.fetch = fakeImg.fetchFn;
        URL.createObjectURL = jest.fn(() => 'blob:fake-preview');
        URL.revokeObjectURL = jest.fn();
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        globalThis.Luker = origLuker;
        URL.createObjectURL = origCreateObjectUrl;
        URL.revokeObjectURL = origRevokeObjectUrl;
        document.body.innerHTML = '';
    });

    test('sessions.remove and removeMany delete owned _ai_attachments files and titleFrom handles image-only turns', async () => {
        const ctx = createMemoryGlobalCtx();
        const store = createSessionStore(ctx);
        fakeImg.files.set('/user/images/_ai_attachments/s1.png', { bytes: Buffer.from([1, 2]), mime: 'image/png' });
        fakeImg.files.set('/user/images/_ai_attachments/s2.png', { bytes: Buffer.from([3, 4]), mime: 'image/png' });
        fakeImg.files.set('/user/images/_references/keep.png', { bytes: Buffer.from([5, 6]), mime: 'image/png' });

        expect(titleFrom('', [{ path: '/user/images/_ai_attachments/s1.png' }])).toBe('[Image]');

        const s1 = await store.create({
            kind: 'ask',
            title: 'One',
            turns: [{ role: 'user', text: '', attachments: [{ path: '/user/images/_ai_attachments/s1.png' }, { path: '/user/images/_references/keep.png' }] }],
        }, { scope: 'global' });
        const s2 = await store.create({
            kind: 'iterate',
            title: 'Two',
            turns: [{ role: 'user', text: 'fix', attachments: [{ path: '/user/images/_ai_attachments/s2.png' }] }],
        }, { scope: 'global' });

        await store.remove(s1.id, { scope: 'global' });
        expect(fakeImg.files.has('/user/images/_ai_attachments/s1.png')).toBe(false);
        expect(fakeImg.files.has('/user/images/_references/keep.png')).toBe(true);

        await store.removeMany([s2.id], { scope: 'global' });
        expect(fakeImg.files.has('/user/images/_ai_attachments/s2.png')).toBe(false);
    });

    test('runAsk and buildAskHistory replay historical and current images losslessly and trimMessages handles multimodal arrays', async () => {
        const b1 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        const b2 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
        fakeImg.files.set('/user/images/_ai_attachments/t1.png', { bytes: Buffer.from(b1), mime: 'image/png' });
        fakeImg.files.set('/user/images/_ai_attachments/t2.png', { bytes: Buffer.from(b2), mime: 'image/png' });

        const history = buildAskHistory([
            { role: 'user', text: '', attachments: [{ path: '/user/images/_ai_attachments/t1.png' }] },
            { role: 'ai', answer: 'I see image 1' },
        ]);
        expect(history).toEqual([
            { role: 'user', content: '', attachments: [{ path: '/user/images/_ai_attachments/t1.png' }] },
            { role: 'assistant', content: 'I see image 1' },
        ]);

        let capturedMessages = null;
        const result = await runAsk({
            question: 'Compare with this one',
            attachments: [{ path: '/user/images/_ai_attachments/t2.png' }],
            overview: { chat: 'ok' },
            history,
            readers: {},
            request: async (messages) => {
                capturedMessages = messages;
                return {
                    text: '',
                    calls: [{ id: 'c1', name: 'wb_answer', args: { text: 'Compared both images.' } }],
                };
            },
        });

        expect(result.answer).toBe('Compared both images.');
        expect(Array.isArray(capturedMessages[1].content)).toBe(true);
        expect(capturedMessages[1].content[0]).toEqual({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${Buffer.from(b1).toString('base64')}` },
        });
        expect(Array.isArray(capturedMessages[3].content)).toBe(true);
        expect(capturedMessages[3].content[1]).toEqual({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${Buffer.from(b2).toString('base64')}` },
        });

        // trimMessages handles array content without throwing or stringifying [object Object]
        const trimmed = trimMessages([
            { role: 'system', content: 'sys' },
            { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
        ], 100);
        expect(trimmed).toHaveLength(2);
    });

    test('Iterate page sends multi-turn images, copies attachments on fork, and deletes only original files when deleting original session', async () => {
        const ctx = createMemoryGlobalCtx();
        globalThis.Luker = { getContext: () => ctx };
        const store = createSessionStore(ctx);
        const sentBatches = [];

        const target = {
            id: 'preset',
            label: 'Preset',
            scopes: () => ({ global: true }),
            load: async () => ({ live: { prompt: 'base' }, target: { name: 'p1' }, title: 'p1' }),
            prompt: () => 'system prompt',
            tools: () => [{ type: 'function', function: { name: 'read_p', parameters: { type: 'object', properties: {} } } }],
            isRead: () => true,
            runRead: async () => 'ok',
            runEdit: async (_c, live) => live,
            units: () => [],
        };

        const app = {
            sessions: store,
            iterateTargets: () => [target],
            settings: () => ({ builtinPrompt: false }),
            snapshot: () => ({}),
            source: {
                aiRequest: jest.fn(async (_ws, { messages }) => {
                    sentBatches.push(JSON.parse(JSON.stringify(messages)));
                    return { text: `seen ${sentBatches.length}`, calls: [] };
                }),
                lastReply: async () => '',
            },
            toast: jest.fn(),
            refreshBadges: jest.fn(),
            isOpen: () => true,
        };

        const page = createIteratePage(app);
        document.body.appendChild(page.el);
        await page.show({ ws: 'preset' });
        await flushMicrotasks();

        // Turn 1: attach an image and send
        const fileInput = page.el.querySelector('[data-lw-role="att-file-input"]');
        const imgBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 42, 43, 44]);
        const file = new File([imgBytes], 'mockup.png', { type: 'image/png' });
        Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
        fileInput.dispatchEvent(new Event('change'));

        const input = page.el.querySelector('.wb-input');
        input.value = 'Fix spacing based on screenshot';
        page.el.querySelector('.wb-send').click();
        await waitFor(() => sentBatches.length === 1 && !page.el.querySelector('.wb-reads.is-live'));

        expect(sentBatches).toHaveLength(1);
        const turn1User = sentBatches[0].find(m => m.role === 'user');
        expect(Array.isArray(turn1User.content)).toBe(true);
        const expectedDataUrl = `data:image/png;base64,${Buffer.from(imgBytes).toString('base64')}`;
        expect(turn1User.content.some(p => p.type === 'image_url' && p.image_url.url === expectedDataUrl)).toBe(true);

        // Turn 2: follow-up text only — Turn 1 image MUST still be replayed!
        input.value = 'Also check header';
        page.el.querySelector('.wb-send').click();
        await waitFor(() => sentBatches.length === 2 && !page.el.querySelector('.wb-reads.is-live'));

        expect(sentBatches).toHaveLength(2);
        const turn2FirstUser = sentBatches[1].filter(m => m.role === 'user')[0];
        expect(Array.isArray(turn2FirstUser.content)).toBe(true);
        expect(turn2FirstUser.content.some(p => p.type === 'image_url' && p.image_url.url === expectedDataUrl)).toBe(true);

        // Persisted session body must contain ONLY lightweight paths, zero data: URLs
        const listBeforeFork = await store.list('iterate', { scope: 'global' });
        const origSession = await store.get(listBeforeFork[0].id, { scope: 'global' });
        const serializedOrig = JSON.stringify(origSession);
        expect(serializedOrig).not.toContain('data:image/');
        const origPath = origSession.turns[0].attachments[0].path;
        expect(fakeImg.files.has(origPath)).toBe(true);

        // Branch from turn 1 AI answer -> copies attachment to a distinct path
        const forkBtns = [...page.el.querySelectorAll('.wb-msg-act')].filter(b => b.textContent.includes('Branch'));
        forkBtns[0].click();
        await waitFor(async () => (await store.list('iterate', { scope: 'global' })).length === 2);

        const listAfterFork = await store.list('iterate', { scope: 'global' });
        expect(listAfterFork).toHaveLength(2);
        const forkedMeta = listAfterFork.find(s => s.id !== origSession.id);
        const forkedSession = await store.get(forkedMeta.id, { scope: 'global' });
        const forkedPath = forkedSession.turns[0].attachments[0].path;
        expect(forkedPath).not.toBe(origPath);
        expect(fakeImg.files.has(forkedPath)).toBe(true);

        // Deleting original session removes origPath while leaving forkedPath intact
        await store.remove(origSession.id, { scope: 'global' });
        expect(fakeImg.files.has(origPath)).toBe(false);
        expect(fakeImg.files.has(forkedPath)).toBe(true);

        page.destroy();
    });

    test('Ask page supports image-only send, preserves attachments on regenerate, and propagates non-vision model errors', async () => {
        const ctx = createMemoryGlobalCtx();
        globalThis.Luker = { getContext: () => ctx };
        const store = createSessionStore(ctx);
        let attempt = 0;
        const captured = [];

        const app = {
            sessions: store,
            askProviders: () => [],
            iterateTargets: () => [],
            suggestions: () => [],
            settings: () => ({ ask: { sources: {} } }),
            snapshot: () => ({}),
            source: {
                askOverview: async () => ({ ok: true }),
                askReaders: () => ({}),
                askToolsForProviders: () => [],
                aiRequest: jest.fn(async (_role, { messages }) => {
                    attempt += 1;
                    captured.push(JSON.parse(JSON.stringify(messages)));
                    if (attempt === 1) {
                        throw new Error('Model does not support image inputs');
                    }
                    return { text: '', calls: [{ id: 'a1', name: 'wb_answer', args: { text: 'Error screenshot analyzed.' } }] };
                }),
            },
            toast: jest.fn(),
            isOpen: () => true,
        };

        const page = createAskPage(app);
        document.body.appendChild(page.el);
        await page.show();
        await flushMicrotasks();

        const fileInput = page.el.querySelector('[data-lw-role="att-file-input"]');
        const file = new File([Uint8Array.from([1, 2, 3, 4])], 'err.png', { type: 'image/png' });
        Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
        fileInput.dispatchEvent(new Event('change'));

        // Send with empty text (image-only)
        page.el.querySelector('.wb-send').click();
        await waitFor(() => page.el.textContent.includes('Model does not support image inputs') && !page.el.querySelector('.wb-reads.is-live'));

        // First attempt errors directly (non-vision model)
        expect(page.el.textContent).toContain('Model does not support image inputs');
        expect(captured).toHaveLength(1);
        expect(Array.isArray(captured[0][1].content)).toBe(true);

        // Answer again preserves the attachment without re-uploading
        const uploadCountBefore = fakeImg.files.size;
        const regenBtn = [...page.el.querySelectorAll('.wb-msg-act')].find(b => b.textContent.includes('Answer again'));
        regenBtn.click();
        await waitFor(() => page.el.textContent.includes('Error screenshot analyzed.') && !page.el.querySelector('.wb-reads.is-live'));

        expect(fakeImg.files.size).toBe(uploadCountBefore);
        expect(captured).toHaveLength(2);
        expect(Array.isArray(captured[1][1].content)).toBe(true);
        expect(page.el.textContent).toContain('Error screenshot analyzed.');

        page.destroy();
    });
});
