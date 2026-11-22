import {
    DEFAULT_ILLUSTRATION_PROMPT,
    DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
    DEFAULT_STUDIO_PROMPT,
    DEFAULT_NATURAL_STUDIO_PROMPT,
    LEGACY_DEFAULT_ILLUSTRATION_PROMPT,
    LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
    V1_DEFAULT_ILLUSTRATION_PROMPT,
    V1_DEFAULT_NATURAL_ILLUSTRATION_PROMPT,
    createDefaultPresets,
    getDefaultPromptValues,
    makeIllustrationId,
} from './presets.js';
import { DEFAULT_EXPLORATION_PROMPT } from '../exploration/prompts.js';

const STYLE_PROMPT_FIELDS = ['illustrationPrompt', 'studioPrompt'];
const PROMPT_FIELDS = [...STYLE_PROMPT_FIELDS, 'explorationPrompt'];

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

function normalizePendingCharacterDesignPrompts(rawList) {
    if (!Array.isArray(rawList)) return [];
    const seen = new Set();
    const out = [];
    for (const item of rawList) {
        if (!item || typeof item !== 'object') continue;
        const presetId = String(item.presetId || '').trim();
        const text = typeof item.text === 'string' ? item.text : '';
        if (!presetId || !text.trim() || seen.has(presetId)) continue;
        seen.add(presetId);
        out.push({
            presetId,
            presetName: String(item.presetName || presetId),
            text,
        });
    }
    return out;
}

export function exportPendingCharacterDesignPromptsContent(entries) {
    const list = normalizePendingCharacterDesignPrompts(entries);
    return list.map(entry => [
        `=== ${entry.presetName} (${entry.presetId}) ===`,
        entry.text,
    ].join('\n')).join('\n\n');
}

export function clearPendingCharacterDesignPrompts(settings, presetIds = null) {
    if (!settings || typeof settings !== 'object') return;
    if (presetIds === null) {
        delete settings.pendingCharacterDesignPrompts;
        return;
    }
    const removeSet = new Set(Array.isArray(presetIds) ? presetIds.map(id => String(id || '').trim()) : []);
    const remaining = normalizePendingCharacterDesignPrompts(settings.pendingCharacterDesignPrompts)
        .filter(entry => !removeSet.has(entry.presetId));
    if (remaining.length > 0) {
        settings.pendingCharacterDesignPrompts = remaining;
    } else {
        delete settings.pendingCharacterDesignPrompts;
    }
}

function deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        return a.length === b.length && a.every((item, idx) => deepEqual(item, b[idx]));
    }
    const keysA = Object.keys(a).filter(k => a[k] !== undefined);
    const keysB = Object.keys(b).filter(k => b[k] !== undefined);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

function normalizePreset(raw, now) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const id = String(raw.id || '');
    if (!id) {
        return null;
    }
    const preset = {
        id,
        name: String(raw.name || ''),
        createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : now,
        updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : now,
        illustrationPrompt: String(raw.illustrationPrompt ?? ''),
        studioPrompt: String(raw.studioPrompt || ''),
        explorationPrompt: String(raw.explorationPrompt || ''),
        llm: {
            apiPresetName: String(raw.llm?.apiPresetName || ''),
            llmPresetName: String(raw.llm?.llmPresetName || ''),
        },
        explorationLlm: {
            apiPresetName: String(raw.explorationLlm?.apiPresetName || ''),
            llmPresetName: String(raw.explorationLlm?.llmPresetName || ''),
        },
        visualInspection: Boolean(raw.visualInspection),
        promptDefaultsInitialized: raw.promptDefaultsInitialized === true,
    };
    if (raw.promptStyle === 'tag' || raw.promptStyle === 'natural') {
        preset.promptStyle = raw.promptStyle;
    }
    const pending = STYLE_PROMPT_FIELDS.filter(field => (raw.pendingStyleDefaults ?? []).includes(field));
    if (pending.length) preset.pendingStyleDefaults = pending;
    return preset;
}

