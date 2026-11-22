export const GENERATION_CONFIG_KEYS = Object.freeze([
    'source',
    'model',
    'vae',
    'sampler',
    'scheduler',
    'steps',
    'scale',
    'width',
    'height',
    'prompt_prefix',
    'negative_prompt',
    'style',
    'restore_faces',
    'enable_hr',
    'adetailer_face',
    'hr_upscaler',
    'hr_scale',
    'denoising_strength',
    'hr_second_pass_steps',
    'clip_skip',
    'auto_url',
    'auto_auth',
    'sdcpp_url',
    'vlad_url',
    'vlad_auth',
    'drawthings_url',
    'drawthings_auth',
    'novel_anlas_guard',
    'novel_sm',
    'novel_sm_dyn',
    'novel_decrisper',
    'novel_variety_boost',
    'openai_style',
    'openai_quality',
    'openai_quality_gpt',
    'openai_duration',
    'comfy_type',
    'comfy_url',
    'comfy_runpod_url',
    'comfy_workflow',
    'comfy_placeholders',
    'pollinations_enhance',
    'stability_style_preset',
    'bfl_upsampling',
    'electronhub_quality',
    'huggingface_model_id',
    'google_api',
    'google_enhance',
    'google_duration',
    'horde',
    'horde_nsfw',
    'horde_karras',
    'horde_sanitize',
    'connection_profile',
    'novel_url',
    'chat_image_url',
    'style_references',
    'character_reference_enabled',
    'character_reference_mode',
    'style_references_enabled',
    'img2img_enabled',
]);

export const CHARACTER_REFERENCE_MODES = Object.freeze(['text_only', 'image_only', 'text_and_image']);

/**
 * Normalizes preset-scoped reference and img2img switches to valid defaults.
 * Legacy presets with non-empty `style_references` and omitted `style_references_enabled` migrate to `true`.
 *
 * @param {object} [raw]
 * @returns {{ character_reference_enabled: boolean, character_reference_mode: 'text_only' | 'image_only' | 'text_and_image', style_references_enabled: boolean, img2img_enabled: boolean }}
 */
export function normalizeReferenceSettings(raw) {
    const mode = raw?.character_reference_mode;
    const hasLegacyStyleRefs = Array.isArray(raw?.style_references) && raw.style_references.length > 0;
    const styleEnabled = raw?.style_references_enabled === undefined
        ? hasLegacyStyleRefs
        : Boolean(raw.style_references_enabled);
    return {
        character_reference_enabled: Boolean(raw?.character_reference_enabled),
        character_reference_mode: CHARACTER_REFERENCE_MODES.includes(mode) ? mode : 'text_only',
        style_references_enabled: styleEnabled,
        img2img_enabled: Boolean(raw?.img2img_enabled),
    };
}

function cloneConfigValue(key, value) {
    if (key === 'comfy_placeholders') {
        return structuredClone(value);
    }
    if (key === 'style_references') {
        return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : [];
    }
    return value;
}

function requireObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
}

export function pickGenerationConfig(sd) {
    requireObject(sd, 'Generation settings');
    const config = {};
    for (const key of GENERATION_CONFIG_KEYS) {
        if (!Object.hasOwn(sd, key)) {
            continue;
        }
        config[key] = cloneConfigValue(key, sd[key]);
    }
    return config;
}

function makeGenerationPresetId(presets, now) {
    const base = `genpreset_${now}`;
    if (!presets.some(preset => preset.id === base)) {
        return base;
    }
    let suffix = 1;
    while (presets.some(preset => preset.id === `${base}_${suffix}`)) {
        suffix += 1;
    }
    return `${base}_${suffix}`;
}

export function normalizeGenerationPreset(raw, now = Date.now()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const id = String(raw.id ?? '');
    if (!id) {
        return null;
    }
    if (!raw.config || typeof raw.config !== 'object' || Array.isArray(raw.config)) {
        return null;
    }
    const config = {
        ...pickGenerationConfig(raw.config),
        ...normalizeReferenceSettings(raw.config),
    };
    return {
        id,
        name: String(raw.name ?? ''),
        config,
        createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : now,
        updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : now,
    };
}

