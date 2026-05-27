/**
 * Shared "preset help" button.
 *
 * Renders a small "?" icon next to a prompt-preset selector. Click opens a
 * popup that explains what kind of preset belongs in that slot. Two variants:
 *
 *   - `iteration` — for plugin / iteration-AI preset slots (CPA iter, memory
 *     graph recall/extract/iter, CardApp Studio iter, etc.). Recommends a
 *     clean preset and provides a one-click "import plugin-only.json" button
 *     that imports the bundled file and selects it in the caller's dropdown.
 *
 *   - `agent` — for agent preset slots (orchestrator Single / Director /
 *     Planner / Loop, search-tools Agent). Recommends an orchestrator-
 *     adapted RP preset (jailbreak + style preserved, format-forcing
 *     stripped), pointing the user at the preset assistant's
 *     "Adapt for orchestrator" mode.
 *
 * Plugin usage:
 *   import { renderPresetHelpButton } from '../preset-help.js';
 *   ... inside template ...
 *   <label for="my_preset">${i18n('My preset')}</label>${renderPresetHelpButton({ kind: 'iteration', targetSelectId: 'my_preset' })}
 *   <select id="my_preset"></select>
 *
 * The click handler is installed once at module load via jQuery event
 * delegation, so plugins don't need to call any init function — just import
 * this module (any usage of `renderPresetHelpButton` brings it in).
 */

import { POPUP_TYPE, POPUP_RESULT, Popup } from '../popup.js';
import { translate, getCurrentLocale } from '../i18n.js';
import { getContext } from '../st-context.js';

const PRESET_HELP_BUTTON_CLASS = 'luker-preset-help';
const PLUGIN_ONLY_PRESET_NAME = 'plugin-only';
const PLUGIN_ONLY_PRESET_URL = '/presets/plugin-only.json';
const DOCS_BASE = 'https://luker.cups.moe';

/**
 * Returns the agent-onboarding recipe URL for the active UI locale.
 * Falls back to the English (path-less) variant for anything outside
 * the two Chinese locales served by the docs site.
 */
function getAgentOnboardingDocUrl() {
    const locale = String(typeof getCurrentLocale === 'function' ? getCurrentLocale() : '').toLowerCase();
    if (locale.startsWith('zh-cn')) {
        return `${DOCS_BASE}/zh-CN/recipes/agent-onboarding.html`;
    }
    if (locale.startsWith('zh-tw') || locale.startsWith('zh-hk') || locale.startsWith('zh-mo')) {
        return `${DOCS_BASE}/zh-TW/recipes/agent-onboarding.html`;
    }
    return `${DOCS_BASE}/recipes/agent-onboarding.html`;
}

function escapeAttr(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    }[c]));
}

function t(s) {
    return translate(s);
}

/**
 * Returns the HTML for an inline "?" help button to place beside a preset
 * selector. The string is safe to interpolate into a template.
 *
 * @param {object} opts
 * @param {'iteration' | 'agent'} opts.kind
 * @param {string} [opts.targetSelectId] — id of the <select> the import
 *   button should populate + select when kind === 'iteration'. Optional for
 *   `agent` (no action button).
 * @returns {string}
 */
export function renderPresetHelpButton({ kind, targetSelectId = '' }) {
    const tooltip = kind === 'agent'
        ? t('What preset should I use for the Agent?')
        : t('What preset should I use here?');
    return `<button type="button" class="${PRESET_HELP_BUTTON_CLASS}" data-luker-preset-help-kind="${escapeAttr(kind)}" data-luker-preset-help-for="${escapeAttr(targetSelectId)}" title="${escapeAttr(tooltip)}" aria-label="${escapeAttr(tooltip)}"><i class="fa-solid fa-circle-question"></i></button>`;
}

function buildIterationHelpHtml() {
    return `
        <div class="luker-preset-help-body">
            <p>${escapeAttr(t('This selector is for the preset the plugin uses to do its own work — editing configs, editing schemas, extracting facts, building recall queries, etc. It is NOT for drafting RP content.'))}</p>
            <p>${escapeAttr(t('A clean preset works best here: one that contains only jailbreak / general unblock prompts, with no RP style instructions, character voice, or narrative format requirements.'))}</p>
            <p>${escapeAttr(t('Why? RP presets often force an output format (mandatory schema blocks, forced thinking chains) that conflicts with the structured tool calls these plugins use. Style instructions can also leak into config edits and produce odd results.'))}</p>
            <p><strong>${escapeAttr(t('Two ways to get a clean preset:'))}</strong></p>
            <ul>
                <li>${escapeAttr(t('Click "Import plugin-only preset" below — imports a pre-built clean preset bundled with Luker, then selects it here.'))}</li>
                <li>${escapeAttr(t('Open the Completion Preset Assistant and start a new session in "Jailbreak-only" mode — it will derive a clean version from your existing RP preset. Your original preset stays untouched.'))}</li>
            </ul>
        </div>`;
}

