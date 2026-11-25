/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { renderTemplateParts } from '../../public/scripts/lens-shared/behavior-summary.js';
import { buildRegexBehaviorSummary } from '../../public/scripts/extensions/regex/behavior-summary-model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

function makeState(overrides = {}) {
    return {
        disabled: false,
        placements: [1],
        pluginRequest: false,
        pluginReply: false,
        minDepthRaw: '',
        maxDepthRaw: '',
        runOnEdit: false,
        substituteRegex: 0,
        markdownOnly: true,
        promptOnly: false,
        ...overrides,
    };
}

function renderModel(model) {
    expect(model).toBeTruthy();
    const rowTexts = (model.rows || []).map((row) => {
        const parts = renderTemplateParts(row.template, row.tokens);
        return {
            role: row.role,
            tone: row.tone || '',
            text: parts.map((p) => p.textContent).join(''),
            parts,
        };
    });
    const warningTexts = (model.warnings || []).map((warn) => {
        const parts = renderTemplateParts(warn.template, warn.tokens);
        return {
            severity: warn.severity || 'warn',
            text: parts.map((p) => p.textContent).join(''),
            parts,
        };
    });
    const fullText = [
        ...rowTexts.map((r) => `${r.role}: ${r.text}`),
        ...warningTexts.map((w) => w.text),
    ].join('\n');
    expect(fullText).not.toContain('NaN');
    expect(fullText).not.toContain('undefined');
    return { rowTexts, warningTexts, fullText };
}

function tokenFieldKeys(model) {
    const keys = new Set();
    for (const row of model?.rows || []) {
        for (const tok of Object.values(row.tokens || {})) {
            if (Array.isArray(tok?.field)) tok.field.forEach((k) => keys.add(k));
            else if (tok?.field) keys.add(tok.field);
        }
    }
    for (const warn of model?.warnings || []) {
        for (const tok of Object.values(warn.tokens || {})) {
            if (Array.isArray(tok?.field)) tok.field.forEach((k) => keys.add(k));
            else if (tok?.field) keys.add(tok.field);
        }
    }
    return keys;
}

