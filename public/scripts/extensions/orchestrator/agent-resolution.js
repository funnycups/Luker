/**
 * Agent / preset / connection-profile resolution for the orchestrator.
 *
 * The orchestrator decides at runtime which connection profile (Chat
 * Completion API config) and which prompt preset to use for each
 * planner / worker / review node. This module owns the pure helpers for
 * that resolution layer:
 *
 *   - Connection-profile listing + sanitization (`getConnectionProfiles`,
 *     `sanitizeConnectionProfileName`, `sanitizeConnectionProfilesForAiPrompt`)
 *   - OpenAI preset listing (`getOpenAIPresetNames`, `sanitizeOpenAIPresetNamesForAiPrompt`)
 *   - Per-preset name extractors (`getPresetApiPresetName`,
 *     `getPresetPromptPresetName`, plus the matching string sanitizers)
 *   - Resolution entry points (`resolveOrchestrationAgentApiPresetName`,
 *     `resolveOrchestrationAgentPromptPresetName`) that fall back to
 *     `settings.llmNodeApiPresetName` / `settings.llmNodePresetName` when
 *     the per-preset values are empty. Both return
 *     `{name, preset, origin}` records (or `null` when nothing is
 *     configured); `origin` is `'card'` for card-embedded matches,
 *     `'global'` for local-global matches, and `null` when the name is
 *     unknown to both sets (in which case `name` is preserved for
 *     display and `preset` is `null`). Callers that only need the name
 *     pass `resolved?.name || ''` straight into
 *     `context.generateTask({ apiPresetName, llmPresetName })`, which
 *     owns connection-profile resolution. `preset` / `origin` are exposed
 *     so downstream code (e.g. the Save To Character Override summary
 *     popup that flags unembedded preset references) can distinguish
 *     card-embedded vs local-global vs unknown references without
 *     another round trip. Both entry points delegate to the pure
 *     `resolveCardFirstPresetName` helper in `agent-preset-resolver.js`
 *     — that same helper is what director-runtime / director-tools
 *     call so all three orchestrator modes share one resolution path.
 *   - AI-build routing prompt builders (`buildAgentApiRoutingPromptData`,
 *     `buildAgentPromptPresetRoutingPromptData`) that surface the available
 *     profiles + global defaults to the AI builder so it can pick a route
 *   - `<select>` option renderers (`renderConnectionProfileOptions`,
 *     `renderOpenAIPresetOptions`) and the `refreshOpenAIPresetSelectors`
 *     DOM helper used by the editor popup to repopulate selects when
 *     settings change
 *
 * The async `resolveOrchestrationRuntimeWorldInfo` lives here too — it
 * pre-resolves the runtime world-info snapshot once per dispatch so
 * callers can pass the same object to every retry of `generateTask`
 * without re-simulating world info each attempt.
 *
 * `escapeHtml` is duplicated as a private helper to keep this module
 * portable. main.js owns the canonical copy; both will collapse into a
 * shared `html-utils.js` helper if/when more modules want it.
 */

const extension_settings = Luker.getContext().extensionSettings;
import { getChatCompletionConnectionProfiles } from '../connection-manager/profile-resolver.js';
import { throwIfAborted } from './abort-utils.js';
import { i18n } from './i18n.js';
import { resolveCardFirstPresetName } from './agent-preset-resolver.js';
import {
    hasEffectiveRuntimeWorldInfo,
    normalizeRuntimeWorldInfo,
    normalizeWorldInfoResolverMessages,
    rewriteDepthWorldInfoToAfter,
} from './world-info.js';

// Character-bound preset access is routed through the ctx layer
// (`Luker.getContext().character.presets.*`, wired in st-context.js).
// Direct imports from `/scripts/character/presets.js` cannot be used
// here — that module pulls in `/scripts/st-context.js` →
// `RossAscends-mods.js` → Bowser, which is absent from the Jest lib
// bundle and would break every orchestrator suite that transitively
// imports this module (agenda-profile, editable-spec, editor-persist-
// presets, …).  The ctx layer is the same three-layer surface used by
// third-party extensions (per feedback_api_layered_exposure), so
// consuming it here also proves the surface out.
function getLukerContext() {
    return (typeof Luker !== 'undefined') ? Luker.getContext() : null;
}
function getActiveCharacter(override = null) {
    if (override) return override;
    const ctx = getLukerContext();
    return ctx?.characters?.[ctx?.characterId] ?? null;
}
function listCardBoundPresets(character) {
    const list = getLukerContext()?.character?.presets?.list;
    if (typeof list !== 'function' || !character) return [];
    const result = list(character);
    return Array.isArray(result) ? result : [];
}

