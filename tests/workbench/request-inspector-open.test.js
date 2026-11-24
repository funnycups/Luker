/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

const callGenericPopupMock = jest.fn();

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    callGenericPopup: callGenericPopupMock,
    POPUP_TYPE: { TEXT: 1 },
}));

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (parts, ...values) => parts.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), ''),
}));

jest.unstable_mockModule('../../public/script.js', () => ({
    getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
}));

/** Minimal DOM-backed jQuery stand-in covering openInspectorPanel() interactions. */
function makeMiniJQuery() {
    const delegated = new WeakMap();
    function wrap(el) {
        const wrapper = {
            0: el,
            length: el ? 1 : 0,
            html(markup) {
                if (markup === undefined) return el ? el.innerHTML : '';
                if (el) el.innerHTML = markup;
                return wrapper;
            },
            on(eventName, selector, handler) {
                if (!el) return wrapper;
                const fn = typeof selector === 'function' ? selector : handler;
                const sel = typeof selector === 'function' ? null : selector;
                if (!sel) {
                    el.addEventListener(eventName, (ev) => fn.call(el, ev));
                    return wrapper;
                }
                let byEvent = delegated.get(el);
                if (!byEvent) {
                    byEvent = new Map();
                    delegated.set(el, byEvent);
                }
                let list = byEvent.get(eventName);
                if (!list) {
                    list = [];
                    byEvent.set(eventName, list);
                    el.addEventListener(eventName, (ev) => {
                        let stopped = false;
                        const origStop = ev.stopPropagation.bind(ev);
                        ev.stopPropagation = () => { stopped = true; origStop(); };
                        for (let node = ev.target; node && node !== el && !stopped; node = node.parentElement) {
                            for (const item of list) {
                                if (node.matches?.(item.sel)) {
                                    item.fn.call(node, ev);
                                    if (stopped) break;
                                }
                            }
                        }
                    });
                }
                list.push({ sel, fn });
                return wrapper;
            },
            find(selector) {
                return wrap(el ? el.querySelector(selector) : null);
            },
            closest(selector) {
                return wrap(el ? el.closest(selector) : null);
            },
            data(key) {
                return el?.getAttribute?.(`data-${key}`) ?? undefined;
            },
            attr(name) {
                return el?.getAttribute?.(name) ?? undefined;
            },
            val() {
                return el?.value ?? '';
            },
            prop() {
                return wrapper;
            },
            scrollTop() {
                return wrapper;
            },
            after() {
                return wrapper;
            },
            append() {
                return wrapper;
            },
        };
        return wrapper;
    }

    const $ = (input) => {
        if (typeof input === 'function') return; // document-ready hook
        if (typeof input === 'string') {
            const trimmed = input.trim();
            if (trimmed.startsWith('<')) {
                const tpl = document.createElement('template');
                tpl.innerHTML = trimmed;
                return wrap(tpl.content.firstElementChild);
            }
            return wrap(document.querySelector(trimmed));
        }
        return wrap(input);
    };
    return $;
}

const $stub = makeMiniJQuery();
globalThis.$ = $stub;
globalThis.jQuery = $stub;

const { openRequestInspector } = await import('../../public/scripts/request-inspector.js');

