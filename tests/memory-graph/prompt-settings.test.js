import { describe, expect, test } from '@jest/globals';
import { installBrowserModuleContext } from '../util/browser-module-context.js';
import * as advancedSettings from '../../public/scripts/extensions/memory-graph/config-iteration/advanced-settings.js';
const {
    ADVANCED_SETTING_DEFAULTS,
    normalizeAdvancedSettings,
    migrateAdvancedPromptSettings,
} = advancedSettings;
import { CONFIG_FIELDS, resolveSettingsForView } from '../../public/scripts/extensions/memory-graph/config-iteration/fields.js';
import { resolveExtractionTemplate } from '../../public/scripts/extensions/memory-graph/prompt-units.js';
import { buildGraphIterSystemPrompt } from '../../public/scripts/extensions/memory-graph/graph-iteration/system-prompt.js';

const promptFields = Object.values(CONFIG_FIELDS).filter(field => field.kind === 'text');

describe('stored advanced prompts', () => {
    test('initializes built-in prompt values instead of empty overrides', () => {
        const settings = normalizeAdvancedSettings({});
        for (const field of promptFields) {
            expect(settings[field.key]).toBe(field.defaultValue);
            expect(ADVANCED_SETTING_DEFAULTS[field.key]).toBe(field.defaultValue);
        }
    });

    test('preserves exact custom text through normalization and display', () => {
        const custom = '  Describe visible details.\n\n';
        const settings = normalizeAdvancedSettings({ extractEdgeRules: custom });
        expect(settings.extractEdgeRules).toBe(custom);
        expect(resolveSettingsForView(settings).extractEdgeRules).toBe(custom);
    });

    test('keeps intentionally cleared current prompts empty', () => {
        const settings = normalizeAdvancedSettings({ recallRouteSystemPrompt: '' });
        expect(settings.recallRouteSystemPrompt).toBe('');
        expect(resolveSettingsForView(settings).recallRouteSystemPrompt).toBe('');
    });

    test('migrates old blank prompts once without replacing custom text', () => {
        expect(typeof migrateAdvancedPromptSettings).toBe('function');
        const settings = { extractTemplate: ' \n', extractEdgeRules: '  User rules.\n' };
        expect(migrateAdvancedPromptSettings(settings)).toBe(true);
        expect(settings.extractTemplate).toBe(CONFIG_FIELDS['settings.extractTemplate'].defaultValue);
        expect(settings.extractEdgeRules).toBe('  User rules.\n');
        settings.extractTemplate = '';
        expect(migrateAdvancedPromptSettings(settings)).toBe(false);
        expect(settings.extractTemplate).toBe('');
    });

    test('migrates only existing prompt overrides in a sparse character scope', () => {
        expect(typeof migrateAdvancedPromptSettings).toBe('function');
        const override = { extractEdgeRules: '', recallQueryMessages: 4 };
        migrateAdvancedPromptSettings(override, { sparse: true });
        expect(override.extractEdgeRules).toBe(CONFIG_FIELDS['settings.extractEdgeRules'].defaultValue);
        expect(override).not.toHaveProperty('extractTemplate');
        expect(override.recallQueryMessages).toBe(4);
    });

    test('rejects a cleared extraction template at execution', () => {
        expect(() => resolveExtractionTemplate({ extractTemplate: '', extractEdgeRules: 'Rules' })).toThrow();
    });

    test('rejects cleared edge instructions at execution', () => {
        expect(() => resolveExtractionTemplate({ extractTemplate: '{{nodes}} {{edges}}', extractEdgeRules: '' })).toThrow();
    });

    test('rejects a cleared graph iteration prompt at execution', () => {
        expect(() => buildGraphIterSystemPrompt({ graphIterSystemPrompt: '' })).toThrow();
    });

    test('internal defaults module owns defaultSettings matching advanced defaults', async () => {
        const env = installBrowserModuleContext({
            constants: {
                promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
                wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
            },
            worldInfoEntry: { template: { position: 0, depth: 4, role: 0 } },
        });
        try {
            const defaults = await import('../../public/scripts/extensions/memory-graph/defaults.js');
            expect(defaults.defaultSettings.nodeTypeSchema).toBe(defaults.defaultNodeTypeSchema);
            for (const [key, value] of Object.entries(ADVANCED_SETTING_DEFAULTS)) {
                expect(defaults.defaultSettings[key]).toBe(value);
            }
        } finally {
            env.restore();
        }
    });
});
