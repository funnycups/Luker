import { characters, saveSettingsDebounced, substituteParams, substituteParamsExtended, this_chid } from '../../../script.js';
import { extension_settings, writeExtensionField } from '../../extensions.js';
import { t } from '../../i18n.js';
import { getPresetManager } from '../../preset-manager.js';
import { regexFromString } from '../../utils.js';
import { lodash } from '../../../lib.js';
import { isRegexScriptPaused, recordRegexExecution, resetRegexScriptState } from './redos-reporter.js';

/**
 * @readonly
 * @enum {number} Regex scripts types
 */
export const SCRIPT_TYPES = {
    // ORDER MATTERS: defines the regex script priority
    GLOBAL: 0,
    PRESET: 2,
    SCOPED: 1,
};

/**
 * Special type for unknown/invalid script types.
 */
export const SCRIPT_TYPE_UNKNOWN = -1;

/**
 * @typedef {import('../../char-data.js').RegexScriptData} RegexScript
 */

/**
 * @typedef {object} GetRegexScriptsOptions
 * @property {boolean} allowedOnly Only return allowed scripts
 */

/**
 * @type {Readonly<GetRegexScriptsOptions>}
 */
const DEFAULT_GET_REGEX_SCRIPTS_OPTIONS = Object.freeze({ allowedOnly: false });
const REGEX_SCRIPT_TYPE_LABELS = Object.freeze({
    [SCRIPT_TYPES.GLOBAL]: 'global',
    [SCRIPT_TYPES.SCOPED]: 'scoped',
    [SCRIPT_TYPES.PRESET]: 'preset',
    [SCRIPT_TYPE_UNKNOWN]: 'unknown',
});
const warnedInvalidPlacementScripts = new Set();
let shownInvalidPlacementToast = false;
const pendingPersistedRegexScriptCleanups = new Set();

function isPersistedRegexScriptRecord(script) {
    return Boolean(script) && typeof script === 'object' && !Array.isArray(script);
}

function filterValidPersistedRegexScripts(scripts) {
    return Array.isArray(scripts) ? scripts.filter(isPersistedRegexScriptRecord) : [];
}

function getPersistedRegexScriptCleanupKey(scriptType) {
    switch (scriptType) {
        case SCRIPT_TYPES.GLOBAL:
            return 'global';
        case SCRIPT_TYPES.SCOPED:
            return `scoped:${String(characters?.[this_chid]?.avatar || '').trim()}`;
        case SCRIPT_TYPES.PRESET:
            return `preset:${String(getCurrentPresetAPI?.() || '').trim()}:${String(getCurrentPresetName?.() || '').trim()}`;
        default:
            return '';
    }
}

function getPersistedRegexScriptCleanupToastMessage(scriptType) {
    switch (scriptType) {
        case SCRIPT_TYPES.GLOBAL:
            return t`Global regex entries contained invalid data. Invalid entries were removed automatically. Check the browser console for details.`;
        case SCRIPT_TYPES.SCOPED:
            return t`Character-scoped regex entries contained invalid data. Invalid entries were removed automatically. Check the browser console for details.`;
        case SCRIPT_TYPES.PRESET:
            return t`Preset regex entries contained invalid data. Invalid entries were removed automatically. Check the browser console for details.`;
        default:
            return t`Some regex scripts contained invalid data. Invalid entries were removed automatically. Check the browser console for details.`;
    }
}

