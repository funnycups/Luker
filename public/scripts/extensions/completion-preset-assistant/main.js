// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { ensureSimulationReviewLocaleData } from '../../iteration-library/simulation-review/i18n/index.js';
import { escapeHtml } from '../../lib/html-escape.js';
import { openSkillManagerPanel } from '../../skills/skill-manager-panel.js';
import { initializePromptDefaults } from '../../lib/prompt-values.js';
import { cloneJsonValue, isPlainObject } from '../json-state-journal.js';
import {
    MODULE_NAME,
    PROMPT_DEFAULTS,
    PROMPT_FIELDS,
    defaultSettings,
} from './defaults.js';
import { i18n, i18nFormat } from './i18n.js';
import { mountBehaviorSummary } from '../../lens-shared/behavior-summary.js';
import { getOpenAIPresetNames as getSharedOpenAIPresetNames } from '../../lens-shared/preset-selectors.js';
import { buildCpaSummaryModel } from './behavior-summary-model.js';

const __ctx = Luker.getContext();
const saveSettingsDebounced = __ctx.saveSettingsDebounced;
const extension_settings = __ctx.extensionSettings;
const getContext = Luker.getContext;
const Popup = __ctx.Popup;

const UI_BLOCK_ID = 'completion_preset_assistant_settings';
const OPEN_BUTTON_ID = 'completion_preset_assistant_open';
const CREATE_BUTTON_ID = 'completion_preset_assistant_create';
const SKILLS_BUTTON_ID = 'completion_preset_assistant_bundle_skills';
const OPENAI_BUTTON_ID = 'completion_preset_assistant_openai_button';

const CPA_SUMMARY_FIELDS = Object.freeze({
    iterBaseSystemPrompt: '#cpa_iter_base_system_prompt',
    iterModePromptOrchestratorOptimize: '#cpa_iter_mode_orchestrator_prompt',
    iterModePromptJailbreakOnly: '#cpa_iter_mode_jailbreak_prompt',
});

let summaryHandle = null;

function clone(value, fallback = {}) {
    return cloneJsonValue(value, fallback);
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = clone(defaultSettings);
    }
    const settings = extension_settings[MODULE_NAME];
    let mutated = false;
    for (const legacyKey of [
        'requestApiProfileName',
        'requestApiPresetName',
        'requestLlmPresetName',
        'includeWorldInfo',
        'toolCallRetryMax',
        'iterSystemPrompt',
    ]) {
        if (Object.hasOwn(settings, legacyKey)) {
            delete settings[legacyKey];
            mutated = true;
        }
    }
    if (initializePromptDefaults(settings, PROMPT_DEFAULTS) || mutated) {
        saveSettingsDebounced();
    }
    return settings;
}

function getOpenAIPresetNames(context = getContext()) {
    return getSharedOpenAIPresetNames(context, { sort: true });
}

function getCurrentTargetRef(context = getContext()) {
    const ref = context?.presets?.getSelected?.('openai');
    return ref && typeof ref === 'object' ? clone(ref, null) : null;
}

function getCurrentLiveSnapshot(context = getContext()) {
    const snapshot = context?.presets?.getLive?.('openai');
    return snapshot && typeof snapshot === 'object' ? clone(snapshot, null) : null;
}

function getStoredDefaultSnapshot(context = getContext()) {
    const snapshot = context?.presets?.getStored?.({ collection: 'openai', name: 'Default' });
    return snapshot && typeof snapshot === 'object' ? clone(snapshot, null) : null;
}

function findCanonicalPresetName(names = [], requestedName = '') {
    const normalizedRequested = String(requestedName || '').trim().toLocaleLowerCase();
    if (!normalizedRequested) return '';
    return names.find((name) => String(name || '').trim().toLocaleLowerCase() === normalizedRequested) || '';
}

