/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import './_mocks/luker-zh.js';
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mountMemoryLens } from '../../../public/scripts/extensions/memory-graph/lens/app.js';

describe('Memory Lens unsaved-changes propagation to topbar and Workbench hostApp', () => {
    let lens = null;

    beforeEach(() => {
        document.body.innerHTML = '';
        globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
    });

    afterEach(() => {
        lens?.destroy?.();
        lens = null;
    });

    test('lights up settings sub-tab dirty dot, reports unsavedCount(), and notifies hostApp.refreshBadges()', async () => {
        const hostApp = {
            refreshBadges: jest.fn(),
            toast: jest.fn(),
            isCompact: () => false,
        };
        const fakeSource = {
            load: jest.fn(async () => ({
                chatKey: 'c1',
                chatLabel: 'Chat 1',
                loadedAt: Date.now(),
                nodes: [],
                edges: [],
                schema: { types: [] },
                columnLabels: {},
                injection: null,
                lastRecall: null,
                tokens: { current: null, entries: [] },
            })),
            settings: {
                read: () => ({
                    values: {
                        enabled: true,
                        autoExtractionEnabled: true,
                        autoCompressionEnabled: true,
                        recallEnabled: true,
                        recallMethod: 'llm',
                        recallInjectPosition: 1,
                        recallInjectDepth: 4,
                        recallInjectRole: 0,
                    },
                    options: {
                        connections: [],
                        presets: [],
                        embeddingProfiles: [],
                        rerankProfiles: [],
                        positions: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
                        roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
                        compressibleTypes: [],
                    },
                    advanced: {
                        values: {
                            updateEvery: 2,
                            extractBatchTurns: 2,
                            extractContextTurns: 2,
                            extractExcludeRecentTurns: 0,
                            extractMode: 'oneshot',
                            llmVisibleRecentMessages: 5,
                            persistentInjectionMaxSeqDistance: 0,
                        },
                        defaults: {
                            updateEvery: 2,
                            extractBatchTurns: 2,
                            extractContextTurns: 2,
                            extractExcludeRecentTurns: 0,
                            extractMode: 'oneshot',
                            llmVisibleRecentMessages: 5,
                        },
                        scope: 'global',
                        hasAvatar: false,
                        hasOverride: false,
                        avatar: '',
                        characterName: '',
                    },
                }),
                set: (_k, v) => v,
                saveAdvanced: jest.fn(async () => {}),
                clearAdvanced: jest.fn(async () => {}),
                subscribe: () => () => {},
            },
            ops: {
                status: () => '',
                onStatus: () => () => {},
                stats: () => ({ nodeCount: 0, edgeCount: 0, messageCount: 0, sourceMessageCount: 0, levelCount: { semantic: 0 } }),
            },
        };

        const host = document.createElement('div');
        document.body.appendChild(host);
        lens = mountMemoryLens({ source: fakeSource, container: host, hostApp, opts: { subview: 'settings' } });
        await new Promise(r => setTimeout(r, 0));

        expect(lens.unsavedCount()).toBe(0);
        const settingsTabBefore = [...host.querySelectorAll('.ml-viewswitch .lw-seg-btn')].at(-1);
        expect(settingsTabBefore.dataset.dirty).toBeUndefined();

        hostApp.refreshBadges.mockClear();
        host.querySelector('[data-cadence-preset="saver"]').click();

        expect(lens.unsavedCount()).toBe(3);
        expect(hostApp.refreshBadges).toHaveBeenCalled();
        const settingsTabAfter = [...host.querySelectorAll('.ml-viewswitch .lw-seg-btn')].at(-1);
        expect(settingsTabAfter.dataset.dirty).toBe('true');
        expect(settingsTabAfter.querySelector('.lw-dirty-dot')).not.toBeNull();

        host.querySelector('[data-settings-action="discard"]').click();
        expect(lens.unsavedCount()).toBe(0);
        const settingsTabCleared = [...host.querySelectorAll('.ml-viewswitch .lw-seg-btn')].at(-1);
        expect(settingsTabCleared.dataset.dirty).toBeUndefined();
    });

    test('concurrent edits during in-flight saveAdvanced preserve edits across all edit paths and keep focused inputs mounted', async () => {
        const makeState = (overrides = {}) => ({
            values: {
                enabled: true,
                autoExtractionEnabled: true,
                autoCompressionEnabled: true,
                recallEnabled: true,
                recallMethod: 'llm',
                recallInjectPosition: 1,
                recallInjectDepth: 4,
                recallInjectRole: 0,
            },
            options: {
                connections: [],
                presets: [],
                embeddingProfiles: [],
                rerankProfiles: [],
                positions: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
                roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
                compressibleTypes: [],
            },
            advanced: {
                values: {
                    updateEvery: 2,
                    extractBatchTurns: 2,
                    extractContextTurns: 2,
                    extractExcludeRecentTurns: 0,
                    extractMode: 'oneshot',
                    llmVisibleRecentMessages: 5,
                    persistentInjectionMaxSeqDistance: 0,
                    ...overrides,
                },
                defaults: {
                    updateEvery: 2,
                    extractBatchTurns: 2,
                    extractContextTurns: 2,
                    extractExcludeRecentTurns: 0,
                    extractMode: 'oneshot',
                    llmVisibleRecentMessages: 5,
                    persistentInjectionMaxSeqDistance: 0,
                },
                scope: 'global',
                hasAvatar: false,
                hasOverride: false,
                avatar: '',
                characterName: '',
            },
        });

        let persistedAdvanced = {
            updateEvery: 2,
            extractBatchTurns: 2,
            extractContextTurns: 2,
            extractExcludeRecentTurns: 0,
            extractMode: 'oneshot',
            llmVisibleRecentMessages: 5,
            persistentInjectionMaxSeqDistance: 0,
        };
        let resolveSave = null;
        const fakeSource = {
            load: jest.fn(async () => ({
                chatKey: 'c1',
                chatLabel: 'Chat 1',
                loadedAt: Date.now(),
                nodes: [],
                edges: [],
                schema: { types: [] },
                columnLabels: {},
                injection: null,
                lastRecall: null,
                tokens: { current: null, entries: [] },
            })),
            settings: {
                read: () => makeState(persistedAdvanced),
                set: (_k, v) => v,
                saveAdvanced: jest.fn((draft) => new Promise((resolve) => {
                    const snapshot = JSON.parse(JSON.stringify(draft));
                    resolveSave = () => {
                        persistedAdvanced = snapshot;
                        resolve();
                    };
                })),
                clearAdvanced: jest.fn(async () => {}),
                subscribe: () => () => {},
            },
            ops: {
                status: () => '',
                onStatus: () => () => {},
                stats: () => ({ nodeCount: 0, edgeCount: 0, messageCount: 0, sourceMessageCount: 0, levelCount: { semantic: 0 } }),
            },
        };

        const host = document.createElement('div');
        document.body.appendChild(host);
        lens = mountMemoryLens({ source: fakeSource, container: host, opts: { subview: 'settings' } });
        await new Promise(r => setTimeout(r, 0));

        const clickSaveGlobal = () => {
            const btn = [...host.querySelectorAll('.ml-settings-sticky button')].at(-1);
            btn.click();
        };

        // 1. Cadence preset clicked while save is in flight
        clickSaveGlobal();
        host.querySelector('[data-cadence-preset="saver"]').click();
        resolveSave();
        await new Promise(r => setTimeout(r, 0));
        expect(host.querySelector('[data-cadence-preset="saver"]').classList.contains('is-active')).toBe(true);
        expect(lens.unsavedCount()).toBeGreaterThan(0);

        // 2. Custom cadence modal Apply clicked while save is in flight
        clickSaveGlobal();
        host.querySelector('[data-cadence-custom="true"]').click();
        const modalUpdateInput = host.querySelector('.ml-custom-cadence-modal [data-field-key="updateEvery"] input');
        modalUpdateInput.value = '7';
        modalUpdateInput.dispatchEvent(new Event('input', { bubbles: true }));
        host.querySelector('.ml-dialog .ml-schema-modal-foot button:last-child').click();
        resolveSave();
        await new Promise(r => setTimeout(r, 0));
        expect(host.querySelector('[data-cadence-custom="true"]').classList.contains('is-active')).toBe(true);
        expect(lens.unsavedCount()).toBeGreaterThan(0);

        // 3. extractMode select changed while save is in flight
        clickSaveGlobal();
        const modeSelect = host.querySelector('[data-field-key="extractMode"] select');
        modeSelect.value = 'crawl';
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        resolveSave();
        await new Promise(r => setTimeout(r, 0));
        expect(host.querySelector('[data-field-key="extractMode"] select').value).toBe('crawl');
        expect(lens.unsavedCount()).toBeGreaterThan(0);

        // 4. Reset Advanced Settings confirmed while save is in flight
        clickSaveGlobal();
        const resetBtn = [...host.querySelectorAll('.ml-settings-sticky button')]
            .find(btn => btn.textContent.includes('重置高级设置') || btn.textContent.includes('Reset Advanced'));
        resetBtn.click();
        host.querySelector('.ml-dialog .ml-schema-modal-foot button:last-child').click();
        resolveSave();
        await new Promise(r => setTimeout(r, 0));
        expect(host.querySelector('[data-field-key="extractMode"] select').value).toBe('oneshot');
        expect(lens.unsavedCount()).toBeGreaterThan(0);

        // 5. Focused input is NOT torn down during concurrent saveAdvanced refresh
        clickSaveGlobal();
        const horizonInput = host.querySelector('[data-field-key="persistentInjectionMaxSeqDistance"] input');
        horizonInput.focus();
        horizonInput.value = '9';
        horizonInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.activeElement).toBe(horizonInput);
        resolveSave();
        await new Promise(r => setTimeout(r, 0));
        expect(horizonInput.isConnected).toBe(true);
        expect(document.activeElement).toBe(horizonInput);
        expect(horizonInput.value).toBe('9');
        expect(lens.unsavedCount()).toBeGreaterThan(0);
    });
});