function buildAgentHelpHtml() {
    const recipeUrl = getAgentOnboardingDocUrl();
    return `
        <div class="luker-preset-help-body">
            <p>${escapeAttr(t('This selector is for the preset an Agent uses to draft content. Unlike iteration-AI presets, the Agent SHOULD use your RP-style instructions — jailbreak, NSFW guidance, style/voice rules, anti-cliché instructions, etc.'))}</p>
            <p>${escapeAttr(t('But a raw daily RP preset is also not the right fit: instructions that force an output schema or a fixed thinking-chain format will block the agent\'s tool calls, and character/world-info that the agent framework already injects will get duplicated.'))}</p>
            <p>${escapeAttr(t('Recommended: derive an Agent-friendly preset from your RP preset. Open the Completion Preset Assistant, start a new session in "Adapt for orchestrator" mode, and ask it to convert. It will keep your style / jailbreak / anti-cliché instructions while disabling format-forcing prompts and duplicate injections. The original preset stays untouched.'))}</p>
            <p><a href="${escapeAttr(recipeUrl)}" target="_blank" rel="noopener noreferrer">${escapeAttr(t('For the full multi-Agent setup walkthrough, see the multi-Agent onboarding recipe in the documentation.'))}</a></p>
        </div>`;
}

async function importPluginOnlyPreset(targetSelectId) {
    const context = typeof getContext === 'function' ? getContext() : null;
    const manager = context?.getPresetManager?.('openai');
    if (!manager) {
        toastr.error(t('Preset manager unavailable.'));
        return false;
    }

    let existing = null;
    try {
        existing = manager.findPreset?.(PLUGIN_ONLY_PRESET_NAME);
    } catch (err) {
        console.warn('[preset-help] findPreset failed', err);
        existing = null;
    }

    let shouldDownload = true;
    if (existing) {
        // Same-name preset already exists. Prompt before overwriting — a
        // user may have customized their copy and an unconditional save
        // would silently clobber it (savePreset → persistPreset overwrites
        // the file on disk). Three outcomes:
        //   AFFIRMATIVE (Overwrite) → re-download bundled, save over existing
        //   NEGATIVE   (Keep)       → skip save, just select the existing one
        //   CANCELLED  (Esc)        → abort the whole action
        const confirmPopup = new Popup(
            escapeAttr(t('A preset named "plugin-only" already exists. Overwrite it with the bundled version, or keep your existing copy and just select it?')),
            POPUP_TYPE.CONFIRM,
            '',
            {
                okButton: t('Overwrite with bundled version'),
                cancelButton: t('Keep existing'),
            },
        );
        const choice = await confirmPopup.show();
        if (choice === POPUP_RESULT.CANCELLED) {
            return false;
        }
        shouldDownload = (choice === POPUP_RESULT.AFFIRMATIVE);
    }

    if (shouldDownload) {
        let data;
        try {
            const response = await fetch(PLUGIN_ONLY_PRESET_URL);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            data = await response.json();
        } catch (err) {
            console.error('[preset-help] Failed to download plugin-only.json', err);
            toastr.error(t('Failed to download the plugin-only preset.'));
            return false;
        }
        try {
            if (data && typeof data === 'object') {
                data.name = PLUGIN_ONLY_PRESET_NAME;
            }
            await manager.savePreset(PLUGIN_ONLY_PRESET_NAME, data);
            toastr.success(existing
                ? t('Overwrote preset: plugin-only')
                : t('Imported preset: plugin-only'));
        } catch (err) {
            console.error('[preset-help] Failed to save plugin-only preset', err);
            toastr.error(t('Failed to save the plugin-only preset.'));
            return false;
        }
    } else {
        toastr.info(t('Selecting your existing "plugin-only" preset.'));
    }

    if (targetSelectId) {
        const $select = $(`#${$.escapeSelector(targetSelectId)}`);
        if ($select.length) {
            const escapedValue = escapeAttr(PLUGIN_ONLY_PRESET_NAME);
            if ($select.find(`option[value="${escapedValue}"]`).length === 0) {
                $select.append(`<option value="${escapedValue}">${escapedValue}</option>`);
            }
            $select.val(PLUGIN_ONLY_PRESET_NAME).trigger('change');
        }
    }

    return true;
}

async function showIterationPopup(targetSelectId) {
    const popup = new Popup(buildIterationHelpHtml(), POPUP_TYPE.TEXT, '', {
        okButton: t('Close'),
        cancelButton: false,
        wider: true,
        customButtons: [{
            text: t('Import plugin-only preset'),
            icon: 'fa-download',
            result: 2,
            action: async () => {
                await importPluginOnlyPreset(targetSelectId);
            },
            appendAtEnd: true,
        }],
    });
    await popup.show();
}

async function showAgentPopup() {
    const popup = new Popup(buildAgentHelpHtml(), POPUP_TYPE.TEXT, '', {
        okButton: t('Got it'),
        cancelButton: false,
        wider: true,
    });
    await popup.show();
}

let handlersInstalled = false;
function installHandlersOnce() {
    if (handlersInstalled) return;
    if (typeof window === 'undefined' || typeof window.jQuery === 'undefined') return;
    handlersInstalled = true;
    window.jQuery(document).on('click.lukerPresetHelp', `.${PRESET_HELP_BUTTON_CLASS}`, async function (e) {
        e.preventDefault();
        e.stopPropagation();
        const $btn = window.jQuery(this);
        const kind = String($btn.attr('data-luker-preset-help-kind') || '');
        const targetSelectId = String($btn.attr('data-luker-preset-help-for') || '');
        try {
            if (kind === 'agent') {
                await showAgentPopup();
            } else {
                await showIterationPopup(targetSelectId);
            }
        } catch (err) {
            console.error('[preset-help] handler failed', err);
        }
    });
}

installHandlersOnce();