function exactLegacyPromptStyle(preset) {
    if (preset.promptStyle) return preset.promptStyle;
    const styles = [];
    if ([DEFAULT_ILLUSTRATION_PROMPT, V1_DEFAULT_ILLUSTRATION_PROMPT, LEGACY_DEFAULT_ILLUSTRATION_PROMPT].includes(preset.illustrationPrompt)
        || preset.studioPrompt === DEFAULT_STUDIO_PROMPT) styles.push('tag');
    if ([DEFAULT_NATURAL_ILLUSTRATION_PROMPT, V1_DEFAULT_NATURAL_ILLUSTRATION_PROMPT, LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT].includes(preset.illustrationPrompt)
        || preset.studioPrompt === DEFAULT_NATURAL_STUDIO_PROMPT) styles.push('natural');
    return styles.length === 1 ? styles[0] : undefined;
}

export function migrateIllustrationPromptSettings(raw, options = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const existingPending = normalizePendingCharacterDesignPrompts(source.pendingCharacterDesignPrompts);
    const pendingById = new Map(existingPending.map(entry => [entry.presetId, entry]));
    if (Array.isArray(source.presets)) {
        for (const rawPreset of source.presets) {
            if (!rawPreset || typeof rawPreset !== 'object') continue;
            const presetId = String(rawPreset.id || '').trim();
            const rawDesign = typeof rawPreset.characterDesignPrompt === 'string' ? rawPreset.characterDesignPrompt : '';
            if (!presetId || !rawDesign.trim() || pendingById.has(presetId)) continue;
            pendingById.set(presetId, {
                presetId,
                presetName: String(rawPreset.name || presetId),
                text: rawDesign,
            });
        }
    }

    const settings = normalizeIllustrationSettings(raw, options);
    for (const preset of settings.presets) {
        if (preset.illustrationPrompt === V1_DEFAULT_ILLUSTRATION_PROMPT) {
            preset.illustrationPrompt = DEFAULT_ILLUSTRATION_PROMPT;
        } else if (preset.illustrationPrompt === V1_DEFAULT_NATURAL_ILLUSTRATION_PROMPT) {
            preset.illustrationPrompt = DEFAULT_NATURAL_ILLUSTRATION_PROMPT;
        }
        if (preset.promptDefaultsInitialized) continue;
        const style = exactLegacyPromptStyle(preset);
        if (style) preset.promptStyle = style;
        if (preset.illustrationPrompt === LEGACY_DEFAULT_ILLUSTRATION_PROMPT) {
            preset.illustrationPrompt = DEFAULT_ILLUSTRATION_PROMPT;
        } else if (preset.illustrationPrompt === LEGACY_DEFAULT_NATURAL_ILLUSTRATION_PROMPT) {
            preset.illustrationPrompt = DEFAULT_NATURAL_ILLUSTRATION_PROMPT;
        }
        const defaults = style ? getDefaultPromptValues(style) : { explorationPrompt: DEFAULT_EXPLORATION_PROMPT };
        const pending = [];
        for (const field of PROMPT_FIELDS) {
            if (preset[field].trim()) continue;
            if (Object.hasOwn(defaults, field)) preset[field] = defaults[field];
            else pending.push(field);
        }
        if (pending.length) preset.pendingStyleDefaults = pending;
        else delete preset.pendingStyleDefaults;
        preset.promptDefaultsInitialized = true;
    }

    const pendingCharacterDesignPrompts = [...pendingById.values()];
    if (pendingCharacterDesignPrompts.length > 0) {
        settings.pendingCharacterDesignPrompts = pendingCharacterDesignPrompts;
    } else {
        delete settings.pendingCharacterDesignPrompts;
    }
    const changed = !raw || typeof raw !== 'object' || !deepEqual(raw, settings);
    return {
        settings,
        pendingCharacterDesignPrompts,
        changed,
    };
}

