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
 *     Planner / Loop, search-tools Agent). The popup body and one-click
 *     "import bundled preset" action depend on `agentMode`:
 *       - `director`     — recommends `agent-director` (marker-free, story
 *                          context is injected by director itself)
 *       - `non-director` — recommends `agent-non-director` (marker-bearing,
 *                          mirrors plugin-only's RP/task separation)
 *       - `dynamic`      — popup reads `#luker_orch_execution_mode` at click
 *                          time and renders the matching variant. Used by
 *                          the orchestrator inline-drawer's global "LLM node
 *                          preset" slot, which is both single-mode's only
 *                          agent slot and the cross-mode fallback for
 *                          per-agent empties.
 *       - omitted        — legacy doc-link-only popup (back-compat)
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
const AGENT_DIRECTOR_PRESET_NAME = 'agent-director';
const AGENT_DIRECTOR_PRESET_URL = '/presets/agent-director.json';
const AGENT_NON_DIRECTOR_PRESET_NAME = 'agent-non-director';
const AGENT_NON_DIRECTOR_PRESET_URL = '/presets/agent-non-director.json';
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
 * @param {'director' | 'non-director' | 'dynamic'} [opts.agentMode] — only
 *   meaningful when kind === 'agent'. Picks which bundled example preset
 *   the popup offers to import. Omit for the legacy doc-link-only popup.
 * @param {string} [opts.targetSelectId] — id of the <select> the import
 *   button should populate + select. Optional for legacy `agent` popups
 *   (no action button); required for `iteration` and for any `agent`
 *   popup with an `agentMode`.
 * @returns {string}
 */
export function renderPresetHelpButton({ kind, agentMode = '', targetSelectId = '' }) {
    const tooltip = kind === 'agent'
        ? t('What preset should I use for the Agent?')
        : t('What preset should I use here?');
    const modeAttr = kind === 'agent' && agentMode
        ? ` data-luker-preset-help-agent-mode="${escapeAttr(agentMode)}"`
        : '';
    return `<button type="button" class="${PRESET_HELP_BUTTON_CLASS}" data-luker-preset-help-kind="${escapeAttr(kind)}"${modeAttr} data-luker-preset-help-for="${escapeAttr(targetSelectId)}" title="${escapeAttr(tooltip)}" aria-label="${escapeAttr(tooltip)}"><i class="fa-solid fa-circle-question"></i></button>`;
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

function buildAgentDirectorHelpHtml() {
    const recipeUrl = getAgentOnboardingDocUrl();
    return `
        <div class="luker-preset-help-body">
            <p>${escapeAttr(t('This selector is for the preset a Director-mode Agent uses (main agent or a sub-agent). Director already injects the full RP context (character card, persona, world info, chat history) inside a <story_context> envelope before the agent runs — so the agent\'s own preset does NOT need any character / world / persona placeholders. Adding them would only re-inject the same content twice and burn tokens.'))}</p>
            <p>${escapeAttr(t('What this slot SHOULD carry: jailbreak / content-permission instructions that wrap the <story_context> block, plus the chatHistory marker so the envelope lands in the right place. Style / voice / anti-cliché rules normally belong in the agent\'s system prompt, not here.'))}</p>
            <p><strong>${escapeAttr(t('Two ways to get a Director-friendly preset:'))}</strong></p>
            <ul>
                <li>${escapeAttr(t('Click "Import agent-director preset" below — imports a minimal Luker-bundled preset (marker-free, permission text only) and selects it here. Good as a quick start.'))}</li>
                <li>${escapeAttr(t('Open the Completion Preset Assistant and start a new session in "Adapt for orchestrator" mode — it will derive a Director-ready version from your existing RP preset, keeping your jailbreak / style / anti-cliché instructions while stripping format-forcing prompts and duplicate injections. Your original preset stays untouched.'))}</li>
            </ul>
            <p><a href="${escapeAttr(recipeUrl)}" target="_blank" rel="noopener noreferrer">${escapeAttr(t('For the full multi-Agent setup walkthrough, see the multi-Agent onboarding recipe in the documentation.'))}</a></p>
        </div>`;
}

function buildAgentNonDirectorHelpHtml() {
    const recipeUrl = getAgentOnboardingDocUrl();
    return `
        <div class="luker-preset-help-body">
            <p>${escapeAttr(t('This selector is for the preset a non-Director Agent uses (Single / Spec / Agenda planner / Loop). Unlike Director, these modes do NOT inject the RP context for the agent — so the agent\'s preset is the only path through which character card, persona, and world info reach the model. Markers (charDescription / personaDescription / worldInfoBefore / worldInfoAfter / chatHistory) must stay enabled, and the RP material should be visibly separated from the runtime task instructions so the agent does not mistake them for narrative continuation.'))}</p>
            <p>${escapeAttr(t('This is the same shape iteration-AI plugins (CPA iter / Memory Graph / CardApp Studio iter) need, just placed in an Agent slot. The bundled preset offered below is identical in structure to the iter-AI plugin-only preset.'))}</p>
            <p><strong>${escapeAttr(t('Two ways to get a non-Director-friendly preset:'))}</strong></p>
            <ul>
                <li>${escapeAttr(t('Click "Import agent-non-director preset" below — imports a Luker-bundled preset (markers enabled, story / user-request envelopes wrap the context) and selects it here. Good as a quick start.'))}</li>
                <li>${escapeAttr(t('Open the Completion Preset Assistant and start a new session in "Adapt for orchestrator" mode — it will derive a version from your existing RP preset that preserves your jailbreak / style / anti-cliché instructions while stripping format-forcing prompts. Your original preset stays untouched.'))}</li>
            </ul>
            <p><a href="${escapeAttr(recipeUrl)}" target="_blank" rel="noopener noreferrer">${escapeAttr(t('For the full multi-Agent setup walkthrough, see the multi-Agent onboarding recipe in the documentation.'))}</a></p>
        </div>`;
}

function buildLegacyAgentHelpHtml() {
    const recipeUrl = getAgentOnboardingDocUrl();
    return `
        <div class="luker-preset-help-body">
            <p>${escapeAttr(t('This selector is for the preset an Agent uses to draft content. Unlike iteration-AI presets, the Agent SHOULD use your RP-style instructions — jailbreak, NSFW guidance, style/voice rules, anti-cliché instructions, etc.'))}</p>
            <p>${escapeAttr(t('But a raw daily RP preset is also not the right fit: instructions that force an output schema or a fixed thinking-chain format will block the agent\'s tool calls, and character/world-info that the agent framework already injects will get duplicated.'))}</p>
            <p>${escapeAttr(t('Recommended: derive an Agent-friendly preset from your RP preset. Open the Completion Preset Assistant, start a new session in "Adapt for orchestrator" mode, and ask it to convert. It will keep your style / jailbreak / anti-cliché instructions while disabling format-forcing prompts and duplicate injections. The original preset stays untouched.'))}</p>
            <p><a href="${escapeAttr(recipeUrl)}" target="_blank" rel="noopener noreferrer">${escapeAttr(t('For the full multi-Agent setup walkthrough, see the multi-Agent onboarding recipe in the documentation.'))}</a></p>
        </div>`;
}

/**
 * Resolve the actually-effective agent mode at click time.
 * - 'director' / 'non-director' → returned as-is
 * - 'dynamic' → reads the orchestrator inline-drawer's execution mode
 *   selector and maps `director` → 'director', anything else → 'non-director'.
 *   When the selector is missing (e.g. used in a future caller that lives
 *   outside the orchestrator UI), falls back to 'non-director' as the
 *   safer-for-more-callers default.
 */
function resolveAgentMode(agentMode) {
    if (agentMode === 'director' || agentMode === 'non-director') return agentMode;
    if (agentMode === 'dynamic') {
        const $select = window.jQuery && window.jQuery('#luker_orch_execution_mode');
        const value = String($select && $select.length ? $select.val() || '' : '').trim();
        return value === 'director' ? 'director' : 'non-director';
    }
    return '';
}

async function importBundledPreset(presetName, presetUrl, target) {
    const context = typeof getContext === 'function' ? getContext() : null;
    const manager = context?.getPresetManager?.('openai');
    if (!manager) {
        toastr.error(t('Preset manager unavailable.'));
        return false;
    }

    let existing = null;
    try {
        existing = manager.findPreset?.(presetName);
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
            escapeAttr(t('A preset named "{name}" already exists. Overwrite it with the bundled version, or keep your existing copy and just select it?').replace('{name}', presetName)),
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
            const response = await fetch(presetUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            data = await response.json();
        } catch (err) {
            console.error(`[preset-help] Failed to download ${presetName}.json`, err);
            toastr.error(t('Failed to download the "{name}" preset.').replace('{name}', presetName));
            return false;
        }
        try {
            if (data && typeof data === 'object') {
                data.name = presetName;
            }
            await manager.savePreset(presetName, data);
            toastr.success((existing
                ? t('Overwrote preset: {name}')
                : t('Imported preset: {name}')).replace('{name}', presetName));
        } catch (err) {
            console.error(`[preset-help] Failed to save ${presetName} preset`, err);
            toastr.error(t('Failed to save the "{name}" preset.').replace('{name}', presetName));
            return false;
        }
    } else {
        toastr.info(t('Selecting your existing "{name}" preset.').replace('{name}', presetName));
    }

    // `target` may be either a string id (legacy callers pass
    // `targetSelectId`) or a jQuery object that already points at the
    // <select>. The DOM-walk fallback path used by callers that don't have
    // a stable id (orchestrator director main / sub-agent slots) goes
    // through the latter.
    let $select = null;
    if (target && typeof target === 'object' && typeof target.length === 'number') {
        $select = target;
    } else if (typeof target === 'string' && target) {
        $select = $(`#${$.escapeSelector(target)}`);
    }
    if ($select && $select.length) {
        const escapedValue = escapeAttr(presetName);
        if ($select.find(`option[value="${escapedValue}"]`).length === 0) {
            $select.append(`<option value="${escapedValue}">${escapedValue}</option>`);
        }
        $select.val(presetName).trigger('change');
    }

    return true;
}

async function showIterationPopup(target) {
    const popup = new Popup(buildIterationHelpHtml(), POPUP_TYPE.TEXT, '', {
        okButton: t('Close'),
        cancelButton: false,
        wider: true,
        customButtons: [{
            text: t('Import plugin-only preset'),
            icon: 'fa-download',
            result: 2,
            action: async () => {
                await importBundledPreset(PLUGIN_ONLY_PRESET_NAME, PLUGIN_ONLY_PRESET_URL, target);
            },
            appendAtEnd: true,
        }],
    });
    await popup.show();
}

async function showAgentDirectorPopup(target) {
    const popup = new Popup(buildAgentDirectorHelpHtml(), POPUP_TYPE.TEXT, '', {
        okButton: t('Close'),
        cancelButton: false,
        wider: true,
        customButtons: [{
            text: t('Import agent-director preset'),
            icon: 'fa-download',
            result: 2,
            action: async () => {
                await importBundledPreset(AGENT_DIRECTOR_PRESET_NAME, AGENT_DIRECTOR_PRESET_URL, target);
            },
            appendAtEnd: true,
        }],
    });
    await popup.show();
}

async function showAgentNonDirectorPopup(target) {
    const popup = new Popup(buildAgentNonDirectorHelpHtml(), POPUP_TYPE.TEXT, '', {
        okButton: t('Close'),
        cancelButton: false,
        wider: true,
        customButtons: [{
            text: t('Import agent-non-director preset'),
            icon: 'fa-download',
            result: 2,
            action: async () => {
                await importBundledPreset(AGENT_NON_DIRECTOR_PRESET_NAME, AGENT_NON_DIRECTOR_PRESET_URL, target);
            },
            appendAtEnd: true,
        }],
    });
    await popup.show();
}

async function showLegacyAgentPopup() {
    const popup = new Popup(buildLegacyAgentHelpHtml(), POPUP_TYPE.TEXT, '', {
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
        const agentMode = String($btn.attr('data-luker-preset-help-agent-mode') || '');
        const targetSelectId = String($btn.attr('data-luker-preset-help-for') || '');
        // Two ways the popup finds the target <select>:
        //   1. explicit id passed via data-luker-preset-help-for (preferred
        //      when the caller has a stable id; e.g. CPA iter, MG iter, the
        //      orchestrator inline-drawer slots, the agenda/loop preset
        //      slots).
        //   2. DOM walk — climb to the closest <label> and grab its sibling
        //      <select>. Used by callers whose <select> has no id (director
        //      main / sub-agent rows, which key off data-orch-* attributes).
        const target = targetSelectId
            ? targetSelectId
            : (function () {
                const $label = $btn.closest('label');
                if ($label.length === 0) return null;
                const $select = $label.find('select').first();
                return $select.length ? $select : null;
            })();
        try {
            if (kind === 'agent') {
                const resolved = resolveAgentMode(agentMode);
                if (resolved === 'director') {
                    await showAgentDirectorPopup(target);
                } else if (resolved === 'non-director') {
                    await showAgentNonDirectorPopup(target);
                } else {
                    await showLegacyAgentPopup();
                }
            } else {
                await showIterationPopup(target);
            }
        } catch (err) {
            console.error('[preset-help] handler failed', err);
        }
    });
}

installHandlersOnce();