function schedulePersistedRegexScriptCleanup(scriptType, scripts) {
    const cleanupKey = getPersistedRegexScriptCleanupKey(scriptType);
    if (!cleanupKey || pendingPersistedRegexScriptCleanups.has(cleanupKey)) {
        return;
    }

    const nextScripts = structuredClone(filterValidPersistedRegexScripts(scripts));
    const targetChid = Number(this_chid);
    const targetPresetApiId = String(getCurrentPresetAPI?.() || '').trim();
    const targetPresetName = String(getCurrentPresetName?.() || '').trim();
    pendingPersistedRegexScriptCleanups.add(cleanupKey);

    if (typeof toastr !== 'undefined') {
        toastr.error(getPersistedRegexScriptCleanupToastMessage(scriptType), t`Regex script error`);
    }

    queueMicrotask(() => {
        void (async () => {
            try {
                switch (scriptType) {
                    case SCRIPT_TYPES.GLOBAL:
                        extension_settings.regex = nextScripts;
                        saveSettingsDebounced();
                        break;
                    case SCRIPT_TYPES.SCOPED: {
                        if (!Number.isInteger(targetChid)) {
                            return;
                        }
                        await writeExtensionField(targetChid, 'regex_scripts', nextScripts);
                        break;
                    }
                    case SCRIPT_TYPES.PRESET: {
                        if (!targetPresetApiId || !targetPresetName) {
                            return;
                        }
                        const presetManager = getPresetManager(targetPresetApiId);
                        if (!presetManager) {
                            return;
                        }
                        await presetManager.writePresetExtensionField({ name: targetPresetName, path: 'regex_scripts', value: nextScripts });
                        break;
                    }
                    default:
                        break;
                }
            } catch (error) {
                console.warn('[Regex] Failed to persist sanitized regex scripts', {
                    scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
                    cleanupKey,
                    error,
                });
            } finally {
                pendingPersistedRegexScriptCleanups.delete(cleanupKey);
            }
        })();
    });
}

function sanitizePersistedRegexScriptList(scripts, scriptType) {
    if (!Array.isArray(scripts)) {
        return [];
    }

    const invalidEntries = [];
    for (let index = scripts.length - 1; index >= 0; index--) {
        if (isPersistedRegexScriptRecord(scripts[index])) {
            continue;
        }
        invalidEntries.push({ index, type: scripts[index] === null ? 'null' : typeof scripts[index] });
        scripts.splice(index, 1);
    }

    if (invalidEntries.length > 0) {
        console.warn('[Regex] Removed invalid persisted regex entries', {
            scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
            invalidEntries,
        });
        schedulePersistedRegexScriptCleanup(scriptType, scripts);
    }

    return scripts;
}

function summarizeRegexScriptForLog(script) {
    if (!script || typeof script !== 'object') {
        return null;
    }

    return {
        id: String(script.id || ''),
        name: String(script.scriptName || ''),
        disabled: Boolean(script.disabled),
        placementCount: Array.isArray(script.placement) ? script.placement.length : 0,
        findRegexLength: String(script.findRegex || '').length,
        replaceLength: String(script.replaceString || '').length,
        promptOnly: Boolean(script.promptOnly),
        markdownOnly: Boolean(script.markdownOnly),
        pluginOnly: Boolean(script.pluginOnly),
        runOnEdit: Boolean(script.runOnEdit),
    };
}
/**
 * @typedef {object} RuntimeRegexProviderOptions
 * @property {boolean} [reloadOnChange=false] Request chat reload when provider is registered/unregistered.
 */

/**
 * @typedef {object} RuntimeRegexScriptsChangedOptions
 * @property {boolean} [requestReload=false]
 */

/**
 * @typedef {object} RuntimeRegexProviderRegistration
 * @property {string} owner
 * @property {(options?: RuntimeRegexScriptsChangedOptions) => void} refresh Notify listeners that provider output changed
 * @property {() => void} unregister Remove the provider registration
 */

/**
 * @typedef {RuntimeRegexProviderRegistration & {
 *   upsertScript: (script: RegexScript, options?: RuntimeRegexScriptsChangedOptions) => boolean,
 *   removeScript: (scriptId: string, options?: RuntimeRegexScriptsChangedOptions) => boolean,
 *   setScripts: (scripts: RegexScript[] | null | undefined, options?: RuntimeRegexScriptsChangedOptions) => void,
 *   clearScripts: (options?: RuntimeRegexScriptsChangedOptions) => void,
 *   getScripts: () => RegexScript[],
 * }} ManagedRuntimeRegexProviderRegistration
 */

/** @type {Map<string, { provider: (options?: GetRegexScriptsOptions) => RegexScript[] | null | undefined, reloadOnChange: boolean, managedScripts?: Map<string, RegexScript> }>} */
const runtimeRegexProviders = new Map();
export const REGEX_RUNTIME_SCRIPTS_CHANGED_EVENT = 'luker:regex-runtime-scripts-changed';

/**
 * @param {{ requestReload?: boolean }} [options]
 * @returns {void}
 */
export function notifyRuntimeRegexScriptsChanged(options = {}) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
        return;
    }
    if (typeof CustomEvent === 'undefined') {
        return;
    }
    window.dispatchEvent(new CustomEvent(REGEX_RUNTIME_SCRIPTS_CHANGED_EVENT, {
        detail: {
            requestReload: Boolean(options?.requestReload),
        },
    }));
}

