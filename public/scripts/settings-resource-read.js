import { assembleResourceFields, loadResourceBootstrap } from './resource-read.js';
import { assembleJsonFields } from './util/resource-fields.js';
import {
    listWorldInfoNames,
    loadNamedDocumentEntries,
    loadPresetDocumentEntries,
    loadPresetResources,
    stampNamedDocuments,
} from './named-resource-read.js';

function selectedPresetNames(settings) {
    return {
        novel: settings?.preset_settings_novel,
        openai: settings?.oai_settings?.preset_settings_openai ?? settings?.preset_settings_openai,
        textgenerationwebui: settings?.textgenerationwebui_settings?.preset,
        kobold: settings?.kai_settings?.preset_settings ?? settings?.preset_settings,
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
    const selected = selectedPresetNames(settingsDocument);

    const [
        presetData,
        world_names,
        themes,
        movingUIPresets,
        quickReplyEntries,
        instruct,
        context,
        sysprompt,
        reasoning,
    ] = await Promise.all([
        loadPresetResources({ selected, complete: !bootstrap, signal }),
        listWorldInfoNames({ signal }),
        loadNamedDocumentEntries('themes', { signal }),
        loadNamedDocumentEntries('movingUI', { signal }),
        bootstrap ? [] : loadNamedDocumentEntries('quickReplies', { signal }),
        loadAdvancedPreset('instruct', { signal }),
        loadAdvancedPreset('context', { signal }),
        loadAdvancedPreset('sysprompt', { signal }),
        loadAdvancedPreset('reasoning', { signal }),
    ]);

    return {
        ...presetData,
        settings: JSON.stringify(settingsDocument),
        world_names,
        themes: stampNamedDocuments(themes),
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
