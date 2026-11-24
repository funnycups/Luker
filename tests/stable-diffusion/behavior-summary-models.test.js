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
    buildIllustrationMainSummary,
    buildIllustrationProfileAgentSummary,
    buildSdModeSummary,
} from '../../public/scripts/extensions/stable-diffusion/behavior-summary-models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

function makeMainState(overrides = {}) {
    return {
        enabled: true,
        autoGenerate: true,
        hasPreset: true,
        presetName: 'Default Tag',
        apiPresetName: '',
        llmPresetName: '',
        contextMessageCount: 10,
        maxConcurrentGenerations: 1,
        minGenerationInterval: 0,
        imageDisplayWidth: 100,
        characterImageConflict: null,
        ...overrides,
    };
}

function makeProfileAgentState(overrides = {}) {
    return {
        characterReferenceEnabled: true,
        canActivateCharacterReference: false,
        visualInspection: false,
        explorationApiPreset: '',
        explorationLlmPreset: '',
        illustrationApiPreset: '',
        illustrationLlmPreset: '',
        ...overrides,
    };
}

function makeSdModeState(overrides = {}) {
    return {
        functionTool: false,
        interactiveMode: false,
        toolCallingSupported: true,
        refineMode: false,
        freeExtend: false,
        minimalPromptProcessing: false,
        multimodalCaptioning: false,
        snap: false,
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
            html(value) {
                if (value === undefined) return list[0]?.innerHTML ?? '';
                for (const el of list) el.innerHTML = String(value);
                return api;
            },
            append(value) {
                for (const el of list) {
                    if (typeof value === 'string') el.insertAdjacentHTML('beforeend', value);
                    else if (value) el.appendChild(value);
                }
                return api;
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
            toggle(show) {
                for (const el of list) el.style.display = show ? '' : 'none';
                return api;
            },
            trigger(eventName) {
                for (const el of list) {
                    el.dispatchEvent(new Event(String(eventName), { bubbles: true }));
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
    delete globalThis.Luker;
    jest.restoreAllMocks();
});

describe('buildIllustrationMainSummary', () => {
    test('disabled state sets dormant tone, dims autoGenerate, notes chat/tag stripping off while Workbench Studio remains active', () => {
        const model = buildIllustrationMainSummary(makeMainState({
            enabled: false,
            autoGenerate: true,
            presetName: 'Anime Tag',
            apiPresetName: 'FastConn',
            llmPresetName: 'StudioPreset',
            maxConcurrentGenerations: 3,
            minGenerationInterval: 500,
            imageDisplayWidth: 80,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual(['autoGenerate']);

        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(rendered.fullText).toMatch(/tag stripping/i);
        expect(rendered.fullText).toMatch(/Workbench Studio/i);
        expect(rendered.fullText).toContain('Anime Tag');
        expect(rendered.fullText).toContain('FastConn');
        expect(rendered.fullText).toContain('StudioPreset');
        expect(rendered.fullText).toContain('3');
        expect(rendered.fullText).toContain('500');
        expect(rendered.fullText).toContain('80%');
        expect(rendered.fullText).toMatch(/newly generated/i);
    });

    test('enabled state covers auto/manual trigger, zero/non-zero context, and current API/preset fallbacks', () => {
        const autoZero = buildIllustrationMainSummary(makeMainState({
            enabled: true,
            autoGenerate: true,
            contextMessageCount: 0,
            apiPresetName: '',
            llmPresetName: '',
        }));
        expect(autoZero.tone).toBe('active');
        expect(autoZero.dormantFields).toEqual([]);
        const autoText = renderModel(autoZero).fullText;
        expect(autoText).toContain('(Current API config)');
        expect(autoText).toContain('(Current preset)');
        expect(autoText).toContain('none');

        const manual = buildIllustrationMainSummary(makeMainState({
            enabled: true,
            autoGenerate: false,
            contextMessageCount: 12,
            apiPresetName: 'OpenAIConn',
            llmPresetName: 'NovelTag',
        }));
        expect(manual.tone).toBe('active');
        const manualText = renderModel(manual).fullText;
        expect(manualText).toMatch(/manual/i);
        expect(manualText).toContain('12');
        expect(manualText).toContain('OpenAIConn');
        expect(manualText).toContain('NovelTag');
        expect(tokenFieldKeys(manual)).toEqual(new Set([
            'autoGenerate',
            'preset',
            'apiPresetName',
            'llmPresetName',
            'contextMessageCount',
            'maxConcurrentGenerations',
            'minGenerationInterval',
            'imageDisplayWidth',
        ]));
    });

    test('missing preset emits danger warning and elevates tone to danger even when disabled', () => {
        const model = buildIllustrationMainSummary(makeMainState({
            enabled: false,
            hasPreset: false,
            presetName: '',
        }));

        expect(model.tone).toBe('danger');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('danger');
        expect(tokenFieldKeys(model).has('preset')).toBe(true);
        const rendered = renderModel(model);
        expect(rendered.warningTexts[0].severity).toBe('danger');
    });

    test('characterImageConflict surfaces conflict notice and elevates tone', () => {
        const model = buildIllustrationMainSummary(makeMainState({
            enabled: true,
            characterImageConflict: {
                code: 'novel_char_ref_requires_v45',
                message: 'NovelAI character reference images require a V4.5 model. Switch to a V4.5 model or use text-only character descriptions.',
                affects: ['character_image'],
            },
        }));

        expect(['warn', 'danger']).toContain(model.tone);
        expect(model.warnings).toHaveLength(1);
        expect(['warn', 'danger']).toContain(model.warnings[0].severity);
        const rendered = renderModel(model);
        expect(rendered.warningTexts[0].text).toContain('V4.5');
    });

    test('hostile preset name renders as literal textContent without child elements', () => {
        const hostile = '<img src=x onerror=1>${autoGenerate}';
        const model = buildIllustrationMainSummary(makeMainState({ presetName: hostile }));
        const parts = renderTemplateParts(model.rows[0].template, model.rows[0].tokens);
        const presetBtn = parts.find((p) => p instanceof Element && p.dataset?.bsumFields === 'preset');
        expect(presetBtn).toBeTruthy();
        expect(presetBtn.children.length).toBe(0);
        expect(presetBtn.textContent).toBe(hostile);
    });
});

describe('buildIllustrationProfileAgentSummary', () => {
    test('characterReferenceEnabled false sets dormant tone, notes chat skip + manual Workbench, and renders read-only span when absent from DOM', () => {
        const model = buildIllustrationProfileAgentSummary(makeProfileAgentState({
            characterReferenceEnabled: false,
            canActivateCharacterReference: false,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual([]);

        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(rendered.fullText).toMatch(/Workbench/i);
        const charRefPart = rendered.rowTexts[0].parts.find((p) => p instanceof Element && p.classList.contains('luker-bsum-tok'));
        expect(charRefPart).toBeTruthy();
        expect(charRefPart.tagName).toBe('SPAN');
        expect(charRefPart.classList.contains('is-readonly')).toBe(true);
    });

    test('characterReferenceEnabled true renders active state and interactive button when activatable', () => {
        const onActivate = jest.fn(() => true);
        const model = buildIllustrationProfileAgentSummary(makeProfileAgentState({
            characterReferenceEnabled: true,
            canActivateCharacterReference: true,
            onCharacterReferenceActivate: onActivate,
        }));

        expect(model.tone).toBe('active');
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).not.toBe('off');
        const btn = rendered.rowTexts[0].parts.find((p) => p instanceof Element && p.classList.contains('luker-bsum-tok'));
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.dataset.bsumFields).toBe('characterReferenceEnabled');
    });

    test('paired-inheritance honesty: inherits illustration pair ONLY when both empty; half-set falls back to global current and warns', () => {
        // 1. Both empty -> inherits illustration preset pair
        const inherited = buildIllustrationProfileAgentSummary(makeProfileAgentState({
            explorationApiPreset: '',
            explorationLlmPreset: '',
            illustrationApiPreset: 'IllConn',
            illustrationLlmPreset: 'IllPreset',
        }));
        expect(inherited.tone).toBe('active');
        expect(inherited.warnings).toEqual([]);
        const inheritedText = renderModel(inherited).fullText;
        expect(inheritedText).toContain('IllConn');
        expect(inheritedText).toContain('IllPreset');

        // 2. Only connection set -> preset falls back to Luker global current rather than illustration preset
        const apiOnly = buildIllustrationProfileAgentSummary(makeProfileAgentState({
            explorationApiPreset: 'ExpConn',
            explorationLlmPreset: '',
            illustrationApiPreset: 'IllConn',
            illustrationLlmPreset: 'IllPreset',
        }));
        expect(apiOnly.tone).toBe('warn');
        expect(apiOnly.warnings).toHaveLength(1);
        expect(apiOnly.warnings[0].severity).toBe('warn');
        const apiOnlyRendered = renderModel(apiOnly);
        expect(apiOnlyRendered.fullText).toContain('ExpConn');
        expect(apiOnlyRendered.fullText).not.toContain('IllPreset');
        expect(apiOnlyRendered.fullText).toMatch(/global/i);
        expect(apiOnlyRendered.fullText).toMatch(/illustration preset/i);

        // 3. Only completion preset set -> connection falls back to Luker global current rather than illustration preset
        const llmOnly = buildIllustrationProfileAgentSummary(makeProfileAgentState({
            explorationApiPreset: '',
            explorationLlmPreset: 'ExpPreset',
            illustrationApiPreset: 'IllConn',
            illustrationLlmPreset: 'IllPreset',
        }));
        expect(llmOnly.tone).toBe('warn');
        expect(llmOnly.warnings).toHaveLength(1);
        expect(llmOnly.warnings[0].severity).toBe('warn');
        const llmOnlyRendered = renderModel(llmOnly);
        expect(llmOnlyRendered.fullText).toContain('ExpPreset');
        expect(llmOnlyRendered.fullText).not.toContain('IllConn');
        expect(llmOnlyRendered.fullText).toMatch(/global/i);

        // 4. Both set -> uses explicit pair with no warning
        const bothSet = buildIllustrationProfileAgentSummary(makeProfileAgentState({
            explorationApiPreset: 'ExpConn',
            explorationLlmPreset: 'ExpPreset',
            illustrationApiPreset: 'IllConn',
            illustrationLlmPreset: 'IllPreset',
        }));
        expect(bothSet.tone).toBe('active');
        expect(bothSet.warnings).toEqual([]);
        const bothText = renderModel(bothSet).fullText;
        expect(bothText).toContain('ExpConn');
        expect(bothText).toContain('ExpPreset');
    });

    test('visualInspection true notes vision-capable model requirement while false notes text-only research', () => {
        const visionOn = buildIllustrationProfileAgentSummary(makeProfileAgentState({ visualInspection: true }));
        expect(renderModel(visionOn).fullText).toMatch(/vision-capable/i);

        const visionOff = buildIllustrationProfileAgentSummary(makeProfileAgentState({ visualInspection: false }));
        expect(renderModel(visionOff).fullText).toMatch(/text-only/i);
    });
});

describe('buildSdModeSummary', () => {
    test('functionTool && interactiveMode && toolCallingSupported emits warn and puts interactiveMode in dormantFields', () => {
        const model = buildSdModeSummary(makeSdModeState({
            functionTool: true,
            interactiveMode: true,
            toolCallingSupported: true,
        }));

        expect(model.tone).toBe('warn');
        expect(model.dormantFields).toEqual(['interactiveMode']);
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        const rendered = renderModel(model);
        expect(rendered.warningTexts[0].text).toMatch(/suppressed/i);
        expect(rendered.fullText).toContain('GenerateImage');
        expect(rendered.fullText).toMatch(/AI Illustration/i);
    });

    test('functionTool && interactiveMode && !toolCallingSupported does not suppress interactiveMode', () => {
        const model = buildSdModeSummary(makeSdModeState({
            functionTool: true,
            interactiveMode: true,
            toolCallingSupported: false,
        }));

        expect(model.tone).toBe('active');
        expect(model.dormantFields).toEqual([]);
        expect(model.warnings).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.fullText).toMatch(/unavailable|unsupported/i);
    });

    test('covers all 5 prompt/ratio switches in both states and clarifies none affect AI Illustration', () => {
        const allOff = buildSdModeSummary(makeSdModeState());
        expect(allOff.tone).toBe('active');
        expect(allOff.dormantFields).toEqual([]);
        expect(allOff.warnings).toEqual([]);
        expect(tokenFieldKeys(allOff)).toEqual(new Set([
            'functionTool',
            'interactiveMode',
            'freeExtend',
            'refineMode',
            'minimalPromptProcessing',
            'multimodalCaptioning',
            'snap',
        ]));

        const offText = renderModel(allOff).fullText;
        expect(offText).toMatch(/verbatim/i);
        expect(offText).toMatch(/none of these 5 switches affect AI Illustration/i);

        const allOn = buildSdModeSummary(makeSdModeState({
            interactiveMode: true,
            freeExtend: true,
            refineMode: true,
            minimalPromptProcessing: true,
            multimodalCaptioning: true,
            snap: true,
        }));
        expect(allOn.tone).toBe('active');
        const onText = renderModel(allOn).fullText;
        expect(onText).toMatch(/LLM-extended/i);
        expect(onText).toMatch(/edit popup/i);
        expect(onText).toMatch(/structured output/i);
        expect(onText).toMatch(/multimodal/i);
        expect(onText).toMatch(/nearest resolution/i);
        expect(onText).toMatch(/none of these 5 switches affect AI Illustration/i);
    });
});

describe('DOM mounting in illustration/settings-ui.js & stable-diffusion/index.js', () => {
    test('Review Focus #4: Profile Agent token degrades to read-only span when #sd_character_reference_enabled is absent from DOM', async () => {
        installMinimalJQuery();
        const container = document.createElement('div');
        container.id = 'sd_container';
        document.body.appendChild(container);

        const illustrationHtml = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/stable-diffusion/illustration-settings.html'),
            'utf8',
        );

        jest.resetModules();
        jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
            renderExtensionTemplateAsync: async () => illustrationHtml,
        }));
        jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
            t: (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), ''),
            translate: (s) => String(s ?? ''),
        }));
        jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
            callGenericPopup: async () => '',
            POPUP_TYPE: { INPUT: 1, CONFIRM: 2 },
        }));
        jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
            clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
        }));

        const { initSettingsUi } = await import('../../public/scripts/extensions/stable-diffusion/illustration/settings-ui.js');

        const settings = {
            enabled: false,
            autoGenerate: false,
            currentPresetId: 'p1',
            presets: [{
                id: 'p1',
                name: 'Tag Default',
                promptStyle: 'tag',
                illustrationPrompt: 'Prompt',
                studioPrompt: 'Studio',
                explorationPrompt: 'Explore',
                llm: { apiPresetName: '', llmPresetName: '' },
                explorationLlm: { apiPresetName: '', llmPresetName: '' },
                visualInspection: false,
            }],
            contextMessageCount: 10,
            maxConcurrentGenerations: 1,
            minGenerationInterval: 0,
            imageDisplayWidth: 100,
        };

        const ui = await initSettingsUi({
            settings,
            saveSettings: jest.fn(),
            context: {
                connectionProfiles: { list: () => [] },
                getPresetManager: () => ({ getAllPresets: () => [] }),
                extensionSettings: { sd: { character_reference_enabled: false } },
            },
            onEnabledChange: jest.fn(),
        });

        const profileCard = document.querySelector('.luker-bsum[data-bsum-id="sd-illustration-profile-agent"]');
        expect(profileCard).toBeTruthy();
        expect(profileCard.classList.contains('is-dormant')).toBe(true);
        const charRefToken = profileCard.querySelector('.luker-bsum-tok');
        expect(charRefToken).toBeTruthy();
        expect(charRefToken.tagName).toBe('SPAN');
        expect(charRefToken.classList.contains('is-readonly')).toBe(true);

        ui.destroy();
    });

    test('mounts Card 1 and Card 2 in real templates, supports cross-drawer expand+scroll+focus+pulse, paired-inheritance updates, conflict warnings, and focus stability', async () => {
        installMinimalJQuery();
        const sdHtml = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/stable-diffusion/settings.html'),
            'utf8',
        );
        const illustrationHtml = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/stable-diffusion/illustration-settings.html'),
            'utf8',
        );

        const sdContainer = document.createElement('div');
        sdContainer.id = 'sd_container';
        sdContainer.innerHTML = sdHtml;
        document.body.appendChild(sdContainer);

        const sdDrawer = sdContainer.querySelector('.sd_settings .inline-drawer');
        const sdDrawerToggle = sdDrawer.querySelector(':scope > .inline-drawer-toggle');
        const sdDrawerContent = sdDrawer.querySelector(':scope > .inline-drawer-content');
        sdDrawerContent.style.display = 'none';
        let toggleClicks = 0;
        sdDrawerToggle.addEventListener('click', () => {
            toggleClicks += 1;
            sdDrawerContent.style.display = sdDrawerContent.style.display === 'none' ? 'block' : 'none';
        });

        const charRefCheck = document.getElementById('sd_character_reference_enabled');
        const scrollSpy = jest.fn();
        charRefCheck.closest('.checkbox_label').scrollIntoView = scrollSpy;
        charRefCheck.checked = false;

        let mockConflict = null;
        const sdSettingsState = {
            character_reference_enabled: false,
        };

        jest.resetModules();
        jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
            renderExtensionTemplateAsync: async () => illustrationHtml,
        }));
        jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
            t: (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), ''),
            translate: (s) => String(s ?? ''),
        }));
        jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
            callGenericPopup: async () => 'Renamed Preset',
            POPUP_TYPE: { INPUT: 1, CONFIRM: 2 },
        }));
        jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
            clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
        }));

        const { initSettingsUi } = await import('../../public/scripts/extensions/stable-diffusion/illustration/settings-ui.js');

        const settings = {
            enabled: false,
            autoGenerate: true,
            currentPresetId: 'p1',
            presets: [
                {
                    id: 'p1',
                    name: 'Default Tag',
                    promptStyle: 'tag',
                    illustrationPrompt: 'Prompt 1',
                    studioPrompt: 'Studio 1',
                    explorationPrompt: 'Explore 1',
                    llm: { apiPresetName: 'IllConn', llmPresetName: 'IllPreset' },
                    explorationLlm: { apiPresetName: '', llmPresetName: '' },
                    visualInspection: false,
                },
                {
                    id: 'p2',
                    name: 'Natural Preset',
                    promptStyle: 'natural',
                    illustrationPrompt: 'Prompt 2',
                    studioPrompt: 'Studio 2',
                    explorationPrompt: 'Explore 2',
                    llm: { apiPresetName: '', llmPresetName: '' },
                    explorationLlm: { apiPresetName: 'OnlyConn', llmPresetName: '' },
                    visualInspection: true,
                },
            ],
            contextMessageCount: 10,
            maxConcurrentGenerations: 2,
            minGenerationInterval: 200,
            imageDisplayWidth: 90,
        };

        const ui = await initSettingsUi({
            settings,
            saveSettings: jest.fn(),
            getCapabilitiesSnapshot: () => ({
                characterReferenceEnabled: Boolean(sdSettingsState.character_reference_enabled),
                supportsCharacterReference: Boolean(sdSettingsState.character_reference_enabled),
                warnings: mockConflict ? [mockConflict] : [],
            }),
            context: {
                connectionProfiles: {
                    list: () => [{ name: 'IllConn' }, { name: 'OnlyConn' }],
                },
                getPresetManager: () => ({
                    getAllPresets: () => ['IllPreset'],
                }),
                extensionSettings: { sd: sdSettingsState },
            },
            onEnabledChange: jest.fn(),
        });

        const illDrawerContent = document.querySelector('#sd_illustration_container .inline-drawer-content');
        const mainCard = illDrawerContent.querySelector('.luker-bsum[data-bsum-id="sd-illustration-main"]');
        const profileDrawerContent = document.querySelector('#sd_illustration_profile_agent_drawer .inline-drawer-content');
        const profileCard = profileDrawerContent.querySelector('.luker-bsum[data-bsum-id="sd-illustration-profile-agent"]');

        expect(mainCard).toBeTruthy();
        expect(illDrawerContent.firstElementChild).toBe(mainCard);
        expect(mainCard.classList.contains('is-dormant')).toBe(true);
        expect(document.getElementById('sd_illustration_auto_generate').closest('.checkbox_label').classList.contains('luker-bsum-field-dormant')).toBe(true);

        expect(profileCard).toBeTruthy();
        expect(profileDrawerContent.firstElementChild).toBe(profileCard);
        expect(profileCard.classList.contains('is-dormant')).toBe(true);

        // Cross-drawer token renders as <button> and expands collapsed .sd_settings drawer + focuses & pulses checkbox
        const jumpBtn = profileCard.querySelector('button[data-bsum-fields="characterReferenceEnabled"]');
        expect(jumpBtn).toBeTruthy();
        jumpBtn.click();
        expect(toggleClicks).toBe(1);
        expect(sdDrawerContent.style.display).toBe('block');
        expect(scrollSpy).toHaveBeenCalled();
        expect(document.activeElement).toBe(charRefCheck);
        expect(charRefCheck.closest('.checkbox_label').classList.contains('luker-bsum-field-pulse')).toBe(true);

        // Flipping #sd_character_reference_enabled updates Card 2 immediately
        charRefCheck.checked = true;
        sdSettingsState.character_reference_enabled = true;
        charRefCheck.dispatchEvent(new Event('change', { bubbles: true }));
        expect(profileCard.classList.contains('is-active')).toBe(true);

        // Switching preset to p2 (half-set explorationLlm + visualInspection: true) updates Card 2 to warn
        const presetSelect = document.getElementById('sd_illustration_preset');
        presetSelect.value = 'p2';
        presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(profileCard.classList.contains('is-warn')).toBe(true);
        expect(profileCard.textContent).toContain('OnlyConn');
        expect(profileCard.textContent).toMatch(/vision-capable/i);

        // Capability update with characterImageConflict surfaces warning on Card 1
        mockConflict = {
            code: 'novel_char_ref_requires_v45',
            message: 'NovelAI character reference images require a V4.5 model. Switch to a V4.5 model or use text-only character descriptions.',
            affects: ['character_image'],
        };
        sdContainer.dispatchEvent(new CustomEvent('sd:capabilities-updated'));
        expect(mainCard.classList.contains('is-danger')).toBe(true);
        expect(mainCard.textContent).toContain('V4.5');

        // Typing into context count preserves focus while Card 1 updates
        const contextInput = document.getElementById('sd_illustration_context_count');
        contextInput.focus();
        contextInput.value = '0';
        contextInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.activeElement).toBe(contextInput);
        document.getElementById('sd_illustration_enabled').checked = true;
        document.getElementById('sd_illustration_enabled').dispatchEvent(new Event('input', { bubbles: true }));
        expect(mainCard.textContent).toContain('none');

        ui.destroy();
    });

    test('settings.html removes redundant sd_free_extend_small and mounts SD mode card directly below .sd_generation_preset_block <hr />', async () => {
        const sdHtml = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/stable-diffusion/settings.html'),
            'utf8',
        );
        expect(sdHtml).not.toContain('sd_free_extend_small');
        expect(sdHtml).not.toContain('(interactive/commands)');

        const sdContainer = document.createElement('div');
        sdContainer.id = 'sd_container';
        sdContainer.innerHTML = sdHtml;
        document.body.appendChild(sdContainer);

        const { mountBehaviorSummary } = await import('../../public/scripts/lens-shared/behavior-summary.js');
        const sdSettingsEl = sdContainer.querySelector('.sd_settings');
        const anchorHr = sdSettingsEl.querySelector('.sd_generation_preset_block + hr');
        expect(anchorHr).toBeTruthy();

        let toolCallingSupported = true;
        const handle = mountBehaviorSummary({
            id: 'sd-mode-summary',
            root: sdSettingsEl,
            anchor: anchorHr,
            position: 'after',
            fields: {
                refineMode: { selector: '#sd_refine_mode', highlight: '.checkbox_label' },
                functionTool: { selector: '#sd_function_tool', highlight: '.checkbox_label' },
                interactiveMode: { selector: '#sd_interactive_mode', highlight: '.checkbox_label' },
                multimodalCaptioning: { selector: '#sd_multimodal_captioning', highlight: '.checkbox_label' },
                freeExtend: { selector: '#sd_free_extend', highlight: '.checkbox_label' },
                snap: { selector: '#sd_snap', highlight: '.checkbox_label' },
                minimalPromptProcessing: { selector: '#sd_minimal_prompt_processing', highlight: '.checkbox_label' },
            },
            readState: (rootEl) => ({
                functionTool: Boolean(rootEl.querySelector('#sd_function_tool')?.checked),
                interactiveMode: Boolean(rootEl.querySelector('#sd_interactive_mode')?.checked),
                toolCallingSupported,
                refineMode: Boolean(rootEl.querySelector('#sd_refine_mode')?.checked),
                freeExtend: Boolean(rootEl.querySelector('#sd_free_extend')?.checked),
                minimalPromptProcessing: Boolean(rootEl.querySelector('#sd_minimal_prompt_processing')?.checked),
                multimodalCaptioning: Boolean(rootEl.querySelector('#sd_multimodal_captioning')?.checked),
                snap: Boolean(rootEl.querySelector('#sd_snap')?.checked),
            }),
            build: buildSdModeSummary,
        });

        expect(anchorHr.nextElementSibling).toBe(handle.el);
        expect(handle.el.nextElementSibling?.getAttribute('for')).toBe('sd_refine_mode');
        expect(handle.el.classList.contains('is-active')).toBe(true);

        const fnCheck = document.getElementById('sd_function_tool');
        const interactiveCheck = document.getElementById('sd_interactive_mode');
        fnCheck.checked = true;
        fnCheck.dispatchEvent(new Event('input', { bubbles: true }));
        interactiveCheck.checked = true;
        interactiveCheck.dispatchEvent(new Event('input', { bubbles: true }));

        expect(handle.el.classList.contains('is-warn')).toBe(true);
        expect(interactiveCheck.closest('.checkbox_label').classList.contains('luker-bsum-field-dormant')).toBe(true);

        toolCallingSupported = false;
        handle.refresh();
        expect(handle.el.classList.contains('is-active')).toBe(true);
        expect(interactiveCheck.closest('.checkbox_label').classList.contains('luker-bsum-field-dormant')).toBe(false);

        const freeExtendTok = handle.el.querySelector('button[data-bsum-fields="freeExtend"]');
        freeExtendTok.click();
        expect(document.activeElement).toBe(document.getElementById('sd_free_extend'));
        expect(document.getElementById('sd_free_extend').closest('.checkbox_label').classList.contains('luker-bsum-field-pulse')).toBe(true);

        handle.destroy();
    });

    test('zh-cn and zh-tw locale files include all SD behavioral summary keys with matching ${token} placeholders and no unescaped semicolons', () => {
        const modelsSrc = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/stable-diffusion/behavior-summary-models.js'),
            'utf8',
        );
        const zhCn = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-tw.json'), 'utf8'));

        const keys = new Set();
        for (const m of modelsSrc.matchAll(/\btranslate\(\s*'((?:\\'|[^'])*)'\s*\)/g)) {
            const raw = m[1].replace(/\\'/g, '\'');
            keys.add(raw);
        }
        expect(keys.size).toBeGreaterThan(20);

        for (const key of keys) {
            expect(key).not.toMatch(/(?<!\\);/);
            expect(typeof zhCn[key]).toBe('string');
            expect(typeof zhTw[key]).toBe('string');
            expect(zhCn[key].length).toBeGreaterThan(0);
            expect(zhTw[key].length).toBeGreaterThan(0);

            const expectedTokens = [...key.matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
            const cnTokens = [...zhCn[key].matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
            const twTokens = [...zhTw[key].matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
            expect(cnTokens).toEqual(expectedTokens);
            expect(twTokens).toEqual(expectedTokens);
        }
    });
});