/**
 * @param {string} ownerId
 * @param {{ provider: (options?: GetRegexScriptsOptions) => RegexScript[] | null | undefined, reloadOnChange: boolean, managedScripts?: Map<string, RegexScript> }} entry
 * @returns {RuntimeRegexProviderRegistration}
 */
function createRuntimeRegexProviderRegistration(ownerId, entry) {
    return {
        owner: ownerId,
        refresh(options = {}) {
            if (runtimeRegexProviders.get(ownerId) !== entry) {
                return;
            }
            notifyRuntimeRegexScriptsChanged({ requestReload: Boolean(options?.requestReload) });
        },
        unregister() {
            if (runtimeRegexProviders.get(ownerId) !== entry) {
                return;
            }
            if (entry.managedScripts instanceof Map) {
                for (const scriptId of entry.managedScripts.keys()) {
                    resetRegexScriptState(scriptId);
                }
            }
            runtimeRegexProviders.delete(ownerId);
            notifyRuntimeRegexScriptsChanged({ requestReload: entry.reloadOnChange });
        },
    };
}

/**
 * @param {RegexScript} script
 * @param {string} ownerId
 * @returns {RegexScript | null}
 */
function normalizeManagedRuntimeRegexScript(script, ownerId) {
    if (!script || typeof script !== 'object') {
        console.warn(`registerManagedRegexProvider: owner "${ownerId}" received a non-object script; skipped.`);
        return null;
    }
    const scriptId = String(script.id || '').trim();
    if (!scriptId) {
        console.warn(`registerManagedRegexProvider: owner "${ownerId}" received a script without id; skipped.`);
        return null;
    }
    const scriptName = String(script.scriptName || '').trim();
    if (!scriptName) {
        console.warn(`registerManagedRegexProvider: owner "${ownerId}" received a script without scriptName; skipped.`);
        return null;
    }
    return {
        ...script,
        id: scriptId,
        scriptName,
    };
}

/**
 * Creates and registers a managed runtime regex provider backed by engine-owned script storage.
 * This is useful for plugins that want `upsert/remove/set/clear` semantics instead of a pure callback provider.
 *
 * @param {string} owner Unique owner id, usually plugin/module name
 * @param {RuntimeRegexProviderOptions} [options] Provider options
 * @returns {ManagedRuntimeRegexProviderRegistration | null}
 */
export function registerManagedRegexProvider(owner, options = {}) {
    const ownerId = String(owner || '').trim();
    if (!ownerId) {
        console.warn('registerManagedRegexProvider: owner is empty');
        return null;
    }
    const reloadOnChange = Boolean(options?.reloadOnChange);
    const managedScripts = new Map();
    const entry = {
        managedScripts,
        reloadOnChange,
        provider() {
            return Array.from(managedScripts.values(), script => ({ ...script }));
        },
    };
    runtimeRegexProviders.set(ownerId, entry);
    notifyRuntimeRegexScriptsChanged({ requestReload: reloadOnChange });

    const baseRegistration = createRuntimeRegexProviderRegistration(ownerId, entry);
    return {
        ...baseRegistration,
        upsertScript(script, changeOptions = {}) {
            if (runtimeRegexProviders.get(ownerId) !== entry) {
                return false;
            }
            const normalizedScript = normalizeManagedRuntimeRegexScript(script, ownerId);
            if (!normalizedScript) {
                return false;
            }
            managedScripts.set(normalizedScript.id, normalizedScript);
            notifyRuntimeRegexScriptsChanged({ requestReload: Boolean(changeOptions?.requestReload) });
            return true;
        },
        removeScript(scriptId, changeOptions = {}) {
            if (runtimeRegexProviders.get(ownerId) !== entry) {
                return false;
            }
            const normalizedId = String(scriptId || '').trim();
            if (!normalizedId) {
                return false;
            }
            const removed = managedScripts.delete(normalizedId);
            if (removed) {
                resetRegexScriptState(normalizedId);
                notifyRuntimeRegexScriptsChanged({ requestReload: Boolean(changeOptions?.requestReload) });
            }
            return removed;
        },
        setScripts(scripts, changeOptions = {}) {
            if (runtimeRegexProviders.get(ownerId) !== entry) {
                return;
            }
            const nextManagedScripts = new Map();
            for (const script of Array.isArray(scripts) ? scripts : []) {
                const normalizedScript = normalizeManagedRuntimeRegexScript(script, ownerId);
                if (!normalizedScript) {
                    continue;
                }
                nextManagedScripts.set(normalizedScript.id, normalizedScript);
            }
            for (const oldId of managedScripts.keys()) {
                if (!nextManagedScripts.has(oldId)) {
                    resetRegexScriptState(oldId);
                }
            }
            managedScripts.clear();
            for (const [scriptId, normalizedScript] of nextManagedScripts.entries()) {
                managedScripts.set(scriptId, normalizedScript);
            }
            notifyRuntimeRegexScriptsChanged({ requestReload: Boolean(changeOptions?.requestReload) });
        },
        clearScripts(changeOptions = {}) {
            if (runtimeRegexProviders.get(ownerId) !== entry || managedScripts.size === 0) {
                return;
            }
            for (const scriptId of managedScripts.keys()) {
                resetRegexScriptState(scriptId);
            }
            managedScripts.clear();
            notifyRuntimeRegexScriptsChanged({ requestReload: Boolean(changeOptions?.requestReload) });
        },
        getScripts() {
            if (runtimeRegexProviders.get(ownerId) !== entry) {
                return [];
            }
            return Array.from(managedScripts.values(), script => ({ ...script }));
        },
    };
}

