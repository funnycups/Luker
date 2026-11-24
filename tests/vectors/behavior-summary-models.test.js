/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { renderTemplateParts } from '../../public/scripts/lens-shared/behavior-summary.js';
import {
    buildVectorsSharedSummary,
    buildVectorsWorldInfoSummary,
    buildVectorsFilesSummary,
    buildVectorsChatsSummary,
} from '../../public/scripts/extensions/vectors/behavior-summary-models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

function makeSharedState(overrides = {}) {
    return {
        enabledWorldInfo: false,
        enabledFiles: false,
        enabledChats: true,
        embeddingProfileId: 'embed-1',
        embeddingProfileLabel: 'OpenAI Small',
        query: 2,
        scoreThreshold: 0.25,
        forceChunkDelimiter: '',
        includeWi: false,
        rerankEnabled: false,
        rerankProfileId: '',
        rerankProfileLabel: '',
        ...overrides,
    };
}

function makeWorldInfoState(overrides = {}) {
    return {
        enabledWorldInfo: true,
        enabledForAll: false,
        maxEntries: 5,
        ...overrides,
    };
}

function makeFilesState(overrides = {}) {
    return {
        enabledFiles: true,
        onlyCustomBoundary: false,
        forceChunkDelimiter: '',
        translateFiles: false,
        translationAvailable: true,
        sizeThreshold: 10,
        chunkSize: 5000,
        overlapPercent: 0,
        chunkCount: 2,
        sizeThresholdDb: 5,
        chunkSizeDb: 2500,
        overlapPercentDb: 0,
        chunkCountDb: 5,
        fileTemplateDb: 'Related information:\n{{text}}',
        filePositionDb: 0,
        fileDepthDb: 4,
        fileDepthRoleDb: 0,
        ...overrides,
    };
}