describe('request-inspector openRequestInspector security & 404 fallback', () => {
    let origFetch;
    let origToastr;

    beforeEach(() => {
        origFetch = globalThis.fetch;
        origToastr = globalThis.toastr;
        callGenericPopupMock.mockClear();
        globalThis.toastr = {
            info: jest.fn(),
            success: jest.fn(),
            error: jest.fn(),
        };
        document.body.innerHTML = '';
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        globalThis.toastr = origToastr;
        jest.restoreAllMocks();
    });

    test('rejects path-traversal and reserved requestIds without issuing detail fetch and falls back to list', async () => {
        const fetchedUrls = [];
        globalThis.fetch = jest.fn(async (url) => {
            fetchedUrls.push(String(url));
            if (String(url) === '/api/request-inspector/list') {
                return {
                    ok: true,
                    json: async () => [{ id: 'req_safe_1', type: 'chat', source: 'openai', model: 'gpt-4o', status: 'success', timestamp: Date.now() }],
                };
            }
            throw new Error(`Unexpected detail fetch: ${url}`);
        });

        for (const badId of ['../secrets', 'foo/bar', 'a\\b', 'req?x=1', 'req#hash', 'list', 'LIST', 'List', '.', '..', 'bad id']) {
            fetchedUrls.length = 0;
            globalThis.toastr.info.mockClear();
            callGenericPopupMock.mockClear();

            await openRequestInspector(badId);

            expect(fetchedUrls).toEqual(['/api/request-inspector/list']);
            expect(globalThis.toastr.info).toHaveBeenCalledTimes(1);
            const content = callGenericPopupMock.mock.calls[0][0];
            expect(content[0].querySelector('.ri-filter-bar')).not.toBeNull();
            expect(content[0].innerHTML).toContain('req_safe_1');
        }
    });

    test('falls back from 404 detail response to list view with toast notice instead of empty dead-end page', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const fetchedUrls = [];
        globalThis.fetch = jest.fn(async (url) => {
            fetchedUrls.push(String(url));
            if (String(url) === '/api/request-inspector/req_expired_404') {
                return { ok: false, status: 404 };
            }
            if (String(url) === '/api/request-inspector/list') {
                return {
                    ok: true,
                    json: async () => [{ id: 'req_recent_1', type: 'chat', source: 'openai', model: 'claude-3', status: 'success', timestamp: Date.now() }],
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await openRequestInspector('req_expired_404');

        expect(fetchedUrls).toEqual([
            '/api/request-inspector/req_expired_404',
            '/api/request-inspector/list',
        ]);
        expect(globalThis.toastr.info).toHaveBeenCalledTimes(1);
        const content = callGenericPopupMock.mock.calls[0][0];
        expect(content[0].querySelector('.ri-filter-bar')).not.toBeNull();
        expect(content[0].innerHTML).toContain('req_recent_1');
        expect(content[0].innerHTML).not.toContain('Failed to load request details.');
        errorSpy.mockRestore();
    });

    test('URL-encodes valid requestId for both detail fetch and export link download', async () => {
        const specialId = 'req:abc+1%2';
        const encodedId = encodeURIComponent(specialId);
        const fetchedUrls = [];
        globalThis.fetch = jest.fn(async (url) => {
            fetchedUrls.push(String(url));
            if (String(url) === `/api/request-inspector/${encodedId}`) {
                return {
                    ok: true,
                    json: async () => ({
                        id: specialId,
                        type: 'chat',
                        source: 'openai',
                        model: 'gemini-2.5-pro',
                        status: 'success',
                        httpStatus: 200,
                        durationMs: 420,
                        timestamp: Date.now(),
                        fullMessages: [{ role: 'user', content: 'hi' }],
                        responseText: 'hello',
                    }),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await openRequestInspector(specialId);

        expect(fetchedUrls).toEqual([`/api/request-inspector/${encodedId}`]);
        expect(globalThis.toastr.info).not.toHaveBeenCalled();

        const content = callGenericPopupMock.mock.calls[0][0];
        const exportBtn = content[0].querySelector('.ri-export');
        expect(exportBtn).not.toBeNull();
        expect(content[0].querySelector('.ri-back')).not.toBeNull();

        // Intercept created anchor element to assert encoded export URL
        let clickedHref = '';
        const origCreateElement = document.createElement.bind(document);
        jest.spyOn(document, 'createElement').mockImplementation((tagName) => {
            const node = origCreateElement(tagName);
            if (String(tagName).toLowerCase() === 'a') {
                node.click = () => { clickedHref = node.getAttribute('href') || ''; };
            }
            return node;
        });

        exportBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        expect(clickedHref).toBe(`/api/request-inspector/${encodedId}/export`);
    });

    test('reopening without initialRequestId resets cachedDetail and currentDetailSearch', async () => {
        const fetchedUrls = [];
        globalThis.fetch = jest.fn(async (url, opts) => {
            const target = String(url);
            fetchedUrls.push(`${opts?.method || 'GET'} ${target}`);
            if (target === '/api/request-inspector/req_prev_1') {
                return {
                    ok: true,
                    json: async () => ({
                        id: 'req_prev_1',
                        type: 'chat',
                        source: 'openai',
                        model: 'gpt-4o',
                        status: 'success',
                        httpStatus: 200,
                        durationMs: 300,
                        timestamp: Date.now(),
                        fullMessages: [{ role: 'user', content: 'old detail' }],
                        responseText: 'old reply',
                    }),
                };
            }
            if (target === '/api/request-inspector/list') {
                return {
                    ok: true,
                    json: async () => [{
                        id: 'req_running_2',
                        type: 'chat',
                        source: 'openai',
                        model: 'gpt-4o',
                        status: 'running',
                        abortKind: 'request',
                        timestamp: Date.now(),
                    }],
                };
            }
            if (target === '/api/request-inspector/req_running_2/abort') {
                return { ok: true, json: async () => ({ ok: true }) };
            }
            throw new Error(`Unexpected fetch: ${target}`);
        });

        await openRequestInspector('req_prev_1');
        const firstContent = callGenericPopupMock.mock.calls[0][0];
        const detailSearch = firstContent[0].querySelector('.ri-detail-search');
        if (detailSearch) {
            detailSearch.value = 'stale-query';
            detailSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
        }

        // Reopen in list mode (no initialRequestId) and trigger refresh via abort button
        fetchedUrls.length = 0;
        callGenericPopupMock.mockClear();
        await openRequestInspector();
        const listContent = callGenericPopupMock.mock.calls[0][0];
        const abortBtn = listContent[0].querySelector('.ri-abort-btn');
        expect(abortBtn).not.toBeNull();
        abortBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise(r => setTimeout(r, 10));

        expect(fetchedUrls).toEqual([
            'GET /api/request-inspector/list',
            'POST /api/request-inspector/req_running_2/abort',
            'GET /api/request-inspector/list',
        ]);
        expect(fetchedUrls.some(u => u.includes('req_prev_1'))).toBe(false);
    });
});
