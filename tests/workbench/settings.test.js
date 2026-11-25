/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import { createSettingsPage } from '../../public/scripts/workbench/pages/settings.js';

function flushMicrotasks() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

beforeAll(() => {
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    }
});

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('workbench settings page', () => {
    test('onRegistryUpdate invalidates choices alongside prompts and drops stale async promptInfo results', async () => {
        let resolveFirstMemoryPrompt;
        let promptCallCount = 0;
        let choicesCallCount = 0;
        let currentTargets = [{ id: 'memory', label: 'Memory graph', tone: 'memory' }];
        let currentChoices = {
            connections: ['ConnA'],
            presets: ['plugin-only'],
            native: { memory: { connection: 'OldNativeConn', preset: 'OldNativePreset' } },
            hasPluginOnly: true,
            errors: {},
        };

        const app = {
            settings: () => ({ ai: {}, ask: { sources: {} }, rules: {}, dismissed: {} }),
            saveSettings: jest.fn(),
            toast: jest.fn(),
            iterateTargets: () => currentTargets,
            suggestRuleProviders: () => [],
            source: {
                listAiChoices: jest.fn(async () => {
                    choicesCallCount++;
                    return JSON.parse(JSON.stringify(currentChoices));
                }),
                promptInfo: jest.fn(async (key) => {
                    promptCallCount++;
                    if (key === 'memory' && promptCallCount === 2) {
                        return new Promise((resolve) => { resolveFirstMemoryPrompt = resolve; });
                    }
                    return { from: `fresh:${key}:${promptCallCount}`, custom: false, text: `text:${key}:${promptCallCount}` };
                }),
            },
        };

        const page = createSettingsPage(app);
        document.body.appendChild(page.el);
        page.show();
        await flushMicrotasks();

        // choices loaded once with OldNativeConn
        expect(choicesCallCount).toBe(1);
        expect(page.el.textContent).toContain('OldNativeConn');

        // First loadPrompts() is still blocked on memory promptInfo (#2)
        // Now registry updates with new native AI choice + new prompt info
        currentChoices = {
            connections: ['ConnA'],
            presets: ['plugin-only'],
            native: { memory: { connection: 'NewNativeConn', preset: 'NewNativePreset' } },
            hasPluginOnly: true,
            errors: {},
        };
        page.onRegistryUpdate();
        await flushMicrotasks();

        // choices was invalidated and reloaded with NewNativeConn
        expect(choicesCallCount).toBe(2);
        expect(page.el.textContent).toContain('NewNativeConn');
        expect(page.el.textContent).not.toContain('OldNativeConn');

        // Fresh promptInfo should be displayed now
        const freshText = page.el.textContent;
        expect(freshText).toContain('fresh:memory:');

        // Resolve the stale first promptInfo call: it MUST NOT overwrite the newer prompt display
        resolveFirstMemoryPrompt({ from: 'STALE_SOURCE', custom: true, text: 'STALE_PROMPT_TEXT' });
        await flushMicrotasks();

        expect(page.el.textContent).not.toContain('STALE_SOURCE');
        expect(page.el.textContent).not.toContain('STALE_PROMPT_TEXT');
    });

    test('renders the shared block, per-target rows and resolved source', async () => {
        const app = {
            settings: () => ({ ai: { default: {}, memory: {}, memory_graph: {} }, ask: { sources: {} }, rules: {}, dismissed: {} }),
            saveSettings: jest.fn(),
            toast: jest.fn(),
            iterateTargets: () => [
                { id: 'memory', label: 'Memory graph config', tone: 'memory' },
                { id: 'memory_graph', label: 'Memory graph content', tone: 'memory' },
            ],
            suggestRuleProviders: () => [],
            source: {
                listAiChoices: jest.fn(async () => ({
                    connections: ['ConnA'],
                    presets: ['plugin-only', 'NativePreset'],
                    native: {
                        memory: { connection: '', preset: 'NativePreset' },
                        memory_graph: { connection: '', preset: 'NativePreset' },
                    },
                    hasPluginOnly: true,
                    errors: {},
                })),
                promptInfo: jest.fn(async () => ({ from: 'test', custom: false, text: 'prompt' })),
            },
        };
        const page = createSettingsPage(app);
        document.body.appendChild(page.el);
        page.show();
        await flushMicrotasks();
        const text = page.el.textContent;
        expect(text).toContain('AI used inside Workbench');
        expect(text).toContain('Shared');
        expect(text).toContain('Not selected, using the bundled example plugin-only');
        expect(text).toContain('Set individually (3 targets)');
        expect(text).toContain('Edit memory graph config');
        expect(text).toContain('Edit memory graph content');
        expect(text).toContain('Memory graph settings · NativePreset');
        expect(text).not.toContain('Plugin settings · NativePreset');
        expect(text).toContain('Luker\'s current connection');
        expect(page.el.querySelector('.wb-ai-actions')).not.toBeNull();
        expect(page.el.querySelector('.wb-ai-targets')).not.toBeNull();
    });
});