/**
 * Warns once per broken script when placement is not a valid array.
 * @param {RegexScript} script The broken regex script
 * @param {number} index Script index
 */
function warnInvalidRegexPlacement(script, index) {
    const scriptName = String(script?.scriptName || '').trim() || `<unnamed #${index}>`;
    const warningKey = `${scriptName}:${index}`;
    if (warnedInvalidPlacementScripts.has(warningKey)) {
        return;
    }
    warnedInvalidPlacementScripts.add(warningKey);
    console.error(`Regex script "${scriptName}" has invalid placement and will be skipped.`);

    if (!shownInvalidPlacementToast && typeof toastr !== 'undefined') {
        shownInvalidPlacementToast = true;
        toastr.error('Some regex scripts are invalid and were skipped. Open Regex Editor to fix or delete them.', 'Regex script error');
    }
}

/**
 * Manages the compiled regex cache with LRU eviction.
 */
export class RegexProvider {
    /** @type {Map<string, RegExp>} */
    #cache = new Map();
    /** @type {number} */
    #maxSize = 1000;

    static instance = new RegexProvider();

    /**
     * Gets a regex instance by its string representation.
     * @param {string} regexString The regex string to retrieve
     * @returns {RegExp?} Compiled regex or null if invalid
     */
    get(regexString) {
        const isCached = this.#cache.has(regexString);
        const regex = isCached
            ? this.#cache.get(regexString)
            : regexFromString(regexString);

        if (!regex) {
            return null;
        }

        if (isCached) {
            // LRU: Move to end by re-inserting
            this.#cache.delete(regexString);
            this.#cache.set(regexString, regex);
        } else {
            // Evict oldest if at capacity
            if (this.#cache.size >= this.#maxSize) {
                const firstKey = this.#cache.keys().next().value;
                this.#cache.delete(firstKey);
            }
            this.#cache.set(regexString, regex);
        }

        // Reset lastIndex for global/sticky regexes
        if (regex.global || regex.sticky) {
            regex.lastIndex = 0;
        }

        return regex;
    }

    /**
     * Clears the entire cache.
     */
    clear() {
        this.#cache.clear();
    }
}

/**
 * Registers an in-memory runtime regex provider.
 * Providers are evaluated on each getRegexScripts() call and are never persisted.
 * Each returned script must include a non-empty `scriptName`.
 *
 * @param {string} owner Unique owner id, usually plugin/module name
 * @param {(options?: GetRegexScriptsOptions) => RegexScript[] | null | undefined} provider Script provider callback
 * @param {RuntimeRegexProviderOptions} [options] Provider options
 * @returns {RuntimeRegexProviderRegistration | null}
 */
