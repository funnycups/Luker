import { characters, saveSettingsDebounced, substituteParams, substituteParamsExtended, this_chid } from '../../../script.js';
import { extension_settings, writeExtensionField } from '../../extensions.js';
import { getPresetManager } from '../../preset-manager.js';
import { regexFromString } from '../../utils.js';
import { isRegexScriptPaused, recordRegexExecution, resetRegexScriptState } from './redos-reporter.js';
import { createRegexEngine } from './engine-core.js';

export { createRegexEngine };

const engine = createRegexEngine({
    getCharacters: () => characters,
    getThisChid: () => this_chid,
    getExtensionSettings: () => extension_settings,
    saveSettingsDebounced: (...args) => saveSettingsDebounced(...args),
    substituteParams: (...args) => substituteParams(...args),
    substituteParamsExtended: (...args) => substituteParamsExtended(...args),
    writeExtensionField: (...args) => writeExtensionField(...args),
    getPresetManager: (...args) => getPresetManager(...args),
    regexFromString: (...args) => regexFromString(...args),
    isRegexScriptPaused: (...args) => isRegexScriptPaused(...args),
    recordRegexExecution: (...args) => recordRegexExecution(...args),
    resetRegexScriptState: (...args) => resetRegexScriptState(...args),
});

export const {
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
} = engine;