const MODULE_NAME = 'orchestrator';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

export function getOpenAIPresetNames(context) {
    const manager = context?.getPresetManager?.('openai');
    if (!manager || typeof manager.getAllPresets !== 'function') {
        return [];
    }
    const names = manager.getAllPresets();
    if (!Array.isArray(names)) {
        return [];
    }
    return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
}

export function renderOpenAIPresetOptions(context, selectedName = '', emptyLabel = i18n('(Current preset)')) {
    const selected = String(selectedName || '').trim();
    const globalNames = getOpenAIPresetNames(context);
    const character = context?.characters?.[context?.characterId];
    const cardList = character ? listCardBoundPresets(character) : [];

    // Group card-bound presets under a dedicated <optgroup> above the
    // local global list.  When the same name exists in both, mark only
    // ONE <option selected> (browsers select the last `selected` in DOM
    // order otherwise) and prefer the card-bound entry so the visual
    // selection matches the card-first resolve rule used at generation
    // time.
    const cardHasSelected = selected && cardList.some(p => p.name === selected);

    // getOpenAIPresetNames reads from the main preset selector's DOM,
    // which includes the card-bound ghost options prepended at chat load
    // (see openai.js:upsertCharacterBoundRuntimeOptions). Dropping those
    // names from the "Local global" optgroup keeps the two groups mutually
    // exclusive — otherwise a card-embedded preset appears twice in this
    // selector (once under Card-bound, once under Local global).
    const cardNameSet = new Set(cardList.map(p => p.name));
    const localOnlyNames = globalNames.filter(name => !cardNameSet.has(name));

    const options = [`<option value="">${escapeHtml(String(emptyLabel || i18n('(Current preset)')))}</option>`];

    if (cardList.length > 0) {
        const cardOptionsHtml = cardList.map((p) => {
            const isSelected = cardHasSelected && p.name === selected;
            const label = p.isDefault ? `${p.name} (${i18n('Default')})` : p.name;
            return `<option value="${escapeHtml(p.name)}"${isSelected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('');
        options.push(`<optgroup label="${escapeHtml(i18n('Card-bound'))}">${cardOptionsHtml}</optgroup>`);
    }

    if (localOnlyNames.length > 0) {
        const globalOptionsHtml = localOnlyNames.map((name) => {
            const isSelected = !cardHasSelected && name === selected;
            return `<option value="${escapeHtml(name)}"${isSelected ? ' selected' : ''}>${escapeHtml(name)}</option>`;
        }).join('');
        options.push(`<optgroup label="${escapeHtml(i18n('Local global'))}">${globalOptionsHtml}</optgroup>`);
    }

    if (selected && !cardHasSelected && !localOnlyNames.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

export function getConnectionProfiles() {
    return getChatCompletionConnectionProfiles();
}

export function sanitizeConnectionProfileName(value = '') {
    return String(value || '').trim();
}

export function getPresetApiPresetName(preset = null) {
    return sanitizeConnectionProfileName(
        preset?.apiPresetName
        ?? preset?.apiPreset
        ?? preset?.agentApiPresetName
        ?? '',
    );
}

export function sanitizePromptPresetName(value = '') {
    return String(value || '').trim();
}

export function getPresetPromptPresetName(preset = null) {
    return sanitizePromptPresetName(
        preset?.promptPresetName
        ?? preset?.llmPresetName
        ?? preset?.chatCompletionPresetName
        ?? preset?.openAIPresetName
        ?? preset?.agentPromptPresetName
        ?? '',
    );
}

export function sanitizeConnectionProfilesForAiPrompt(profiles = getConnectionProfiles()) {
    return (Array.isArray(profiles) ? profiles : [])
        .map((profile) => {
            const name = sanitizeConnectionProfileName(profile?.name);
            if (!name) {
                return null;
            }
            return {
                name,
                api: String(profile?.api || '').trim(),
                model: String(profile?.model || '').trim(),
            };
        })
        .filter(Boolean);
}

/**
 * Return chat-completion preset names available to the AI builder,
 * split by origin so the builder can reason about scope:
 *
 *   - `local_global` — names in the user's global preset library.
 *     Persist across chats and characters. Safe to reference from any
 *     agent profile.
 *   - `card_bound` — names embedded on the currently active character
 *     card only. Travel with the card on export; resolve to the card
 *     copy at runtime (card wins over a same-named local global).
 *     Referencing one of these names from a profile intended for a
 *     different card will fail to resolve on that card.
 *
 * `getOpenAIPresetNames` reads the flat DOM which includes card-bound
 * ghost options (see openai.js:upsertCharacterBoundRuntimeOptions),
 * so we subtract the card set to derive the local-global-only list —
 * mirrors the split used by `renderOpenAIPresetOptions` and the
 * `getLocalPresetNames` helper in manage-bound-presets-dialog.js.
 *
 * @param {object} context Luker context
 * @returns {{local_global: string[], card_bound: string[]}}
 */
export function sanitizeOpenAIPresetNamesForAiPrompt(context) {
    const flatNames = getOpenAIPresetNames(context);
    const character = context?.characters?.[context?.characterId];
    const cardList = character ? listCardBoundPresets(character) : [];
    const cardBoundNames = [...new Set(cardList.map(p => String(p?.name || '').trim()).filter(Boolean))];
    const cardNameSet = new Set(cardBoundNames);
    const localGlobalNames = flatNames.filter(name => !cardNameSet.has(name));
    return { local_global: localGlobalNames, card_bound: cardBoundNames };
}

export function buildAgentApiRoutingPromptData(settings = extension_settings[MODULE_NAME]) {
    return {
        global_orchestration_api_preset: sanitizeConnectionProfileName(settings?.llmNodeApiPresetName || ''),
        empty_value_behavior: 'Empty apiPresetName falls back to the global orchestration API preset. If that is also empty, runtime uses the current chat API configuration.',
        default_policy: 'Do not set planner/agent apiPresetName unless the user explicitly asks for a specific provider/model route for that planner or agent.',
        available_connection_profiles: sanitizeConnectionProfilesForAiPrompt(getConnectionProfiles()),
    };
}

export function buildAgentPromptPresetRoutingPromptData(context, settings = extension_settings[MODULE_NAME]) {
    const split = sanitizeOpenAIPresetNamesForAiPrompt(context);
    return {
        global_orchestration_prompt_preset: sanitizePromptPresetName(settings?.llmNodePresetName || ''),
        empty_value_behavior: 'Empty promptPresetName falls back to the global orchestration chat completion preset. If that is also empty, runtime uses the current chat completion preset configuration.',
        default_policy: 'Do not set planner/agent promptPresetName unless the user explicitly asks for a specific chat completion preset route for that planner or agent.',
        // Split by origin so the AI can reason about scope. Card-bound
        // names only resolve on the currently active character card and
        // travel with the card on export; local-global names live in the
        // user's preset library and are safe to reference from any card.
        available_local_global_chat_completion_presets: split.local_global,
        available_card_bound_chat_completion_presets: split.card_bound,
    };
}

/**
 * Resolve the API connection profile name an agent should use.
 *
 * For orchestrator agent binding, name resolution is card-first:
 *   1. If the agent's preset object carries an explicit apiPresetName,
 *      look it up on the active card; card-bound match wins over a
 *      same-name local global preset.
 *   2. Otherwise fall back to `settings.llmNodeApiPresetName`.
 *
 * Return shape mirrors `resolveCharacterBoundPresetByName`:
 *   `{ name, preset, origin: 'card' | 'global' | null } | null`
 *
 * `origin: null` marks names that are known to NEITHER the card nor the
 * local global set — the raw name is preserved so callers can surface a
 * "(missing)" hint downstream, and the null tag prevents classifiers
 * (e.g. the Save-to-Character unembedded-preset detector) from misreading
 * an unknown reference as a local-global one.
 *
 * Callers that only need the name string do `resolved?.name || ''` —
 * `context.generateTask` accepts the empty string to mean "inherit
 * runtime defaults", so a null resolve stays backward-compatible.
 *
 * @param {object} settings orchestrator settings slot
 * @param {object|null} preset agent record with optional apiPresetName
 * @param {object|null} [characterOverride] override the active-character
 *        lookup (used by callers that resolve against a specific card,
 *        e.g. Save To Character Override detection)
 * @returns {{name: string, preset: object|null, origin: 'card'|'global'|null} | null}
 */
export function resolveOrchestrationAgentApiPresetName(settings, preset = null, characterOverride = null) {
    const character = getActiveCharacter(characterOverride);
    const resolveByName = getLukerContext()?.character?.presets?.resolveByName;
    return resolveCardFirstPresetName({
        explicitName: getPresetApiPresetName(preset),
        fallbackName: sanitizeConnectionProfileName(settings?.llmNodeApiPresetName || ''),
        character,
        resolveByName,
    });
}

/**
 * Same as `resolveOrchestrationAgentApiPresetName` for chat-completion
 * prompt presets — card-first resolution rooted at
 * `settings.llmNodePresetName` when the agent field is empty.
 *
 * @param {object} settings
 * @param {object|null} preset
 * @param {object|null} [characterOverride]
 * @returns {{name: string, preset: object|null, origin: 'card'|'global'|null} | null}
 */
export function resolveOrchestrationAgentPromptPresetName(settings, preset = null, characterOverride = null) {
    const character = getActiveCharacter(characterOverride);
    const resolveByName = getLukerContext()?.character?.presets?.resolveByName;
    return resolveCardFirstPresetName({
        explicitName: getPresetPromptPresetName(preset),
        fallbackName: sanitizePromptPresetName(settings?.llmNodePresetName || ''),
        character,
        resolveByName,
    });
}

export function renderConnectionProfileOptions(selectedName = '', emptyLabel = i18n('(Current API config)')) {
    const selected = sanitizeConnectionProfileName(selectedName);
    const names = getConnectionProfiles().map(profile => profile.name);
    const options = [`<option value="">${escapeHtml(String(emptyLabel || i18n('(Current API config)')))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

export function refreshOpenAIPresetSelectors(root, context, settings, prefix = '') {
    const selectorValues = [
        ['luker_orch_llm_api_preset', settings.llmNodeApiPresetName],
        ['luker_orch_llm_preset', settings.llmNodePresetName],
        ['luker_orch_request_api_preset', settings.requestApiPresetName],
        ['luker_orch_request_llm_preset', settings.requestLlmPresetName],
    ];

    for (const [baseId, value] of selectorValues) {
        const select = root.find(`#${prefix}${baseId}`);
        if (!select.length) {
            continue;
        }
        const isConnectionSelector = baseId.endsWith('_api_preset');
        select.html(isConnectionSelector ? renderConnectionProfileOptions(value) : renderOpenAIPresetOptions(context, value));
        select.val(String(value || '').trim());
    }
}

export async function resolveOrchestrationRuntimeWorldInfo(context, settings, {
    worldInfoMessages = null,
    runtimeWorldInfo = null,
    forceWorldInfoResimulate = false,
    worldInfoType = 'quiet',
    abortSignal = null,
} = {}) {
    const includeWorldInfoWithPreset = settings?.includeWorldInfoWithPreset !== false;
    if (!includeWorldInfoWithPreset) {
        return {};
    }
    throwIfAborted(abortSignal, 'Orchestration aborted.');
    if (!forceWorldInfoResimulate && hasEffectiveRuntimeWorldInfo(runtimeWorldInfo)) {
        return normalizeRuntimeWorldInfo(runtimeWorldInfo);
    }
    const resolverMessages = normalizeWorldInfoResolverMessages(worldInfoMessages);
    if (resolverMessages.length === 0 || typeof context?.resolveWorldInfoForMessages !== 'function') {
        return {};
    }
    const resolved = await context.resolveWorldInfoForMessages(resolverMessages, {
        type: String(worldInfoType || 'quiet'),
        fallbackToCurrentChat: false,
        postActivationHook: rewriteDepthWorldInfoToAfter,
    });
    throwIfAborted(abortSignal, 'Orchestration aborted.');
    return normalizeRuntimeWorldInfo(resolved);
}
