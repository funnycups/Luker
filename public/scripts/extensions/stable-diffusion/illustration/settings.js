import { createDefaultPresets, makeIllustrationId } from './presets.js';

export const IMAGE_CONFIG_KEYS = Object.freeze([
    'source', 'model', 'sampler', 'scheduler', 'vae', 'steps', 'scale', 'width', 'height',
    'prompt_prefix', 'negative_prompt', 'style', 'restore_faces', 'enable_hr', 'adetailer_face',
    'hr_upscaler', 'hr_scale', 'denoising_strength', 'hr_second_pass_steps', 'clip_skip',
    'novel_anlas_guard', 'novel_sm', 'novel_sm_dyn', 'novel_decrisper', 'novel_variety_boost',
    'openai_style', 'openai_quality', 'openai_quality_gpt', 'openai_duration', 'comfy_type',
    'comfy_url', 'comfy_runpod_url', 'comfy_workflow', 'pollinations_enhance',
    'stability_style_preset', 'bfl_upsampling', 'google_api', 'google_enhance', 'google_duration',
    'horde', 'horde_nsfw', 'horde_karras', 'horde_sanitize',
]);

export const DEFAULT_ILLUSTRATION_SETTINGS = Object.freeze({
    enabled: false,
    autoGenerate: false,
    initialized: false,
    currentPresetId: '',
    presets: [],
    maxPromptsPerMessage: 5,
    contextMessageCount: 10,
    maxConcurrentGenerations: 1,
    minGenerationInterval: 0,
    imageDisplayWidth: 100,
    studioSessions: {},
});

export const ILLUSTRATION_NUMBER_RULES = Object.freeze({
    maxPromptsPerMessage: { min: 1, max: 30, fallback: 5, integer: true },
    contextMessageCount: { min: 0, max: 50, fallback: 10, integer: true },
    maxConcurrentGenerations: { min: 1, max: 5, fallback: 1, integer: true },
    minGenerationInterval: { min: 0, max: 10000, fallback: 0, integer: true },
    imageDisplayWidth: { min: 10, max: 100, fallback: 100, integer: true },
});

export function readImageConfig(sd) {
    const config = {};
    for (const key of IMAGE_CONFIG_KEYS) {
        config[key] = sd?.[key];
    }
    return config;
}

export function applyImageConfig(sd, config) {
    const applied = [];
    for (const key of IMAGE_CONFIG_KEYS) {
        if (!Object.hasOwn(config || {}, key) || config[key] === undefined) {
            continue;
        }
        sd[key] = config[key];
        applied.push(key);
    }
    return applied;
}

export function imageConfigFingerprint(config) {
    const entries = Object.keys(config || {})
        .filter(key => config[key] !== undefined)
        .sort()
        .map(key => [key, config[key]]);
    return JSON.stringify(entries);
}

export function getPresetById(settings, id) {
    const target = String(id || '');
    if (!target) {
        return null;
    }
    return settings?.presets?.find(preset => preset.id === target) || null;
}

function clampNumber(value, rule) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return rule.fallback;
    }
    const rounded = rule.integer ? Math.round(parsed) : parsed;
    return Math.min(rule.max, Math.max(rule.min, rounded));
}

function normalizePreset(raw, now) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const id = String(raw.id || '');
    if (!id) {
        return null;
    }
    return {
        id,
        name: String(raw.name || ''),
        createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : now,
        updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : now,
        illustrationPrompt: String(raw.illustrationPrompt || ''),
        studioPrompt: String(raw.studioPrompt || ''),
        llm: {
            apiPresetName: String(raw.llm?.apiPresetName || ''),
            llmPresetName: String(raw.llm?.llmPresetName || ''),
        },
        image: raw.image && typeof raw.image === 'object' ? structuredClone(raw.image) : {},
    };
}

export function normalizeIllustrationSettings(raw, { imageConfig = {}, llm = {}, now = Date.now(), presetNames } = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const settings = {
        ...DEFAULT_ILLUSTRATION_SETTINGS,
        ...source,
        presets: Array.isArray(source.presets) ? source.presets.map(preset => normalizePreset(preset, now)).filter(Boolean) : [],
        studioSessions: source.studioSessions && typeof source.studioSessions === 'object' ? source.studioSessions : {},
    };

    settings.enabled = Boolean(settings.enabled);
    settings.autoGenerate = Boolean(settings.autoGenerate);
    for (const [key, rule] of Object.entries(ILLUSTRATION_NUMBER_RULES)) {
        settings[key] = clampNumber(settings[key], rule);
    }

    if (!source.initialized) {
        settings.presets = createDefaultPresets({ imageConfig, llm, now, names: presetNames });
        settings.initialized = true;
    } else {
        settings.initialized = true;
    }

    const current = getPresetById(settings, settings.currentPresetId);
    settings.currentPresetId = current ? current.id : (settings.presets[0]?.id || '');
    return settings;
}

export function addPresetFromCurrent(settings, { name, imageConfig = {}, llm = {}, now = Date.now() } = {}) {
    const template = getPresetById(settings, settings?.currentPresetId) || settings?.presets?.[0];
    const preset = {
        id: makeIllustrationId('preset'),
        name: String(name || ''),
        createdAt: now,
        updatedAt: now,
        illustrationPrompt: String(template?.illustrationPrompt || ''),
        studioPrompt: String(template?.studioPrompt || ''),
        llm: {
            apiPresetName: String(llm?.apiPresetName || ''),
            llmPresetName: String(llm?.llmPresetName || ''),
        },
        image: structuredClone(imageConfig),
    };
    settings.presets.push(preset);
    return preset;
}

export function updatePreset(settings, id, patch, now = Date.now()) {
    const preset = getPresetById(settings, id);
    if (!preset) {
        throw new Error(`Preset not found: ${id}`);
    }
    const allowed = ['name', 'illustrationPrompt', 'studioPrompt', 'llm', 'image'];
    for (const key of allowed) {
        if (!Object.hasOwn(patch || {}, key)) {
            continue;
        }
        if (key === 'llm') {
            preset.llm = {
                apiPresetName: String(patch.llm?.apiPresetName || ''),
                llmPresetName: String(patch.llm?.llmPresetName || ''),
            };
        } else if (key === 'image') {
            preset.image = structuredClone(patch.image || {});
        } else {
            preset[key] = String(patch[key] ?? '');
        }
    }
    preset.updatedAt = now;
    return preset;
}

export function deletePreset(settings, id) {
    const target = String(id || '');
    const index = settings?.presets?.findIndex(preset => preset.id === target) ?? -1;
    if (index < 0) {
        throw new Error(`Preset not found: ${id}`);
    }
    settings.presets.splice(index, 1);
    if (settings.currentPresetId === target) {
        settings.currentPresetId = settings.presets[0]?.id || '';
    }
    return settings.currentPresetId;
}

export function selectPreset(settings, id) {
    const preset = getPresetById(settings, id);
    if (!preset) {
        throw new Error(`Preset not found: ${id}`);
    }
    settings.currentPresetId = preset.id;
}
