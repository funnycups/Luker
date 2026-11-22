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
});
