import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { t, translate } from '../../../i18n.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { clamp } from '../../../utils.js';
import { createExternalFieldFocuser, mountBehaviorSummary } from '../../../lens-shared/behavior-summary.js';
import { computeImageCapabilities } from '../capabilities.js';
import {
    buildIllustrationMainSummary,
    buildIllustrationProfileAgentSummary,
} from '../behavior-summary-models.js';
import { findCharacterImageConflict } from './task.js';
import {
    ILLUSTRATION_NUMBER_RULES,
    addPresetFromCurrent,
    deletePreset,
    getPresetById,
    selectPreset,
    updatePreset,
} from './settings.js';
import { getDefaultPromptValues } from './presets.js';
import { openLegacyCharacterDesignMigrationDialog } from './legacy-migration-dialog.js';
import { DEFAULT_EXPLORATION_PROMPT } from '../exploration/prompts.js';

const CONTAINER_ID = 'sd_illustration_container';

const ILLUSTRATION_MAIN_SUMMARY_FIELDS = Object.freeze({
    enabled: { selector: '#sd_illustration_enabled', highlight: '.checkbox_label' },
    autoGenerate: { selector: '#sd_illustration_auto_generate', highlight: '.checkbox_label' },
    preset: { selector: '#sd_illustration_preset', highlight: '.sd_illustration_row' },
    apiPresetName: { selector: '#sd_illustration_api_preset', highlight: '.sd_illustration_row' },
    llmPresetName: { selector: '#sd_illustration_llm_preset', highlight: '.sd_illustration_row' },
    contextMessageCount: { selector: '#sd_illustration_context_count', highlight: '.sd_illustration_row' },
    maxConcurrentGenerations: { selector: '#sd_illustration_max_concurrent', highlight: '.sd_illustration_row' },
    minGenerationInterval: { selector: '#sd_illustration_min_interval', highlight: '.sd_illustration_row' },
    imageDisplayWidth: { selector: '#sd_illustration_display_width', highlight: '.sd_illustration_row' },
});

const ILLUSTRATION_PROFILE_AGENT_SUMMARY_FIELDS = Object.freeze({
    visualInspection: { selector: '#sd_illustration_visual_inspection', highlight: '.checkbox_label' },
    explorationApiPreset: { selector: '#sd_illustration_exploration_api_preset', highlight: '.sd_illustration_row' },
    explorationLlmPreset: { selector: '#sd_illustration_exploration_llm_preset', highlight: '.sd_illustration_row' },
});

function currentPreset(settings) {
    return getPresetById(settings, settings.currentPresetId);
}

