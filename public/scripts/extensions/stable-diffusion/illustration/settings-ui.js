import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { t } from '../../../i18n.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { clamp } from '../../../utils.js';
import {
    ILLUSTRATION_NUMBER_RULES,
    addPresetFromCurrent,
    deletePreset,
    getPresetById,
    selectPreset,
    updatePreset,
} from './settings.js';

const CONTAINER_ID = 'sd_illustration_container';

function currentPreset(settings) {
    return getPresetById(settings, settings.currentPresetId);
}

function escapeOption(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function initSettingsUi({ settings, saveSettings, context, onEnabledChange }) {
    if (document.getElementById(CONTAINER_ID)) {
        return;
    }

    const html = await renderExtensionTemplateAsync('stable-diffusion', 'illustration-settings');
    $('#sd_container').append(html);

    const presetSelect = $('#sd_illustration_preset');
    const promptField = $('#sd_illustration_prompt');
    const studioField = $('#sd_illustration_studio_prompt');
    const apiPresetSelect = $('#sd_illustration_api_preset');
    const llmPresetSelect = $('#sd_illustration_llm_preset');

    const refreshFields = () => {
        const preset = currentPreset(settings);
        const disabled = !preset;
        promptField.prop('disabled', disabled);
        studioField.prop('disabled', disabled);
        apiPresetSelect.prop('disabled', disabled);
        llmPresetSelect.prop('disabled', disabled);
        promptField.val(preset?.illustrationPrompt || '');
        studioField.val(preset?.studioPrompt || '');
        apiPresetSelect.val(preset?.llm?.apiPresetName || '');
        llmPresetSelect.val(preset?.llm?.llmPresetName || '');
    };

    const refreshPresetOptions = () => {
        const options = settings.presets.map(preset => `<option value="${escapeOption(preset.id)}">${escapeOption(preset.name)}</option>`);
        presetSelect.html(options.join('') || `<option value="">${escapeOption(t`No presets`)}</option>`);
        presetSelect.val(settings.currentPresetId);
        refreshFields();
    };

    const refreshConnectionOptions = () => {
        const selected = currentPreset(settings)?.llm?.apiPresetName || '';
        const profiles = context.connectionProfiles?.list?.() || [];
        const names = profiles.map(profile => profile.name);
        const options = [`<option value="">${escapeOption(t`(Current API config)`)}</option>`];
        for (const name of names) {
            options.push(`<option value="${escapeOption(name)}">${escapeOption(name)}</option>`);
        }
        if (selected && !names.includes(selected)) {
            options.push(`<option value="${escapeOption(selected)}">${escapeOption(selected)} ${escapeOption(t`(missing)`)}</option>`);
        }
        apiPresetSelect.html(options.join('')).val(selected);
    };

    const refreshLlmPresetOptions = () => {
        const selected = currentPreset(settings)?.llm?.llmPresetName || '';
        const manager = context.getPresetManager?.('openai');
        const presets = Array.isArray(manager?.getAllPresets?.()) ? manager.getAllPresets() : [];
        const names = [...new Set(presets.map(name => String(name || '').trim()).filter(Boolean))];
        const options = [`<option value="">${escapeOption(t`(Current preset)`)}</option>`];
        for (const name of names) {
            options.push(`<option value="${escapeOption(name)}">${escapeOption(name)}</option>`);
        }
        if (selected && !names.includes(selected)) {
            options.push(`<option value="${escapeOption(selected)}">${escapeOption(selected)} ${escapeOption(t`(missing)`)}</option>`);
        }
        llmPresetSelect.html(options.join('')).val(selected);
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

    $('#sd_illustration_preset_new').on('click', () => {
        const template = currentPreset(settings);
        const name = t`Copy of ${template?.name || t`Preset`}`;
        const preset = addPresetFromCurrent(settings, {
            name,
            llm: template?.llm || {},
            now: Date.now(),
        });
        selectPreset(settings, preset.id);
        saveSettings();
        refreshPresetOptions();
        refreshConnectionOptions();
        refreshLlmPresetOptions();
    });

    $('#sd_illustration_preset_rename').on('click', async () => {
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

    $(document).on('click', `#${CONTAINER_ID} .inline-drawer-toggle`, () => {
        refreshConnectionOptions();
        refreshLlmPresetOptions();
    });

    return {
        refreshPresetOptions,
        refreshConnectionOptions,
        refreshLlmPresetOptions,
        refreshFields,
    };
}
