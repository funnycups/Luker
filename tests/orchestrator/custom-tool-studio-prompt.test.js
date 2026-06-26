/**
 * Verify `augmentStudioPromptWithCustomTools` — the per-profile intro
 * the Studio AI's system prompt gets covering visible custom tools +
 * the authoring + discovery tool catalog.
 *
 * Direct unit on the helper. The full `buildAiIterationSystemPrompt`
 * pulls main.js's UI / event surface, which would drag in script.js;
 * we extract the augmentation logic into its own exported helper so
 * jest can exercise it without the browser-only deps.
 */

import { describe, test, expect } from '@jest/globals';

import { augmentStudioPromptWithCustomTools } from '../../public/scripts/extensions/orchestrator/studio-prompt-augment.js';

describe('augmentStudioPromptWithCustomTools', () => {
    test('appends profile + extension tools when present', () => {
        const base = 'You are an iterator.';
        const profile = {
            customTools: [
                { name: 'my_weather', description: 'Get weather', mode: 'read', body: '', simulateBody: '', parameters: {} },
            ],
        };
        const ext = [{ name: 'memory_node_create', mode: 'write', description: 'Create node', source: 'extension' }];
        const out = augmentStudioPromptWithCustomTools(base, profile, ext);
        expect(out).toContain('my_weather');
        expect(out).toContain('memory_node_create');
        expect(out).toContain('tools.custom.');
    });

    test('emits authoring catalog even when both profile + extension lists are empty', () => {
        const out = augmentStudioPromptWithCustomTools('base', { customTools: [] }, []);
        expect(out).not.toBe('base');
        expect(out).toContain('no custom tools yet');
        expect(out).toContain('luker_orch_set_custom_tool');
    });

    test('handles null profile', () => {
        const out = augmentStudioPromptWithCustomTools('base', null, []);
        expect(out).toContain('no custom tools yet');
        expect(out).toContain('luker_orch_set_custom_tool');
    });

    test('handles missing customTools field on profile', () => {
        const out = augmentStudioPromptWithCustomTools('base', {}, []);
        expect(out).toContain('no custom tools yet');
    });

    test('appends profile-only when extension list is empty', () => {
        const base = 'sys';
        const profile = {
            customTools: [
                { name: 'only_profile', description: '', mode: 'write', body: '', simulateBody: '', parameters: {} },
            ],
        };
        const out = augmentStudioPromptWithCustomTools(base, profile, []);
        expect(out).toContain('only_profile');
        expect(out).toContain('Layer-3 tools');
        expect(out).not.toContain('Layer-2 tools');
    });

    test('appends extension-only when profile carries no customTools', () => {
        const base = 'sys';
        const ext = [{ name: 'ext_only', mode: 'read', description: 'desc', source: 'extension' }];
        const out = augmentStudioPromptWithCustomTools(base, { customTools: [] }, ext);
        expect(out).toContain('ext_only');
        expect(out).toContain('Layer-2 tools');
        expect(out).not.toContain('Layer-3 tools on this profile');
    });

    test('renders mode markers per entry', () => {
        const base = 'sys';
        const profile = {
            customTools: [
                { name: 'read_tool', description: '', mode: 'read', body: '', simulateBody: '', parameters: {} },
                { name: 'write_tool', description: '', mode: 'write', body: '', simulateBody: '', parameters: {} },
            ],
        };
        const out = augmentStudioPromptWithCustomTools(base, profile, []);
        expect(out).toContain('read_tool [read]');
        expect(out).toContain('write_tool [write]');
    });

    test('flag path defaults to tools.custom.<name> for loop mode', () => {
        const base = 'sys';
        const profile = {
            customTools: [
                { name: 't1', description: '', mode: 'write', body: '', simulateBody: '', parameters: {} },
            ],
        };
        const out = augmentStudioPromptWithCustomTools(base, profile, [], 'loop');
        expect(out).toContain('`tools.custom.<name>`');
        expect(out).not.toContain('defaultTools.custom.<name>');
        expect(out).not.toContain('spec.defaultTools');
    });

    test('flag path is tools.custom.<name> for director mode', () => {
        const base = 'sys';
        const profile = {
            customTools: [
                { name: 't1', description: '', mode: 'write', body: '', simulateBody: '', parameters: {} },
            ],
        };
        const out = augmentStudioPromptWithCustomTools(base, profile, [], 'director');
        expect(out).toContain('`tools.custom.<name>`');
        expect(out).not.toContain('defaultTools.custom.<name>');
        expect(out).not.toContain('spec.defaultTools');
    });

    test('flag path is defaultTools.custom.<name> for agenda mode', () => {
        const base = 'sys';
        const profile = {
            customTools: [
                { name: 't1', description: '', mode: 'write', body: '', simulateBody: '', parameters: {} },
            ],
        };
        const out = augmentStudioPromptWithCustomTools(base, profile, [], 'agenda');
        expect(out).toContain('`defaultTools.custom.<name>`');
        expect(out).not.toContain('`tools.custom.<name>`');
        expect(out).not.toContain('spec.defaultTools');
    });

    test('flag path is spec.defaultTools.custom.<name> for spec mode', () => {
        const base = 'sys';
        const profile = {
            customTools: [
                { name: 't1', description: '', mode: 'write', body: '', simulateBody: '', parameters: {} },
            ],
        };
        const out = augmentStudioPromptWithCustomTools(base, profile, [], 'spec');
        expect(out).toContain('`spec.defaultTools.custom.<name>`');
        expect(out).not.toContain('`tools.custom.<name>`');
        expect(out).not.toContain('`defaultTools.custom.<name>`');
    });

    test('unknown mode falls back to loop path', () => {
        const base = 'sys';
        const profile = {
            customTools: [
                { name: 't1', description: '', mode: 'write', body: '', simulateBody: '', parameters: {} },
            ],
        };
        const out = augmentStudioPromptWithCustomTools(base, profile, [], 'weird');
        expect(out).toContain('`tools.custom.<name>`');
    });

    test('names every authoring + maintenance tool by exact id', () => {
        const out = augmentStudioPromptWithCustomTools('base', null, []);
        const required = [
            'luker_orch_list_custom_tools',
            'luker_orch_get_custom_tool',
            'luker_orch_set_custom_tool',
            'luker_orch_patch_custom_tool_body',
            'luker_orch_patch_custom_tool_schema',
            'luker_orch_remove_custom_tool',
            'luker_orch_dry_run_custom_tool',
            'luker_ctx_list_keys',
            'luker_ctx_describe',
            'luker_docs_list',
            'luker_docs_read',
        ];
        for (const name of required) {
            expect(out).toContain(name);
        }
    });

    test('does NOT carry the legacy "Do NOT modify customTools[]" prohibition', () => {
        const out = augmentStudioPromptWithCustomTools('base', null, []);
        expect(out).not.toMatch(/Do NOT modify .customTools/);
    });
});
