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
 * goes through `context.writeExtensionField`, which replaces the whole
 * `data.extensions.memory_graph` value on disk. The persist helpers below
 * read the previous blob and spread it before overlaying the new key, so
 * sibling overrides (e.g. schemaOverride when writing advancedOverride)
 * survive the round-trip.
 *
 * Removal is implemented via the `UNSET_VALUE` sentinel. Since
 * `writeExtensionField` is replace-mode, omitting a subkey on the new
 * blob already drops it — but `UNSET_VALUE` is still the way to remove
 * a key from the blob's payload without changing the rest of the shape
 * (the server's `processUnsetSentinels` sweep deletes it post-merge).
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

const getContext = Luker.getContext;
const UNSET_VALUE = Luker.getContext().constants.unset;

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
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
        return null;
    }
    if (Object.keys(override).length === 0) {
        return null;
    }
    // Return the raw sparse payload. The caller merges it over the normalized
    // globals, so filling every registered key here would mask global edits
    // with stale per-card copies.
    return { ...override };
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
    // Inject the effective nodeTypeSchema so consumers reading
    // `settings.nodeTypeSchema` directly (retriever.js, fallback paths in
    // main.js, etc.) see the character override instead of the raw global
    // schema. Without this, getEffectiveSettings only carried advanced-key
    // overrides and the schema override was lost on the read path.
    return {
        ...base,
        ...getEffectiveAdvancedSettings(context, base),
        nodeTypeSchema: getEffectiveNodeTypeSchema(context, base),
    };
}

export function getEffectiveNodeTypeSchema(context = null, settings = null) {
    const ctx = context || getContext();
    const currentSettings = settings || deps.getSettings();
    const avatar = getCurrentAvatar(ctx);
    const overrideSchema = getCharacterSchemaOverrideByAvatar(ctx, avatar);
    if (overrideSchema && overrideSchema.length > 0) {
        return deps.normalizeNodeTypeSchema(overrideSchema);
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
    const effectiveSettings = getEffectiveAdvancedSettings(ctx, currentSettings);
    return {
        avatar,
        hasAvatar,
        characterName,
        hasOverride,
        scope: hasOverride ? 'character' : 'global',
        settings: effectiveSettings,
    };
}

export async function persistCharacterSchemaOverride(context, avatar, schema, options = {}) {
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
    if (options?.requireSaved) {
        await context.writeExtensionField(characterIndex, deps.MODULE_NAME, next, { requireSaved: true });
    } else {
        await context.writeExtensionField(characterIndex, deps.MODULE_NAME, next);
    }
    return true;
}

export async function removeCharacterSchemaOverride(context, avatar, options = {}) {
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
    // Use UNSET_VALUE so the server's processUnsetSentinels sweep deletes
    // the key from the on-disk blob. Plain `null` would only set the field
    // to null and leave the key in place.
    next[CHARACTER_SCHEMA_OVERRIDE_KEY] = UNSET_VALUE;
    if (options?.requireSaved) {
        await context.writeExtensionField(characterIndex, deps.MODULE_NAME, next, { requireSaved: true });
    } else {
        await context.writeExtensionField(characterIndex, deps.MODULE_NAME, next);
    }
    return true;
}

/**
 * Apply a sparse patch to the card's advanced-settings override.
 *
 * Reads the raw sparse object, shallow-copies it, writes `patch.set`, deletes
 * `patch.unset` keys, and writes the result back. The payload is not
 * normalized: only the keys the caller touched differ from the globals. When
 * no keys remain, the `UNSET_VALUE` sentinel clears the blob slot. Sibling
 * keys such as `schemaOverride` pass through untouched. A failed write
 * propagates to the caller.
 */
export async function persistCharacterAdvancedOverridePatch(context, avatar, patch = {}, options = {}) {
    const target = String(avatar || '').trim();
    if (!target || typeof context?.writeExtensionField !== 'function') {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }
    const previous = getCharacterExtensionDataByAvatar(context, target);
    const nextOverride = { ...(getCharacterAdvancedOverrideByAvatar(context, target) || {}) };
    const setValues = patch?.set && typeof patch.set === 'object' ? patch.set : {};
    Object.assign(nextOverride, setValues);
    const unsetKeys = Array.isArray(patch?.unset) ? patch.unset : [];
    for (const key of unsetKeys) {
        delete nextOverride[String(key)];
    }
    const next = {
        ...previous,
        [CHARACTER_ADVANCED_OVERRIDE_KEY]: Object.keys(nextOverride).some(key => key !== 'promptDefaultsInitialized')
            ? { ...nextOverride, promptDefaultsInitialized: true }
            : UNSET_VALUE,
    };
    if (options?.requireSaved) {
        await context.writeExtensionField(characterIndex, deps.MODULE_NAME, next, { requireSaved: true });
    } else {
        await context.writeExtensionField(characterIndex, deps.MODULE_NAME, next);
    }
    return true;
}

/**
 * Legacy full-snapshot write path: normalizes `advancedSettings` into all
 * registered keys and replaces the card's `advancedOverride` with it. New
 * writes go through {@link persistCharacterAdvancedOverridePatch} so the card
 * only stores the keys that differ from the globals.
 */
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
        [CHARACTER_ADVANCED_OVERRIDE_KEY]: {
            ...deps.normalizeAdvancedSettings(advancedSettings, deps.defaultSettings),
            promptDefaultsInitialized: true,
        },
    };
    await context.writeExtensionField(characterIndex, deps.MODULE_NAME, next, { requireSaved: true });
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
    // Same reasoning as removeCharacterSchemaOverride: use UNSET_VALUE so
    // the server actually deletes the key instead of leaving a null value.
    next[CHARACTER_ADVANCED_OVERRIDE_KEY] = UNSET_VALUE;
    await context.writeExtensionField(characterIndex, deps.MODULE_NAME, next);
    return true;
}
