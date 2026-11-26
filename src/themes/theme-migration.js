import path from 'node:path';

import {
    getNamedDocRepo,
    getSettingsRepo,
    getStorageEngine,
    isReadOnly,
    isStorageInitialized,
} from '../storage/index.js';
import {
    deepEqualJson,
    getBuiltinTheme,
    getBuiltinThemeStylesheetText,
    isBuiltinThemeName,
    isLegacyShippedLensCss,
    isUnmodifiedLegacyBuiltinTheme,
    listBuiltinThemeNames,
    stripInternalThemeFields,
} from './builtin-themes.js';

const THEME_POWER_USER_KEYS = Object.freeze([
    'blur_strength',
    'main_text_color',
    'italics_text_color',
    'underline_text_color',
    'quote_text_color',
    'blur_tint_color',
    'chat_tint_color',
    'user_mes_blur_tint_color',
    'bot_mes_blur_tint_color',
    'shadow_color',
    'shadow_width',
    'border_color',
    'font_scale',
    'fast_ui_mode',
    'waifuMode',
    'avatar_style',
    'chat_display',
    'toastr_position',
    'noShadows',
    'chat_width',
    'timer_enabled',
    'timestamps_enabled',
    'timestamp_model_icon',
    'mesIDDisplay_enabled',
    'hideChatAvatars_enabled',
    'message_token_count_enabled',
    'expand_message_actions',
    'enableZenSliders',
    'enableLabMode',
    'hotswap_enabled',
    'bogus_folders',
    'zoomed_avatar_magnification',
    'reduced_motion',
    'compact_input_area',
    'show_swipe_num_all_messages',
    'click_to_edit',
    'media_display',
]);

/** @type {WeakMap<object, Set<string>>} */
const migratedByEngine = new WeakMap();
/** @type {WeakMap<object, Map<string, Promise<void>>>} */
const inFlightByEngine = new WeakMap();

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getEngineMigratedSet(engine) {
    let set = migratedByEngine.get(engine);
    if (!set) {
        set = new Set();
        migratedByEngine.set(engine, set);
    }
    return set;
}

function getEngineInFlightMap(engine) {
    let map = inFlightByEngine.get(engine);
    if (!map) {
        map = new Map();
        inFlightByEngine.set(engine, map);
    }
    return map;
}

function pickUniqueCustomThemeName(baseName, existingNames) {
    const cleanBase = String(baseName || 'Custom').trim() || 'Custom';
    let candidate = `${cleanBase} (Custom)`;
    let counter = 2;
    while (existingNames.has(candidate) || isBuiltinThemeName(candidate)) {
        candidate = `${cleanBase} (Custom ${counter})`;
        counter += 1;
    }
    existingNames.add(candidate);
    return candidate;
}

function buildMigratedThemeDoc(newName, baseDoc, powerUser, legacyCss, legacyPalettes) {
    const doc = {
        ...stripInternalThemeFields(baseDoc),
        name: newName,
    };
    if (isPlainObject(powerUser)) {
        for (const key of THEME_POWER_USER_KEYS) {
            if (powerUser[key] !== undefined) {
                doc[key] = powerUser[key];
            }
        }
    }
    doc.custom_css = legacyCss;
    const resolvedPalettes = isPlainObject(legacyPalettes)
        ? legacyPalettes
        : (isPlainObject(baseDoc?.palettes) ? baseDoc.palettes : null);
    if (resolvedPalettes) {
        doc.palettes = JSON.parse(JSON.stringify(resolvedPalettes));
    } else {
        delete doc.palettes;
    }
    return doc;
}

async function loadExistingThemeNameSet(namedDocRepo, handle) {
    const entries = await namedDocRepo.list(handle, 'themes');
    const names = new Set(listBuiltinThemeNames());
    for (const entry of entries) {
        const name = entry?.key?.name;
        if (typeof name === 'string' && name.length > 0) {
            names.add(name);
        }
    }
    return names;
}