async function buildNewPresetBaseline(context = getContext()) {
    try {
        const manager = typeof context?.getPresetManager === 'function'
            ? context.getPresetManager('openai')
            : null;
        if (typeof manager?.getDefaultPreset === 'function') {
            const restored = await manager.getDefaultPreset('Default');
            if (restored?.isDefault && isPlainObject(restored?.preset)) {
                return clone(restored.preset, {});
            }
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to load packaged Default preset baseline`, error);
    }
    const defaultSnapshot = getStoredDefaultSnapshot(context);
    if (isPlainObject(defaultSnapshot?.body)) return clone(defaultSnapshot.body, {});
    const liveSnapshot = getCurrentLiveSnapshot(context);
    if (isPlainObject(liveSnapshot?.body)) return clone(liveSnapshot.body, {});
    return {};
}

async function handleCreateNewPreset() {
    const context = getContext();
    const requestedName = String(await Popup.show.input(
        i18n('Create New Preset'),
        i18n('Enter a name for the new preset.'),
        '',
    ) || '').trim();
    if (!requestedName) return;

    const existingName = findCanonicalPresetName(getOpenAIPresetNames(context), requestedName);
    if (existingName) {
        toastr.warning(i18nFormat('Preset already exists: ${0}', existingName));
        return;
    }

    try {
        const result = await context.presets.save(
            { collection: 'openai', name: requestedName },
            await buildNewPresetBaseline(context),
            { select: true },
        );
        if (!result?.ok || !result?.ref) {
            throw new Error(i18n('Create preset failed.'));
        }
        toastr.success(i18nFormat('Preset created: ${0}', result.ref.name || requestedName));
        await openCpaIteration();
    } catch (error) {
        toastr.error(i18nFormat('AI request failed: ${0}', error?.message || error));
        console.error(`[${MODULE_NAME}] Failed to create preset`, error);
    }
}

async function openBundleSkillsForCurrentPreset() {
    const context = getContext();
    const targetRef = getCurrentTargetRef(context);
    if (!targetRef || !targetRef.name) {
        toastr.warning(i18n('No preset is currently selected.'));
        return;
    }
    const initialScope = {
        kind: 'preset',
        name: String(targetRef.name),
    };
    try {
        await openSkillManagerPanel({ context, t: i18n, initialScope });
    } catch (e) {
        toastr.error(i18nFormat('AI request failed: ${0}', e?.message || e));
        console.error(`[${MODULE_NAME}] Failed to open Skill Manager`, e);
    }
}

async function openCpaIteration() {
    const context = getContext();

    const targetRef = getCurrentTargetRef(context);
    if (!targetRef) {
        toastr.warning(i18n('No preset is currently selected.'));
        return null;
    }

    const wb = context?.workbench;
    if (typeof wb?.open !== 'function') {
        toastr.error(i18n('Workbench is unavailable.'));
        return null;
    }

    return wb.open({ page: 'ai', ws: 'preset', scope: 'preset' });
}

function ensureOpenAiToolbarButton() {
    const toolbar = jQuery('#openai_api-presets .preset_manager_select_actions').first();
    if (!toolbar.length || toolbar.find(`#${OPENAI_BUTTON_ID}`).length) return;

    toolbar.append(`
<div id="${OPENAI_BUTTON_ID}" class="menu_button menu_button_icon completion-preset-assistant-open" title="${escapeHtml(i18n('Open Assistant'))}">
    <i class="fa-fw fa-solid fa-wand-magic-sparkles"></i>
</div>`);
}

function readSummaryState(rootEl) {
    const settings = ensureSettings();
    const readPrompt = (selector, fallback) => {
        const el = rootEl.querySelector(selector);
        return el ? String(el.value ?? '') : String(fallback ?? '');
    };
    return {
        iterBaseSystemPrompt: readPrompt('#cpa_iter_base_system_prompt', settings.iterBaseSystemPrompt),
        iterModePromptOrchestratorOptimize: readPrompt('#cpa_iter_mode_orchestrator_prompt', settings.iterModePromptOrchestratorOptimize),
        iterModePromptJailbreakOnly: readPrompt('#cpa_iter_mode_jailbreak_prompt', settings.iterModePromptJailbreakOnly),
        defaultPrompts: {
            iterBaseSystemPrompt: defaultSettings.iterBaseSystemPrompt,
            iterModePromptOrchestratorOptimize: defaultSettings.iterModePromptOrchestratorOptimize,
            iterModePromptJailbreakOnly: defaultSettings.iterModePromptJailbreakOnly,
        },
        i18n,
    };
}

function mountSummary(root) {
    const rootEl = root?.[0];
    if (typeof Element === 'undefined' || !(rootEl instanceof Element)) {
        summaryHandle?.destroy?.();
        summaryHandle = null;
        return;
    }
    if (summaryHandle?.el && rootEl.contains(summaryHandle.el)) {
        summaryHandle.refresh();
        return;
    }
    summaryHandle?.destroy?.();
    summaryHandle = null;
    const anchor = rootEl.querySelector('.inline-drawer-content > .cpa_row');
    if (!anchor) return;
    summaryHandle = mountBehaviorSummary({
        id: 'cpa-settings-summary',
        root: rootEl,
        anchor,
        position: 'after',
        fields: CPA_SUMMARY_FIELDS,
        ariaLabel: i18n('Completion Preset Assistant behavior summary'),
        readState: readSummaryState,
        build: buildCpaSummaryModel,
    });
}

function refreshUiState() {
    const settings = ensureSettings();
    for (const { key, id } of PROMPT_FIELDS) {
        const field = jQuery(`#${id}`);
        if (field.length && field[0] !== document.activeElement) {
            field.val(settings[key] ?? '');
        }
    }
    ensureOpenAiToolbarButton();
    summaryHandle?.refresh?.();
}

function bindUi() {
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) return;

    root.off('.cpa');
    jQuery(document).off('.cpaOpen');

    root.on('click.cpa', `#${OPEN_BUTTON_ID}`, async function () {
        await openCpaIteration();
    });
    root.on('click.cpa', `#${CREATE_BUTTON_ID}`, async function () {
        await handleCreateNewPreset();
    });
    root.on('click.cpa', `#${SKILLS_BUTTON_ID}`, async function () {
        await openBundleSkillsForCurrentPreset();
    });
    root.on('input.cpa', '[data-cpa-prompt]', function () {
        ensureSettings()[this.dataset.cpaPrompt] = this.value;
        saveSettingsDebounced();
    });
    root.on('click.cpa', '[data-cpa-reset-prompt]', function () {
        const key = this.dataset.cpaResetPrompt;
        const nextValue = defaultSettings[key] ?? '';
        ensureSettings()[key] = nextValue;
        const fieldDef = PROMPT_FIELDS.find(f => f.key === key);
        if (fieldDef) {
            root.find(`#${fieldDef.id}`).val(nextValue);
        }
        refreshUiState();
        saveSettingsDebounced();
    });

    jQuery(document).on('click.cpaOpen', `#${OPENAI_BUTTON_ID}`, async function () {
        await openCpaIteration();
    });

    mountSummary(root);
}

function ensureUi(context = getContext()) {
    const host = jQuery('#extensions_settings2');
    if (!host.length) return;

    ensureOpenAiToolbarButton();
    if (jQuery(`#${UI_BLOCK_ID}`).length) {
        bindUi();
        refreshUiState(context);
        return;
    }

    host.append(`
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${escapeHtml(i18n('Completion Preset Assistant'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="cpa_row">
                <div id="${OPEN_BUTTON_ID}" class="menu_button">${escapeHtml(i18n('Open in Workbench'))}</div>
                <div id="${CREATE_BUTTON_ID}" class="menu_button">${escapeHtml(i18n('Create New Preset'))}</div>
                <div id="${SKILLS_BUTTON_ID}" class="menu_button" title="${escapeHtml(i18n('Bundle skills with this preset'))}">
                    <i class="fa-fw fa-solid fa-cubes"></i> ${escapeHtml(i18n('Bundle skills with this preset'))}
                </div>
            </div>
            <details class="marginTop10">
                <summary>${escapeHtml(i18n('Advanced prompts'))}</summary>
                ${PROMPT_FIELDS.map(({ key, id, label }) => `
                <div class="flex-container alignItemsBaseline">
                    <label for="${id}">${escapeHtml(i18n(label))}</label>
                    <button type="button" id="cpa_reset_${id.slice(4)}" class="menu_button" data-cpa-reset-prompt="${key}">${escapeHtml(i18n('Reset to default'))}</button>
                </div>
                <textarea id="${id}" class="text_pole" rows="6" data-cpa-prompt="${key}"></textarea>`).join('')}
            </details>
        </div>
    </div>
</div>`);

    bindUi();
    refreshUiState(context);
}

function getPresetEventCollection(event = null) {
    return String(event?.collection || event?.apiId || '').trim();
}

jQuery(async () => {
    ensureSimulationReviewLocaleData();
    ensureSettings();
    ensureUi();
    const context = getContext();
    context.eventSource.on(context.eventTypes.PRESET_CHANGED, (event) => {
        if (getPresetEventCollection(event) === 'openai') refreshUiState();
    });
    context.eventSource.on(context.eventTypes.PRESET_RENAMED, (event) => {
        if (getPresetEventCollection(event) === 'openai') refreshUiState();
    });
    context.eventSource.on(context.eventTypes.PRESET_DELETED, (event) => {
        if (getPresetEventCollection(event) === 'openai') refreshUiState();
    });
});