function escapeOption(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function initSettingsUi({
    settings,
    saveSettings,
    context,
    onEnabledChange,
    getCapabilitiesSnapshot = null,
}) {
    if (document.getElementById(CONTAINER_ID)) {
        return;
    }

    const html = await renderExtensionTemplateAsync('stable-diffusion', 'illustration-settings');
    $('#sd_container').append(html);

    const containerEl = document.getElementById(CONTAINER_ID);
    const presetSelect = $('#sd_illustration_preset');
    const styleSelect = $('#sd_illustration_prompt_style');
    const legacyDesignNotice = $('#sd_illustration_legacy_design_notice');
    const reviewLegacyDesignBtn = $('#sd_illustration_review_legacy_design');
    const promptField = $('#sd_illustration_prompt');
    const studioField = $('#sd_illustration_studio_prompt');
    const explorationField = $('#sd_illustration_exploration_prompt');
    const visualInspectionCheck = $('#sd_illustration_visual_inspection');
    const apiPresetSelect = $('#sd_illustration_api_preset');
    const llmPresetSelect = $('#sd_illustration_llm_preset');
    const expApiPresetSelect = $('#sd_illustration_exploration_api_preset');
    const expLlmPresetSelect = $('#sd_illustration_exploration_llm_preset');
    const presetButtons = $('#sd_illustration_preset_new, #sd_illustration_preset_rename, #sd_illustration_preset_delete');
    const resetButtons = [
        ['illustrationPrompt', $('#sd_illustration_prompt_reset')],
        ['studioPrompt', $('#sd_illustration_studio_prompt_reset')],
        ['explorationPrompt', $('#sd_illustration_exploration_prompt_reset')],
    ];
    let presetSavePending = false;
    let emptyPresetStyle = '';
    let mainSummary = null;
    let profileAgentSummary = null;
    const externalFieldFocuser = createExternalFieldFocuser();

    const focusSdCharacterReferenceCheckbox = () => {
        const target = document.getElementById('sd_character_reference_enabled');
        if (!target) {
            return false;
        }
        const wrapper = target.closest('.checkbox_label') || target;
        return externalFieldFocuser.focus(target, { highlightEl: wrapper });
    };

    const resolveCapabilities = () => {
        if (typeof getCapabilitiesSnapshot === 'function') {
            return getCapabilitiesSnapshot() || null;
        }
        const sdSettings = context?.extensionSettings?.sd;
        return sdSettings && typeof sdSettings === 'object'
            ? computeImageCapabilities(sdSettings)
            : null;
    };

    const refreshSummaries = () => {
        mainSummary?.refresh();
        profileAgentSummary?.refresh();
    };

    const readMainSummaryState = (rootEl) => {
        const preset = currentPreset(settings);
        const capabilities = resolveCapabilities();
        const readCheckbox = (selector, fallback) => {
            const el = rootEl.querySelector(selector);
            return el ? Boolean(el.checked) : Boolean(fallback);
        };
        const readValue = (selector, fallback) => {
            const el = rootEl.querySelector(selector);
            return el ? String(el.value ?? '') : String(fallback ?? '');
        };
        return {
            enabled: readCheckbox('#sd_illustration_enabled', settings.enabled),
            autoGenerate: readCheckbox('#sd_illustration_auto_generate', settings.autoGenerate),
            hasPreset: Boolean(preset),
            presetName: preset ? String(preset.name || '') : '',
            apiPresetName: preset ? readValue('#sd_illustration_api_preset', preset.llm?.apiPresetName || '') : '',
            llmPresetName: preset ? readValue('#sd_illustration_llm_preset', preset.llm?.llmPresetName || '') : '',
            contextMessageCount: readValue('#sd_illustration_context_count', settings.contextMessageCount),
            maxConcurrentGenerations: readValue('#sd_illustration_max_concurrent', settings.maxConcurrentGenerations),
            minGenerationInterval: readValue('#sd_illustration_min_interval', settings.minGenerationInterval),
            imageDisplayWidth: readValue('#sd_illustration_display_width', settings.imageDisplayWidth),
            characterImageConflict: findCharacterImageConflict(capabilities),
            translate,
        };
    };

    const readProfileAgentSummaryState = (rootEl) => {
        const preset = currentPreset(settings);
        const capabilities = resolveCapabilities();
        const charRefEl = document.getElementById('sd_character_reference_enabled');
        const characterReferenceEnabled = charRefEl
            ? Boolean(charRefEl.checked)
            : Boolean(capabilities?.characterReferenceEnabled ?? context?.extensionSettings?.sd?.character_reference_enabled);
        const readCheckbox = (selector, fallback) => {
            const el = rootEl.querySelector(selector);
            return el ? Boolean(el.checked) : Boolean(fallback);
        };
        const readValue = (selector, fallback) => {
            const el = rootEl.querySelector(selector);
            return el ? String(el.value ?? '') : String(fallback ?? '');
        };
        return {
            characterReferenceEnabled,
            canActivateCharacterReference: Boolean(charRefEl),
            visualInspection: preset ? readCheckbox('#sd_illustration_visual_inspection', preset.visualInspection) : false,
            explorationApiPreset: preset ? readValue('#sd_illustration_exploration_api_preset', preset.explorationLlm?.apiPresetName || '') : '',
            explorationLlmPreset: preset ? readValue('#sd_illustration_exploration_llm_preset', preset.explorationLlm?.llmPresetName || '') : '',
            illustrationApiPreset: preset ? readValue('#sd_illustration_api_preset', preset.llm?.apiPresetName || '') : '',
            illustrationLlmPreset: preset ? readValue('#sd_illustration_llm_preset', preset.llm?.llmPresetName || '') : '',
            translate,
        };
    };

    const refreshFields = () => {
        const preset = currentPreset(settings);
        const disabled = !preset || presetSavePending;
        const hasPendingLegacy = Array.isArray(settings.pendingCharacterDesignPrompts)
            && settings.pendingCharacterDesignPrompts.length > 0;
        legacyDesignNotice.toggle(hasPendingLegacy);
        reviewLegacyDesignBtn.prop('disabled', presetSavePending);
        presetSelect.prop('disabled', presetSavePending);
        styleSelect.prop('disabled', presetSavePending).val(preset ? (preset.promptStyle || '') : emptyPresetStyle);
        presetButtons.prop('disabled', presetSavePending).attr('aria-disabled', String(presetSavePending));
        for (const [field, reset] of resetButtons) {
            reset.prop('disabled', disabled || (field !== 'explorationPrompt' && !preset?.promptStyle));
        }
        promptField.prop('disabled', disabled);
        studioField.prop('disabled', disabled);
        explorationField.prop('disabled', disabled);
        visualInspectionCheck.prop('disabled', disabled);
        apiPresetSelect.prop('disabled', disabled);
        llmPresetSelect.prop('disabled', disabled);
        expApiPresetSelect.prop('disabled', disabled);
        expLlmPresetSelect.prop('disabled', disabled);
        promptField.val(preset?.illustrationPrompt || '');
        studioField.val(preset?.studioPrompt || '');
        explorationField.val(preset?.explorationPrompt || '');
        visualInspectionCheck.prop('checked', Boolean(preset?.visualInspection));
        apiPresetSelect.val(preset?.llm?.apiPresetName || '');
        llmPresetSelect.val(preset?.llm?.llmPresetName || '');
        expApiPresetSelect.val(preset?.explorationLlm?.apiPresetName || '');
        expLlmPresetSelect.val(preset?.explorationLlm?.llmPresetName || '');
        refreshSummaries();
    };

    const reportSaveError = error => toastr.error(String(error?.message || error), t`Image Generation`);
    const savePresetUpdate = async (preset, patch) => {
        if (presetSavePending) return;
        const previous = { ...preset };
        presetSavePending = true;
        let applied;
        try {
            updatePreset(settings, preset.id, patch);
            applied = { ...preset };
            refreshFields();
            await context.workbench.saveSettingsChecked(context);
        } catch (error) {
            if (applied) {
                for (const key of new Set([...Object.keys(previous), ...Object.keys(applied)])) {
                    if (previous[key] === applied[key] || preset[key] !== applied[key]) continue;
                    if (Object.hasOwn(previous, key)) preset[key] = previous[key];
                    else delete preset[key];
                }
            }
            reportSaveError(error);
        } finally {
            presetSavePending = false;
            refreshFields();
        }
    };

    const refreshPresetOptions = () => {
        const options = settings.presets.map(preset => `<option value="${escapeOption(preset.id)}">${escapeOption(preset.name)}</option>`);
        presetSelect.html(options.join('') || `<option value="">${escapeOption(t`No presets`)}</option>`);
        presetSelect.val(settings.currentPresetId);
        refreshFields();
    };

    const refreshConnectionOptions = () => {
        const selected = currentPreset(settings)?.llm?.apiPresetName || '';
        const expSelected = currentPreset(settings)?.explorationLlm?.apiPresetName || '';
        const profiles = context.connectionProfiles?.list?.() || [];
        const names = profiles.map(profile => profile.name);
        const buildOpts = (sel, emptyLabel) => {
            const opts = [`<option value="">${escapeOption(emptyLabel)}</option>`];
            for (const name of names) {
                opts.push(`<option value="${escapeOption(name)}">${escapeOption(name)}</option>`);
            }
            if (sel && !names.includes(sel)) {
                opts.push(`<option value="${escapeOption(sel)}">${escapeOption(sel)} ${escapeOption(t`(missing)`)}</option>`);
            }
            return opts.join('');
        };
        apiPresetSelect.html(buildOpts(selected, t`(Current API config)`)).val(selected);
        expApiPresetSelect.html(buildOpts(expSelected, t`(Inherit illustration connection)`)).val(expSelected);
        refreshSummaries();
    };

    const refreshLlmPresetOptions = () => {
        const selected = currentPreset(settings)?.llm?.llmPresetName || '';
        const expSelected = currentPreset(settings)?.explorationLlm?.llmPresetName || '';
        const manager = context.getPresetManager?.('openai');
        const presets = Array.isArray(manager?.getAllPresets?.()) ? manager.getAllPresets() : [];
        const names = [...new Set(presets.map(name => String(name || '').trim()).filter(Boolean))];
        const buildOpts = (sel, emptyLabel) => {
            const opts = [`<option value="">${escapeOption(emptyLabel)}</option>`];
            for (const name of names) {
                opts.push(`<option value="${escapeOption(name)}">${escapeOption(name)}</option>`);
            }
            if (sel && !names.includes(sel)) {
                opts.push(`<option value="${escapeOption(sel)}">${escapeOption(sel)} ${escapeOption(t`(missing)`)}</option>`);
            }
            return opts.join('');
        };
        llmPresetSelect.html(buildOpts(selected, t`(Current preset)`)).val(selected);
        expLlmPresetSelect.html(buildOpts(expSelected, t`(Inherit illustration preset)`)).val(expSelected);
        refreshSummaries();
    };

    $('#sd_illustration_enabled').prop('checked', settings.enabled).on('input', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettings();
        onEnabledChange?.(settings.enabled);
    });
    $('#sd_illustration_auto_generate').prop('checked', settings.autoGenerate).on('input', function () {
        settings.autoGenerate = !!$(this).prop('checked');
        saveSettings();
    });

    presetSelect.on('change', function () {
        const id = String($(this).val() || '');
        if (!id || !getPresetById(settings, id)) {
            return;
        }
        selectPreset(settings, id);
        saveSettings();
        refreshFields();
        refreshConnectionOptions();
        refreshLlmPresetOptions();
    });

    styleSelect.on('change', async function () {
        const style = String($(this).val() || '');
        const preset = currentPreset(settings);
        if (!preset) {
            emptyPresetStyle = style;
            return;
        }
        await savePresetUpdate(preset, { promptStyle: style });
    });
    for (const [field, reset] of resetButtons) {
        reset.on('click', async () => {
            const preset = currentPreset(settings);
            if (!preset) {
                return;
            }
            const value = field === 'explorationPrompt'
                ? DEFAULT_EXPLORATION_PROMPT
                : getDefaultPromptValues(preset.promptStyle)[field];
            await savePresetUpdate(preset, { [field]: value });
        });
    }
    $('#sd_illustration_iterate_ai').on('click', () => {
        context.workbench.open({ page: 'ai', ws: 'sd' });
    });
    reviewLegacyDesignBtn.on('click', () => {
        void openLegacyCharacterDesignMigrationDialog({
            settings,
            context,
            onResolved: () => refreshFields(),
        });
    });

    promptField.on('input', function () {
        const preset = currentPreset(settings);
        if (!preset) {
            return;
        }
        updatePreset(settings, preset.id, { illustrationPrompt: String($(this).val() || '') }, Date.now());
        saveSettings();
    });

    studioField.on('input', function () {
        const preset = currentPreset(settings);
        if (!preset) {
            return;
        }
        updatePreset(settings, preset.id, { studioPrompt: String($(this).val() || '') }, Date.now());
        saveSettings();
    });

    explorationField.on('input', function () {
        const preset = currentPreset(settings);
        if (!preset) {
            return;
        }
        updatePreset(settings, preset.id, { explorationPrompt: String($(this).val() || '') }, Date.now());
        saveSettings();
    });

    visualInspectionCheck.on('input', function () {
        const preset = currentPreset(settings);
        if (!preset) {
            return;
        }
        updatePreset(settings, preset.id, { visualInspection: !!$(this).prop('checked') }, Date.now());
        saveSettings();
    });

    expApiPresetSelect.on('change', function () {
        const preset = currentPreset(settings);
        if (!preset) {
            return;
        }
        updatePreset(settings, preset.id, {
            explorationLlm: {
                apiPresetName: String($(this).val() || ''),
                llmPresetName: preset.explorationLlm?.llmPresetName || '',
            },
        }, Date.now());
        saveSettings();
    });

    expLlmPresetSelect.on('change', function () {
        const preset = currentPreset(settings);
        if (!preset) {
            return;
        }
        updatePreset(settings, preset.id, {
            explorationLlm: {
                apiPresetName: preset.explorationLlm?.apiPresetName || '',
                llmPresetName: String($(this).val() || ''),
            },
        }, Date.now());
        saveSettings();
    });

    apiPresetSelect.on('change', function () {
        const preset = currentPreset(settings);
        if (!preset) {
            return;
        }
        updatePreset(settings, preset.id, {
            llm: { apiPresetName: String($(this).val() || ''), llmPresetName: preset.llm?.llmPresetName || '' },
        }, Date.now());
        saveSettings();
    });

    llmPresetSelect.on('change', function () {
        const preset = currentPreset(settings);
        if (!preset) {
            return;
        }
        updatePreset(settings, preset.id, {
            llm: { apiPresetName: preset.llm?.apiPresetName || '', llmPresetName: String($(this).val() || '') },
        }, Date.now());
        saveSettings();
    });

    $('#sd_illustration_preset_new').on('click', async () => {
        if (presetSavePending) return;
        const template = currentPreset(settings);
        const promptStyle = template ? template.promptStyle : emptyPresetStyle;
        if (!promptStyle) {
            toastr.info(t`Choose a default prompt style`, t`Image Generation`);
            styleSelect.trigger('focus');
            return;
        }
        const name = t`Copy of ${template?.name || t`Preset`}`;
        const previousId = settings.currentPresetId;
        let preset;
        presetSavePending = true;
        try {
            preset = addPresetFromCurrent(settings, {
                name, promptStyle, llm: template?.llm || {}, now: Date.now(),
            });
            selectPreset(settings, preset.id);
            refreshPresetOptions();
            await context.workbench.saveSettingsChecked(context);
        } catch (error) {
            if (preset) {
                const index = settings.presets.findIndex(candidate => candidate.id === preset.id);
                if (index !== -1) settings.presets.splice(index, 1);
                if (settings.currentPresetId === preset.id) settings.currentPresetId = previousId;
            }
            reportSaveError(error);
        } finally {
            presetSavePending = false;
            refreshPresetOptions();
            refreshConnectionOptions();
            refreshLlmPresetOptions();
        }
    });

    $('#sd_illustration_preset_rename').on('click', async () => {
        if (presetSavePending) return;
        const preset = currentPreset(settings);
        if (!preset) {
            toastr.warning(t`No preset selected.`, t`Image Generation`);
            return;
        }
        const name = await callGenericPopup(t`Preset name`, POPUP_TYPE.INPUT, preset.name);
        if (!name || String(name) === preset.name) {
            return;
        }
        updatePreset(settings, preset.id, { name: String(name) }, Date.now());
        saveSettings();
        refreshPresetOptions();
    });

    $('#sd_illustration_preset_delete').on('click', async () => {
        if (presetSavePending) return;
        const preset = currentPreset(settings);
        if (!preset) {
            toastr.warning(t`No preset selected.`, t`Image Generation`);
            return;
        }
        const confirmed = await callGenericPopup(
            t`Delete this prompt preset?`,
            POPUP_TYPE.CONFIRM,
        );
        if (!confirmed) {
            return;
        }
        deletePreset(settings, preset.id);
        saveSettings();
        refreshPresetOptions();
        refreshConnectionOptions();
        refreshLlmPresetOptions();
    });

    const bindNumber = (selector, key) => {
        const element = $(selector);
        const rule = ILLUSTRATION_NUMBER_RULES[key];
        element.val(settings[key]).on('input', function () {
            const parsed = Number(this.value);
            if (!Number.isFinite(parsed)) {
                return;
            }
            settings[key] = clamp(Math.round(parsed), rule.min, rule.max);
            saveSettings();
        });
    };

    bindNumber('#sd_illustration_context_count', 'contextMessageCount');
    bindNumber('#sd_illustration_max_concurrent', 'maxConcurrentGenerations');
    bindNumber('#sd_illustration_min_interval', 'minGenerationInterval');
    bindNumber('#sd_illustration_display_width', 'imageDisplayWidth');

    refreshPresetOptions();
    refreshConnectionOptions();
    refreshLlmPresetOptions();
    refreshFields();

    const summaryAbort = new AbortController();
    const mainDrawerContent = containerEl?.querySelector('.inline-drawer-content');
    if (containerEl && mainDrawerContent) {
        mainSummary = mountBehaviorSummary({
            id: 'sd-illustration-main',
            root: containerEl,
            anchor: mainDrawerContent,
            position: 'prepend',
            fields: ILLUSTRATION_MAIN_SUMMARY_FIELDS,
            ariaLabel: translate('AI illustration behavior summary'),
            readState: readMainSummaryState,
            build: buildIllustrationMainSummary,
        });
    }

    const profileDrawerContent = containerEl?.querySelector('#sd_illustration_profile_agent_drawer > .inline-drawer-content')
        || containerEl?.querySelector('#sd_illustration_visual_inspection')?.closest('.inline-drawer-content');
    if (containerEl && profileDrawerContent) {
        profileAgentSummary = mountBehaviorSummary({
            id: 'sd-illustration-profile-agent',
            root: containerEl,
            anchor: profileDrawerContent,
            position: 'prepend',
            fields: ILLUSTRATION_PROFILE_AGENT_SUMMARY_FIELDS,
            ariaLabel: translate('Character profile agent behavior summary'),
            readState: readProfileAgentSummaryState,
            build: buildIllustrationProfileAgentSummary,
            onTokenActivate: (fields) => {
                if (fields.includes('characterReferenceEnabled')) {
                    return focusSdCharacterReferenceCheckbox();
                }
                return false;
            },
        });
    }

    const sdContainerEl = document.getElementById('sd_container');
    if (sdContainerEl) {
        sdContainerEl.addEventListener('sd:capabilities-updated', () => {
            refreshSummaries();
        }, { signal: summaryAbort.signal });
        for (const evtName of ['input', 'change']) {
            sdContainerEl.addEventListener(evtName, (event) => {
                const target = event.target;
                if (!(target instanceof Element) || (containerEl && containerEl.contains(target))) {
                    return;
                }
                if (
                    target.id === 'sd_character_reference_enabled'
                    || target.id === 'sd_character_reference_mode'
                    || target.id === 'sd_source'
                    || target.id === 'sd_model'
                    || target.id === 'sd_comfy_type'
                    || target.id === 'sd_comfy_workflow'
                    || target.id === 'sd_style_references_enabled'
                    || target.id === 'sd_generation_preset'
                ) {
                    refreshSummaries();
                }
            }, { signal: summaryAbort.signal });
        }
    }

    if (containerEl) {
        containerEl.addEventListener('click', (event) => {
            if (event.target instanceof Element && event.target.closest('.inline-drawer-toggle')) {
                refreshConnectionOptions();
                refreshLlmPresetOptions();
                refreshSummaries();
            }
        }, { signal: summaryAbort.signal });
    }

    const destroy = () => {
        summaryAbort.abort();
        externalFieldFocuser.clear();
        mainSummary?.destroy();
        profileAgentSummary?.destroy();
        mainSummary = null;
        profileAgentSummary = null;
    };

    return {
        refreshPresetOptions,
        refreshConnectionOptions,
        refreshLlmPresetOptions,
        refreshFields,
        refreshSummaries,
        destroy,
    };
}
