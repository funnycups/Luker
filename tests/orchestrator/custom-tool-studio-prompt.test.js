/**
 * Verify `augmentStudioPromptWithCustomTools` — the read-only intro the
 * Studio AI's system prompt gets when the working profile (or the live
 * Layer-2 extension registry) carries one or more custom tools.
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

    test('no append when both are empty', () => {
        const out = augmentStudioPromptWithCustomTools('base', { customTools: [] }, []);
        expect(out).toBe('base');
    });

    test('handles null profile', () => {
        const out = augmentStudioPromptWithCustomTools('base', null, []);
        expect(out).toBe('base');
    });

    test('handles missing customTools field on profile', () => {
        const out = augmentStudioPromptWithCustomTools('base', {}, []);
        expect(out).toBe('base');
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
        expect(out).toContain('From this profile');
        expect(out).not.toContain('From extensions');
    });

    test('appends extension-only when profile carries no customTools', () => {
        const base = 'sys';
        const ext = [{ name: 'ext_only', mode: 'read', description: 'desc', source: 'extension' }];
        const out = augmentStudioPromptWithCustomTools(base, { customTools: [] }, ext);
        expect(out).toContain('ext_only');
        expect(out).toContain('From extensions');
        expect(out).not.toContain('From this profile');
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
        expect(out).not.toContain('defaultTools.custom');
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
        expect(out).not.toContain('defaultTools.custom');
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
});
