// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory Lens entry point: registers the embedded 'memory' workspace, AskProvider,
// and SuggestRuleProvider with Workbench, and starts the background tag filter
// and token recorder.

import {
    getCharacterAdvancedOverrideByAvatar,
    getCharacterSchemaOverrideByAvatar,
    getEffectiveNodeTypeSchema,
    getEffectiveSettings,
    getSchemaScopeInfo,
    persistCharacterAdvancedOverridePatch,
    persistCharacterSchemaOverride,
    removeCharacterSchemaOverride,
} from '../character-overrides.js';
import {
    commitGraphUiMutation,
    ensureMemoryStoreLoaded,
    ensureStoreSyncedWithChat,
    getChatKey,
    getDefaultNodeTypeSchema,
    getSettings,
    invalidateLatestRecallSnapshot,
    normalizeNodeTypeSchema,
    readChatRange,
    searchGraphSimilarNodes,
    syncGenerationVisibleHistoryRuntimeRegexScripts,
    syncGraphVectorsAfterMutation,
} from '../main.js';
import { getMemoryGraphReadApi } from '../read-api.js';
import { getMemoryGraphWriteApi } from '../write-api.js';
import { startTagFilter } from './filter/filter-runtime.js';
import { i18n } from './i18n.js';
import { createMemoryConfigTarget, createMemoryGraphTarget } from './iterate-targets.js';
import { createMemoryAskProvider, createMemorySuggestRuleProvider } from './providers.js';
import { startRecorder } from './token-stats.js';

const getContext = () => Luker.getContext();

let unregisters = [];
let stopBackground = null;

export function initMemoryLens() {
    const ctx = getContext();
    const { workbench } = ctx;

    for (const unreg of unregisters.splice(0)) unreg?.();

    const deps = {
        getSettings,
        getDefaultNodeTypeSchema,
        normalizeNodeTypeSchema,
        ensureMemoryStoreLoaded,
        ensureStoreSyncedWithChat,
        commitGraphUiMutation,
        getChatKey,
        syncGraphVectorsAfterMutation,
        readChatRange,
        searchGraphSimilarNodes,
        getMemoryGraphReadApi,
        getMemoryGraphWriteApi,
        getEffectiveSettings,
        getEffectiveNodeTypeSchema,
        getSchemaScopeInfo,
        getCharacterSchemaOverrideByAvatar,
        getCharacterAdvancedOverrideByAvatar,
        persistCharacterSchemaOverride,
        removeCharacterSchemaOverride,
        persistCharacterAdvancedOverridePatch,
        invalidateLatestRecallSnapshot,
        syncGenerationVisibleHistoryRuntimeRegexScripts,
    };

    if (workbench) {
        unregisters.push(
            workbench.registerWorkspace({
                id: 'memory',
                get title() { return i18n('Memory graph'); },
                icon: 'memory',
                order: 10,
                tone: 'memory',
                flush: true,
                mount(container, { app: hostApp, opts } = {}) {
                    let instance = null;
                    let pendingOpts = opts || null;
                    let destroyed = false;
                    const mounting = Promise.all([
                        import('./app.js'),
                        import('./source-luker.js'),
                    ]).then(([{ mountMemoryLens }, { createLukerSource }]) => {
                        if (destroyed) return;
                        instance = mountMemoryLens({
                            source: createLukerSource({
                                onError: (msg) => hostApp?.toast?.(msg, { error: true }),
                            }),
                            container,
                            hostApp,
                            opts: pendingOpts,
                        });
                    }).catch((err) => {
                        console.error('[memory-graph/lens] failed to mount workspace', err);
                        hostApp?.toast?.(String(err?.message || err), { error: true });
                    });
                    return {
                        show(showOpts) {
                            if (instance) instance.show(showOpts);
                            else if (showOpts) pendingOpts = showOpts;
                            void mounting;
                        },
                        hide() {
                            instance?.hide?.();
                        },
                        update(nextOpts) {
                            if (instance) instance.update(nextOpts);
                            else if (nextOpts) pendingOpts = nextOpts;
                        },
                        onEscape: () => instance?.onEscape?.() || false,
                        onSnapshot: () => instance?.onSnapshot?.(),
                        unsavedCount: () => Number(instance?.unsavedCount?.() || 0),
                        destroy() {
                            destroyed = true;
                            instance?.destroy?.();
                            instance = null;
                        },
                    };
                },
            }),
            workbench.registerAskProvider(createMemoryAskProvider(getContext, deps)),
            workbench.registerSuggestRuleProvider(createMemorySuggestRuleProvider(getContext, deps)),
            workbench.registerIterateTarget?.(createMemoryConfigTarget(getContext, deps)),
            workbench.registerIterateTarget?.(createMemoryGraphTarget(getContext, deps)),
        );
    }

    stopBackground?.();
    stopBackground = null;

    const cleanups = [];
    try {
        const stopFilter = startTagFilter(getContext);
        if (typeof stopFilter === 'function') cleanups.push(stopFilter);
    } catch (err) {
        console.warn('[memory-graph/lens] tag filter unavailable', err);
    }
    const stopRec = startRecorder(getContext);
    if (typeof stopRec === 'function') cleanups.push(stopRec);
    stopBackground = () => {
        for (const fn of cleanups.splice(0)) fn?.();
    };
}
