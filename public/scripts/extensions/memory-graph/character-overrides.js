/**
 * Per-character override layer for memory-graph settings.
 *
 * SillyTavern stores per-character extension data inside the character
 * card's `data.extensions[MODULE_NAME]` blob. Memory-graph uses two
 * keys in that blob:
 *
 *  - `schemaOverride`   replaces the global node-type schema for
 *                       conversations with this specific character.
 *  - `advancedOverride` patches the global advanced settings (recall
 *                       layout, compression knobs, etc.) for this
 *                       character only.
 *
 * Reading goes through `extension_settings[MODULE_NAME]` first and then
 * applies the per-character override on top via `getEffective*`. Writing
 * goes through `context.writeExtensionField`.
 *
 * Removal is implemented as an explicit `null` write rather than key
 * deletion because `writeExtensionField` merges instead of replaces.
 *
 * To keep this module decoupled from main.js, callers wire an explicit
 * `deps` object once at module bootstrap (`configure({...})`) carrying:
 *   - `MODULE_NAME`               extension blob key on the character card
 *   - `defaultSettings`           global defaults used as a normalization
 *                                 fallback when overrides are read
 *   - `normalizeNodeTypeSchema`   schema canonicalizer
 *   - `normalizeAdvancedSettings` advanced-settings canonicalizer
 *   - `getSettings`               accessor for the current global settings
 */

import { getContext } from '../../extensions.js';

let deps = {
    MODULE_NAME: 'memory_graph',
    defaultSettings: {},
    normalizeNodeTypeSchema: (schema) => schema,
    normalizeAdvancedSettings: (settings) => settings,
    getSettings: () => ({}),
};

const CHARACTER_SCHEMA_OVERRIDE_KEY = 'schemaOverride';
const CHARACTER_ADVANCED_OVERRIDE_KEY = 'advancedOverride';

/**
 * Wire the cross-module dependencies. Call once at extension init from
 * main.js so subsequent calls to the `getEffective*` / `persist*` helpers
 * see the right defaults.
 */
export function configure(next) {
    deps = { ...deps, ...next };
}

export function getCurrentAvatar(context) {
    const ctx = context || getContext();
    return String(ctx?.characters?.[ctx?.characterId]?.avatar || '').trim();
}

export function getCharacterByAvatar(context, avatar) {
    const target = String(avatar || '').trim();
    if (!target) {
        return null;
    }
    return (context?.characters || []).find((item) => String(item?.avatar || '').trim() === target) || null;
}

export function getCharacterIndexByAvatar(context, avatar) {
    const target = String(avatar || '').trim();
    if (!target) {
        return -1;
    }
    return (context?.characters || []).findIndex((item) => String(item?.avatar || '').trim() === target);
}

export function getCharacterDisplayNameByAvatar(context, avatar) {
    const character = getCharacterByAvatar(context, avatar);
    return String(character?.name || avatar || '').trim();
}

export function getCharacterExtensionDataByAvatar(context, avatar) {
    const character = getCharacterByAvatar(context, avatar);
    const payload = character?.data?.extensions?.[deps.MODULE_NAME];
    return payload && typeof payload === 'object' ? payload : {};
}

export function getCharacterSchemaOverrideByAvatar(context, avatar) {
    const extensionData = getCharacterExtensionDataByAvatar(context, avatar);
    const schema = extensionData?.[CHARACTER_SCHEMA_OVERRIDE_KEY];
    if (!Array.isArray(schema) || schema.length === 0) {
        return null;
    }
    return deps.normalizeNodeTypeSchema(schema);
}

export function getCharacterAdvancedOverrideByAvatar(context, avatar) {
    const extensionData = getCharacterExtensionDataByAvatar(context, avatar);
    const override = extensionData?.[CHARACTER_ADVANCED_OVERRIDE_KEY];
    if (!override || typeof override !== 'object') {
        return null;
    }
    return deps.normalizeAdvancedSettings(override, deps.defaultSettings);
}

export function getEffectiveAdvancedSettings(context = null, settings = null) {
    const ctx = context || getContext();
    const currentSettings = settings || deps.getSettings();
    const base = deps.normalizeAdvancedSettings(currentSettings, deps.defaultSettings);
    const avatar = getCurrentAvatar(ctx);
    const override = avatar ? getCharacterAdvancedOverrideByAvatar(ctx, avatar) : null;
    if (!override) {
        return base;
    }
    return deps.normalizeAdvancedSettings({ ...base, ...override }, base);
}

export function getEffectiveSettings(context = null, settings = null) {
    const base = settings || deps.getSettings();
    return {
        ...base,
        ...getEffectiveAdvancedSettings(context, base),
    };
}

