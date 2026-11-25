import { importPresetExample, openPresetDerivation, PRESET_EXAMPLES } from '../../lens-shared/preset-examples.js';
import { normalizeToolCallRetryMax } from '../../lib/iter-tool-calling.js';
import { mountBehaviorSummary } from '../../lens-shared/behavior-summary.js';
import { buildCeaSummaryModel } from './behavior-summary-model.js';

const CEA_SUMMARY_FIELDS = Object.freeze({
    requestApiPresetName: '#cea_sync_api_preset',
    requestLlmPresetName: '#cea_sync_llm_preset',
    toolCallRetryMax: '#cea_tool_retries',
});

export function createCharacterEditorUi(deps) {
    const {
        STYLE_ID,
        UI_BLOCK_ID,
        defaultSettings,
        escapeHtml,
        getContext,
        getSettings,
        i18n,
        openCharacterEditorPopup,
        refreshPresetSelectors,
        saveSettingsDebounced,
    } = deps;

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
#${UI_BLOCK_ID} .cea_row { display:flex; gap:8px; align-items:center; margin:6px 0; flex-wrap:wrap; }
#${UI_BLOCK_ID} .cea_preset_actions { margin:4px 0 8px; }
`;
        document.head.append(style);
    }

    function ensureUi() {
        const host = jQuery('#extensions_settings2');
        if (!host.length) {
            return;
        }

        ensureStyles();
        if (jQuery(`#${UI_BLOCK_ID}`).length) {
            bindUi();
            return;
        }

        const html = `
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${escapeHtml(i18n('Character Editor Assistant'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="cea_row">
                <div class="menu_button" id="cea_open_editor_popup">${escapeHtml(i18n('Open Editor'))}</div>
                <div class="menu_button" id="cea_open_cardapp_studio"><i class="fa-solid fa-code"></i> ${escapeHtml(i18n('CardApp Studio'))}</div>
            </div>
            <label for="cea_sync_llm_preset">${escapeHtml(i18n('Iteration AI prompt preset (params + prompt)'))}</label>
            <select id="cea_sync_llm_preset" class="text_pole"></select>
            <div class="cea_row cea_preset_actions">
                <div class="menu_button menu_button_small" id="cea_import_preset_example">${escapeHtml(i18n('Import example'))}</div>
                <div class="menu_button menu_button_small" id="cea_derive_preset">${escapeHtml(i18n('Derive from an existing preset'))}</div>
            </div>
            <label for="cea_sync_api_preset">${escapeHtml(i18n('Iteration AI API preset (Connection profile)'))}</label>
            <select id="cea_sync_api_preset" class="text_pole"></select>
            <label for="cea_tool_retries">${escapeHtml(i18n('Tool-call retries on invalid/missing tool call (N)'))}</label>
            <input id="cea_tool_retries" class="text_pole" type="number" min="0" step="1"/>

            <details class="cea_prompt_overrides">
                <summary>${escapeHtml(i18n('Custom System Prompts (advanced)'))}</summary>
                <label for="cea_editor_system_prompt">${escapeHtml(i18n('Editor iteration prompt'))}</label>
                <textarea id="cea_editor_system_prompt" class="text_pole textarea_compact" rows="8"></textarea>
                <div class="cea_row">
                    <div class="menu_button" id="cea_reset_editor_system_prompt">${escapeHtml(i18n('Reset to default'))}</div>
                </div>
                <label for="cea_cardapp_studio_system_prompt">${escapeHtml(i18n('CardApp Studio prompt'))}</label>
                <textarea id="cea_cardapp_studio_system_prompt" class="text_pole textarea_compact" rows="8"></textarea>
                <div class="cea_row">
                    <div class="menu_button" id="cea_reset_cardapp_studio_system_prompt">${escapeHtml(i18n('Reset to default'))}</div>
                </div>
            </details>
        </div>
    </div>
</div>`;

        host.append(html);
        bindUi();
    }

    let summaryHandle = null;

    function readSummaryState(rootEl) {
        const settings = getSettings();
        const readValue = (selector, fallback) => {
            const el = rootEl.querySelector(selector);
            return el ? String(el.value ?? '') : String(fallback ?? '');
        };
        return {
            requestApiPresetName: readValue('#cea_sync_api_preset', settings.requestApiPresetName),
            requestLlmPresetName: readValue('#cea_sync_llm_preset', settings.requestLlmPresetName),
            toolCallRetryMax: readValue('#cea_tool_retries', settings.toolCallRetryMax ?? defaultSettings.toolCallRetryMax),
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
        const anchor = rootEl.querySelector('.inline-drawer-content > .cea_row');
        if (!anchor) {
            return;
        }
        summaryHandle = mountBehaviorSummary({
            id: 'cea-settings-summary',
            root: rootEl,
            anchor,
            position: 'after',
            fields: CEA_SUMMARY_FIELDS,
            ariaLabel: i18n('Character Editor Assistant behavior summary'),
            readState: readSummaryState,
            build: buildCeaSummaryModel,
        });
    }
    async function refreshUiState(context = getContext()) {
        const root = jQuery(`#${UI_BLOCK_ID}`);
        if (!root.length) {
            return;
        }
        const settings = getSettings();
        // Every settings save from anywhere refreshes this panel; the field
        // the user is editing keeps its uncommitted value.
        const setUnlessFocused = (selector, value) => {
            const field = root.find(selector);
            if (field.length && field[0] !== document.activeElement) {
                field.val(value);
            }
        };
        setUnlessFocused('#cea_tool_retries', String(settings.toolCallRetryMax ?? defaultSettings.toolCallRetryMax));
        setUnlessFocused('#cea_editor_system_prompt', String(settings.editorIterationSystemPrompt || ''));
        setUnlessFocused('#cea_cardapp_studio_system_prompt', String(settings.cardAppStudioSystemPrompt || ''));
        refreshPresetSelectors(root, context, settings);
        summaryHandle?.refresh?.();
    }

    function bindUi() {
        const root = jQuery(`#${UI_BLOCK_ID}`);
        if (!root.length) {
            return;
        }

        root.off('.cea');

        root.on('click.cea', '#cea_import_preset_example', async () => {
            try {
                const ok = await importPresetExample(PRESET_EXAMPLES.pluginOnly);
                if (!ok) return;
                const settings = getSettings();
                settings.requestLlmPresetName = PRESET_EXAMPLES.pluginOnly;
                saveSettingsDebounced();
                refreshPresetSelectors(root, getContext(), settings);
                summaryHandle?.refresh?.();
            } catch (err) {
                toastr.error(String(err?.message || err));
            }
        });

        root.on('click.cea', '#cea_derive_preset', async () => {
            try {
                await openPresetDerivation('jailbreak-only');
            } catch (err) {
                toastr.error(String(err?.message || err));
            }
        });

        root.on('change.cea', '#cea_sync_llm_preset', function () {
            const settings = getSettings();
            settings.requestLlmPresetName = String(jQuery(this).val() || '').trim();
            saveSettingsDebounced();
        });

        root.on('change.cea', '#cea_sync_api_preset', function () {
            const settings = getSettings();
            settings.requestApiPresetName = String(jQuery(this).val() || '').trim();
            saveSettingsDebounced();
        });

        root.on('change.cea', '#cea_tool_retries', function () {
            const settings = getSettings();
            settings.toolCallRetryMax = normalizeToolCallRetryMax(jQuery(this).val(), 0);
            saveSettingsDebounced();
        });

        root.on('input.cea change.cea', '#cea_editor_system_prompt', function () {
            const settings = getSettings();
            settings.editorIterationSystemPrompt = String(jQuery(this).val() || '');
            saveSettingsDebounced();
        });

        root.on('input.cea change.cea', '#cea_cardapp_studio_system_prompt', function () {
            const settings = getSettings();
            settings.cardAppStudioSystemPrompt = String(jQuery(this).val() || '');
            saveSettingsDebounced();
        });

        root.on('click.cea', '#cea_reset_editor_system_prompt', function () {
            const settings = getSettings();
            settings.editorIterationSystemPrompt = defaultSettings.editorIterationSystemPrompt;
            root.find('#cea_editor_system_prompt').val(defaultSettings.editorIterationSystemPrompt);
            saveSettingsDebounced();
        });

        root.on('click.cea', '#cea_reset_cardapp_studio_system_prompt', function () {
            const settings = getSettings();
            settings.cardAppStudioSystemPrompt = defaultSettings.cardAppStudioSystemPrompt;
            root.find('#cea_cardapp_studio_system_prompt').val(defaultSettings.cardAppStudioSystemPrompt);
            saveSettingsDebounced();
        });

        root.on('click.cea', '#cea_open_editor_popup', async function () {
            await openCharacterEditorPopup(getContext());
        });

        root.on('click.cea', '#cea_open_cardapp_studio', async function () {
            const context = getContext();
            const cardAppApi = context.getExtensionApi('card-app');
            const charId = cardAppApi?.getCharId?.();
            if (!charId) {
                toastr.warning(i18n('No character selected or character has no avatar.'));
                return;
            }
            try {
                const { openCardAppStudio } = await import('./studio/studio.js');
                await openCardAppStudio(charId);
            } catch (err) {
                console.error('[CEA] Failed to open CardApp Studio:', err);
                toastr.error(String(err?.message || err));
            }
        });

        mountSummary(root);
    }

    return {
        ensureUi,
        refreshUiState,
    };
}