export function normalizeGenerationPresets(raw, { currentConfig, defaultName, now = Date.now() } = {}) {
    if (raw === undefined) {
        const presets = [];
        const preset = {
            id: makeGenerationPresetId(presets, now),
            name: String(defaultName ?? ''),
            config: pickGenerationConfig(currentConfig ?? {}),
            createdAt: now,
            updatedAt: now,
        };
        presets.push(preset);
        return { currentId: preset.id, presets };
    }
    requireObject(raw, 'Generation presets');
    const presets = Array.isArray(raw.presets)
        ? raw.presets.map(preset => normalizeGenerationPreset(preset, now)).filter(Boolean)
        : [];
    const currentId = presets.some(preset => preset.id === raw.currentId)
        ? raw.currentId
        : (presets[0]?.id ?? '');
    return { currentId, presets };
}

export function getGenerationPreset(bucket, id) {
    const target = String(id ?? '');
    if (!target) {
        return null;
    }
    return bucket?.presets?.find(preset => preset.id === target) ?? null;
}

export function createGenerationPreset(bucket, { name, config, now = Date.now() } = {}) {
    requireObject(config, 'Generation preset config');
    const presetName = String(name ?? '');
    if (bucket.presets.some(preset => preset.name === presetName)) {
        throw new Error(`Generation preset name already exists: ${presetName}`);
    }
    const preset = {
        id: makeGenerationPresetId(bucket.presets, now),
        name: presetName,
        config: pickGenerationConfig(config),
        createdAt: now,
        updatedAt: now,
    };
    bucket.presets.push(preset);
    return preset;
}

export function renameGenerationPreset(bucket, id, name, now = Date.now()) {
    const preset = getGenerationPreset(bucket, id);
    if (!preset) {
        throw new Error(`Generation preset not found: ${id}`);
    }
    const presetName = String(name ?? '');
    if (bucket.presets.some(entry => entry.id !== preset.id && entry.name === presetName)) {
        throw new Error(`Generation preset name already exists: ${presetName}`);
    }
    preset.name = presetName;
    preset.updatedAt = now;
    return preset;
}

export function deleteGenerationPreset(bucket, id) {
    const target = String(id ?? '');
    const index = bucket?.presets?.findIndex(preset => preset.id === target) ?? -1;
    if (index < 0) {
        throw new Error(`Generation preset not found: ${id}`);
    }
    bucket.presets.splice(index, 1);
    if (bucket.currentId === target) {
        bucket.currentId = bucket.presets[0]?.id ?? '';
    }
    return bucket.currentId;
}

export function selectGenerationPreset(bucket, id) {
    const preset = getGenerationPreset(bucket, id);
    if (!preset) {
        throw new Error(`Generation preset not found: ${id}`);
    }
    bucket.currentId = preset.id;
}

export function applyGenerationConfig(sd, config) {
    requireObject(sd, 'Generation settings');
    requireObject(config, 'Generation preset config');
    const applied = [];
    for (const key of GENERATION_CONFIG_KEYS) {
        if (!Object.hasOwn(config, key)) {
            continue;
        }
        sd[key] = cloneConfigValue(key, config[key]);
        applied.push(key);
    }
    const normalizedRefs = normalizeReferenceSettings(config);
    for (const [key, value] of Object.entries(normalizedRefs)) {
        sd[key] = value;
    }
    return applied;
}

export function syncGenerationPresetFromSettings(bucket, sd, { now = Date.now(), omitKeys = [] } = {}) {
    const preset = getGenerationPreset(bucket, bucket?.currentId);
    if (!preset) {
        return null;
    }
    const omitted = new Set(omitKeys);
    const config = pickGenerationConfig(sd);
    for (const key of Object.keys(config)) {
        if (omitted.has(key)) {
            continue;
        }
        preset.config[key] = config[key];
    }
    preset.updatedAt = now;
    return preset;
}

export function patchGenerationPresetConfig(bucket, id, patch, now = Date.now()) {
    const preset = getGenerationPreset(bucket, id);
    if (!preset) {
        return null;
    }
    requireObject(patch, 'Generation preset patch');
    const config = pickGenerationConfig(patch);
    for (const key of Object.keys(config)) {
        preset.config[key] = config[key];
    }
    preset.updatedAt = now;
    return preset;
}
