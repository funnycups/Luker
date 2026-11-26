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
    buildTtsNarrationSummary,
    buildTtsNpcAttributionSummary,
} from '../../public/scripts/extensions/tts/behavior-summary-models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

function makeNarrationState(overrides = {}) {
    return {
        enabled: true,
        provider: 'ElevenLabs',
        autoGeneration: true,
        narrateUser: false,
        periodicAutoGeneration: false,
        narrateByParagraphs: false,
        narrateQuoted: false,
        narrateDialogues: false,
        narrateTranslatedOnly: false,
        skipCodeblocks: false,
        skipTags: false,
        passAsterisks: false,
        multiVoiceEnabled: false,
        applyRegex: false,
        playbackRate: 1,
        ...overrides,
    };
}

function makeNpcState(overrides = {}) {
    return {
        enabled: true,
        npcAttributionEnabled: true,
        apiPreset: '',
        preset: '',
        retryMax: 2,
        multiVoiceEnabled: true,
        canActivateMultiVoice: false,
        canActivateEnabled: false,
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
            is(selector) {
                if (selector === ':checked') {
                    return Boolean(list[0]?.checked);
                }
                return Boolean(list[0]?.matches?.(selector));
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
            html(value) {
                if (value === undefined) return list[0]?.innerHTML ?? '';
                for (const el of list) el.innerHTML = String(value);
                return api;
            },
            append(value) {
                for (const el of list) {
                    if (typeof value === 'string') {
                        el.insertAdjacentHTML('beforeend', value);
                    } else if (value?.length !== undefined && !value.nodeType) {
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
            toggleClass(cls, force) {
                for (const el of list) {
                    if (force === undefined) el.classList.toggle(cls);
                    else el.classList.toggle(cls, Boolean(force));
                }
                return api;
            },
            removeAttr(name) {
                for (const el of list) el.removeAttribute(name);
                return api;
            },
            css(prop, value) {
                for (const el of list) el.style[prop] = value;
                return api;
            },
            trigger(eventName) {
                const name = String(eventName).split('.')[0];
                for (const el of list) {
                    if (el.__jqHandlers) {
                        for (const entry of el.__jqHandlers) {
                            if (entry.type === name) {
                                entry.handler.call(el, { type: name, target: el, currentTarget: el });
                            }
                        }
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
    document.body.className = '';
});

afterEach(() => {
    delete globalThis.$;
    delete globalThis.jQuery;
    delete globalThis.toastr;
    delete globalThis.Luker;
    jest.restoreAllMocks();
});

describe('buildTtsNarrationSummary', () => {
    test('!enabled sets dormant tone, clears warnings, and dims narration controls below #tts_enabled', () => {
        const model = buildTtsNarrationSummary(makeNarrationState({
            enabled: false,
            passAsterisks: true,
            narrateDialogues: true,
            multiVoiceEnabled: true,
            narrateQuoted: true,
            autoGeneration: false,
            narrateUser: true,
            periodicAutoGeneration: true,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set([
            'narrateUser',
            'autoGeneration',
            'periodicAutoGeneration',
            'narrateByParagraphs',
            'narrateQuoted',
            'narrateDialogues',
            'narrateTranslatedOnly',
            'skipCodeblocks',
            'skipTags',
            'passAsterisks',
            'multiVoiceEnabled',
            'applyRegex',
            'regexPattern',
            'playbackRate',
        ]));
        expect(model.dormantFields).not.toContain('provider');
        expect(model.dormantFields).not.toContain('enabled');

        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(rendered.fullText).toMatch(/TTS is off.*all narration settings below are inactive/i);
        expect(tokenFieldKeys(model)).toEqual(new Set(['enabled']));
    });

    test('enabled with clean defaults renders Trigger and Text filter rows with no warnings', () => {
        const model = buildTtsNarrationSummary(makeNarrationState({
            enabled: true,
            provider: 'ElevenLabs',
            playbackRate: 1.25,
            autoGeneration: true,
        }));

        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.rowTexts).toHaveLength(2);
        expect(rendered.fullText).toContain('ElevenLabs');
        expect(rendered.fullText).toContain('1.25×');
        expect(rendered.fullText).toMatch(/Auto-narrates/i);
        expect(rendered.fullText).toMatch(/raw text/i);
        expect(rendered.fullText).toMatch(/single voice/i);
        expect(tokenFieldKeys(model)).toEqual(new Set([
            'autoGeneration',
            'narrateUser',
            'provider',
            'playbackRate',
            'periodicAutoGeneration',
            'narrateByParagraphs',
            'narrateTranslatedOnly',
            'skipCodeblocks',
            'skipTags',
            'passAsterisks',
            'narrateDialogues',
            'applyRegex',
            'narrateQuoted',
            'multiVoiceEnabled',
        ]));
    });

    test('passAsterisks && narrateDialogues emits warn and puts narrateDialogues in dormantFields', () => {
        const model = buildTtsNarrationSummary(makeNarrationState({
            passAsterisks: true,
            narrateDialogues: true,
        }));

        expect(model.tone).toBe('warn');
        expect(model.dormantFields).toContain('narrateDialogues');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        const warnText = renderModel(model).warningTexts[0].text;
        expect(warnText).toContain('Pass Asterisks to TTS Engine');
        expect(warnText).toContain('Ignore *text, even "quotes", inside asterisks*');
        expect(tokenFieldKeys(model)).toContain('narrateDialogues');
        expect(tokenFieldKeys(model)).toContain('passAsterisks');
    });

    test('passAsterisks without narrateDialogues keeps narrateDialogues in dormantFields without warning', () => {
        const model = buildTtsNarrationSummary(makeNarrationState({
            passAsterisks: true,
            narrateDialogues: false,
            multiVoiceEnabled: true,
        }));

        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual(['narrateDialogues']);
        renderModel(model);
    });

    test('multiVoiceEnabled && !passAsterisks emits warn explaining asterisks are stripped first', () => {
        const model = buildTtsNarrationSummary(makeNarrationState({
            multiVoiceEnabled: true,
            passAsterisks: false,
        }));

        expect(model.tone).toBe('warn');
        expect(model.warnings.some((w) => w.severity === 'warn')).toBe(true);
        const warnText = renderModel(model).warningTexts.map((w) => w.text).join('\n');
        expect(warnText).toContain('Pass Asterisks to TTS Engine');
        expect(warnText).toMatch(/asterisk.*stripped|stripped.*asterisk/i);
    });

    test('multiVoiceEnabled && narrateQuoted emits warn explaining narration/action voices are stripped', () => {
        const model = buildTtsNarrationSummary(makeNarrationState({
            multiVoiceEnabled: true,
            passAsterisks: true,
            narrateQuoted: true,
        }));

        expect(model.tone).toBe('warn');
        expect(model.warnings.some((w) => w.severity === 'warn')).toBe(true);
        const warnText = renderModel(model).warningTexts.map((w) => w.text).join('\n');
        expect(warnText).toContain('Only narrate "quotes"');
        expect(warnText).toMatch(/narration.*stripped|stripped.*splitting|non-quoted/i);
    });

    test('periodicAutoGeneration && !autoGeneration and narrateUser && !autoGeneration emit warn and dim both fields', () => {
        const bothOff = buildTtsNarrationSummary(makeNarrationState({
            autoGeneration: false,
            periodicAutoGeneration: false,
            narrateUser: false,
        }));
        expect(bothOff.tone).toBe('active');
        expect(bothOff.warnings).toEqual([]);
        expect(new Set(bothOff.dormantFields)).toEqual(new Set(['narrateUser', 'periodicAutoGeneration']));
        expect(renderModel(bothOff).fullText).toMatch(/Manual narration only/i);

        const periodicWarn = buildTtsNarrationSummary(makeNarrationState({
            autoGeneration: false,
            periodicAutoGeneration: true,
            narrateUser: false,
        }));
        expect(periodicWarn.tone).toBe('warn');
        expect(periodicWarn.warnings).toHaveLength(1);
        expect(periodicWarn.warnings[0].severity).toBe('warn');
        expect(new Set(periodicWarn.dormantFields)).toEqual(new Set(['narrateUser', 'periodicAutoGeneration']));
        expect(renderModel(periodicWarn).warningTexts[0].text).toContain('Narrate by paragraphs (when streaming)');

        const userWarn = buildTtsNarrationSummary(makeNarrationState({
            autoGeneration: false,
            periodicAutoGeneration: false,
            narrateUser: true,
        }));
        expect(userWarn.tone).toBe('warn');
        expect(userWarn.warnings).toHaveLength(1);
        expect(userWarn.warnings[0].severity).toBe('warn');
        expect(new Set(userWarn.dormantFields)).toEqual(new Set(['narrateUser', 'periodicAutoGeneration']));
        expect(renderModel(userWarn).warningTexts[0].text).toContain('Narrate user messages');

        const bothWarn = buildTtsNarrationSummary(makeNarrationState({
            autoGeneration: false,
            periodicAutoGeneration: true,
            narrateUser: true,
        }));
        expect(bothWarn.tone).toBe('warn');
        expect(bothWarn.warnings).toHaveLength(2);
    });

    test('provider === "System" omits playbackRate token and speed text', () => {
        for (const autoGeneration of [true, false]) {
            const model = buildTtsNarrationSummary(makeNarrationState({
                provider: 'System',
                playbackRate: 1.75,
                autoGeneration,
            }));
            expect(tokenFieldKeys(model)).not.toContain('playbackRate');
            const rendered = renderModel(model);
            expect(rendered.fullText).toContain('System');
            expect(rendered.fullText).not.toContain('1.75');
            expect(rendered.fullText).not.toContain('×');
        }
    });

    test('transient blank/invalid playbackRate and hostile provider name render safely', () => {
        const blankRate = buildTtsNarrationSummary(makeNarrationState({
            playbackRate: '',
            provider: 'Edge',
        }));
        const blankRendered = renderModel(blankRate);
        expect(blankRendered.fullText).toContain('1×');

        const hostile = '<img src=x onerror=1>${enabled}';
        const hostileModel = buildTtsNarrationSummary(makeNarrationState({ provider: hostile }));
        const parts = renderTemplateParts(hostileModel.rows[0].template, hostileModel.rows[0].tokens);
        const providerBtn = parts.find((p) => p instanceof Element && p.dataset?.bsumFields === 'provider');
        expect(providerBtn).toBeTruthy();
        expect(providerBtn.children.length).toBe(0);
        expect(providerBtn.textContent).toBe(hostile);
    });
});

describe('buildTtsNpcAttributionSummary', () => {
    test('!npcAttributionEnabled sets dormant tone and dims apiPreset, preset, and retryMax', () => {
        const model = buildTtsNpcAttributionSummary(makeNpcState({
            npcAttributionEnabled: false,
            multiVoiceEnabled: false,
            enabled: false,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set(['apiPreset', 'preset', 'retryMax']));
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(tokenFieldKeys(model)).toEqual(new Set(['npcAttributionEnabled']));
    });

    test('npcAttributionEnabled && multiVoiceEnabled renders active config with current fallbacks and retry count', () => {
        const model = buildTtsNpcAttributionSummary(makeNpcState({
            enabled: true,
            npcAttributionEnabled: true,
            multiVoiceEnabled: true,
            apiPreset: '',
            preset: '',
            retryMax: 3,
        }));

        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.fullText).toContain('(Current API config)');
        expect(rendered.fullText).toContain('(Current preset)');
        expect(rendered.fullText).toContain('3');
    });

    test('npcAttributionEnabled && !multiVoiceEnabled emits warn explaining whole-message narration requires Multi-Voice and supports cross-scope read-only vs interactive token', () => {
        const absent = buildTtsNpcAttributionSummary(makeNpcState({
            enabled: true,
            npcAttributionEnabled: true,
            multiVoiceEnabled: false,
            canActivateMultiVoice: false,
        }));

        expect(absent.tone).toBe('warn');
        expect(absent.warnings).toHaveLength(1);
        expect(absent.warnings[0].severity).toBe('warn');
        const rendered = renderModel(absent);
        expect(rendered.warningTexts[0].text).toMatch(/auto or full-message narration/i);
        expect(rendered.warningTexts[0].text).toMatch(/desktop per-quote play buttons/i);
        expect(rendered.warningTexts[0].text).toContain('Different voices for "quotes", *text inside asterisks* and other text');
        const absentTok = rendered.warningTexts[0].parts.find((p) => p instanceof Element && p.classList.contains('luker-bsum-tok'));
        expect(absentTok.tagName).toBe('SPAN');
        expect(absentTok.classList.contains('is-readonly')).toBe(true);

        const onActivate = jest.fn(() => true);
        const present = buildTtsNpcAttributionSummary(makeNpcState({
            enabled: true,
            npcAttributionEnabled: true,
            multiVoiceEnabled: false,
            canActivateMultiVoice: true,
            onMultiVoiceActivate: onActivate,
        }));
        const presentParts = renderTemplateParts(present.warnings[0].template, present.warnings[0].tokens);
        const presentBtn = presentParts.find((p) => p instanceof Element && p.classList.contains('luker-bsum-tok'));
        expect(presentBtn.tagName).toBe('BUTTON');
        expect(presentBtn.dataset.bsumFields).toBe('multiVoiceEnabled');
    });

    test('npcAttributionEnabled && !enabled reflects paused status and reacts to enabled + blank retryMax', () => {
        const pausedReady = buildTtsNpcAttributionSummary(makeNpcState({
            enabled: false,
            npcAttributionEnabled: true,
            multiVoiceEnabled: true,
            apiPreset: 'FastConn',
            preset: 'CleanPreset',
            retryMax: '',
            canActivateEnabled: true,
        }));
        expect(pausedReady.tone).toBe('dormant');
        expect(pausedReady.warnings).toEqual([]);
        const rendered = renderModel(pausedReady);
        expect(rendered.fullText).toContain('FastConn');
        expect(rendered.fullText).toContain('CleanPreset');
        expect(rendered.fullText).toContain('2');
        expect(rendered.fullText).toMatch(/paused/i);
        const enabledBtn = rendered.rowTexts[0].parts.find((p) => p instanceof Element && p.dataset?.bsumFields === 'enabled');
        expect(enabledBtn.tagName).toBe('BUTTON');

        const pausedNoMv = buildTtsNpcAttributionSummary(makeNpcState({
            enabled: false,
            npcAttributionEnabled: true,
            multiVoiceEnabled: false,
        }));
        expect(pausedNoMv.tone).toBe('warn');
        expect(pausedNoMv.warnings).toHaveLength(1);
    });
});

describe('TTS settings.html mounting via real init(), cross-refresh, jQuery triggers, focus & i18n parity', () => {
    async function loadTtsModule({ extensionSettings, apiProfiles = [], openaiPresets = [] } = {}) {
        jest.resetModules();

        const settingsHtml = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/tts/settings.html'),
            'utf8',
        );

        const listeners = new Map();
        const eventSource = {
            on: jest.fn((evt, cb) => {
                if (!listeners.has(evt)) listeners.set(evt, []);
                listeners.get(evt).push(cb);
            }),
            removeListener: jest.fn(),
            makeLast: jest.fn(),
            emit: jest.fn(async (evt, ...args) => {
                for (const cb of listeners.get(evt) || []) {
                    await cb(...args);
                }
            }),
        };

        const contextObj = {
            chat: [],
            groupId: null,
            characterId: undefined,
            name1: 'User',
            name2: 'Seraphina',
            characters: [],
            groups: [],
            extensionSettings,
            getPresetManager: () => ({ getAllPresets: () => openaiPresets }),
        };

        jest.unstable_mockModule('../../public/script.js', () => ({
            cancelTtsPlay: jest.fn(),
            eventSource,
            event_types: {
                MESSAGE_SWIPED: 'message_swiped',
                CHAT_CHANGED: 'chat_changed',
                MESSAGE_DELETED: 'message_deleted',
                GROUP_UPDATED: 'group_updated',
                GENERATION_STARTED: 'generation_started',
                GENERATION_ENDED: 'generation_ended',
                CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
                USER_MESSAGE_RENDERED: 'user_message_rendered',
                APP_READY: 'app_ready',
            },
            getCurrentChatId: () => 'chat-1',
            getRequestHeaders: () => ({}),
            isStreamingEnabled: () => false,
            name2: 'Seraphina',
            saveSettingsDebounced: jest.fn(),
            substituteParams: (s) => s,
        }));
        jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
            ModuleWorkerWrapper: class {
                update = jest.fn();
            },
            extension_settings: extensionSettings,
            getContext: () => contextObj,
            renderExtensionTemplateAsync: async () => settingsHtml,
        }));
        jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
            debounce: (fn) => fn,
            debounceAsync: (fn) => fn,
            delay: async () => {},
            escapeRegex: (s) => String(s),
            getBase64Async: async () => '',
            getStringHash: () => 1,
            isValidUrl: () => true,
            onlyUnique: (v, i, a) => a.indexOf(v) === i,
            regexFromString: (s) => {
                try {
                    const match = String(s).match(/^\/(.+)\/([a-z]*)$/);
                    return match ? new RegExp(match[1], match[2]) : new RegExp(String(s));
                } catch {
                    return null;
                }
            },
            splitRecursive: (s) => [s],
        }));
        jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
            accountStorage: { getItem: () => null, setItem: jest.fn() },
        }));
        jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
            power_user: { allow_name2_display: false },
        }));
        jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
            oai_settings: {},
            proxies: [],
        }));
        jest.unstable_mockModule('../../public/scripts/secrets.js', () => ({
            SECRET_KEYS: {},
            secret_state: {},
            writeSecret: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
            isMobile: () => false,
        }));
        jest.unstable_mockModule('../../public/scripts/constants.js', () => ({
            debounce_timeout: { relaxed: 100 },
        }));
        jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
            POPUP_TYPE: { TEXT: 1 },
            Popup: class { static util = { popups: [] }; },
            callGenericPopup: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
            SlashCommandParser: { addCommandObject: jest.fn() },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
            SlashCommand: { fromProps: (p) => p },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
            ARGUMENT_TYPE: { STRING: 'string' },
            SlashCommandArgument: class {},
            SlashCommandNamedArgument: { fromProps: (p) => p },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
            SlashCommandEnumValue: class {},
            enumTypes: { enum: 'enum' },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
            enumIcons: { voice: 'voice' },
        }));
        jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
            applyLocale: (s) => s,
            t: (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), ''),
            translate: (text) => String(text ?? ''),
        }));
        jest.unstable_mockModule('../../public/scripts/lib/iter-tool-calling.js', () => ({
            requestToolCallWithRetry: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
            getChatCompletionConnectionProfiles: () => apiProfiles.map((name) => ({ name })),
        }));

        const mod = await import('../../public/scripts/extensions/tts/index.js');
        return { mod, eventSource };
    }

    test('mounts Card 1 above #tts_enabled and Card 2 at top of #tts_npc_attribution_block, preserves #tts_regex_warning & .tts_voicemap_hint, cross-refreshes, handles jQuery triggers, and jumps across scopes', async () => {
        installMinimalJQuery();
        globalThis.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };

        const container = document.createElement('div');
        container.id = 'tts_container';
        const wandContainer = document.createElement('div');
        wandContainer.id = 'tts_wand_container';
        document.body.append(container, wandContainer);

        const extensionSettings = {
            tts: {
                enabled: false,
                currentProvider: 'ElevenLabs',
                auto_generation: true,
                narrate_user: false,
                periodic_auto_generation: false,
                narrate_by_paragraphs: false,
                narrate_quoted_only: false,
                narrate_dialogues_only: false,
                narrate_translated_only: false,
                skip_codeblocks: false,
                skip_tags: false,
                pass_asterisks: false,
                multi_voice_enabled: false,
                apply_regex: false,
                regex_pattern: '',
                playback_rate: 1,
                npcAttributionEnabled: false,
                npcAttributionApiPresetName: '',
                npcAttributionPresetName: '',
                npcAttributionRetryMax: 2,
                ElevenLabs: { voiceMap: {} },
                System: { voiceMap: {} },
            },
        };

        const { mod, eventSource } = await loadTtsModule({
            extensionSettings,
            apiProfiles: ['FastConn'],
            openaiPresets: ['CleanPreset'],
        });

        const intervalIds = [];
        const origSetInterval = globalThis.setInterval;
        jest.spyOn(globalThis, 'setInterval').mockImplementation((fn, ms, ...args) => {
            const id = origSetInterval(fn, ms, ...args);
            intervalIds.push(id);
            return id;
        });

        try {
            await mod.init();
            // Let init()'s un-awaited loadTtsProvider() settle before switching providers.
            await new Promise((r) => setTimeout(r, 25));

            const drawerContent = document.querySelector('#tts_settings .inline-drawer-content');
            const ttsEnabledLabel = document.getElementById('tts_enabled').closest('.checkbox_label');
            const npcBlock = document.getElementById('tts_npc_attribution_block');

            const card1 = drawerContent.querySelector('.luker-bsum[data-bsum-id="tts-narration"]');
            const card2 = npcBlock.querySelector('.luker-bsum[data-bsum-id="tts-npc-attribution"]');

            expect(card1).toBeTruthy();
            expect(card1.nextElementSibling).toBe(ttsEnabledLabel);
            expect(card2).toBeTruthy();
            expect(npcBlock.firstElementChild).toBe(card2);

            // Required static elements preserved
            expect(document.getElementById('tts_regex_warning')).toBeTruthy();
            expect(document.querySelector('.tts_voicemap_hint')).toBeTruthy();

            // Both cards start dormant
            expect(card1.classList.contains('is-dormant')).toBe(true);
            expect(card2.classList.contains('is-dormant')).toBe(true);
            expect(document.getElementById('tts_auto_generation').closest('.checkbox_label').classList.contains('luker-bsum-field-dormant')).toBe(true);
            expect(document.getElementById('tts_npc_attribution_api_preset').closest('.tts_custom_voices').classList.contains('luker-bsum-field-dormant')).toBe(true);

            // Enabling #tts_enabled activates Card 1
            const enabledCheck = document.getElementById('tts_enabled');
            enabledCheck.checked = true;
            globalThis.$('#tts_enabled').trigger('click');
            expect(card1.classList.contains('is-active')).toBe(true);
            expect(card1.textContent).toContain('ElevenLabs');
            expect(card1.textContent).toContain('1×');

            // jQuery .trigger('input') on #playback_rate updates Card 1 speed token
            const rateInput = document.getElementById('playback_rate');
            rateInput.value = '1.5';
            globalThis.$('#playback_rate').trigger('input');
            expect(card1.textContent).toContain('1.5×');

            // Switching provider to System via jQuery .trigger('change') omits playbackRate
            const providerSelect = document.getElementById('tts_provider');
            providerSelect.value = 'System';
            globalThis.$('#tts_provider').trigger('change');
            expect(card1.textContent).toContain('System');
            expect(card1.textContent).not.toContain('1.5×');
            expect(card1.querySelector('button[data-bsum-fields="playbackRate"]')).toBeNull();

            // Enabling NPC attribution with multiVoiceEnabled off warns on Card 2
            const npcCheck = document.getElementById('tts_npc_attribution_enabled');
            npcCheck.checked = true;
            globalThis.$('#tts_npc_attribution_enabled').trigger('click');
            expect(card2.classList.contains('is-warn')).toBe(true);
            expect(card2.textContent).toMatch(/desktop per-quote play buttons/i);

            // Selecting attribution API connection & completion preset updates Card 2
            const apiSel = document.getElementById('tts_npc_attribution_api_preset');
            apiSel.value = 'FastConn';
            globalThis.$('#tts_npc_attribution_api_preset').trigger('change');
            const presetSel = document.getElementById('tts_npc_attribution_preset');
            presetSel.value = 'CleanPreset';
            globalThis.$('#tts_npc_attribution_preset').trigger('change');
            expect(card2.textContent).toContain('FastConn');
            expect(card2.textContent).toContain('CleanPreset');

            // Clicking multiVoiceEnabled token in Card 2 jumps to & pulses #tts_multi_voice_enabled
            const multiVoiceJumpBtn = card2.querySelector('.luker-bsum-warnings button[data-bsum-fields="multiVoiceEnabled"]');
            expect(multiVoiceJumpBtn).toBeTruthy();
            multiVoiceJumpBtn.click();
            const multiVoiceCheck = document.getElementById('tts_multi_voice_enabled');
            expect(document.activeElement).toBe(multiVoiceCheck);
            expect(multiVoiceCheck.closest('.checkbox_label').classList.contains('luker-bsum-field-pulse')).toBe(true);

            // Checking #tts_multi_voice_enabled cross-refreshes Card 2 (clears warn -> active) and warns on Card 1 (!passAsterisks)
            multiVoiceCheck.checked = true;
            multiVoiceCheck.dispatchEvent(new Event('change', { bubbles: true }));
            expect(card2.classList.contains('is-active')).toBe(true);
            expect(card1.classList.contains('is-warn')).toBe(true);

            // Toggling #tts_enabled off via native change cross-refreshes Card 2 to dormant (paused)
            enabledCheck.checked = false;
            enabledCheck.dispatchEvent(new Event('change', { bubbles: true }));
            expect(card1.classList.contains('is-dormant')).toBe(true);
            expect(card2.classList.contains('is-dormant')).toBe(true);

            // Typing into #tts_npc_attribution_retry_max preserves focus while Card 2 updates
            enabledCheck.checked = true;
            enabledCheck.dispatchEvent(new Event('change', { bubbles: true }));
            const retryInput = document.getElementById('tts_npc_attribution_retry_max');
            retryInput.focus();
            retryInput.value = '4';
            retryInput.dispatchEvent(new Event('input', { bubbles: true }));
            expect(document.activeElement).toBe(retryInput);
            expect(card2.textContent).toContain('4');

            // APP_READY event refreshes summaries cleanly
            providerSelect.value = 'Edge';
            await eventSource.emit('app_ready');
            expect(card1.textContent).toContain('Edge');

            // Re-mounting is idempotent (exactly 1 Card 1 and 1 Card 2)
            mod.mountTtsBehaviorSummaries();
            expect(document.querySelectorAll('.luker-bsum[data-bsum-id="tts-narration"]')).toHaveLength(1);
            expect(document.querySelectorAll('.luker-bsum[data-bsum-id="tts-npc-attribution"]')).toHaveLength(1);
        } finally {
            for (const id of intervalIds) {
                clearInterval(id);
            }
        }
    });

    test('zh-cn and zh-tw locale files include all TTS summary keys with matching ${token} placeholders, zero unescaped semicolons, and full-width CJK punctuation', () => {
        const modelsSrc = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/tts/behavior-summary-models.js'),
            'utf8',
        );
        const indexSrc = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/tts/index.js'),
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
        expect(keys.size).toBeGreaterThan(20);

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

        expect(zhCn['Different voices for quotes and text inside asterisks']).toMatch(/[\u4e00-\u9fff]/);
        expect(zhCn['Different voices for quotes and text inside asterisks']).not.toMatch(/Different voices/i);
        expect(zhTw['Different voices for quotes and text inside asterisks']).toMatch(/[\u4e00-\u9fff]/);
        expect(zhTw['Different voices for quotes and text inside asterisks']).not.toMatch(/Different voices/i);

        for (const localeMap of [zhCn, zhTw]) {
            globalThis.Luker = { getContext: () => ({ translate: makeTranslate(localeMap) }) };

            const passWarn = buildTtsNarrationSummary(makeNarrationState({
                passAsterisks: true,
                narrateDialogues: true,
                multiVoiceEnabled: true,
                narrateQuoted: true,
                autoGeneration: false,
                periodicAutoGeneration: true,
                narrateUser: true,
            }));
            const warnTokensByField = new Map();
            for (const warn of passWarn.warnings) {
                for (const tok of Object.values(warn.tokens)) {
                    warnTokensByField.set(tok.field, tok.text);
                }
            }
            expect(warnTokensByField.get('passAsterisks')).toBe(localeMap['Pass Asterisks to TTS Engine']);
            expect(warnTokensByField.get('narrateDialogues')).toBe(localeMap['Ignore text, even quotes, inside asterisk']);
            expect(warnTokensByField.get('multiVoiceEnabled')).toBe(localeMap['Different voices for quotes and text inside asterisks']);
            expect(warnTokensByField.get('narrateQuoted')).toBe(localeMap['Only narrate quotes']);
            expect(warnTokensByField.get('periodicAutoGeneration')).toBe(localeMap['Narrate by paragraphs (when streaming)']);
            expect(warnTokensByField.get('narrateUser')).toBe(localeMap['Narrate user messages']);
            expect(warnTokensByField.get('autoGeneration')).toBe(localeMap['Auto Generation']);

            const npcDormant = buildTtsNpcAttributionSummary(makeNpcState({
                npcAttributionEnabled: false,
            }));
            expect(npcDormant.rows[0].tokens.npcAttributionEnabled.text).toBe(localeMap['NPC dialogue attribution']);

            const npcWarn = buildTtsNpcAttributionSummary(makeNpcState({
                enabled: false,
                npcAttributionEnabled: true,
                multiVoiceEnabled: false,
                apiPreset: '',
                preset: '',
                canActivateMultiVoice: true,
                canActivateEnabled: true,
            }));
            expect(npcWarn.rows[0].tokens.apiPreset.text).toBe(localeMap['(Current API config)']);
            expect(npcWarn.rows[0].tokens.preset.text).toBe(localeMap['(Current preset)']);
            expect(npcWarn.rows[0].tokens.enabled.text).toBe(localeMap['tts_enabled']);
            expect(npcWarn.warnings[0].tokens.multiVoiceEnabled.text).toBe(localeMap['Different voices for quotes and text inside asterisks']);
        }
    });
});