export function registerRegexProvider(owner, provider, options = {}) {
    const ownerId = String(owner || '').trim();
    if (!ownerId) {
        console.warn('registerRegexProvider: owner is empty');
        return null;
    }
    if (typeof provider !== 'function') {
        console.warn(`registerRegexProvider: provider for "${ownerId}" is not a function`);
        return null;
    }
    const reloadOnChange = Boolean(options?.reloadOnChange);
    const entry = { provider, reloadOnChange };
    runtimeRegexProviders.set(ownerId, entry);
    notifyRuntimeRegexScriptsChanged({ requestReload: reloadOnChange });
    return createRuntimeRegexProviderRegistration(ownerId, entry);
}

/**
 * Unregisters an in-memory runtime regex provider.
 *
 * @param {string} owner Owner id used during registration
 * @returns {void}
 */
export function unregisterRegexProvider(owner) {
    const ownerId = String(owner || '').trim();
    if (!ownerId) {
        return;
    }
    const runtimeProvider = runtimeRegexProviders.get(ownerId);
    const requestReload = Boolean(runtimeProvider?.reloadOnChange);
    if (runtimeProvider?.managedScripts instanceof Map) {
        for (const scriptId of runtimeProvider.managedScripts.keys()) {
            resetRegexScriptState(scriptId);
        }
    }
    runtimeRegexProviders.delete(ownerId);
    notifyRuntimeRegexScriptsChanged({ requestReload });
}

/**
 * Collects all runtime regex scripts from registered providers.
 * Runtime scripts are shallow-cloned to avoid mutating provider-owned objects.
 *
 * @param {GetRegexScriptsOptions} options Options for retrieving scripts
 * @returns {RegexScript[]}
 */
function collectRuntimeRegexScripts(options = DEFAULT_GET_REGEX_SCRIPTS_OPTIONS) {
    const scripts = [];
    for (const [owner, runtimeProvider] of runtimeRegexProviders.entries()) {
        try {
            const provider = runtimeProvider?.provider;
            const value = provider?.(options);
            if (!Array.isArray(value)) {
                continue;
            }
            for (const script of value) {
                if (!script || typeof script !== 'object') {
                    continue;
                }
                const scriptName = String(script.scriptName || '').trim();
                if (!scriptName) {
                    console.warn(`collectRuntimeRegexScripts: provider "${owner}" returned a script without scriptName; skipped.`);
                    continue;
                }
                scripts.push({ ...script, scriptName, __runtime_owner: owner });
            }
        } catch (error) {
            console.error(`collectRuntimeRegexScripts: provider "${owner}" failed`, error);
        }
    }
    return scripts;
}

/**
 * Returns runtime regex scripts provided by plugins/scripts.
 * This is for read-only UI/debug display and should not be used for persistence writes.
 *
 * @param {GetRegexScriptsOptions} options Options for retrieving scripts
 * @returns {RegexScript[]}
 */
export function getRuntimeRegexScripts(options = DEFAULT_GET_REGEX_SCRIPTS_OPTIONS) {
    return collectRuntimeRegexScripts(options);
}

/**
 * Retrieves the list of regex scripts by combining the scripts from the extension settings and the character data
 *
 * @param {GetRegexScriptsOptions} options Options for retrieving the regex scripts
 * @returns {RegexScript[]} An array of regex scripts, where each script is an object containing the necessary information.
 */
export function getRegexScripts(options = DEFAULT_GET_REGEX_SCRIPTS_OPTIONS) {
    return [
        ...Object.values(SCRIPT_TYPES).flatMap(type => getScriptsByType(type, options)),
        ...collectRuntimeRegexScripts(options),
    ];
}

/**
 * Retrieves the regex scripts for a specific type.
 * @param {SCRIPT_TYPES} scriptType The type of regex scripts to retrieve.
 * @param {GetRegexScriptsOptions} options Options for retrieving the regex scripts
 * @returns {RegexScript[]} An array of regex scripts for the specified type.
 */
