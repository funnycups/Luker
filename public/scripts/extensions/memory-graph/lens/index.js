// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory Lens entry point: registers the embedded 'memory' workspace, AskProvider,
// and SuggestRuleProvider with Workbench, and starts the background tag filter
// and token recorder unless a third-party copy is active.

import { registerLensSharedLocaleData } from '../../../lens-shared/locale-data.js';
import { getCharacterAdvancedOverrideByAvatar, persistCharacterAdvancedOverridePatch } from '../character-overrides.js';
import { getSettings, ensureMemoryStoreLoaded, invalidateLatestRecallSnapshot } from '../main.js';
import { getMemoryGraphReadApi } from '../read-api.js';
import { startTagFilter } from './filter/filter-runtime.js';
import { i18n } from './i18n.js';
import { registerLensLocaleData } from './locale-data.js';
import { createMemoryAskProvider, createMemorySuggestRuleProvider } from './providers.js';
import { startRecorder } from './token-stats.js';

const THIRD_PARTY_COPY = /third-party\/memory-lens$/i;
const getContext = () => Luker.getContext();

let unregisters = [];
let stopBackground = null;
let warnedThirdParty = false;

/** The former third-party copy would run the tag filter and token recorder a second time. */
function thirdPartyCopyActive(ctx) {
    const names = ctx?.listExtensionNames?.() || [];
    const disabled = ctx?.extensionSettings?.disabledExtensions || [];
    return names.some(name => THIRD_PARTY_COPY.test(name) && !disabled.includes(name));
}

export function initMemoryLens() {
    const ctx = getContext();
    const { addLocaleData, workbench } = ctx;
    if (typeof addLocaleData === 'function') {
        registerLensSharedLocaleData(addLocaleData);
        registerLensLocaleData(addLocaleData);
    }

    for (const unreg of unregisters.splice(0)) unreg?.();

    const deps = {
        getSettings,
        ensureMemoryStoreLoaded,
        getMemoryGraphReadApi,
        getCharacterAdvancedOverrideByAvatar,
        persistCharacterAdvancedOverridePatch,
        invalidateLatestRecallSnapshot,
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
        );
    }

    stopBackground?.();
    stopBackground = null;

    if (thirdPartyCopyActive(ctx)) {
        if (!warnedThirdParty) {
            warnedThirdParty = true;
            globalThis.toastr?.warning?.(
                i18n('Please remove the third-party Memory Lens, the built-in one replaces it'),
                i18n('Memory Lens'),
            );
        }
        return;
    }

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