function installMinimalJQuery() {
    function wrap(elements) {
        const list = Array.from(elements || []).filter(Boolean);
        const api = Object.assign(list, {
            find(selector) {
                const found = [];
                for (const el of list) {
                    if (el.querySelectorAll) {
                        for (const match of el.querySelectorAll(selector)) {
                            if (!found.includes(match)) found.push(match);
                        }
                    }
                }
                return wrap(found);
            },
            get(index) {
                return index === undefined ? list : list[index];
            },
            first() {
                return wrap(list.length > 0 ? [list[0]] : []);
            },
            children(selector) {
                const kids = [];
                for (const el of list) {
                    for (const child of el.children || []) {
                        if (!selector || child.matches?.(selector)) {
                            if (!kids.includes(child)) kids.push(child);
                        }
                    }
                }
                return wrap(kids);
            },
            val(value) {
                if (value === undefined) return list[0]?.value ?? '';
                const next = Array.isArray(value) ? value.join('\n') : String(value);
                for (const el of list) el.value = next;
                return api;
            },
            prop(name, value) {
                if (value === undefined) return list[0]?.[name];
                for (const el of list) el[name] = value;
                return api;
            },
            attr(name, value) {
                if (value === undefined) return list[0]?.getAttribute?.(name) ?? undefined;
                for (const el of list) el.setAttribute(name, String(value));
                return api;
            },
            text(value) {
                if (value === undefined) return list[0]?.textContent ?? '';
                for (const el of list) el.textContent = String(value);
                return api;
            },
            empty() {
                for (const el of list) el.innerHTML = '';
                return api;
            },
            append(value) {
                for (const el of list) {
                    if (typeof value === 'string') el.insertAdjacentHTML('beforeend', value);
                    else if (value?.length !== undefined && !value.nodeType) {
                        for (const item of value) el.appendChild(item);
                    } else if (value) {
                        el.appendChild(value);
                    }
                }
                return api;
            },
            remove() {
                for (const el of list) el.remove();
                return api;
            },
            clone() {
                return wrap(list.map((el) => el.cloneNode(true)));
            },
            toggleClass(cls, state) {
                for (const el of list) el.classList.toggle(cls, state);
                return api;
            },
            addClass(cls) {
                for (const el of list) el.classList.add(cls);
                return api;
            },
            removeClass(cls) {
                for (const el of list) el.classList.remove(cls);
                return api;
            },
            hasClass(cls) {
                return Boolean(list[0]?.classList?.contains(cls));
            },
            hide() {
                for (const el of list) el.style.display = 'none';
                return api;
            },
            show() {
                for (const el of list) el.style.display = '';
                return api;
            },
            is(sel) {
                if (sel === ':visible') {
                    return Boolean(list[0] && !list[0].classList?.contains('displayNone') && list[0].style?.display !== 'none');
                }
                return Boolean(list[0]?.matches?.(sel));
            },
            toggle(show) {
                for (const el of list) el.style.display = show ? '' : 'none';
                return api;
            },
            filter(sel) {
                if (typeof sel === 'function') {
                    return wrap(Array.prototype.filter.call(list, (el, i) => sel.call(el, i, el)));
                }
                return wrap(Array.prototype.filter.call(list, (el) => {
                    if (sel === ':checked') return Boolean(el.checked);
                    return Boolean(el.matches?.(sel));
                }));
            },
            map(fn) {
                const mapped = Array.prototype.map.call(list, (el, i) => fn.call(el, i, el));
                return Object.assign(mapped, {
                    get: () => mapped,
                });
            },
            each(fn) {
                list.forEach((el, i) => fn.call(el, i, el));
                return api;
            },
            sortable() {
                return api;
            },
            disableSelection() {
                return api;
            },
            trigger(eventName) {
                const name = String(eventName).split('.')[0];
                for (const el of list) {
                    el.dispatchEvent(new Event(name, { bubbles: true }));
                }
                return api;
            },
            on(events, selectorOrHandler, maybeHandler) {
                const selector = typeof selectorOrHandler === 'string' ? selectorOrHandler : null;
                const handler = selector ? maybeHandler : selectorOrHandler;
                const eventNames = String(events).split(/\s+/).filter(Boolean);
                for (const el of list) {
                    if (!el.__jqHandlers) el.__jqHandlers = [];
                    for (const rawName of eventNames) {
                        const [type, ns = ''] = rawName.split('.');
                        const listener = (event) => {
                            if (selector) {
                                const target = event.target instanceof Element ? event.target.closest(selector) : null;
                                if (!target || !el.contains(target)) return;
                                handler.call(target, event);
                            } else {
                                handler.call(el, event);
                            }
                        };
                        el.addEventListener(type, listener);
                        el.__jqHandlers.push({ type, ns, listener });
                    }
                }
                return api;
            },
            off(namespace) {
                const ns = String(namespace || '').replace(/^\./, '');
                for (const el of list) {
                    if (!el.__jqHandlers) continue;
                    el.__jqHandlers = el.__jqHandlers.filter((entry) => {
                        if (!ns || entry.ns === ns) {
                            el.removeEventListener(entry.type, entry.listener);
                            return false;
                        }
                        return true;
                    });
                }
                return api;
            },
        });
        return api;
    }

    const jq = (input) => {
        if (!input) return wrap([]);
        if (typeof input === 'string') {
            if (input.trim().startsWith('<')) {
                const tpl = document.createElement('template');
                tpl.innerHTML = input.trim();
                return wrap(tpl.content.children);
            }
            return wrap(document.querySelectorAll(input));
        }
        if (input instanceof Element || input === document || input === window) {
            return wrap([input]);
        }
        return wrap([]);
    };
    globalThis.$ = jq;
    globalThis.jQuery = jq;
    return jq;
}

beforeAll(() => {
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    }
    if (!Element.prototype.scrollIntoView) {
        Element.prototype.scrollIntoView = () => {};
    }
});

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    delete globalThis.$;
    delete globalThis.jQuery;
    delete globalThis.toastr;
    delete globalThis.Luker;
    jest.restoreAllMocks();
});