export function getScriptsByType(scriptType, { allowedOnly } = DEFAULT_GET_REGEX_SCRIPTS_OPTIONS) {
    switch (scriptType) {
        case SCRIPT_TYPE_UNKNOWN:
            return [];
        case SCRIPT_TYPES.GLOBAL:
            return sanitizePersistedRegexScriptList(extension_settings.regex ?? [], SCRIPT_TYPES.GLOBAL);
        case SCRIPT_TYPES.SCOPED: {
            if (allowedOnly && !extension_settings?.character_allowed_regex?.includes(characters?.[this_chid]?.avatar)) {
                return [];
            }
            const scopedScripts = characters[this_chid]?.data?.extensions?.regex_scripts;
            return sanitizePersistedRegexScriptList(scopedScripts, SCRIPT_TYPES.SCOPED);
        }
        case SCRIPT_TYPES.PRESET: {
            if (allowedOnly && !extension_settings?.preset_allowed_regex?.[getCurrentPresetAPI()]?.includes(getCurrentPresetName())) {
                return [];
            }
            const presetManager = getPresetManager();
            const presetScripts = presetManager?.readPresetExtensionField({ path: 'regex_scripts' });
            return sanitizePersistedRegexScriptList(presetScripts, SCRIPT_TYPES.PRESET);
        }
        default:
            console.warn(`getScriptsByType: Invalid script type ${scriptType}`);
            return [];
    }
}

/**
 * Saves an array of regex scripts for a specific type.
 * @param {RegexScript[]} scripts An array of regex scripts to save.
 * @param {SCRIPT_TYPES} scriptType The type of regex scripts to save.
 * @returns {Promise<void>}
 */
export async function saveScriptsByType(scripts, scriptType) {
    const normalizedScripts = filterValidPersistedRegexScripts(scripts);
    const character = characters?.[this_chid];
    const context = {
        scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
        scriptCount: normalizedScripts.length,
        chid: this_chid ?? null,
        avatar: character?.avatar || null,
        currentPresetApi: getCurrentPresetAPI?.() || null,
        currentPresetName: getCurrentPresetName?.() || null,
        scripts: normalizedScripts.slice(0, 5).map(summarizeRegexScriptForLog),
    };

    console.info('[Regex] saveScriptsByType requested', context);

    switch (scriptType) {
        case SCRIPT_TYPES.GLOBAL:
            extension_settings.regex = normalizedScripts;
            saveSettingsDebounced();
            console.info('[Regex] Global scripts staged in extension settings', context);
            break;
        case SCRIPT_TYPES.SCOPED:
            await writeExtensionField(this_chid, 'regex_scripts', normalizedScripts);
            console.info('[Regex] Scoped scripts persisted to character extension field', context);
            break;
        case SCRIPT_TYPES.PRESET: {
            const presetManager = getPresetManager();
            await presetManager.writePresetExtensionField({ path: 'regex_scripts', value: normalizedScripts });
            console.info('[Regex] Preset scripts persisted to preset extension field', context);
            break;
        }
        default:
            console.warn(`saveScriptsByType: Invalid script type ${scriptType}`);
            break;
    }
}

/**
 * Check if character's regexes are allowed to be used; if character is undefined, returns false
 * @param {Character|undefined} character
 * @returns {boolean}
 */
export function isScopedScriptsAllowed(character) {
    return !!extension_settings?.character_allowed_regex?.includes(character?.avatar);
}

/**
 * Allow character's regexes to be used; if character is undefined, do nothing
 * @param {Character|undefined} character
 * @returns {void}
 */
export function allowScopedScripts(character) {
    const avatar = character?.avatar;
    if (!avatar) {
        return;
    }
    if (!Array.isArray(extension_settings?.character_allowed_regex)) {
        extension_settings.character_allowed_regex = [];
    }
    if (!extension_settings.character_allowed_regex.includes(avatar)) {
        extension_settings.character_allowed_regex.push(avatar);
        saveSettingsDebounced();
        console.info('[Regex] Scoped scripts allowed for character', {
            avatar,
            chid: this_chid ?? null,
        });
    }
}

/**
 * Disallow character's regexes to be used; if character is undefined, do nothing
 * @param {Character|undefined} character
 * @returns {void}
 */
export function disallowScopedScripts(character) {
    const avatar = character?.avatar;
    if (!avatar) {
        return;
    }
    if (!Array.isArray(extension_settings?.character_allowed_regex)) {
        return;
    }
    const index = extension_settings.character_allowed_regex.indexOf(avatar);
    if (index !== -1) {
        extension_settings.character_allowed_regex.splice(index, 1);
        saveSettingsDebounced();
        console.info('[Regex] Scoped scripts disallowed for character', {
            avatar,
            chid: this_chid ?? null,
        });
    }
}

/**
 * Check if preset's regexes are allowed to be used
 * @param {string} apiId API ID
 * @param {string} presetName Preset name
 * @returns {boolean} True if allowed, false if not
 */