export function normalizeIllustrationSettings(raw, { llm = {}, now = Date.now(), presetNames } = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const settings = {
        ...DEFAULT_ILLUSTRATION_SETTINGS,
        ...source,
        presets: Array.isArray(source.presets) ? source.presets.map(preset => normalizePreset(preset, now)).filter(Boolean) : [],
    };
    if (Object.hasOwn(source, 'studioSessions') && source.studioSessions && typeof source.studioSessions === 'object') {
        settings.studioSessions = source.studioSessions;
    } else {
        delete settings.studioSessions;
    }
    const pendingLegacy = normalizePendingCharacterDesignPrompts(source.pendingCharacterDesignPrompts);
    if (pendingLegacy.length > 0) {
        settings.pendingCharacterDesignPrompts = pendingLegacy;
    } else {
        delete settings.pendingCharacterDesignPrompts;
    }
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

export function addPresetFromCurrent(settings, { name, promptStyle, llm = {}, now = Date.now() } = {}) {
    const template = getPresetById(settings, settings?.currentPresetId) || settings?.presets?.[0];
    const style = promptStyle ?? template?.promptStyle;
    if (!style) {
        throw new Error('Select a prompt style before creating a preset.');
    }
    const defaults = getDefaultPromptValues(style);
    const preset = {
        id: makeIllustrationId('preset'),
        name: String(name || ''),
        promptStyle: style,
        promptDefaultsInitialized: true,
        createdAt: now,
        updatedAt: now,
        illustrationPrompt: String(template?.illustrationPrompt || ''),
        studioPrompt: String(template?.studioPrompt || ''),
        explorationPrompt: String(template?.explorationPrompt || ''),
        llm: {
            apiPresetName: String(llm?.apiPresetName || ''),
            llmPresetName: String(llm?.llmPresetName || ''),
        },
        explorationLlm: {
            apiPresetName: String(template?.explorationLlm?.apiPresetName || ''),
            llmPresetName: String(template?.explorationLlm?.llmPresetName || ''),
        },
        visualInspection: Boolean(template?.visualInspection),
    };
    for (const field of PROMPT_FIELDS) {
        if (!preset[field].trim()) preset[field] = defaults[field];
    }
    settings.presets.push(preset);
    return preset;
}

export function updatePreset(settings, id, patch, now = Date.now()) {
    const preset = getPresetById(settings, id);
    if (!preset) {
        throw new Error(`Preset not found: ${id}`);
    }
    if (Object.hasOwn(patch || {}, 'promptStyle')) getDefaultPromptValues(patch.promptStyle);
    const allowed = [
        'name',
        'illustrationPrompt',
        'studioPrompt',
        'explorationPrompt',
        'llm',
        'explorationLlm',
        'visualInspection',
        'promptStyle',
    ];
    for (const key of allowed) {
        if (!Object.hasOwn(patch || {}, key)) {
            continue;
        }
        if (key === 'llm' || key === 'explorationLlm') {
            preset[key] = {
                apiPresetName: String(patch[key]?.apiPresetName || ''),
                llmPresetName: String(patch[key]?.llmPresetName || ''),
            };
        } else if (key === 'visualInspection') {
            preset.visualInspection = Boolean(patch.visualInspection);
        } else {
            preset[key] = String(patch[key] ?? '');
        }
    }
    const pending = (preset.pendingStyleDefaults || []).filter(field => !Object.hasOwn(patch || {}, field));
    if (preset.promptStyle) {
        const defaults = getDefaultPromptValues(preset.promptStyle);
        for (const field of pending) {
            if (!preset[field].trim()) preset[field] = defaults[field];
        }
        delete preset.pendingStyleDefaults;
    } else if (pending.length) {
        preset.pendingStyleDefaults = pending;
    } else {
        delete preset.pendingStyleDefaults;
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