async function runMigrationForHandle(handle) {
    const namedDocRepo = getNamedDocRepo();
    const settingsRepo = getSettingsRepo();

    /** @type {Set<string> | null} */
    let existingNames = null;
    const getExistingNames = async () => {
        if (!existingNames) {
            existingNames = await loadExistingThemeNameSet(namedDocRepo, handle);
        }
        return existingNames;
    };

    /** @type {Map<string, string>} */
    const renamedThemes = new Map();

    // 1. Clean up or preserve user-stored theme docs that shadow built-in names.
    for (const builtinName of listBuiltinThemeNames()) {
        const readResult = await namedDocRepo.read(handle, 'themes', builtinName);
        if (!readResult.exists || !readResult.valid || readResult.value == null) {
            continue;
        }
        const userDoc = readResult.value;
        if (isUnmodifiedLegacyBuiltinTheme(builtinName, userDoc)) {
            await namedDocRepo.delete(handle, 'themes', builtinName);
            continue;
        }
        const names = await getExistingNames();
        const newName = pickUniqueCustomThemeName(builtinName, names);
        const migratedDoc = {
            ...stripInternalThemeFields(userDoc),
            name: newName,
        };
        await namedDocRepo.save(handle, 'themes', newName, migratedDoc);
        await namedDocRepo.delete(handle, 'themes', builtinName);
        renamedThemes.set(builtinName, newName);
    }

    // 2. Strip legacy power_user.custom_css / power_user.palettes from settings.json,
    //    preserving any unsaved custom CSS as an independent user theme.
    let settingsDoc;
    try {
        settingsDoc = await settingsRepo.get(handle);
    } catch {
        // Leave corrupt settings untouched so the regular settings endpoints surface 422.
        return;
    }
    if (!isPlainObject(settingsDoc) || !isPlainObject(settingsDoc.power_user)) {
        return;
    }

    const pu = settingsDoc.power_user;
    let settingsChanged = false;

    if (typeof pu.theme === 'string' && renamedThemes.has(pu.theme)) {
        pu.theme = renamedThemes.get(pu.theme);
        settingsChanged = true;
    }

    const hasLegacyCss = Object.prototype.hasOwnProperty.call(pu, 'custom_css');
    const hasLegacyPalettes = Object.prototype.hasOwnProperty.call(pu, 'palettes');

    if (hasLegacyCss || hasLegacyPalettes) {
        const legacyCss = typeof pu.custom_css === 'string' ? pu.custom_css : '';
        const legacyPalettes = isPlainObject(pu.palettes) ? pu.palettes : null;
        const activeName = typeof pu.theme === 'string' ? pu.theme : '';
        const hasCustomCssPayload = legacyCss.trim().length > 0;
        const hasCustomPalettesPayload = legacyPalettes !== null && Object.keys(legacyPalettes).length > 0;

        if (hasCustomCssPayload || hasCustomPalettesPayload) {
            const activeBuiltinDoc = isBuiltinThemeName(activeName) ? getBuiltinTheme(activeName) : null;
            const activeUserDoc = (!activeBuiltinDoc && activeName)
                ? await namedDocRepo.get(handle, 'themes', activeName)
                : null;
            const activeDoc = activeUserDoc || activeBuiltinDoc || null;

            const isUnmodifiedBuiltinLens = Boolean(activeBuiltinDoc?.builtin_stylesheet)
                && isLegacyShippedLensCss(legacyCss);
            const alreadySavedInActiveUserTheme = isPlainObject(activeUserDoc)
                && String(activeUserDoc.custom_css || '') === legacyCss;
            const hasUnsavedCss = hasCustomCssPayload && !isUnmodifiedBuiltinLens && !alreadySavedInActiveUserTheme;

            const activePalettes = isPlainObject(activeDoc?.palettes) ? activeDoc.palettes : null;
            const hasUnsavedPalettes = hasCustomPalettesPayload
                && !deepEqualJson(legacyPalettes, activePalettes);

            if (hasUnsavedCss || hasUnsavedPalettes) {
                const names = await getExistingNames();
                const newName = pickUniqueCustomThemeName(activeName || 'Custom', names);
                const baseDoc = activeDoc || {};
                const effectiveCss = hasCustomCssPayload && !isUnmodifiedBuiltinLens
                    ? legacyCss
                    : (activeBuiltinDoc?.builtin_stylesheet
                        ? getBuiltinThemeStylesheetText(activeBuiltinDoc)
                        : String(baseDoc.custom_css || ''));
                const migratedTheme = buildMigratedThemeDoc(newName, baseDoc, pu, effectiveCss, legacyPalettes);
                await namedDocRepo.save(handle, 'themes', newName, migratedTheme);
                pu.theme = newName;
            }
        }

        delete pu.custom_css;
        delete pu.palettes;
        settingsChanged = true;
    }

    if (settingsChanged) {
        await settingsRepo.save(handle, settingsDoc);
    }
}

/**
 * Ensures legacy seeded built-in themes and persisted `power_user.custom_css` /
 * `power_user.palettes` fields have been migrated for `handle`. Memoized per
 * active storage engine instance so repeated requests incur zero I/O.
 * @param {string} handle
 */
export async function ensureLegacyThemesMigrated(handle) {
    if (!handle || !isStorageInitialized() || isReadOnly()) {
        return;
    }
    const engine = getStorageEngine();
    const migrated = getEngineMigratedSet(engine);
    if (migrated.has(handle)) {
        return;
    }
    const inFlight = getEngineInFlightMap(engine);
    let task = inFlight.get(handle);
    if (!task) {
        task = runMigrationForHandle(handle)
            .then(() => {
                migrated.add(handle);
            })
            .finally(() => {
                inFlight.delete(handle);
            });
        inFlight.set(handle, task);
    }
    await task;
}

/**
 * Clears the memoized migration flag for `handle` (e.g. after restoring a
 * backup or importing a data archive that may contain legacy theme data).
 * @param {string} [handle]
 */
export function invalidateLegacyThemeMigration(handle) {
    if (!isStorageInitialized()) {
        return;
    }
    const engine = getStorageEngine();
    const migrated = migratedByEngine.get(engine);
    if (!migrated) {
        return;
    }
    if (handle) {
        migrated.delete(handle);
    } else {
        migrated.clear();
    }
}

/**
 * Runs legacy theme migration across all user directories at server startup.
 * @param {import('../users.js').UserDirectoryList[]} directoriesList
 */
export async function migrateLegacyThemesForAllUsers(directoriesList) {
    if (!Array.isArray(directoriesList) || !isStorageInitialized() || isReadOnly()) {
        return;
    }
    for (const directories of directoriesList) {
        const handle = directories?.root ? path.basename(directories.root) : '';
        if (!handle) continue;
        try {
            await ensureLegacyThemesMigrated(handle);
        } catch (err) {
            console.warn(`Legacy theme migration failed for user "${handle}":`, err);
        }
    }
}