export function isPresetScriptsAllowed(apiId, presetName) {
    if (!apiId || !presetName) {
        return false;
    }
    return !!extension_settings?.preset_allowed_regex?.[apiId]?.includes(presetName);
}

/**
 * Allow preset's regexes to be used
 * @param {string} apiId API ID
 * @param {string} presetName Preset name
 * @returns {void}
 */
export function allowPresetScripts(apiId, presetName) {
    if (!apiId || !presetName) {
        return;
    }
    if (!Array.isArray(extension_settings?.preset_allowed_regex?.[apiId])) {
        lodash.set(extension_settings, ['preset_allowed_regex', apiId], []);
    }
    if (!extension_settings.preset_allowed_regex[apiId].includes(presetName)) {
        extension_settings.preset_allowed_regex[apiId].push(presetName);
        saveSettingsDebounced();
    }
}

/**
 * Disallow preset's regexes to be used
 * @param {string} apiId API ID
 * @param {string} presetName Preset name
 * @returns {void}
 */
export function disallowPresetScripts(apiId, presetName) {
    if (!apiId || !presetName) {
        return;
    }
    if (!Array.isArray(extension_settings?.preset_allowed_regex?.[apiId])) {
        return;
    }
    const index = extension_settings.preset_allowed_regex[apiId].indexOf(presetName);
    if (index !== -1) {
        extension_settings.preset_allowed_regex[apiId].splice(index, 1);
        saveSettingsDebounced();
    }
}

/**
 * Gets the current API ID from the preset manager.
 * @returns {string|null} Current API ID, or null if no preset manager
 */
export function getCurrentPresetAPI() {
    return getPresetManager()?.apiId ?? null;
}

/**
 * Gets the name of the currently selected preset.
 * @returns {string|null} The name of the currently selected preset, or null if no preset manager
 */
export function getCurrentPresetName() {
    return getPresetManager()?.getSelectedPresetName() ?? null;
}

/**
 * @readonly
 * @enum {number} Where the regex script should be applied
 */
export const regex_placement = {
    /**
     * @deprecated MD Display is deprecated. Do not use.
     */
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    // 4 - sendAs (legacy)
    WORLD_INFO: 5,
    REASONING: 6,
};

/**
 * @readonly
 * @enum {number} How to substitute parameters in the find regex
 */
export const substitute_find_regex = {
    NONE: 0,
    RAW: 1,
    ESCAPED: 2,
};

function sanitizeRegexMacro(x) {
    return (x && typeof x === 'string') ?
        x.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, function (s) {
            switch (s) {
                case '\n':
                    return '\\n';
                case '\r':
                    return '\\r';
                case '\t':
                    return '\\t';
                case '\v':
                    return '\\v';
                case '\f':
                    return '\\f';
                case '\0':
                    return '\\0';
                default:
                    return '\\' + s;
            }
        }) : x;
}

/**
 * Parent function to fetch a regexed version of a raw string
 * @param {string} rawString The raw string to be regexed
 * @param {regex_placement} placement The placement of the string
 * @param {RegexParams} params The parameters to use for the regex script
 * @returns {string} The regexed string
 * @typedef {{characterOverride?: string, isMarkdown?: boolean, isPrompt?: boolean, isPluginPrompt?: boolean, isEdit?: boolean, depth?: number }} RegexParams The parameters to use for the regex script
 */
