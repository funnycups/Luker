import { assembleResourceFields, loadResourceBootstrap } from './resource-read.js';
import { assembleJsonFields } from './util/resource-fields.js';
import {
    listThemeDirectory,
    listWorldInfoNames,
    loadNamedDocumentEntries,
    loadPresetDocumentEntries,
    loadPresetResources,
    readThemeDocument,
    stampNamedDocuments,
} from './named-resource-read.js';

function uniqueNonEmptyStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const trimmed = typeof value === 'string' ? value.trim() : '';
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed);
            result.push(trimmed);
        }
    }
    return result;
}

export function activePresetApiId(settings) {
    switch (settings?.main_api) {
        case 'openai':
            return 'openai';
        case 'novel':
            return 'novel';
        case 'textgenerationwebui':
            return 'textgenerationwebui';
        case 'kobold':
        case 'koboldhorde':
            return 'kobold';
        default:
            return 'openai';
    }
}

export function selectedPresetNames(settings, { activeApiOnly = false } = {}) {
    const openaiCandidates = uniqueNonEmptyStrings([
        settings?.oai_settings?.global_preset_settings_openai,
        settings?.oai_settings?.preset_settings_openai,
        settings?.preset_settings_openai,
    ]);
    const koboldRaw = settings?.kai_settings?.preset_settings ?? settings?.preset_settings;
    const koboldCandidates = uniqueNonEmptyStrings([koboldRaw]).filter(name => name !== 'gui');

    const full = {
        novel: uniqueNonEmptyStrings([settings?.preset_settings_novel]),
        openai: openaiCandidates.length > 0 ? openaiCandidates : ['Default'],
        textgenerationwebui: uniqueNonEmptyStrings([settings?.textgenerationwebui_settings?.preset]),
        kobold: koboldCandidates,
    };

    if (!activeApiOnly) {
        return full;
    }

    const activeApi = activePresetApiId(settings);
    return {
        novel: activeApi === 'novel' ? full.novel : [],
        // `loadOpenAISettings` inspects the active OpenAI preset body at
        // startup (character-bound restore, alias backfill, reasoning effort),
        // so keep OpenAI's selected preset hydrated regardless of main_api.
        openai: full.openai,
        textgenerationwebui: activeApi === 'textgenerationwebui' ? full.textgenerationwebui : [],
        kobold: activeApi === 'kobold' ? full.kobold : [],
    };
}

export async function loadSettingsDocument({ signal } = {}) {
    const { account } = await loadResourceBootstrap({ signal });
    const query = new URLSearchParams({ account });
    const directoryUrl = `/api/settings/fields?${query}`;
    const fieldUrl = (path) => {
        const params = new URLSearchParams({ account, path });
        return `/api/settings/field?${params}`;
    };
    const { directory, values } = await assembleResourceFields({ directoryUrl, fieldUrl, signal });
    return assembleJsonFields(directory, values);
}

async function loadAdvancedPreset(apiId, { signal } = {}) {
    return stampNamedDocuments(await loadPresetDocumentEntries(apiId, { signal }));
}

export async function loadSettingsEnvelope({ bootstrap = false, signal } = {}) {
    const metadata = await loadResourceBootstrap({ signal });
    const settingsDocument = await loadSettingsDocument({ signal });
    const selected = selectedPresetNames(settingsDocument, { activeApiOnly: bootstrap });
    const selectedThemeName = typeof settingsDocument?.power_user?.theme === 'string'
        ? settingsDocument.power_user.theme
        : '';

    const [
        presetData,
        world_names,
        themeData,
        movingUIPresets,
        quickReplyEntries,
        instruct,
        context,
        sysprompt,
        reasoning,
    ] = await Promise.all([
        loadPresetResources({ selected, complete: !bootstrap, signal }),
        listWorldInfoNames({ signal }),
        bootstrap
            ? Promise.all([
                listThemeDirectory({ signal }),
                selectedThemeName ? readThemeDocument(selectedThemeName, { signal }) : Promise.resolve(null),
            ]).then(([directory, activeTheme]) => ({ directory, activeTheme }))
            : Promise.all([
                listThemeDirectory({ signal }),
                loadNamedDocumentEntries('themes', { signal }),
            ]).then(([directory, entries]) => ({ directory, entries })),
        loadNamedDocumentEntries('movingUI', { signal }),
        bootstrap ? [] : loadNamedDocumentEntries('quickReplies', { signal }),
        loadAdvancedPreset('instruct', { signal }),
        loadAdvancedPreset('context', { signal }),
        loadAdvancedPreset('sysprompt', { signal }),
        loadAdvancedPreset('reasoning', { signal }),
    ]);

    const themeDirectory = themeData.directory;
    const builtinSet = new Set(themeDirectory.builtin);
    let themes;
    let activeTheme = null;
    if (bootstrap) {
        activeTheme = themeData.activeTheme ?? null;
        themes = themeDirectory.names.map((name) => {
            if (activeTheme && activeTheme.name === name) {
                return activeTheme;
            }
            return { name, builtin: builtinSet.has(name), _summary: true };
        });
    } else {
        themes = stampNamedDocuments(themeData.entries);
        activeTheme = selectedThemeName
            ? (themes.find(t => t?.name === selectedThemeName) ?? null)
            : null;
    }

    return {
        ...presetData,
        settings: JSON.stringify(settingsDocument),
        world_names,
        themes,
        theme_directory: themeDirectory,
        active_theme: activeTheme,
        movingUIPresets: stampNamedDocuments(movingUIPresets),
        quickReplyPresets: bootstrap ? [] : stampNamedDocuments(quickReplyEntries),
        instruct,
        context,
        sysprompt,
        reasoning,
        enable_extensions: metadata.enable_extensions,
        enable_extensions_auto_update: metadata.enable_extensions_auto_update,
        enable_accounts: metadata.enable_accounts,
    };
}