describe('buildRegexBehaviorSummary (all 11 verified runtime rules)', () => {
    test('Rule 1: disabled: true sets dormant tone and renders Rule is disabled — never runs', () => {
        const model = buildRegexBehaviorSummary(makeState({
            disabled: true,
            placements: [],
            markdownOnly: false,
            promptOnly: false,
            runOnEdit: true,
            minDepthRaw: '5',
            maxDepthRaw: '2',
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(rendered.fullText).toMatch(/Rule is disabled/i);
        expect(rendered.fullText).toMatch(/never runs/i);
        expect(tokenFieldKeys(model)).toContain('disabled');
    });

    test('Rule 2: empty placements + !pluginReply emits danger warning and flags pluginRequest with empty placements', () => {
        const displayModel = buildRegexBehaviorSummary(makeState({
            placements: [],
            markdownOnly: true,
            pluginRequest: false,
            pluginReply: false,
        }));
        expect(displayModel.tone).toBe('danger');
        expect(displayModel.warnings.some((w) => w.severity === 'danger')).toBe(true);
        expect(tokenFieldKeys(displayModel)).toContain('placements');
        const displayRendered = renderModel(displayModel);
        expect(displayRendered.warningTexts.some((w) => w.severity === 'danger' && /never trigger/i.test(w.text))).toBe(true);

        const pluginReqModel = buildRegexBehaviorSummary(makeState({
            placements: [],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: true,
            pluginReply: false,
        }));
        expect(pluginReqModel.tone).toBe('danger');
        expect(pluginReqModel.warnings.some((w) => w.severity === 'danger')).toBe(true);
        const reqRendered = renderModel(pluginReqModel);
        expect(reqRendered.warningTexts.some((w) => w.severity === 'danger' && /Plugin Requests/i.test(w.text))).toBe(true);
        expect(tokenFieldKeys(pluginReqModel)).toContain('pluginRequest');
        expect(tokenFieldKeys(pluginReqModel)).toContain('placements');
    });

    test('Rule 3: neither markdownOnly, promptOnly, pluginRequest, nor pluginReply triggers danger permanent mutation warning and dims minDepth/maxDepth', () => {
        const model = buildRegexBehaviorSummary(makeState({
            placements: [1, 2],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: false,
            pluginReply: false,
            runOnEdit: true,
            minDepthRaw: '1',
            maxDepthRaw: '4',
        }));

        expect(model.tone).toBe('danger');
        expect(model.warnings.some((w) => w.severity === 'danger')).toBe(true);
        expect(model.dormantFields).toContain('minDepth');
        expect(model.dormantFields).toContain('maxDepth');
        expect(model.dormantFields).not.toContain('runOnEdit');

        const rendered = renderModel(model);
        expect(rendered.fullText).toMatch(/permanently rewrites saved chat history|Permanent irreversible/i);
        expect(rendered.fullText).toMatch(/edits/i);
        const keys = tokenFieldKeys(model);
        expect(keys).toContain('markdownOnly');
        expect(keys).toContain('promptOnly');
        expect(keys).toContain('pluginRequest');
        expect(keys).toContain('pluginReply');
    });

    test('Rule 4: pluginRequest: true alone is non-destructive (NOT permanent mutation)', () => {
        const model = buildRegexBehaviorSummary(makeState({
            placements: [1, 2],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: true,
            pluginReply: false,
            runOnEdit: false,
        }));

        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual(['runOnEdit']);
        const rendered = renderModel(model);
        expect(rendered.fullText).toMatch(/Non-destructive/i);
        expect(rendered.fullText).toMatch(/Plugin Requests/);
        expect(rendered.fullText).toMatch(/untouched/i);
        expect(rendered.fullText).not.toMatch(/Permanent irreversible/i);
    });

    test('Rule 5: WORLD_INFO (5) without promptOnly and without pluginRequest emits warn; valid with promptOnly or pluginRequest', () => {
        const warnModel = buildRegexBehaviorSummary(makeState({
            placements: [5],
            markdownOnly: true,
            promptOnly: false,
            pluginRequest: false,
            runOnEdit: false,
        }));
        expect(warnModel.tone).toBe('warn');
        expect(warnModel.warnings.some((w) => w.severity === 'warn')).toBe(true);
        const warnRendered = renderModel(warnModel);
        expect(warnRendered.warningTexts.some((w) => w.severity === 'warn' && /World Info/i.test(w.text))).toBe(true);

        const promptOk = buildRegexBehaviorSummary(makeState({
            placements: [5],
            markdownOnly: false,
            promptOnly: true,
            pluginRequest: false,
            runOnEdit: false,
        }));
        expect(promptOk.tone).toBe('active');
        expect(promptOk.warnings).toEqual([]);

        const pluginReqOk = buildRegexBehaviorSummary(makeState({
            placements: [5],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: true,
            runOnEdit: false,
        }));
        expect(pluginReqOk.tone).toBe('active');
        expect(pluginReqOk.warnings).toEqual([]);
    });

    test('Rule 6: SLASH_COMMAND (3) with only promptOnly and/or pluginRequest emits warn; valid with markdownOnly or permanent', () => {
        for (const flags of [
            { markdownOnly: false, promptOnly: true, pluginRequest: false },
            { markdownOnly: false, promptOnly: false, pluginRequest: true },
            { markdownOnly: false, promptOnly: true, pluginRequest: true },
        ]) {
            const warnModel = buildRegexBehaviorSummary(makeState({
                placements: [3],
                ...flags,
                runOnEdit: false,
            }));
            expect(warnModel.tone).toBe('warn');
            expect(warnModel.warnings.some((w) => w.severity === 'warn')).toBe(true);
            const rendered = renderModel(warnModel);
            expect(rendered.warningTexts.some((w) => w.severity === 'warn' && /Slash Commands/i.test(w.text))).toBe(true);
        }

        const displayOk = buildRegexBehaviorSummary(makeState({
            placements: [3],
            markdownOnly: true,
            promptOnly: false,
            pluginRequest: false,
            runOnEdit: false,
        }));
        expect(displayOk.tone).toBe('active');
        expect(displayOk.warnings).toEqual([]);
    });

    test('Rule 7: REASONING (6) with only pluginRequest emits warn; valid with markdownOnly or promptOnly', () => {
        const warnModel = buildRegexBehaviorSummary(makeState({
            placements: [6],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: true,
            runOnEdit: false,
        }));
        expect(warnModel.tone).toBe('warn');
        expect(warnModel.warnings.some((w) => w.severity === 'warn')).toBe(true);
        const rendered = renderModel(warnModel);
        expect(rendered.warningTexts.some((w) => w.severity === 'warn' && /Reasoning/i.test(w.text))).toBe(true);

        const displayOk = buildRegexBehaviorSummary(makeState({
            placements: [6],
            markdownOnly: true,
            pluginRequest: true,
            runOnEdit: false,
        }));
        expect(displayOk.tone).toBe('active');
        expect(displayOk.warnings).toEqual([]);

        const promptOk = buildRegexBehaviorSummary(makeState({
            placements: [6],
            promptOnly: true,
            pluginRequest: true,
            runOnEdit: false,
        }));
        expect(promptOk.tone).toBe('active');
        expect(promptOk.warnings).toEqual([]);
    });

    test('Rule 8: runOnEdit: true while any scoped lane is active (or only WORLD_INFO checked) emits warn and adds runOnEdit to dormantFields', () => {
        for (const lane of [
            { markdownOnly: true, placements: [1] },
            { promptOnly: true, placements: [1] },
            { pluginRequest: true, placements: [1] },
            { pluginReply: true, placements: [] },
        ]) {
            const model = buildRegexBehaviorSummary(makeState({
                markdownOnly: false,
                promptOnly: false,
                pluginRequest: false,
                pluginReply: false,
                runOnEdit: true,
                ...lane,
            }));
            expect(model.tone).toBe('warn');
            expect(model.dormantFields).toContain('runOnEdit');
            expect(model.warnings.some((w) => w.severity === 'warn')).toBe(true);
            const rendered = renderModel(model);
            expect(rendered.warningTexts.some((w) => w.severity === 'warn' && /Run On Edit/i.test(w.text))).toBe(true);
        }

        const worldInfoOnlyPerm = buildRegexBehaviorSummary(makeState({
            placements: [5],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: false,
            pluginReply: false,
            runOnEdit: true,
        }));
        expect(worldInfoOnlyPerm.dormantFields).toContain('runOnEdit');
        const wiRendered = renderModel(worldInfoOnlyPerm);
        expect(wiRendered.warningTexts.some((w) => w.severity === 'warn' && /Run On Edit/i.test(w.text))).toBe(true);
    });

    test('Rule 9: minDepth > maxDepth emits danger; minDepth === maxDepth is valid; blank/-1 includes Continue', () => {
        const inverted = buildRegexBehaviorSummary(makeState({
            placements: [1],
            markdownOnly: true,
            minDepthRaw: '5',
            maxDepthRaw: '2',
        }));
        expect(inverted.tone).toBe('danger');
        expect(inverted.warnings.some((w) => w.severity === 'danger')).toBe(true);
        const invRendered = renderModel(inverted);
        expect(invRendered.warningTexts.some((w) => w.severity === 'danger' && /5/.test(w.text) && /2/.test(w.text))).toBe(true);

        const equal = buildRegexBehaviorSummary(makeState({
            placements: [1],
            markdownOnly: true,
            minDepthRaw: '2',
            maxDepthRaw: '2',
        }));
        expect(equal.tone).toBe('active');
        expect(equal.warnings).toEqual([]);
        const eqRendered = renderModel(equal);
        expect(eqRendered.fullText).toContain('2');

        const contDefault = buildRegexBehaviorSummary(makeState({
            placements: [1],
            markdownOnly: true,
            minDepthRaw: '',
            maxDepthRaw: '',
        }));
        expect(contDefault.tone).toBe('active');
        expect(renderModel(contDefault).fullText).toMatch(/Continue/i);

        const contMinusOne = buildRegexBehaviorSummary(makeState({
            placements: [1],
            markdownOnly: true,
            minDepthRaw: '-1',
            maxDepthRaw: '3',
        }));
        expect(contMinusOne.tone).toBe('active');
        expect(renderModel(contMinusOne).fullText).toMatch(/Continue/i);
    });

    test('Rule 10: pluginReply only with placements or depth set emits warn and dims placements/minDepth/maxDepth', () => {
        const withPlacement = buildRegexBehaviorSummary(makeState({
            placements: [1],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: false,
            pluginReply: true,
            runOnEdit: false,
        }));
        expect(withPlacement.tone).toBe('warn');
        expect(withPlacement.warnings.some((w) => w.severity === 'warn')).toBe(true);
        expect(new Set(withPlacement.dormantFields)).toEqual(new Set(['placements', 'minDepth', 'maxDepth', 'runOnEdit']));
        expect(renderModel(withPlacement).warningTexts.some((w) => w.severity === 'warn' && /Plugin Replies/i.test(w.text))).toBe(true);

        const withDepth = buildRegexBehaviorSummary(makeState({
            placements: [],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: false,
            pluginReply: true,
            minDepthRaw: '1',
            maxDepthRaw: '3',
            runOnEdit: false,
        }));
        expect(withDepth.tone).toBe('warn');
        expect(withDepth.warnings.some((w) => w.severity === 'warn')).toBe(true);
        expect(new Set(withDepth.dormantFields)).toEqual(new Set(['placements', 'minDepth', 'maxDepth', 'runOnEdit']));

        const cleanReplyOnly = buildRegexBehaviorSummary(makeState({
            placements: [],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: false,
            pluginReply: true,
            minDepthRaw: '',
            maxDepthRaw: '',
            runOnEdit: false,
        }));
        expect(cleanReplyOnly.tone).toBe('active');
        expect(cleanReplyOnly.warnings).toEqual([]);
        expect(new Set(cleanReplyOnly.dormantFields)).toEqual(new Set(['placements', 'minDepth', 'maxDepth', 'runOnEdit']));
        renderModel(cleanReplyOnly);
    });

    test('Rule 11 (Review Focus #2): transient "-" or "" depth inputs parse cleanly without NaN', () => {
        for (const [minDepthRaw, maxDepthRaw] of [
            ['-', ''],
            ['', '-'],
            ['-', '-'],
            ['-', '2'],
            ['2', '-'],
            ['   ', ''],
            [null, undefined],
        ]) {
            const model = buildRegexBehaviorSummary(makeState({
                placements: [1],
                markdownOnly: true,
                minDepthRaw,
                maxDepthRaw,
            }));
            expect(model.tone).toBe('active');
            expect(model.warnings).toEqual([]);
            const rendered = renderModel(model);
            expect(rendered.fullText).not.toContain('NaN');
            expect(rendered.fullText).not.toContain('undefined');
        }
    });
});

describe('Regex Editor DOM integration, popup reopen idempotency, and i18n audit', () => {
    async function setupRegexModule({
        editorTemplateHtml,
        reuseTemplateNode = false,
        onPopupOpen = null,
    } = {}) {
        jest.resetModules();

        const scripts = {
            global: [
                {
                    id: 'r1',
                    scriptName: 'Existing Rule',
                    findRegex: '/foo/g',
                    replaceString: 'bar',
                    trimStrings: [],
                    placement: [1],
                    disabled: false,
                    markdownOnly: true,
                    promptOnly: false,
                    pluginLanes: [],
                    runOnEdit: false,
                    substituteRegex: 0,
                    minDepth: null,
                    maxDepth: null,
                },
            ],
            scoped: [],
            preset: [],
        };

        const extensionSettings = {
            disabledExtensions: [],
            regex: scripts.global,
            regex_presets: [],
            regex_perf_detection: true,
            character_allowed_regex: [],
            preset_allowed_regex: {},
        };

        let cachedEditorNode = null;
        const callGenericPopupMock = jest.fn(async (content, _type, _input, options = {}) => {
            const el = content?.get?.(0) || content?.[0] || content;
            if (el instanceof Element) {
                document.body.appendChild(el);
            }
            const fakePopup = {
                result: 0,
                value: 0,
                okButton: document.createElement('button'),
                cancelButton: document.createElement('button'),
            };
            options.onOpen?.(fakePopup);
            if (typeof onPopupOpen === 'function') {
                await onPopupOpen({ el, popup: fakePopup, options });
            }
            options.onClosing?.(fakePopup);
            options.onClose?.(fakePopup);
            if (el instanceof Element && !reuseTemplateNode) {
                el.remove();
            }
            return 0;
        });

        jest.unstable_mockModule('fflate', () => ({
            gzipSync: () => new Uint8Array(),
            gzip: () => {},
        }));
        jest.unstable_mockModule('../../public/script.js', () => ({
            characters: [],
            chatElement: globalThis.$('<div></div>'),
            eventSource: { on: jest.fn(), emit: jest.fn() },
            event_types: {
                MAIN_API_CHANGED: 'main_api_changed',
                CHAT_CHANGED: 'chat_changed',
                CHARACTER_DELETED: 'character_deleted',
                PRESET_RENAMED_BEFORE: 'preset_renamed_before',
                PRESET_CHANGED: 'preset_changed',
                PRESET_DELETED: 'preset_deleted',
                APP_READY: 'app_ready',
                CHARACTER_EDITOR_OPENED: 'character_editor_opened',
                CHAT_LOADED: 'chat_loaded',
            },
            getCurrentChatId: () => 'chat1',
            messageFormatting: (s) => s,
            redisplayChat: jest.fn(),
            reloadCurrentChat: jest.fn(),
            saveSettings: jest.fn(),
            saveSettingsDebounced: jest.fn(),
            substituteParams: (s) => s,
            substituteParamsExtended: (s) => s,
            this_chid: undefined,
            unshallowCharacter: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
            extension_settings: extensionSettings,
            renderExtensionTemplateAsync: jest.fn(async (_ext, templateId) => {
                if (templateId === 'editor') {
                    if (reuseTemplateNode) {
                        if (!cachedEditorNode) {
                            const wrap = document.createElement('div');
                            wrap.innerHTML = editorTemplateHtml;
                            cachedEditorNode = wrap.firstElementChild;
                        }
                        return cachedEditorNode;
                    }
                    return editorTemplateHtml;
                }
                return '<div></div>';
            }),
            writeExtensionField: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
            selected_group: null,
        }));
        jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
            callGenericPopup: callGenericPopupMock,
            POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
            POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3 },
            Popup: { show: { confirm: jest.fn(), input: jest.fn() } },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
            SlashCommand: { fromProps: (x) => x },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
            ARGUMENT_TYPE: { STRING: 'string', BOOLEAN: 'boolean' },
            SlashCommandArgument: class {},
            SlashCommandNamedArgument: { fromProps: (x) => x },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
            commonEnumProviders: { boolean: () => () => [] },
            enumIcons: { getStateIcon: () => '', preset: '' },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
            SlashCommandEnumValue: class {},
            enumTypes: { enum: 'enum', name: 'name', variable: 'variable' },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
            SlashCommandParser: { addCommandObject: jest.fn() },
        }));
        jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
            download: jest.fn(),
            equalsIgnoreCaseAndAccents: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
            escapeHtml: (s) => String(s),
            getFileText: jest.fn(),
            getSortableDelay: () => 0,
            isFalseBoolean: () => false,
            isTrueBoolean: () => false,
            regexFromString: (input) => {
                if (typeof input !== 'string') return null;
                const m = input.match(/\/(.+)\/([gimsuy]*)/s);
                return m ? new RegExp(m[1], m[2]) : new RegExp(input);
            },
            setInfoBlock: (el, msg) => {
                if (el) el.textContent = String(msg ?? '');
            },
            uuidv4: () => 'test-uuid',
        }));
        jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
            getCurrentLocale: () => 'en',
            t: (strings, ...values) => strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), ''),
            translate: (text) => String(text ?? ''),
        }));
        jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
            accountStorage: { getItem: () => null, setItem: jest.fn(), removeItem: jest.fn() },
        }));
        jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({
            getPresetManager: () => null,
        }));

        const mod = await import('../../public/scripts/extensions/regex/index.js');
        return { mod, callGenericPopupMock };
    }

    test('editor.html removes ext_regex_desc small note while keeping #regex_info_block, .regex-scope-help-link, and ? link', () => {
        const html = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/regex/editor.html'),
            'utf8',
        );

        expect(html).not.toContain('ext_regex_desc');
        expect(html).not.toContain('Regex is a tool to find/replace strings using regular expressions.');
        expect(html).toContain('id="regex_info_block"');
        expect(html).toContain('class="regex-scope-help-link');
        expect(html).toContain('https://docs.sillytavern.app/extensions/regex/');
        expect(html).toContain('<span class="note-link-span">?</span>');
    });

    test('Review Focus #3 + live DOM: mounts strictly one summary card above Affects/Other Options, refreshes live on input/change without losing focus, and destroys cleanly on close/reopen even with reused DOM', async () => {
        installMinimalJQuery();
        globalThis.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };

        const editorTemplateHtml = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/regex/editor.html'),
            'utf8',
        );

        const seenOpens = [];
        let activePopupHook = null;
        const { mod } = await setupRegexModule({
            editorTemplateHtml,
            reuseTemplateNode: true,
            onPopupOpen: async ({ el }) => {
                const cards = el.querySelectorAll('.luker-bsum[data-bsum-id="regex-editor"]');
                const twoColGrid = el.querySelector('input[name="replace_position"]')?.closest('.wi-enter-footer-text')?.parentElement;
                seenOpens.push({
                    cardCount: cards.length,
                    nextIsTwoCol: cards[0]?.nextElementSibling === twoColGrid,
                });
                if (activePopupHook) {
                    await activePopupHook(el, cards[0]);
                }
            },
        });

        // Open #1 (new script): verify live updates, focus preservation, and token click jump
        let liveChecks = null;
        activePopupHook = (el, card) => {
            const initWarn = card.classList.contains('is-warn');
            const runOnEditLabel = el.querySelector('input[name="run_on_edit"]').closest('label.checkbox');
            const initDormant = runOnEditLabel.classList.contains('luker-bsum-field-dormant');

            const runOnEditInput = el.querySelector('input[name="run_on_edit"]');
            runOnEditInput.checked = false;
            runOnEditInput.dispatchEvent(new Event('change', { bubbles: true }));
            const afterUncheckActive = card.classList.contains('is-active');

            const minDepthInput = el.querySelector('input[name="min_depth"]');
            const maxDepthInput = el.querySelector('input[name="max_depth"]');
            minDepthInput.focus();
            minDepthInput.value = '-';
            minDepthInput.dispatchEvent(new Event('input', { bubbles: true }));
            const focusAfterDash = document.activeElement === minDepthInput;
            const noNaNAfterDash = !card.textContent.includes('NaN');
            const activeAfterDash = card.classList.contains('is-active');

            minDepthInput.value = '5';
            minDepthInput.dispatchEvent(new Event('input', { bubbles: true }));
            maxDepthInput.value = '2';
            maxDepthInput.dispatchEvent(new Event('input', { bubbles: true }));
            const focusAfterInvert = document.activeElement === minDepthInput;
            const dangerAfterInvert = card.classList.contains('is-danger');

            const maxBtn = card.querySelector('.luker-bsum-warnings button[data-bsum-fields="maxDepth"]');
            maxBtn?.click();
            const focusedMaxAfterJump = document.activeElement === maxDepthInput;

            liveChecks = {
                initWarn,
                initDormant,
                afterUncheckActive,
                focusAfterDash,
                noNaNAfterDash,
                activeAfterDash,
                focusAfterInvert,
                dangerAfterInvert,
                hasMaxBtn: Boolean(maxBtn),
                focusedMaxAfterJump,
            };
        };

        await mod.onRegexEditorOpenClick(false, 0);
        expect(liveChecks).toEqual({
            initWarn: true,
            initDormant: true,
            afterUncheckActive: true,
            focusAfterDash: true,
            noNaNAfterDash: true,
            activeAfterDash: true,
            focusAfterInvert: true,
            dangerAfterInvert: true,
            hasMaxBtn: true,
            focusedMaxAfterJump: true,
        });
        // After close, card is cleanly destroyed even though DOM node was reused
        expect(document.querySelectorAll('.luker-bsum[data-bsum-id="regex-editor"]')).toHaveLength(0);

        // Open #2 (reopening with reused DOM node mounts strictly one card)
        activePopupHook = null;
        await mod.onRegexEditorOpenClick('r1', 0);
        expect(document.querySelectorAll('.luker-bsum[data-bsum-id="regex-editor"]')).toHaveLength(0);

        // Open #3 (read-only runtime plugin script popup also mounts strictly one card and destroys on close)
        await mod.onReadonlyRegexViewOpenClick({
            id: 'plugin-r1',
            scriptName: 'Plugin Rule',
            findRegex: '/bar/g',
            replaceString: 'baz',
            trimStrings: [],
            placement: [],
            disabled: false,
            markdownOnly: false,
            promptOnly: false,
            pluginLanes: ['reply'],
            runOnEdit: false,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
        }, 'Plugin Rule');
        expect(document.querySelectorAll('.luker-bsum[data-bsum-id="regex-editor"]')).toHaveLength(0);
        expect(seenOpens).toEqual([
            { cardCount: 1, nextIsTwoCol: true },
            { cardCount: 1, nextIsTwoCol: true },
            { cardCount: 1, nextIsTwoCol: true },
        ]);
    });

    test('zh-cn and zh-tw locale files include all Regex summary keys with matching ${token} placeholders, zero unescaped semicolons, and full-width CJK punctuation', () => {
        const modelSrc = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/regex/behavior-summary-model.js'),
            'utf8',
        );
        const indexSrc = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/regex/index.js'),
            'utf8',
        );
        const zhCn = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-tw.json'), 'utf8'));
        const halfWidthCjk = /[\u3400-\u9fff][,.;:!?()]|[,.;:!?()][\u3400-\u9fff]/;

        const keys = new Set();
        const englishTexts = new Set();
        for (const src of [modelSrc, indexSrc]) {
            for (const m of src.matchAll(/\btranslate\(\s*'((?:\\'|[^'])*)'(?:\s*,\s*'((?:\\'|[^'])*)')?\s*\)/g)) {
                const text = m[1].replace(/\\'/g, '\'');
                const key = m[2] ? m[2].replace(/\\'/g, '\'') : text;
                englishTexts.add(text);
                keys.add(key);
            }
        }
        expect(keys.size).toBeGreaterThan(15);

        for (const text of englishTexts) {
            expect(text).not.toMatch(/(?<!\\);/);
        }

        for (const key of keys) {
            expect(key).not.toMatch(/(?<!\\);/);
            expect(typeof zhCn[key]).toBe('string');
            expect(typeof zhTw[key]).toBe('string');
            expect(zhCn[key].length).toBeGreaterThan(0);
            expect(zhTw[key].length).toBeGreaterThan(0);
            expect(halfWidthCjk.test(zhCn[key])).toBe(false);
            expect(halfWidthCjk.test(zhTw[key])).toBe(false);

            const expectedTokens = [...key.matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
            const cnTokens = [...zhCn[key].matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
            const twTokens = [...zhTw[key].matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
            expect(cnTokens).toEqual(expectedTokens);
            expect(twTokens).toEqual(expectedTokens);
        }
    });

    test('zh-cn and zh-tw warning and effect labels match editor.html Only Format Display, Only Format Prompt (?), and ext_regex_affects verbatim', () => {
        const zhCn = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-tw.json'), 'utf8'));
        const makeTranslate = (localeMap) => (text, key = null) => localeMap?.[key || text] || text;

        for (const localeMap of [zhCn, zhTw]) {
            const expectedDisplay = localeMap['Only Format Display'];
            const expectedPrompt = localeMap['Only Format Prompt (?)'];
            const expectedAffects = localeMap['ext_regex_affects'];
            expect(expectedDisplay).toBeTruthy();
            expect(expectedPrompt).toBeTruthy();
            expect(expectedAffects).toBeTruthy();

            // Verify defaultTranslate forwards (text, key) through Luker.getContext().translate
            globalThis.Luker = { getContext: () => ({ translate: makeTranslate(localeMap) }) };

            const permanentModel = buildRegexBehaviorSummary(makeState({
                placements: [1],
                markdownOnly: false,
                promptOnly: false,
                pluginRequest: false,
                pluginReply: false,
            }));
            const permanentWarnTokens = permanentModel.warnings[0].tokens;
            expect(permanentWarnTokens.markdownOnly.text).toBe(expectedDisplay);
            expect(permanentWarnTokens.promptOnly.text).toBe(expectedPrompt);
            expect(renderModel(permanentModel).fullText).toContain(expectedDisplay);
            expect(renderModel(permanentModel).fullText).toContain(expectedPrompt);

            const emptyPlacementsModel = buildRegexBehaviorSummary(makeState({
                placements: [],
                markdownOnly: true,
                promptOnly: false,
                pluginRequest: true,
                pluginReply: false,
            }));
            expect(emptyPlacementsModel.warnings[0].tokens.placements.text).toBe(expectedAffects);
            expect(renderModel(emptyPlacementsModel).fullText).toContain(expectedAffects);

            const worldInfoWarnModel = buildRegexBehaviorSummary(makeState({
                placements: [5],
                markdownOnly: true,
                promptOnly: false,
                pluginRequest: false,
            }));
            expect(worldInfoWarnModel.warnings[0].tokens.promptOnly.text).toBe(expectedPrompt);

            const replyOnlyWarnModel = buildRegexBehaviorSummary(makeState({
                placements: [1],
                markdownOnly: false,
                promptOnly: false,
                pluginRequest: false,
                pluginReply: true,
            }));
            expect(replyOnlyWarnModel.warnings[0].tokens.placements.text).toBe(expectedAffects);

            const effectModel = buildRegexBehaviorSummary(makeState({
                placements: [1, 2],
                markdownOnly: true,
                promptOnly: true,
                translate: makeTranslate(localeMap),
            }));
            const effectPassesText = effectModel.rows[1].tokens.passes.text;
            expect(effectPassesText).toContain(expectedDisplay);
            expect(effectPassesText).toContain(expectedPrompt);
            expect(effectModel.rows[0].tokens.placements.text).toContain(localeMap['ext_regex_user_input']);
            expect(effectModel.rows[0].tokens.placements.text).toContain(localeMap['ext_regex_ai_output']);
            renderModel(effectModel);
        }
    });
});
