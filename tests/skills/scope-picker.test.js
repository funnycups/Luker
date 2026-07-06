import { describe, test, expect, jest } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/skills/i18n.js', () => ({
    ensureSkillI18n: () => {},
}));

describe('scope-picker: listAllOrchPresetScopes', () => {
    test('returns empty array when orchestrator plugin is not loaded', async () => {
        const { listAllOrchPresetScopes } = await import('../../public/scripts/skills/scope-picker.js');
        const context = { extensionSettings: {} };
        expect(listAllOrchPresetScopes(context)).toEqual([]);
    });

    test('enumerates presets across all 4 modes', async () => {
        const { listAllOrchPresetScopes } = await import('../../public/scripts/skills/scope-picker.js');
        const context = {
            extensionSettings: {
                orchestrator: {
                    presetLibraries: {
                        spec: { s1: { name: 'Spec Default' } },
                        agenda: { a1: { name: 'Agenda A' }, a2: { name: 'Agenda B' } },
                        loop: {},
                        director: { d1: { name: 'Director X' } },
                    },
                },
            },
        };
        const result = listAllOrchPresetScopes(context);
        // Sorted by mode alphabetically, then by name alphabetically within mode.
        expect(result).toEqual([
            { mode: 'agenda', name: 'Agenda A' },
            { mode: 'agenda', name: 'Agenda B' },
            { mode: 'director', name: 'Director X' },
            { mode: 'spec', name: 'Spec Default' },
        ]);
    });

    test('skips entries without a name field', async () => {
        const { listAllOrchPresetScopes } = await import('../../public/scripts/skills/scope-picker.js');
        const context = {
            extensionSettings: {
                orchestrator: {
                    presetLibraries: {
                        spec: { s1: { name: 'Good' }, s2: {}, s3: { name: '' } },
                        agenda: {},
                        loop: {},
                        director: {},
                    },
                },
            },
        };
        expect(listAllOrchPresetScopes(context)).toEqual([
            { mode: 'spec', name: 'Good' },
        ]);
    });
});

describe('scope-picker: buildScopePickerHtml with orch-preset kind', () => {
    test('renders orch-preset radio and dropdown when orchPresetScopes is non-empty', async () => {
        const { buildScopePickerHtml } = await import('../../public/scripts/skills/scope-picker.js');
        const html = buildScopePickerHtml({
            title: 'Pick scope',
            t: (s) => s,
            suggestKind: 'orch-preset',
            suggestPreset: '',
            suggestChar: '',
            suggestOrchPreset: { mode: 'director', name: 'RP4' },
            presets: [],
            characters: [],
            orchPresetScopes: [
                { mode: 'director', name: 'RP4' },
                { mode: 'agenda', name: 'Casual' },
            ],
        });
        // Radio present and checked when suggestKind matches
        expect(html).toMatch(/<input type="radio"[^>]*value="orch-preset"[^>]*checked/);
        // Both options rendered with canonical scope-encoded values
        expect(html).toContain('value="orch-preset/director/RP4"');
        expect(html).toContain('value="orch-preset/agenda/Casual"');
        // Suggested tuple is selected
        expect(html).toMatch(/value="orch-preset\/director\/RP4"[^>]*selected/);
        // Sub-row is not hidden when suggestKind === 'orch-preset'
        expect(html).toMatch(/data-skill-scope-row="orch-preset"(?![^>]*hidden)/);
        // Preset and character rows ARE hidden
        expect(html).toMatch(/data-skill-scope-row="preset"[^>]*hidden/);
        expect(html).toMatch(/data-skill-scope-row="character"[^>]*hidden/);
    });

    test('renders empty-state placeholder when orchPresetScopes is empty', async () => {
        const { buildScopePickerHtml } = await import('../../public/scripts/skills/scope-picker.js');
        const html = buildScopePickerHtml({
            title: 'Pick scope',
            t: (s) => s,
            suggestKind: 'global',
            suggestPreset: '',
            suggestChar: '',
            suggestOrchPreset: null,
            presets: [],
            characters: [],
            orchPresetScopes: [],
        });
        // Radio still renders (letting users see the kind exists) but the
        // dropdown falls back to a disabled placeholder — mirrors how preset
        // and character rows handle empty lists.
        expect(html).toMatch(/<input type="radio"[^>]*value="orch-preset"/);
        expect(html).toContain('(no orchestrator presets)');
    });
});
