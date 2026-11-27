// SPDX-License-Identifier: AGPL-3.0-or-later

export function createRegexEngine(deps) {
    /**
     * @readonly
     * @enum {number} Regex scripts types
     */
    const SCRIPT_TYPES = {
        // ORDER MATTERS: defines the regex script priority
        GLOBAL: 0,
        PRESET: 2,
        SCOPED: 1,
    };

    /**
     * Special type for unknown/invalid script types.
     */
    const SCRIPT_TYPE_UNKNOWN = -1;

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

    function normalizeCharacterId(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    }

    function isPersistedRegexScriptRecord(script) {
        return Boolean(script) && typeof script === 'object' && !Array.isArray(script);
    }

    function filterValidPersistedRegexScripts(scripts) {
        return Array.isArray(scripts) ? scripts.filter(isPersistedRegexScriptRecord) : [];
    }

    function cloneValidPersistedRegexScripts(scripts) {
        return filterValidPersistedRegexScripts(scripts).map(script => structuredClone(script));
    }

    /**
     * Captures the current storage target identity for a regex script type before async work.
     * @param {SCRIPT_TYPES} scriptType
     * @returns {{ scriptType: SCRIPT_TYPES, characterId?: number | null, character?: object | null, avatar?: string, presetApiId?: string | null, presetName?: string | null }}
     */
    function captureRegexTarget(scriptType) {
        switch (scriptType) {
            case SCRIPT_TYPES.SCOPED: {
                const characterId = normalizeCharacterId(deps.getThisChid());
                const character = characterId !== null ? (deps.getCharacters()?.[characterId] ?? null) : null;
                return {
                    scriptType,
                    characterId,
                    character,
                    avatar: String(character?.avatar || '').trim(),
                };
            }
            case SCRIPT_TYPES.PRESET:
                return {
                    scriptType,
                    presetApiId: getCurrentPresetAPI?.() ?? null,
                    presetName: getCurrentPresetName?.() ?? null,
                };
            case SCRIPT_TYPES.GLOBAL:
            default:
                return { scriptType };
        }
    }

    const CHARACTER_API_PROXY_TARGET = Symbol.for('luker.characterApiProxyTarget');

    function unwrapCharacterTarget(value) {
        let current = value;
        while (current && typeof current === 'object') {
            const unwrapped = current[CHARACTER_API_PROXY_TARGET];
            if (!unwrapped || unwrapped === current) {
                break;
            }
            current = unwrapped;
        }
        return current;
    }

    function resolveScopedCharacterTarget(target = null) {
        if (target && Object.prototype.hasOwnProperty.call(target, 'character')) {
            const expectedCharacter = unwrapCharacterTarget(target.character);
            if (!expectedCharacter) {
                return null;
            }
            const preferredId = normalizeCharacterId(target.characterId);
            if (preferredId !== null && unwrapCharacterTarget(deps.getCharacters()?.[preferredId]) === expectedCharacter) {
                const matched = deps.getCharacters()[preferredId];
                return {
                    characterId: preferredId,
                    character: matched,
                    avatar: String(matched.avatar || '').trim(),
                };
            }
            if (Array.isArray(deps.getCharacters())) {
                const reindexed = deps.getCharacters().findIndex(entry => unwrapCharacterTarget(entry) === expectedCharacter);
                if (reindexed !== -1) {
                    const matched = deps.getCharacters()[reindexed];
                    return {
                        characterId: reindexed,
                        character: matched,
                        avatar: String(matched.avatar || '').trim(),
                    };
                }
            }
            return null;
        }

        if (target && (Object.prototype.hasOwnProperty.call(target, 'characterId') || Object.prototype.hasOwnProperty.call(target, 'avatar'))) {
            const preferredId = normalizeCharacterId(target.characterId);
            const requestedAvatar = typeof target.avatar === 'string' ? target.avatar.trim() : '';
            if (preferredId !== null) {
                const candidate = deps.getCharacters()?.[preferredId] ?? null;
                if (candidate && (!requestedAvatar || String(candidate.avatar || '').trim() === requestedAvatar)) {
                    return {
                        characterId: preferredId,
                        character: candidate,
                        avatar: String(candidate.avatar || '').trim(),
                    };
                }
            }
            if (requestedAvatar && Array.isArray(deps.getCharacters())) {
                const byAvatar = deps.getCharacters().findIndex(entry => String(entry?.avatar || '').trim() === requestedAvatar);
                if (byAvatar !== -1) {
                    const candidate = deps.getCharacters()[byAvatar];
                    return {
                        characterId: byAvatar,
                        character: candidate,
                        avatar: String(candidate.avatar || '').trim(),
                    };
                }
            }
            return null;
        }

        const characterId = normalizeCharacterId(deps.getThisChid());
        const character = characterId !== null ? (deps.getCharacters()?.[characterId] ?? null) : null;
        if (characterId === null || !character) {
            return null;
        }
        return {
            characterId,
            character,
            avatar: String(character.avatar || '').trim(),
        };
    }

    function resolvePresetTarget(target = null) {
        if (target && (Object.prototype.hasOwnProperty.call(target, 'presetApiId') || Object.prototype.hasOwnProperty.call(target, 'presetName'))) {
            return {
                presetApiId: String(target.presetApiId || '').trim() || null,
                presetName: String(target.presetName || '').trim() || null,
            };
        }
        return {
            presetApiId: String(getCurrentPresetAPI?.() || '').trim() || null,
            presetName: String(getCurrentPresetName?.() || '').trim() || null,
        };
    }

    function sanitizePersistedRegexScriptList(scripts, scriptType, { clone = true, onInvalid = null } = {}) {
        if (!Array.isArray(scripts)) {
            return [];
        }

        const validScripts = [];
        const invalidEntries = [];
        for (let index = 0; index < scripts.length; index++) {
            if (isPersistedRegexScriptRecord(scripts[index])) {
                validScripts.push(clone ? structuredClone(scripts[index]) : scripts[index]);
                continue;
            }
            invalidEntries.push({ index, type: scripts[index] === null ? 'null' : typeof scripts[index] });
        }

        if (invalidEntries.length > 0) {
            console.error('[Regex] Detected invalid persisted regex entries; skipping them', {
                scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
                invalidEntries,
            });
            onInvalid?.(invalidEntries);
        }

        return validScripts;
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
            pluginLanes: getPluginLanes(script),
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
    const REGEX_RUNTIME_SCRIPTS_CHANGED_EVENT = 'luker:regex-runtime-scripts-changed';

    /**
     * @param {{ requestReload?: boolean }} [options]
     * @returns {void}
     */
    function notifyRuntimeRegexScriptsChanged(options = {}) {
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
                        deps.resetRegexScriptState(scriptId);
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
            trimStrings: normalizeRuntimeTrimStrings(script.trimStrings),
        };
    }

    /**
     * Normalizes `trimStrings` for scripts handed in at runtime.
     *
     * The regex editor is the only writer that guarantees the field exists.
     * Runtime scripts bypass it, and the engine reads the value directly as
     * soon as a replacement references a capture group.
     *
     * @param {unknown} trimStrings The trim strings to normalize
     * @returns {string[]} The normalized trim strings
     */
    function normalizeRuntimeTrimStrings(trimStrings) {
        return Array.isArray(trimStrings) ? trimStrings.map(String) : [];
    }

    /**
     * Creates and registers a managed runtime regex provider backed by engine-owned script storage.
     * This is useful for plugins that want `upsert/remove/set/clear` semantics instead of a pure callback provider.
     * Each script must include a non-empty `id` and `scriptName`. `trimStrings` is filled with an empty list when omitted.
     *
     * @param {string} owner Unique owner id, usually plugin/module name
     * @param {RuntimeRegexProviderOptions} [options] Provider options
     * @returns {ManagedRuntimeRegexProviderRegistration | null}
     */
    function registerManagedRegexProvider(owner, options = {}) {
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
                    deps.resetRegexScriptState(normalizedId);
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
                        deps.resetRegexScriptState(oldId);
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
                    deps.resetRegexScriptState(scriptId);
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
    class RegexProvider {
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
                : deps.regexFromString(regexString);

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
     * Each returned script must include a non-empty `scriptName`. `trimStrings` is
     * filled with an empty list when omitted.
     *
     * @param {string} owner Unique owner id, usually plugin/module name
     * @param {(options?: GetRegexScriptsOptions) => RegexScript[] | null | undefined} provider Script provider callback
     * @param {RuntimeRegexProviderOptions} [options] Provider options
     * @returns {RuntimeRegexProviderRegistration | null}
     */
    function registerRegexProvider(owner, provider, options = {}) {
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
    function unregisterRegexProvider(owner) {
        const ownerId = String(owner || '').trim();
        if (!ownerId) {
            return;
        }
        const runtimeProvider = runtimeRegexProviders.get(ownerId);
        const requestReload = Boolean(runtimeProvider?.reloadOnChange);
        if (runtimeProvider?.managedScripts instanceof Map) {
            for (const scriptId of runtimeProvider.managedScripts.keys()) {
                deps.resetRegexScriptState(scriptId);
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
                    if (options.throwOnError && value != null) throw new Error(`Regex provider "${owner}" did not return a script array.`);
                    if (value != null) {
                        options.onInvalid?.([{ owner, type: typeof value }]);
                    }
                    continue;
                }
                for (const script of value) {
                    if (!script || typeof script !== 'object' || Array.isArray(script)) {
                        if (options.throwOnError) throw new Error(`Regex provider "${owner}" returned an invalid script.`);
                        options.onInvalid?.([{ owner, type: script === null ? 'null' : (Array.isArray(script) ? 'array' : typeof script) }]);
                        continue;
                    }
                    const scriptName = String(script.scriptName || '').trim();
                    if (!scriptName) {
                        if (options.throwOnError) throw new Error(`Regex provider "${owner}" returned a script without a name.`);
                        console.warn(`collectRuntimeRegexScripts: provider "${owner}" returned a script without scriptName; skipped.`);
                        options.onInvalid?.([{ owner, type: 'missing_name' }]);
                        continue;
                    }
                    scripts.push({ ...script, scriptName, trimStrings: normalizeRuntimeTrimStrings(script.trimStrings), __runtime_owner: owner });
                }
            } catch (error) {
                if (options.throwOnError) throw error;
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
    function getRuntimeRegexScripts(options = DEFAULT_GET_REGEX_SCRIPTS_OPTIONS) {
        return collectRuntimeRegexScripts(options);
    }

    /**
     * Retrieves the list of regex scripts by combining the scripts from the extension settings and the character data
     *
     * @param {GetRegexScriptsOptions} options Options for retrieving the regex scripts
     * @returns {RegexScript[]} An array of regex scripts, where each script is an object containing the necessary information.
     */
    function getRegexScripts(options = DEFAULT_GET_REGEX_SCRIPTS_OPTIONS) {
        return [
            ...Object.values(SCRIPT_TYPES).flatMap(type => getScriptsByType(type, options)),
            ...collectRuntimeRegexScripts(options),
        ];
    }

    /**
     * Freeze enabled script data without retaining provider callbacks or performance
     * state. Preset-only tasks do not collect character or runtime-context providers.
     */
    function captureRegexScripts({ includeCharacter = true, preset = null } = {}) {
        if (deps.getExtensionSettings().disabledExtensions.includes('regex')) return [];
        const copyScripts = value => {
            const scripts = value ?? [];
            if (!Array.isArray(scripts) || scripts.some(script => !isPersistedRegexScriptRecord(script))) {
                throw new Error('Cannot capture invalid persisted regex scripts. Correct them in the Regex settings.');
            }
            return JSON.parse(JSON.stringify(scripts));
        };
        const scripts = copyScripts(deps.getExtensionSettings().regex);
        const presetAllowed = preset
            && deps.getExtensionSettings().preset_allowed_regex?.[preset.apiId]?.includes(preset.name);
        if (presetAllowed) {
            scripts.push(...copyScripts(preset.settings.extensions?.regex_scripts));
        }
        if (includeCharacter) {
            const character = deps.getCharacters()[deps.getThisChid()];
            if (isScopedScriptsAllowed(character)) {
                scripts.push(...copyScripts(character?.data?.extensions?.regex_scripts));
            }
            scripts.push(...collectRuntimeRegexScripts({ allowedOnly: true, throwOnError: true }));
        }
        return JSON.parse(JSON.stringify(scripts.filter(script => !deps.isRegexScriptPaused(script.id))));
    }

    /**
     * Retrieves the regex scripts for a specific type.
     * Returned arrays and script records are isolated copies of the persisted entries.
     * @param {SCRIPT_TYPES} scriptType The type of regex scripts to retrieve.
     * @param {GetRegexScriptsOptions & { target?: ReturnType<typeof captureRegexTarget> | null }} options Options for retrieving the regex scripts
     * @returns {RegexScript[]} An array of regex scripts for the specified type.
     */
    function getScriptsByType(scriptType, { allowedOnly = false, target = null, clone = true, onInvalid = null } = DEFAULT_GET_REGEX_SCRIPTS_OPTIONS) {
        switch (scriptType) {
            case SCRIPT_TYPE_UNKNOWN:
                return [];
            case SCRIPT_TYPES.GLOBAL:
                return sanitizePersistedRegexScriptList(deps.getExtensionSettings().regex ?? [], SCRIPT_TYPES.GLOBAL, { clone, onInvalid });
            case SCRIPT_TYPES.SCOPED: {
                const scoped = resolveScopedCharacterTarget(target);
                if (!scoped) {
                    return [];
                }
                if (allowedOnly && !deps.getExtensionSettings()?.character_allowed_regex?.includes(scoped.avatar)) {
                    return [];
                }
                const scopedScripts = scoped.character?.data?.extensions?.regex_scripts;
                return sanitizePersistedRegexScriptList(scopedScripts, SCRIPT_TYPES.SCOPED, { clone, onInvalid });
            }
            case SCRIPT_TYPES.PRESET: {
                const preset = resolvePresetTarget(target);
                if (allowedOnly && !deps.getExtensionSettings()?.preset_allowed_regex?.[preset.presetApiId]?.includes(preset.presetName)) {
                    return [];
                }
                const presetManager = deps.getPresetManager(preset.presetApiId || undefined);
                const presetScripts = presetManager?.readPresetExtensionField(
                    preset.presetName ? { name: preset.presetName, path: 'regex_scripts' } : { path: 'regex_scripts' },
                );
                return sanitizePersistedRegexScriptList(presetScripts, SCRIPT_TYPES.PRESET, { clone, onInvalid });
            }
            default:
                console.warn(`getScriptsByType: Invalid script type ${scriptType}`);
                return [];
        }
    }

    /**
     * Serializes a read-modify-write update against character-scoped regex scripts on the captured target character.
     * @param {(currentScripts: RegexScript[]) => RegexScript[] | null} updater Returns the next script array, or null to skip writing cleanly.
     * @param {ReturnType<typeof captureRegexTarget> | null} [target=null] Captured scoped character target
     * @returns {Promise<{ changed: boolean, character: object, characterId: number, scripts: RegexScript[] }>}
     */
    async function updateScopedRegexScripts(updater, target = null) {
        const scoped = resolveScopedCharacterTarget(target);
        if (!scoped) {
            console.error('[Regex] Scoped scripts target character is unavailable', {
                requestedChid: target?.characterId ?? deps.getThisChid() ?? null,
                requestedAvatar: target?.avatar ?? null,
            });
            throw new Error('Failed to save character-scoped regex scripts: target character is unavailable.');
        }

        let shouldPersist = true;
        let computedScripts = [];
        const saved = await deps.writeExtensionField(
            scoped.characterId,
            'regex_scripts',
            async (currentRaw) => {
                const currentValid = cloneValidPersistedRegexScripts(currentRaw);
                const nextRaw = await updater(currentValid);
                if (nextRaw === null) {
                    shouldPersist = false;
                    computedScripts = currentValid;
                    return currentRaw;
                }
                shouldPersist = true;
                computedScripts = cloneValidPersistedRegexScripts(nextRaw);
                return computedScripts;
            },
            { isCurrent: () => shouldPersist },
        );

        if (!shouldPersist) {
            return {
                changed: false,
                character: scoped.character,
                characterId: scoped.characterId,
                scripts: computedScripts,
            };
        }

        if (!saved) {
            console.error('[Regex] Scoped scripts failed to persist to character extension field', {
                chid: scoped.characterId,
                avatar: scoped.avatar || null,
                scriptCount: computedScripts.length,
            });
            throw new Error('Failed to save character-scoped regex scripts.');
        }

        console.info('[Regex] Scoped scripts persisted to character extension field', {
            scriptType: REGEX_SCRIPT_TYPE_LABELS[SCRIPT_TYPES.SCOPED],
            scriptCount: computedScripts.length,
            chid: scoped.characterId,
            avatar: scoped.avatar || null,
            scripts: computedScripts.slice(0, 5).map(summarizeRegexScriptForLog),
        });

        return {
            changed: true,
            character: scoped.character,
            characterId: scoped.characterId,
            scripts: computedScripts,
        };
    }

    /**
     * Saves an array of regex scripts for a specific type.
     * @param {RegexScript[]} scripts An array of regex scripts to save.
     * @param {SCRIPT_TYPES} scriptType The type of regex scripts to save.
     * @param {{ target?: ReturnType<typeof captureRegexTarget> | null, persistGlobal?: (() => Promise<{ ok?: boolean, status?: string, error?: string }>) | null }} [options]
     * @returns {Promise<void>}
     */
    async function saveScriptsByType(scripts, scriptType, options = {}) {
        const normalizedScripts = cloneValidPersistedRegexScripts(scripts);
        const scopedTarget = scriptType === SCRIPT_TYPES.SCOPED ? resolveScopedCharacterTarget(options?.target) : null;
        const presetTarget = scriptType === SCRIPT_TYPES.PRESET ? resolvePresetTarget(options?.target) : null;
        const character = scriptType === SCRIPT_TYPES.SCOPED ? scopedTarget?.character : deps.getCharacters()?.[deps.getThisChid()];
        const targetChid = scriptType === SCRIPT_TYPES.SCOPED ? scopedTarget?.characterId : deps.getThisChid();
        const context = {
            scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
            scriptCount: normalizedScripts.length,
            chid: targetChid ?? null,
            avatar: character?.avatar || null,
            currentPresetApi: presetTarget?.presetApiId || getCurrentPresetAPI?.() || null,
            currentPresetName: presetTarget?.presetName || getCurrentPresetName?.() || null,
            scripts: normalizedScripts.slice(0, 5).map(summarizeRegexScriptForLog),
        };

        console.info('[Regex] saveScriptsByType requested', context);

        switch (scriptType) {
            case SCRIPT_TYPES.GLOBAL: {
                const previousGlobalScripts = deps.getExtensionSettings().regex;
                deps.getExtensionSettings().regex = normalizedScripts;
                if (typeof options?.persistGlobal === 'function') {
                    let outcome;
                    try {
                        outcome = await options.persistGlobal();
                    } catch (error) {
                        if (deps.getExtensionSettings().regex === normalizedScripts) {
                            deps.getExtensionSettings().regex = previousGlobalScripts;
                        }
                        console.error('[Regex] Global scripts immediate persistence threw', { ...context, error });
                        throw error;
                    }
                    if (!outcome?.ok || outcome.status !== 'saved') {
                        if (deps.getExtensionSettings().regex === normalizedScripts) {
                            deps.getExtensionSettings().regex = previousGlobalScripts;
                        }
                        console.error('[Regex] Global scripts immediate persistence failed', { ...context, outcome });
                        throw new Error(outcome?.error || `Failed to save global regex scripts (${outcome?.status || 'failed'}).`);
                    }
                    console.info('[Regex] Global scripts persisted to extension settings', context);
                    break;
                }
                deps.saveSettingsDebounced();
                console.info('[Regex] Global scripts staged in extension settings', context);
                break;
            }
            case SCRIPT_TYPES.SCOPED: {
                if (!scopedTarget) {
                    console.error('[Regex] Scoped scripts target character is unavailable', context);
                    throw new Error('Failed to save character-scoped regex scripts: target character is unavailable.');
                }
                const saved = await deps.writeExtensionField(scopedTarget.characterId, 'regex_scripts', normalizedScripts);
                if (!saved) {
                    console.error('[Regex] Scoped scripts failed to persist to character extension field', context);
                    throw new Error('Failed to save character-scoped regex scripts.');
                }
                console.info('[Regex] Scoped scripts persisted to character extension field', context);
                break;
            }
            case SCRIPT_TYPES.PRESET: {
                const presetManager = deps.getPresetManager(presetTarget?.presetApiId || undefined);
                if (!presetManager || !presetTarget?.presetName) {
                    console.error('[Regex] Preset scripts target preset is unavailable', context);
                    throw new Error('Failed to save preset regex scripts: target preset is unavailable.');
                }
                await presetManager.writePresetExtensionField({ name: presetTarget.presetName, path: 'regex_scripts', value: normalizedScripts });
                console.info('[Regex] Preset scripts persisted to preset extension field', context);
                break;
            }
            default:
                console.warn(`saveScriptsByType: Invalid script type ${scriptType}`);
                throw new Error(`Invalid regex script type: ${scriptType}`);
        }
    }

    /**
     * Check if character's regexes are allowed to be used; if character is undefined, returns false
     * @param {Character|undefined} character
     * @returns {boolean}
     */
    function isScopedScriptsAllowed(character) {
        return !!deps.getExtensionSettings()?.character_allowed_regex?.includes(character?.avatar);
    }

    /**
     * Allow character's regexes to be used; if character is undefined, do nothing
     * @param {Character|undefined} character
     * @returns {void}
     */
    function allowScopedScripts(character) {
        const avatar = character?.avatar;
        if (!avatar) {
            return;
        }
        if (!Array.isArray(deps.getExtensionSettings()?.character_allowed_regex)) {
            deps.getExtensionSettings().character_allowed_regex = [];
        }
        if (!deps.getExtensionSettings().character_allowed_regex.includes(avatar)) {
            deps.getExtensionSettings().character_allowed_regex.push(avatar);
            deps.saveSettingsDebounced();
            console.info('[Regex] Scoped scripts allowed for character', {
                avatar,
                chid: deps.getThisChid() ?? null,
            });
        }
    }

    /**
     * Disallow character's regexes to be used; if character is undefined, do nothing
     * @param {Character|undefined} character
     * @returns {void}
     */
    function disallowScopedScripts(character) {
        const avatar = character?.avatar;
        if (!avatar) {
            return;
        }
        if (!Array.isArray(deps.getExtensionSettings()?.character_allowed_regex)) {
            return;
        }
        const index = deps.getExtensionSettings().character_allowed_regex.indexOf(avatar);
        if (index !== -1) {
            deps.getExtensionSettings().character_allowed_regex.splice(index, 1);
            deps.saveSettingsDebounced();
            console.info('[Regex] Scoped scripts disallowed for character', {
                avatar,
                chid: deps.getThisChid() ?? null,
            });
        }
    }

    /**
     * Check if preset's regexes are allowed to be used
     * @param {string} apiId API ID
     * @param {string} presetName Preset name
     * @returns {boolean} True if allowed, false if not
     */
    function isPresetScriptsAllowed(apiId, presetName) {
        if (!apiId || !presetName) {
            return false;
        }
        return !!deps.getExtensionSettings()?.preset_allowed_regex?.[apiId]?.includes(presetName);
    }

    /**
     * Allow preset's regexes to be used
     * @param {string} apiId API ID
     * @param {string} presetName Preset name
     * @returns {void}
     */
    function allowPresetScripts(apiId, presetName) {
        if (!apiId || !presetName) {
            return;
        }
        if (!Array.isArray(deps.getExtensionSettings()?.preset_allowed_regex?.[apiId])) {
            deps.getExtensionSettings().preset_allowed_regex ??= {};
            deps.getExtensionSettings().preset_allowed_regex[apiId] = [];
        }
        if (!deps.getExtensionSettings().preset_allowed_regex[apiId].includes(presetName)) {
            deps.getExtensionSettings().preset_allowed_regex[apiId].push(presetName);
            deps.saveSettingsDebounced();
        }
    }

    /**
     * Disallow preset's regexes to be used
     * @param {string} apiId API ID
     * @param {string} presetName Preset name
     * @returns {void}
     */
    function disallowPresetScripts(apiId, presetName) {
        if (!apiId || !presetName) {
            return;
        }
        if (!Array.isArray(deps.getExtensionSettings()?.preset_allowed_regex?.[apiId])) {
            return;
        }
        const index = deps.getExtensionSettings().preset_allowed_regex[apiId].indexOf(presetName);
        if (index !== -1) {
            deps.getExtensionSettings().preset_allowed_regex[apiId].splice(index, 1);
            deps.saveSettingsDebounced();
        }
    }

    /**
     * Gets the current API ID from the preset manager.
     * @returns {string|null} Current API ID, or null if no preset manager
     */
    function getCurrentPresetAPI() {
        return deps.getPresetManager()?.apiId ?? null;
    }

    /**
     * Gets the name of the currently selected preset.
     * @returns {string|null} The name of the currently selected preset, or null if no preset manager
     */
    function getCurrentPresetName() {
        return deps.getPresetManager()?.getSelectedPresetName() ?? null;
    }

    /**
     * @readonly
     * @enum {number} Where the regex script should be applied
     */
    const regex_placement = {
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
    const substitute_find_regex = {
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

    const PLUGIN_LANES = new Set(['request', 'reply']);

    /**
     * Resolve the plugin application points for a script.
     * Legacy persisted scripts used `pluginOnly` for both points.
     * @param {object} script The regex script
     * @returns {Array<'request' | 'reply'>} The selected plugin lanes
     */
    function getPluginLanes(script) {
        if (Array.isArray(script?.pluginLanes)) {
            return [...new Set(script.pluginLanes.filter(lane => PLUGIN_LANES.has(lane)))];
        }
        return script?.pluginOnly ? ['request', 'reply'] : [];
    }

    /**
     * Remove the legacy plugin scope field from a script without mutating it.
     * @param {object} script The regex script
     * @returns {object} A copy without the legacy plugin scope field
     */
    function omitLegacyPluginScope(script) {
        if (!script || typeof script !== 'object') {
            return script;
        }
        const { pluginOnly: _legacyPluginOnly, ...rest } = script;
        return rest;
    }

    /**
     * Normalize a script record so it carries plugin lanes and no legacy field.
     * @param {object} script The regex script
     * @returns {object} A copy with `pluginLanes` and without the legacy field
     */
    function normalizePluginScriptRecord(script) {
        if (!script || typeof script !== 'object') {
            return script;
        }
        return { ...omitLegacyPluginScope(script), pluginLanes: getPluginLanes(script) };
    }

    /**
     * Parent function to fetch a regexed version of a raw string
     * @param {string} rawString The raw string to be regexed
     * @param {regex_placement} placement The placement of the string
     * @param {RegexParams} params The parameters to use for the regex script
     * @returns {string} The regexed string
     * @typedef {{characterOverride?: string, isMarkdown?: boolean, isPrompt?: boolean, isPluginInput?: boolean, isPluginOutput?: boolean, isEdit?: boolean, depth?: number }} RegexParams The parameters to use for the regex script
     */
    function getRegexedString(rawString, placement, {
        characterOverride, isMarkdown, isPrompt, isPluginInput, isPluginOutput, isEdit, depth,
        scripts, substitute, isolated = false,
    } = {}) {
        if ((scripts !== undefined && !Array.isArray(scripts)) || (isolated && scripts === undefined)) {
            throw new TypeError('Captured regex execution requires a script snapshot.');
        }
        if (isolated && typeof substitute !== 'function') {
            throw new TypeError('Captured regex execution requires a macro snapshot processor.');
        }
        // WTF have you passed me?
        if (typeof rawString !== 'string') {
            console.warn('getRegexedString: rawString is not a string. Returning empty string.');
            return '';
        }

        let finalString = rawString;
        if ((!isolated && deps.getExtensionSettings().disabledExtensions.includes('regex')) || !rawString || placement === undefined) {
            return finalString;
        }

        const allRegex = scripts ?? getRegexScripts({ allowedOnly: true, clone: false });
        const trackPerformance = !isolated && deps.getExtensionSettings().regex_perf_detection !== false;
        allRegex.forEach((script, index) => {
            if (!script || typeof script !== 'object') {
                return;
            }

            const pluginLanes = getPluginLanes(script);
            const placementList = Array.isArray(script.placement)
                ? script.placement
                : pluginLanes.length > 0 ? [] : null;
            if (!placementList) {
                if (isolated) throw new Error(`Regex script "${script.scriptName}" has invalid placement settings.`);
                warnInvalidRegexPlacement(script, index);
                return;
            }

            const hasScopedTarget = Boolean(script.markdownOnly || script.promptOnly || pluginLanes.length > 0);
            const matchesScopedTarget =
                // Script applies to Markdown and input is Markdown
                (script.markdownOnly && isMarkdown) ||
                // Script applies to the main outgoing prompt and input is that prompt
                (script.promptOnly && isPrompt) ||
                // Plugin request lane: text going into a plugin request.
                (pluginLanes.includes('request') && isPluginInput) ||
                // Plugin reply lane: assistant text a plugin request returns.
                (pluginLanes.includes('reply') && isPluginOutput);

            // The reply is always assistant text. Placement describes message
            // kinds within a stream, so it does not gate the reply lane.
            const isReplyLane = isPluginOutput && pluginLanes.includes('reply');

            if ((hasScopedTarget && matchesScopedTarget) ||
                // Script applies to the persisted chat content only when no scoped target is enabled.
                (!hasScopedTarget && !isMarkdown && !isPrompt && !isPluginInput && !isPluginOutput)) {
                if (isEdit && !script.runOnEdit) {
                    if (!isolated) console.debug(`getRegexedString: Skipping script ${script.scriptName} because it does not run on edit`);
                    return;
                }

                // The reply pass has no depth; depth filtering applies to every
                // other lane that reaches this branch.
                if (typeof depth === 'number' && !isReplyLane) {
                    if (!isNaN(script.minDepth) && script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) {
                        if (!isolated) console.debug(`getRegexedString: Skipping script ${script.scriptName} because depth ${depth} is less than minDepth ${script.minDepth}`);
                        return;
                    }

                    if (!isNaN(script.maxDepth) && script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) {
                        if (!isolated) console.debug(`getRegexedString: Skipping script ${script.scriptName} because depth ${depth} is greater than maxDepth ${script.maxDepth}`);
                        return;
                    }
                }

                if (isReplyLane || placementList.includes(placement)) {
                    if (!isolated && deps.isRegexScriptPaused(script.id)) {
                        return;
                    }
                    const __regexStart = trackPerformance ? performance.now() : 0;
                    finalString = runRegexScript(script, finalString, { characterOverride, substitute, isolated });
                    if (trackPerformance) {
                        const __regexElapsed = performance.now() - __regexStart;
                        deps.recordRegexExecution(script, __regexElapsed);
                    }
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
    function runRegexScript(regexScript, rawString, { characterOverride, substitute, isolated = false } = {}) {
        let newString = rawString;
        if (!regexScript || !!(regexScript.disabled) || !regexScript?.findRegex || !rawString) {
            return newString;
        }

        const getRegexString = () => {
            switch (Number(regexScript.substituteRegex)) {
                case substitute_find_regex.NONE:
                    return regexScript.findRegex;
                case substitute_find_regex.RAW:
                    return substitute ? substitute(regexScript.findRegex) : deps.substituteParamsExtended(regexScript.findRegex);
                case substitute_find_regex.ESCAPED:
                    return substitute
                        ? substitute(regexScript.findRegex, { postProcessFn: sanitizeRegexMacro })
                        : deps.substituteParamsExtended(regexScript.findRegex, {}, sanitizeRegexMacro);
                default:
                    if (isolated) throw new Error(`Regex script "${regexScript.scriptName}" has an unknown substitution mode.`);
                    console.warn(`runRegexScript: Unknown substituteRegex value ${regexScript.substituteRegex}. Using raw regex.`);
                    return regexScript.findRegex;
            }
        };
        const regexString = getRegexString();
        const findRegex = isolated ? deps.regexFromString(regexString) : RegexProvider.instance.get(regexString);

        // The user skill issued. Return with nothing.
        if (!findRegex) {
            if (isolated) throw new Error(`Regex script "${regexScript.scriptName}" has an invalid expression.`);
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
                const filteredMatch = filterString(match, regexScript.trimStrings, { characterOverride, substitute });

                return filteredMatch;
            });

            // Substitute at the end
            return (substitute ?? deps.substituteParams)(replaceWithGroups);
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
    function filterString(rawString, trimStrings, { characterOverride, substitute = deps.substituteParams } = {}) {
        let finalString = rawString;
        trimStrings.forEach((trimString) => {
            const subTrimString = substitute(trimString, { name2Override: characterOverride });
            finalString = finalString.replaceAll(subTrimString, '');
        });

        return finalString;
    }


    return {
        SCRIPT_TYPES,
        SCRIPT_TYPE_UNKNOWN,
        captureRegexTarget,
        REGEX_RUNTIME_SCRIPTS_CHANGED_EVENT,
        notifyRuntimeRegexScriptsChanged,
        registerManagedRegexProvider,
        RegexProvider,
        registerRegexProvider,
        unregisterRegexProvider,
        getRuntimeRegexScripts,
        getRegexScripts,
        captureRegexScripts,
        getScriptsByType,
        updateScopedRegexScripts,
        saveScriptsByType,
        isScopedScriptsAllowed,
        allowScopedScripts,
        disallowScopedScripts,
        isPresetScriptsAllowed,
        allowPresetScripts,
        disallowPresetScripts,
        getCurrentPresetAPI,
        getCurrentPresetName,
        regex_placement,
        substitute_find_regex,
        getPluginLanes,
        omitLegacyPluginScope,
        normalizePluginScriptRecord,
        getRegexedString,
        runRegexScript,
    };
}