function makeChatsState(overrides = {}) {
    return {
        enabledChats: true,
        keepHidden: false,
        template: 'Past events:\n{{text}}',
        position: 0,
        depth: 2,
        messageChunkSize: 400,
        protect: 5,
        insert: 3,
        summarize: false,
        summarizeSent: false,
        summarySource: 'main',
        summaryPrompt: 'Summarize concisely.',
        summaryRetries: 2,
        summaryThreshold: 200,
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

function installMinimalJQuery({ syntheticOnly = false } = {}) {
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
            val(value) {
                if (value === undefined) return list[0]?.value ?? '';
                for (const el of list) el.value = String(value);
                return api;
            },
            prop(name, value) {
                if (value === undefined) return list[0]?.[name];
                for (const el of list) el[name] = value;
                return api;
            },
            text(value) {
                if (value === undefined) return list[0]?.textContent ?? '';
                for (const el of list) el.textContent = String(value);
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
            hide() {
                for (const el of list) el.style.display = 'none';
                return api;
            },
            show() {
                for (const el of list) el.style.display = '';
                return api;
            },
            toggle(show) {
                for (const el of list) el.style.display = show ? '' : 'none';
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
            trigger(eventName) {
                const name = String(eventName).split('.')[0];
                for (const el of list) {
                    if (syntheticOnly) {
                        if (el.__jqHandlers) {
                            for (const entry of el.__jqHandlers) {
                                if (entry.type === name) {
                                    entry.handler.call(el, { type: name, target: el, currentTarget: el });
                                }
                            }
                        }
                    } else {
                        el.dispatchEvent(new Event(name, { bubbles: true }));
                    }
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
                        el.__jqHandlers.push({ type, ns, listener, handler });
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

describe('buildVectorsSharedSummary', () => {
    test('all 3 feature toggles off sets dormant tone, clears warnings, and dims shared retrieval/rerank controls', () => {
        const model = buildVectorsSharedSummary(makeSharedState({
            enabledWorldInfo: false,
            enabledFiles: false,
            enabledChats: false,
            embeddingProfileId: '',
            rerankEnabled: true,
            rerankProfileId: '',
            includeWi: true,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set([
            'embeddingProfileId',
            'query',
            'scoreThreshold',
            'forceChunkDelimiter',
            'includeWi',
            'rerankEnabled',
            'rerankProfileId',
        ]));
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(tokenFieldKeys(model)).toEqual(new Set([
            'enabledWorldInfo',
            'enabledFiles',
            'enabledChats',
        ]));
    });

    test('any feature toggle on with empty embeddingProfileId emits danger warning', () => {
        for (const toggles of [
            { enabledWorldInfo: true, enabledFiles: false, enabledChats: false },
            { enabledWorldInfo: false, enabledFiles: true, enabledChats: false },
            { enabledWorldInfo: false, enabledFiles: false, enabledChats: true },
        ]) {
            const model = buildVectorsSharedSummary(makeSharedState({
                ...toggles,
                embeddingProfileId: '',
                embeddingProfileLabel: '',
            }));
            expect(model.tone).toBe('danger');
            expect(model.warnings.some((w) => w.severity === 'danger')).toBe(true);
            const rendered = renderModel(model);
            expect(rendered.warningTexts.some((w) => w.severity === 'danger' && /Embedding Profile/i.test(w.text))).toBe(true);
            expect(tokenFieldKeys(model)).toContain('embeddingProfileId');
        }
    });

    test('rerankEnabled without rerankProfileId emits warn noting candidate over-fetch; !rerankEnabled puts rerankProfileId in dormantFields', () => {
        const missingRerank = buildVectorsSharedSummary(makeSharedState({
            enabledChats: true,
            rerankEnabled: true,
            rerankProfileId: '',
        }));
        expect(missingRerank.tone).toBe('warn');
        expect(missingRerank.warnings.some((w) => w.severity === 'warn')).toBe(true);
        expect(missingRerank.dormantFields).not.toContain('rerankProfileId');
        const warnText = renderModel(missingRerank).warningTexts.map((w) => w.text).join('\n');
        expect(warnText).toMatch(/4x.*20|max\(4x, 20\)/i);
        expect(warnText).toMatch(/skip/i);

        const rerankOff = buildVectorsSharedSummary(makeSharedState({
            enabledChats: true,
            rerankEnabled: false,
            rerankProfileId: 'rr-1',
            rerankProfileLabel: 'Cohere Rerank',
        }));
        expect(rerankOff.tone).toBe('active');
        expect(rerankOff.warnings).toEqual([]);
        expect(rerankOff.dormantFields).toContain('rerankProfileId');
        expect(renderModel(rerankOff).rowTexts[1].tone).toBe('off');

        const rerankReady = buildVectorsSharedSummary(makeSharedState({
            enabledChats: true,
            rerankEnabled: true,
            rerankProfileId: 'rr-1',
            rerankProfileLabel: 'Cohere Rerank',
        }));
        expect(rerankReady.tone).toBe('active');
        expect(rerankReady.dormantFields).not.toContain('rerankProfileId');
        expect(renderModel(rerankReady).fullText).toContain('Cohere Rerank');
    });

    test('includeWi on while only World Info enabled puts includeWi and forceChunkDelimiter in dormantFields and warns clearly', () => {
        const wiOnly = buildVectorsSharedSummary(makeSharedState({
            enabledWorldInfo: true,
            enabledFiles: false,
            enabledChats: false,
            includeWi: true,
        }));
        expect(wiOnly.tone).toBe('warn');
        expect(wiOnly.dormantFields).toContain('includeWi');
        expect(wiOnly.dormantFields).toContain('forceChunkDelimiter');
        expect(wiOnly.warnings.some((w) => w.severity === 'warn')).toBe(true);
        const warnText = renderModel(wiOnly).warningTexts.map((w) => w.text).join('\n');
        expect(warnText).toMatch(/Include in World Info Scanning/i);
        expect(warnText).toMatch(/Chat.*Data Bank|Data Bank.*Chat/i);

        const withChats = buildVectorsSharedSummary(makeSharedState({
            enabledWorldInfo: true,
            enabledFiles: false,
            enabledChats: true,
            includeWi: true,
        }));
        expect(withChats.tone).toBe('active');
        expect(withChats.dormantFields).not.toContain('includeWi');
        expect(withChats.dormantFields).not.toContain('forceChunkDelimiter');
        expect(withChats.warnings).toEqual([]);

        const withFiles = buildVectorsSharedSummary(makeSharedState({
            enabledWorldInfo: false,
            enabledFiles: true,
            enabledChats: false,
            includeWi: true,
        }));
        expect(withFiles.tone).toBe('active');
        expect(withFiles.dormantFields).not.toContain('includeWi');
        expect(withFiles.dormantFields).not.toContain('forceChunkDelimiter');
        expect(withFiles.warnings).toEqual([]);
    });

    test('transient blank numeric inputs render safely without NaN or undefined', () => {
        const model = buildVectorsSharedSummary(makeSharedState({
            enabledChats: true,
            query: '',
            scoreThreshold: '',
        }));
        expect(model.tone).toBe('active');
        const rendered = renderModel(model);
        expect(rendered.fullText).toContain('OpenAI Small');
        expect(rendered.fullText).toContain('2');
        expect(rendered.fullText).toContain('0.25');
    });
});

describe('buildVectorsWorldInfoSummary', () => {
    test('disabled state sets dormant tone and dims enabledForAll and maxEntries', () => {
        const model = buildVectorsWorldInfoSummary(makeWorldInfoState({
            enabledWorldInfo: false,
            enabledForAll: true,
            maxEntries: 8,
        }));
        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set(['enabledForAll', 'maxEntries']));
        expect(renderModel(model).rowTexts[0].tone).toBe('off');
    });

    test('enabled state renders all enabled entries vs vectorized entries only and maxEntries', () => {
        const allEntries = buildVectorsWorldInfoSummary(makeWorldInfoState({
            enabledWorldInfo: true,
            enabledForAll: true,
            maxEntries: 7,
        }));
        expect(allEntries.tone).toBe('active');
        expect(allEntries.dormantFields).toEqual([]);
        const allText = renderModel(allEntries).fullText;
        expect(allText).toContain('all enabled entries');
        expect(allText).toContain('7');

        const vecOnly = buildVectorsWorldInfoSummary(makeWorldInfoState({
            enabledWorldInfo: true,
            enabledForAll: false,
            maxEntries: 3,
        }));
        expect(vecOnly.tone).toBe('active');
        const vecText = renderModel(vecOnly).fullText;
        expect(vecText).toContain('🔗 vectorized entries only');
        expect(vecText).toContain('3');
    });
});

describe('buildVectorsFilesSummary', () => {
    test('disabled state sets dormant tone and dims all file controls', () => {
        const model = buildVectorsFilesSummary(makeFilesState({
            enabledFiles: false,
        }));
        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set([
            'onlyCustomBoundary',
            'translateFiles',
            'sizeThreshold',
            'chunkSize',
            'overlapPercent',
            'chunkCount',
            'sizeThresholdDb',
            'chunkSizeDb',
            'overlapPercentDb',
            'chunkCountDb',
            'fileTemplateDb',
            'filePositionDb',
            'fileDepthDb',
            'fileDepthRoleDb',
        ]));
    });

    test('onlyCustomBoundary without forceChunkDelimiter emits warn; with delimiter clears warn', () => {
        const missingDelim = buildVectorsFilesSummary(makeFilesState({
            onlyCustomBoundary: true,
            forceChunkDelimiter: '',
        }));
        expect(missingDelim.tone).toBe('warn');
        expect(missingDelim.warnings.some((w) => w.severity === 'warn')).toBe(true);
        const warnText = renderModel(missingDelim).warningTexts.map((w) => w.text).join('\n');
        expect(warnText).toMatch(/Chunk boundary/i);
        expect(warnText).toMatch(/fall.*back|default/i);
        expect(tokenFieldKeys(missingDelim)).toContain('forceChunkDelimiter');

        const withDelim = buildVectorsFilesSummary(makeFilesState({
            onlyCustomBoundary: true,
            forceChunkDelimiter: '---',
        }));
        expect(withDelim.tone).toBe('active');
        expect(withDelim.warnings).toEqual([]);
        expect(renderModel(withDelim).fullText).toContain('---');
    });

    test('translateFiles when translationAvailable is false emits warn', () => {
        const unavailable = buildVectorsFilesSummary(makeFilesState({
            translateFiles: true,
            translationAvailable: false,
        }));
        expect(unavailable.tone).toBe('warn');
        expect(unavailable.warnings.some((w) => w.severity === 'warn')).toBe(true);
        expect(renderModel(unavailable).warningTexts[0].text).toMatch(/Chat Translation/i);

        const available = buildVectorsFilesSummary(makeFilesState({
            translateFiles: true,
            translationAvailable: true,
        }));
        expect(available.tone).toBe('active');
        expect(available.warnings).toEqual([]);
    });

    test('missing {{text}} in fileTemplateDb emits danger warning', () => {
        const model = buildVectorsFilesSummary(makeFilesState({
            fileTemplateDb: 'Related info without macro',
        }));
        expect(model.tone).toBe('danger');
        expect(model.warnings.some((w) => w.severity === 'danger')).toBe(true);
        const warnText = renderModel(model).warningTexts.map((w) => w.text).join('\n');
        expect(warnText).toContain('{{text}}');
    });

    test('filePositionDb !== 1 dims fileDepthDb and fileDepthRoleDb; === 1 activates and renders depth & role', () => {
        for (const pos of [0, 2]) {
            const nonChat = buildVectorsFilesSummary(makeFilesState({
                filePositionDb: pos,
                fileDepthDb: 6,
                fileDepthRoleDb: 1,
            }));
            expect(new Set(nonChat.dormantFields)).toEqual(new Set(['fileDepthDb', 'fileDepthRoleDb']));
            expect(tokenFieldKeys(nonChat)).not.toContain('fileDepthDb');
            expect(tokenFieldKeys(nonChat)).not.toContain('fileDepthRoleDb');
            renderModel(nonChat);
        }

        const inChat = buildVectorsFilesSummary(makeFilesState({
            filePositionDb: 1,
            fileDepthDb: 6,
            fileDepthRoleDb: 2,
        }));
        expect(inChat.dormantFields).toEqual([]);
        const rendered = renderModel(inChat);
        expect(rendered.fullText).toContain('6');
        expect(rendered.fullText).toContain('Assistant');
        expect(tokenFieldKeys(inChat)).toContain('fileDepthDb');
        expect(tokenFieldKeys(inChat)).toContain('fileDepthRoleDb');
    });
});

describe('buildVectorsChatsSummary', () => {
    test('disabled state sets dormant tone and dims all chat controls', () => {
        const model = buildVectorsChatsSummary(makeChatsState({
            enabledChats: false,
            summarize: true,
        }));
        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set([
            'keepHidden',
            'template',
            'position',
            'depth',
            'messageChunkSize',
            'protect',
            'insert',
            'summarize',
            'summarizeSent',
            'summarySource',
            'summaryPrompt',
            'summaryRetries',
            'summaryThreshold',
        ]));
    });

    test('summarizeSent without summarize emits warn and dims all summary sub-controls', () => {
        const model = buildVectorsChatsSummary(makeChatsState({
            summarize: false,
            summarizeSent: true,
            position: 0,
        }));
        expect(model.tone).toBe('warn');
        expect(model.warnings.some((w) => w.severity === 'warn')).toBe(true);
        const warnText = renderModel(model).warningTexts.map((w) => w.text).join('\n');
        expect(warnText).toMatch(/Summarize chat messages when sending/i);
        expect(warnText).toMatch(/Summarize chat messages for vector generation/i);
        expect(new Set(model.dormantFields)).toEqual(new Set([
            'summarizeSent',
            'summarySource',
            'summaryPrompt',
            'summaryRetries',
            'summaryThreshold',
            'depth',
        ]));
    });

    test('missing {{text}} in template emits danger warning', () => {
        const model = buildVectorsChatsSummary(makeChatsState({
            template: 'No macro here',
        }));
        expect(model.tone).toBe('danger');
        expect(model.warnings.some((w) => w.severity === 'danger')).toBe(true);
        expect(renderModel(model).warningTexts[0].text).toContain('{{text}}');
    });

    test('summarize with whitespace-only or empty summaryPrompt emits danger warning', () => {
        const model = buildVectorsChatsSummary(makeChatsState({
            summarize: true,
            summaryPrompt: '   \n\t ',
        }));
        expect(model.tone).toBe('danger');
        expect(model.warnings.some((w) => w.severity === 'danger')).toBe(true);
        const warnText = renderModel(model).warningTexts.map((w) => w.text).join('\n');
        expect(warnText).toMatch(/Summary Prompt/i);
    });

    test('position !== 1 dims depth; position === 1 renders depth and keeps it active', () => {
        const inPrompt = buildVectorsChatsSummary(makeChatsState({
            position: 0,
            depth: 3,
            summarize: true,
            summarySource: 'webllm',
            summaryThreshold: 0,
            summaryRetries: 4,
            summarizeSent: true,
            messageChunkSize: 0,
            keepHidden: true,
        }));
        expect(inPrompt.tone).toBe('active');
        expect(inPrompt.dormantFields).toEqual(['depth']);
        const promptText = renderModel(inPrompt).fullText;
        expect(promptText).toContain('WebLLM Extension');
        expect(promptText).toContain('4');
        expect(promptText).toContain('whole messages');
        expect(promptText).toContain('including hidden messages');

        const inChat = buildVectorsChatsSummary(makeChatsState({
            position: 1,
            depth: 7,
            summarize: true,
        }));
        expect(inChat.dormantFields).toEqual([]);
        expect(renderModel(inChat).fullText).toContain('7');
        expect(tokenFieldKeys(inChat)).toContain('depth');
    });
});

describe('Vector Storage settings.html cleanup, real init() mounting & locale validation', () => {
    async function loadVectorsModule({ extensionSettings, profiles = [] } = {}) {
        jest.resetModules();

        const settingsHtml = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/vectors/settings.html'),
            'utf8',
        );

        const listeners = new Map();
        const eventSource = {
            on: jest.fn((evt, cb) => {
                if (!listeners.has(evt)) listeners.set(evt, []);
                listeners.get(evt).push(cb);
            }),
            emit: jest.fn(async (evt, ...args) => {
                for (const cb of listeners.get(evt) || []) {
                    await cb(...args);
                }
            }),
        };

        jest.unstable_mockModule('../../public/script.js', () => ({
            eventSource,
            event_types: {
                CONNECTION_PROFILE_CREATED: 'connection_profile_created',
                CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
                CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
                MESSAGE_DELETED: 'message_deleted',
                MESSAGE_EDITED: 'message_edited',
                MESSAGE_SENT: 'message_sent',
                MESSAGE_RECEIVED: 'message_received',
                MESSAGE_SWIPED: 'message_swiped',
                CHAT_DELETED: 'chat_deleted',
                GROUP_CHAT_DELETED: 'group_chat_deleted',
                FILE_ATTACHMENT_DELETED: 'file_attachment_deleted',
                WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
                APP_READY: 'app_ready',
            },
            extension_prompt_types: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
            extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            getCurrentChatId: () => 'chat-1',
            getRequestHeaders: () => ({}),
            is_send_press: false,
            saveSettingsDebounced: jest.fn(),
            setExtensionPrompt: jest.fn(),
            substituteParams: (s) => s,
            generateRaw: jest.fn(),
            substituteParamsExtended: (s) => s,
        }));
        jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
            ModuleWorkerWrapper: class {
                update = jest.fn();
            },
            extension_settings: extensionSettings,
            getContext: () => ({ chat: [], extensionSettings }),
            renderExtensionTemplateAsync: async () => settingsHtml,
        }));
        jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
            collapseNewlines: (s) => s,
            registerDebugFunction: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/chats.js', () => ({
            getDataBankAttachments: () => [],
            getDataBankAttachmentsForSource: () => [],
            getFileAttachment: async () => '',
        }));
        jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
            debounce: (fn) => fn,
            getStringHash: () => 1,
            waitUntilCondition: async () => {},
            onlyUnique: (v, i, a) => a.indexOf(v) === i,
            splitRecursive: (s) => [s],
            trimToStartSentence: (s) => s,
            trimToEndSentence: (s) => s,
            escapeHtml: (s) => String(s),
            isTrueBoolean: (v) => v === true || v === 'true',
            uuidv4: () => 'uuid-1',
        }));
        jest.unstable_mockModule('../../public/scripts/constants.js', () => ({
            debounce_timeout: { relaxed: 100 },
        }));
        jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
            getSortedEntries: async () => [],
        }));
        jest.unstable_mockModule('../../public/scripts/textgen-settings.js', () => ({
            textgen_types: { OLLAMA: 'ollama', LLAMACPP: 'llamacpp', VLLM: 'vllm', KOBOLDCPP: 'koboldcpp' },
            textgenerationwebui_settings: {},
        }));
        const slashCommands = new Map();
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
            SlashCommandParser: {
                addCommandObject: jest.fn((cmd) => {
                    if (cmd?.name) slashCommands.set(cmd.name, cmd);
                }),
            },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
            SlashCommand: { fromProps: (p) => p },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
            ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean' },
            SlashCommandArgument: Object.assign(class {}, { fromProps: (p) => p }),
            SlashCommandNamedArgument: Object.assign(class {}, { fromProps: (p) => p }),
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
            SlashCommandEnumValue: class {},
            enumTypes: { enum: 'enum' },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
            commonEnumProviders: { boolean: () => () => [] },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandReturnHelper.js', () => ({
            slashCommandReturnHelper: { doReturn: jest.fn(), enumList: () => [] },
        }));
        jest.unstable_mockModule('../../public/scripts/extensions/shared.js', () => ({
            generateWebLlmChatPrompt: jest.fn(),
            isWebLlmSupported: () => false,
        }));
        jest.unstable_mockModule('../../public/scripts/reasoning.js', () => ({
            removeReasoningFromString: (s) => s,
        }));
        jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
            oai_settings: {},
        }));
        jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/embed-rerank.js', () => ({
            listEmbeddingProfiles: () => profiles.filter((p) => p.mode === 'embed'),
            getEmbeddingProfileById: (id) => profiles.find((p) => p.mode === 'embed' && p.id === id) || null,
            listRerankProfiles: () => profiles.filter((p) => p.mode === 'rerank'),
            getRerankProfileById: (id) => profiles.find((p) => p.mode === 'rerank' && p.id === id) || null,
            upsertEmbeddingProfile: jest.fn(),
            upsertRerankProfile: jest.fn(),
            renderProfileSelect: (sel, mode, selectedId = '') => {
                sel.innerHTML = '';
                const noneOpt = document.createElement('option');
                noneOpt.value = '';
                noneOpt.textContent = '<None>';
                sel.appendChild(noneOpt);
                for (const p of profiles.filter((x) => x.mode === mode)) {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = p.name;
                    sel.appendChild(opt);
                }
                sel.value = selectedId || '';
            },
        }));
        jest.unstable_mockModule('../../public/scripts/embedding-service.js', () => ({
            EmbeddingService: {},
        }));
        jest.unstable_mockModule('../../public/scripts/lib/prompt-values.js', () => ({
            initializePromptDefaults: () => false,
            requireStoredPrompt: (v) => v,
        }));
        jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
            t: (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), ''),
            translate: (text) => String(text ?? ''),
        }));

        const mod = await import('../../public/scripts/extensions/vectors/index.js');
        return { mod, eventSource, slashCommands };
    }

    test('settings.html deletes obsolete/redundant notes and keeps the Connection Profile setup hint', () => {
        const html = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/vectors/settings.html'),
            'utf8',
        );

        expect(html).not.toContain('Checked: all entries except ❌ status can be activated.');
        expect(html).not.toContain('Unchecked: only entries with ❌ status can be activated.');
        expect(html).not.toContain('Unchecked: only entries with 🔗 status can be activated.');
        expect(html).not.toContain('This will slow down vector generation drastically');
        expect(html).not.toContain('might cause your sent messages to take a bit to process');
        expect(html).not.toContain('Only used when Main API or WebLLM Extension is selected.');
        expect(html).not.toContain('Old messages are vectorized gradually as you chat.');

        expect(html).toContain('Manage profiles in the Connection Profile panel (Embedding tab) under API Connections.');
    });

    test('mounts all 4 cards via real init(), cross-refreshes across shared/feature toggles and profile updates, preserves focus, and handles token jumps', async () => {
        installMinimalJQuery();
        globalThis.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };

        const container = document.createElement('div');
        container.id = 'vectors_container';
        document.body.appendChild(container);

        const profiles = [
            { id: 'emb-1', mode: 'embed', name: 'OpenAI Embed' },
            { id: 'rr-1', mode: 'rerank', name: 'Cohere Rerank' },
        ];
        const extensionSettings = {
            vectors: {
                embeddingProfileId: 'emb-1',
                rerankProfileId: '',
                rerank_enabled: false,
                include_wi: true,
                enabled_world_info: false,
                enabled_files: false,
                enabled_chats: false,
            },
        };

        const { mod, eventSource } = await loadVectorsModule({ extensionSettings, profiles });
        await mod.init();

        const sharedCard = document.querySelector('.luker-bsum[data-bsum-id="vectors-shared"]');
        const wiCard = document.querySelector('.luker-bsum[data-bsum-id="vectors-world-info"]');
        const filesCard = document.querySelector('.luker-bsum[data-bsum-id="vectors-files"]');
        const chatsCard = document.querySelector('.luker-bsum[data-bsum-id="vectors-chats"]');

        expect(sharedCard).toBeTruthy();
        expect(wiCard).toBeTruthy();
        expect(filesCard).toBeTruthy();
        expect(chatsCard).toBeTruthy();

        // All 4 cards start dormant when all 3 feature toggles are off
        expect(sharedCard.classList.contains('is-dormant')).toBe(true);
        expect(wiCard.classList.contains('is-dormant')).toBe(true);
        expect(filesCard.classList.contains('is-dormant')).toBe(true);
        expect(chatsCard.classList.contains('is-dormant')).toBe(true);

        // Enabling World Info only activates WI card and refreshes Shared card to warn about dormant include_wi and dims forceChunkDelimiter
        const wiToggle = document.getElementById('vectors_enabled_world_info');
        wiToggle.checked = true;
        wiToggle.dispatchEvent(new Event('input', { bubbles: true }));

        expect(wiCard.classList.contains('is-active')).toBe(true);
        expect(sharedCard.classList.contains('is-warn')).toBe(true);
        expect(document.getElementById('vectors_include_wi').closest('.checkbox_label').classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(document.getElementById('vectors_force_chunk_delimiter').closest('.flex-container.flexFlowColumn').classList.contains('luker-bsum-field-dormant')).toBe(true);

        // Enabling Files activates Files card AND clears Shared card include_wi warning/dormancy and undims forceChunkDelimiter via cross-refresh
        const filesToggle = document.getElementById('vectors_enabled_files');
        filesToggle.checked = true;
        filesToggle.dispatchEvent(new Event('input', { bubbles: true }));

        expect(filesCard.classList.contains('is-active')).toBe(true);
        expect(sharedCard.classList.contains('is-active')).toBe(true);
        expect(document.getElementById('vectors_include_wi').closest('.checkbox_label').classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(document.getElementById('vectors_force_chunk_delimiter').closest('.flex-container.flexFlowColumn').classList.contains('luker-bsum-field-dormant')).toBe(false);

        // File depth & role are dormant when position !== 1, leaving In-chat radio label undimmed
        const fileDepthInput = document.getElementById('vectors_file_depth_db');
        const fileRoleSelect = document.getElementById('vectors_file_depth_role_db');
        expect(fileDepthInput.classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(fileRoleSelect.classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(fileDepthInput.closest('label').classList.contains('luker-bsum-field-dormant')).toBe(false);

        // Switching file position to In-chat (1) undims fileDepthDb and fileDepthRoleDb
        const fileInChatRadio = document.querySelector('input[name="vectors_file_position_db"][value="1"]');
        fileInChatRadio.checked = true;
        fileInChatRadio.dispatchEvent(new Event('change', { bubbles: true }));
        expect(fileDepthInput.classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(fileRoleSelect.classList.contains('luker-bsum-field-dormant')).toBe(false);

        // Toggling rerank on without profile warns on Shared card; picking rerank profile clears warning
        const rerankToggle = document.getElementById('vectors_rerank_enabled');
        rerankToggle.checked = true;
        rerankToggle.dispatchEvent(new Event('input', { bubbles: true }));
        expect(sharedCard.classList.contains('is-warn')).toBe(true);
        const rerankSel = document.getElementById('vectors_rerank_profile');
        rerankSel.value = 'rr-1';
        rerankSel.dispatchEvent(new Event('change', { bubbles: true }));
        expect(sharedCard.classList.contains('is-active')).toBe(true);
        expect(sharedCard.textContent).toContain('Cohere Rerank');

        // Checking onlyCustomBoundary with empty delimiter shows warn; clicking Chunk boundary token jumps up to #vectors_force_chunk_delimiter
        const customBoundaryCheck = document.getElementById('vectors_only_custom_boundary');
        customBoundaryCheck.checked = true;
        customBoundaryCheck.dispatchEvent(new Event('input', { bubbles: true }));
        expect(filesCard.classList.contains('is-warn')).toBe(true);

        const delimBtn = filesCard.querySelector('.luker-bsum-warnings button[data-bsum-fields="forceChunkDelimiter"]');
        expect(delimBtn).toBeTruthy();
        delimBtn.click();
        expect(document.activeElement).toBe(document.getElementById('vectors_force_chunk_delimiter'));

        // Typing into query preserves input focus while Shared card updates live
        const queryInput = document.getElementById('vectors_query');
        queryInput.focus();
        queryInput.value = '6';
        queryInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.activeElement).toBe(queryInput);
        expect(sharedCard.textContent).toContain('6');

        // Emptying summary prompt makes Chats card danger; clicking Reset to default restores active via cross-refresh
        const chatsToggle = document.getElementById('vectors_enabled_chats');
        chatsToggle.checked = true;
        chatsToggle.dispatchEvent(new Event('input', { bubbles: true }));

        // Verify summary sub-controls and non-In-chat depth are dormant when summarize=false and position!==1
        const chatDepthInput = document.getElementById('vectors_depth');
        expect(chatDepthInput.classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(chatDepthInput.closest('label').classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(document.getElementById('vectors_summarize_user').closest('.checkbox_label').classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(document.getElementById('vectors_summary_prompt').classList.contains('luker-bsum-field-dormant')).toBe(true);

        const chatInChatRadio = document.querySelector('input[name="vectors_position"][value="1"]');
        chatInChatRadio.checked = true;
        chatInChatRadio.dispatchEvent(new Event('change', { bubbles: true }));
        expect(chatDepthInput.classList.contains('luker-bsum-field-dormant')).toBe(false);

        const summarizeCheck = document.getElementById('vectors_summarize');
        summarizeCheck.checked = true;
        summarizeCheck.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.getElementById('vectors_summarize_user').closest('.checkbox_label').classList.contains('luker-bsum-field-dormant')).toBe(false);

        const summaryPrompt = document.getElementById('vectors_summary_prompt');
        summaryPrompt.value = '';
        summaryPrompt.dispatchEvent(new Event('input', { bubbles: true }));
        expect(chatsCard.classList.contains('is-danger')).toBe(true);

        document.getElementById('vectors_summary_prompt_restore').click();
        expect(chatsCard.classList.contains('is-active')).toBe(true);

        // Deleting embedding profile via eventSource refreshes Shared card to danger
        profiles.splice(0, 1);
        await eventSource.emit('connection_profile_deleted');
        expect(sharedCard.classList.contains('is-danger')).toBe(true);
    });

    test('jQuery-only .trigger("input") from slash commands updates summaries via persistSettings() without native input event', async () => {
        installMinimalJQuery({ syntheticOnly: true });
        globalThis.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };

        const container = document.createElement('div');
        container.id = 'vectors_container';
        document.body.appendChild(container);

        const profiles = [
            { id: 'emb-1', mode: 'embed', name: 'OpenAI Embed' },
        ];
        const extensionSettings = {
            vectors: {
                embeddingProfileId: 'emb-1',
                enabled_world_info: true,
                enabled_files: false,
                enabled_chats: true,
                query: 2,
                score_threshold: 0.25,
                max_entries: 5,
            },
        };

        const { mod, slashCommands } = await loadVectorsModule({ extensionSettings, profiles });
        await mod.init();

        const sharedCard = document.querySelector('.luker-bsum[data-bsum-id="vectors-shared"]');
        const wiCard = document.querySelector('.luker-bsum[data-bsum-id="vectors-world-info"]');
        expect(sharedCard.textContent).toContain('0.25');
        expect(sharedCard.textContent).toContain('2');
        expect(wiCard.textContent).toContain('5');

        await slashCommands.get('vector-threshold').callback({}, '0.65');
        expect(sharedCard.textContent).toContain('0.65');

        await slashCommands.get('vector-query').callback({}, '8');
        expect(sharedCard.textContent).toContain('8');

        await slashCommands.get('vector-max-entries').callback({}, '12');
        expect(wiCard.textContent).toContain('12');
    });

    test('zh-cn and zh-tw locale files include all Vector Storage summary keys with matching ${token} placeholders, zero unescaped semicolons, and full-width CJK punctuation', () => {
        const modelsSrc = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/vectors/behavior-summary-models.js'),
            'utf8',
        );
        const indexSrc = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/vectors/index.js'),
            'utf8',
        );
        const zhCn = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-tw.json'), 'utf8'));
        const halfWidthCjk = /[\u3400-\u9fff][,.;:!?()]|[,.;:!?()][\u3400-\u9fff]/;

        const keys = new Set();
        const englishTexts = new Set();
        for (const src of [modelsSrc, indexSrc]) {
            for (const m of src.matchAll(/\btranslate\(\s*'((?:\\'|[^'])*)'(?:\s*,\s*'((?:\\'|[^'])*)')?\s*\)/g)) {
                const text = m[1].replace(/\\'/g, '\'');
                const key = m[2] ? m[2].replace(/\\'/g, '\'') : text;
                englishTexts.add(text);
                keys.add(key);
            }
        }
        expect(keys.size).toBeGreaterThan(25);

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

    test('zh-cn and zh-tw summary control tokens match settings.html data-i18n labels verbatim', () => {
        const zhCn = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-tw.json'), 'utf8'));
        const makeTranslate = (localeMap) => (text, key = null) => localeMap?.[key || text] || text;

        for (const localeMap of [zhCn, zhTw]) {
            globalThis.Luker = { getContext: () => ({ translate: makeTranslate(localeMap) }) };

            const sharedDanger = buildVectorsSharedSummary(makeSharedState({
                enabledChats: true,
                embeddingProfileId: '',
                rerankEnabled: true,
                rerankProfileId: '',
            }));
            expect(sharedDanger.warnings[0].tokens.embeddingProfileId.text).toBe(localeMap['Embedding Profile']);
            expect(sharedDanger.warnings[1].tokens.rerankEnabled.text).toBe(localeMap['Enable Rerank']);
            expect(sharedDanger.warnings[1].tokens.rerankProfileId.text).toBe(localeMap['Rerank Profile']);

            const wiWarn = buildVectorsSharedSummary(makeSharedState({
                enabledWorldInfo: true,
                enabledFiles: false,
                enabledChats: false,
                includeWi: true,
            }));
            expect(wiWarn.warnings[0].tokens.includeWi.text).toBe(localeMap['Include in World Info Scanning']);

            const filesWarn = buildVectorsFilesSummary(makeFilesState({
                onlyCustomBoundary: true,
                forceChunkDelimiter: '',
                translateFiles: true,
                translationAvailable: false,
                fileTemplateDb: 'no macro',
            }));
            expect(filesWarn.warnings[0].tokens.onlyCustomBoundary.text).toBe(localeMap['Only chunk on custom boundary']);
            expect(filesWarn.warnings[0].tokens.forceChunkDelimiter.text).toBe(localeMap['Chunk boundary']);
            expect(filesWarn.warnings[1].tokens.translateFiles.text).toBe(localeMap['Translate files into English before processing']);
            expect(filesWarn.warnings[2].tokens.fileTemplateDb.text).toBe(localeMap['Injection Template']);

            const chatsWarn = buildVectorsChatsSummary(makeChatsState({
                summarize: false,
                summarizeSent: true,
                template: 'no macro',
            }));
            expect(chatsWarn.warnings[0].tokens.summarizeSent.text).toBe(localeMap['Summarize chat messages when sending']);
            expect(chatsWarn.warnings[0].tokens.summarize.text).toBe(localeMap['Summarize chat messages for vector generation']);
            expect(chatsWarn.warnings[1].tokens.template.text).toBe(localeMap['Injection Template']);

            const emptyPromptWarn = buildVectorsChatsSummary(makeChatsState({
                summarize: true,
                summaryPrompt: '',
            }));
            expect(emptyPromptWarn.warnings[0].tokens.summaryPrompt.text).toBe(localeMap['Summary Prompt']);
        }
    });
});