export function getEffectiveNodeTypeSchema(context = null, settings = null) {
    const ctx = context || getContext();
    const currentSettings = settings || deps.getSettings();
    const avatar = getCurrentAvatar(ctx);
    const overrideSchema = getCharacterSchemaOverrideByAvatar(ctx, avatar);
    if (overrideSchema && overrideSchema.length > 0) {
        return overrideSchema;
    }
    return deps.normalizeNodeTypeSchema(currentSettings?.nodeTypeSchema);
}

export function getSchemaScopeInfo(context = null, settings = null) {
    const ctx = context || getContext();
    const currentSettings = settings || deps.getSettings();
    const avatar = getCurrentAvatar(ctx);
    const hasAvatar = Boolean(avatar);
    const characterName = hasAvatar ? getCharacterDisplayNameByAvatar(ctx, avatar) : '';
    const overrideSchema = hasAvatar ? getCharacterSchemaOverrideByAvatar(ctx, avatar) : null;
    const hasOverride = Array.isArray(overrideSchema) && overrideSchema.length > 0;
    const effectiveSchema = hasOverride
        ? overrideSchema
        : deps.normalizeNodeTypeSchema(currentSettings?.nodeTypeSchema);
    return {
        avatar,
        hasAvatar,
        characterName,
        hasOverride,
        scope: hasOverride ? 'character' : 'global',
        schema: effectiveSchema,
    };
}

export function getAdvancedScopeInfo(context = null, settings = null) {
    const ctx = context || getContext();
    const currentSettings = settings || deps.getSettings();
    const avatar = getCurrentAvatar(ctx);
    const hasAvatar = Boolean(avatar);
    const characterName = hasAvatar ? getCharacterDisplayNameByAvatar(ctx, avatar) : '';
    const overrideSettings = hasAvatar ? getCharacterAdvancedOverrideByAvatar(ctx, avatar) : null;
    const hasOverride = Boolean(overrideSettings);
    const effectiveSettings = hasOverride
        ? deps.normalizeAdvancedSettings(overrideSettings, currentSettings)
        : deps.normalizeAdvancedSettings(currentSettings, deps.defaultSettings);
    return {
        avatar,
        hasAvatar,
        characterName,
        hasOverride,
        scope: hasOverride ? 'character' : 'global',
        settings: effectiveSettings,
    };
}

export async function persistCharacterSchemaOverride(context, avatar, schema) {
    const target = String(avatar || '').trim();
    if (!target || typeof context?.writeExtensionField !== 'function') {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }
    const previous = getCharacterExtensionDataByAvatar(context, target);
    const next = {
        ...previous,
        [CHARACTER_SCHEMA_OVERRIDE_KEY]: deps.normalizeNodeTypeSchema(schema),
    };
    await context.writeExtensionField(characterIndex, deps.MODULE_NAME, next);
    return true;
}

export async function removeCharacterSchemaOverride(context, avatar) {
    const target = String(avatar || '').trim();
    if (!target || typeof context?.writeExtensionField !== 'function') {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }
    const previous = getCharacterExtensionDataByAvatar(context, target);
    if (!Object.prototype.hasOwnProperty.call(previous, CHARACTER_SCHEMA_OVERRIDE_KEY)) {
        return true;
    }
    const next = { ...previous };
    // writeExtensionField() persists via merge-attributes, so removals must be
    // sent as explicit nulls instead of omitted keys.
    next[CHARACTER_SCHEMA_OVERRIDE_KEY] = null;
    await context.writeExtensionField(characterIndex, deps.MODULE_NAME, next);
    return true;
}

export async function persistCharacterAdvancedOverride(context, avatar, advancedSettings) {
    const target = String(avatar || '').trim();
    if (!target || typeof context?.writeExtensionField !== 'function') {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }
    const previous = getCharacterExtensionDataByAvatar(context, target);
    const next = {
        ...previous,
        [CHARACTER_ADVANCED_OVERRIDE_KEY]: deps.normalizeAdvancedSettings(advancedSettings, deps.defaultSettings),
    };
    await context.writeExtensionField(characterIndex, deps.MODULE_NAME, next);
    return true;
}

export async function removeCharacterAdvancedOverride(context, avatar) {
    const target = String(avatar || '').trim();
    if (!target || typeof context?.writeExtensionField !== 'function') {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }
    const previous = getCharacterExtensionDataByAvatar(context, target);
    if (!Object.prototype.hasOwnProperty.call(previous, CHARACTER_ADVANCED_OVERRIDE_KEY)) {
        return true;
    }
    const next = { ...previous };
    // writeExtensionField() persists via merge-attributes, so removals must be
    // sent as explicit nulls instead of omitted keys.
    next[CHARACTER_ADVANCED_OVERRIDE_KEY] = null;
    await context.writeExtensionField(characterIndex, deps.MODULE_NAME, next);
    return true;
}
