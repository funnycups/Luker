import { createDefaultPresets, makeIllustrationId } from './presets.js';

export const DEFAULT_ILLUSTRATION_SETTINGS = Object.freeze({
    enabled: false,
    autoGenerate: false,
    initialized: false,
    currentPresetId: '',
    presets: [],
    contextMessageCount: 10,
    maxConcurrentGenerations: 1,
    minGenerationInterval: 0,
    imageDisplayWidth: 100,
    studioSessions: {},
});

export const ILLUSTRATION_NUMBER_RULES = Object.freeze({
    contextMessageCount: { min: 0, max: 50, fallback: 10, integer: true },
    maxConcurrentGenerations: { min: 1, max: 5, fallback: 1, integer: true },
    minGenerationInterval: { min: 0, max: 10000, fallback: 0, integer: true },
    imageDisplayWidth: { min: 10, max: 100, fallback: 100, integer: true },
});

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
    };
}

export function normalizeIllustrationSettings(raw, { llm = {}, now = Date.now(), presetNames } = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const settings = {
        ...DEFAULT_ILLUSTRATION_SETTINGS,
        ...source,
        presets: Array.isArray(source.presets) ? source.presets.map(preset => normalizePreset(preset, now)).filter(Boolean) : [],
        studioSessions: source.studioSessions && typeof source.studioSessions === 'object' ? source.studioSessions : {},
    };
    delete settings.maxPromptsPerMessage;

    settings.enabled = Boolean(settings.enabled);
    settings.autoGenerate = Boolean(settings.autoGenerate);
    for (const [key, rule] of Object.entries(ILLUSTRATION_NUMBER_RULES)) {
        settings[key] = clampNumber(settings[key], rule);
    }

    if (!source.initialized) {
        settings.presets = createDefaultPresets({ llm, now, names: presetNames });
        settings.initialized = true;
    } else {
        settings.initialized = true;
    }

    const current = getPresetById(settings, settings.currentPresetId);
    settings.currentPresetId = current ? current.id : (settings.presets[0]?.id || '');
    return settings;
}

export function addPresetFromCurrent(settings, { name, llm = {}, now = Date.now() } = {}) {
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
    };
    settings.presets.push(preset);
    return preset;
}

export function updatePreset(settings, id, patch, now = Date.now()) {
    const preset = getPresetById(settings, id);
    if (!preset) {
        throw new Error(`Preset not found: ${id}`);
    }
    const allowed = ['name', 'illustrationPrompt', 'studioPrompt', 'llm'];
    for (const key of allowed) {
        if (!Object.hasOwn(patch || {}, key)) {
            continue;
        }
        if (key === 'llm') {
            preset.llm = {
                apiPresetName: String(patch.llm?.apiPresetName || ''),
                llmPresetName: String(patch.llm?.llmPresetName || ''),
            };
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