export function getRegexedString(rawString, placement, { characterOverride, isMarkdown, isPrompt, isPluginPrompt, isEdit, depth } = {}) {
    // WTF have you passed me?
    if (typeof rawString !== 'string') {
        console.warn('getRegexedString: rawString is not a string. Returning empty string.');
        return '';
    }

    let finalString = rawString;
    if (extension_settings.disabledExtensions.includes('regex') || !rawString || placement === undefined) {
        return finalString;
    }

    const allRegex = getRegexScripts({ allowedOnly: true });
    allRegex.forEach((script, index) => {
        if (!script || typeof script !== 'object') {
            return;
        }

        const placementList = Array.isArray(script.placement) ? script.placement : null;
        if (!placementList) {
            warnInvalidRegexPlacement(script, index);
            return;
        }

        const hasScopedTarget = Boolean(script.markdownOnly || script.promptOnly || script.pluginOnly);
        const matchesScopedTarget =
            // Script applies to Markdown and input is Markdown
            (script.markdownOnly && isMarkdown) ||
            // Script applies to Generate and input is Generate
            (script.promptOnly && isPrompt) ||
            // Script applies to plugin-built messages
            (script.pluginOnly && isPluginPrompt);

        if ((hasScopedTarget && matchesScopedTarget) ||
            // Script applies to the persisted chat content only when no scoped target is enabled.
            (!hasScopedTarget && !isMarkdown && !isPrompt && !isPluginPrompt)) {
            if (isEdit && !script.runOnEdit) {
                console.debug(`getRegexedString: Skipping script ${script.scriptName} because it does not run on edit`);
                return;
            }

            // Check if the depth is within the min/max depth
            if (typeof depth === 'number') {
                if (!isNaN(script.minDepth) && script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) {
                    console.debug(`getRegexedString: Skipping script ${script.scriptName} because depth ${depth} is less than minDepth ${script.minDepth}`);
                    return;
                }

                if (!isNaN(script.maxDepth) && script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) {
                    console.debug(`getRegexedString: Skipping script ${script.scriptName} because depth ${depth} is greater than maxDepth ${script.maxDepth}`);
                    return;
                }
            }

            if (placementList.includes(placement)) {
                if (isRegexScriptPaused(script.id)) {
                    return;
                }
                const __regexStart = performance.now();
                finalString = runRegexScript(script, finalString, { characterOverride });
                const __regexElapsed = performance.now() - __regexStart;
                recordRegexExecution(script, __regexElapsed);
            }
        }
    });

    return finalString;
}

/**
 * Runs the provided regex script on the given string
 * @param {RegexScript} regexScript The regex script to run
 * @param {string} rawString The string to run the regex script on
 * @param {RegexScriptParams} params The parameters to use for the regex script
 * @returns {string} The new string
 * @typedef {{characterOverride?: string}} RegexScriptParams The parameters to use for the regex script
 */
export function runRegexScript(regexScript, rawString, { characterOverride } = {}) {
    let newString = rawString;
    if (!regexScript || !!(regexScript.disabled) || !regexScript?.findRegex || !rawString) {
        return newString;
    }

    const getRegexString = () => {
        switch (Number(regexScript.substituteRegex)) {
            case substitute_find_regex.NONE:
                return regexScript.findRegex;
            case substitute_find_regex.RAW:
                return substituteParamsExtended(regexScript.findRegex);
            case substitute_find_regex.ESCAPED:
                return substituteParamsExtended(regexScript.findRegex, {}, sanitizeRegexMacro);
            default:
                console.warn(`runRegexScript: Unknown substituteRegex value ${regexScript.substituteRegex}. Using raw regex.`);
                return regexScript.findRegex;
        }
    };
    const regexString = getRegexString();
    const findRegex = RegexProvider.instance.get(regexString);

    // The user skill issued. Return with nothing.
    if (!findRegex) {
        return newString;
    }

    // Run replacement. Currently does not support the Overlay strategy
    newString = rawString.replace(findRegex, function (match) {
        const args = [...arguments];
        const replaceString = regexScript.replaceString.replace(/{{match}}/gi, '$0');
        const replaceWithGroups = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num, groupName) => {
            if (num) {
                // Handle numbered capture groups ($1, $2, etc.)
                match = args[Number(num)];
            } else if (groupName) {
                // Handle named capture groups ($<name>)
                const groups = args[args.length - 1];
                match = groups && typeof groups === 'object' && groups[groupName];
            }

            // No match found - return the empty string
            if (!match) {
                return '';
            }

            // Remove trim strings from the match
            const filteredMatch = filterString(match, regexScript.trimStrings, { characterOverride });

            return filteredMatch;
        });

        // Substitute at the end
        return substituteParams(replaceWithGroups);
    });

    return newString;
}

/**
 * Filters anything to trim from the regex match
 * @param {string} rawString The raw string to filter
 * @param {string[]} trimStrings The strings to trim
 * @param {RegexScriptParams} params The parameters to use for the regex filter
 * @returns {string} The filtered string
 */
function filterString(rawString, trimStrings, { characterOverride } = {}) {
    let finalString = rawString;
    trimStrings.forEach((trimString) => {
        const subTrimString = substituteParams(trimString, { name2Override: characterOverride });
        finalString = finalString.replaceAll(subTrimString, '');
    });

    return finalString;
}
