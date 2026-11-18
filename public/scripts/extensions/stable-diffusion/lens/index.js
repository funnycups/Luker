// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerLensSharedLocaleData } from '../../../lens-shared/locale-data.js';
import { getImageActivityStore } from '../activity.js';
import { i18n } from './i18n.js';
import { mountSdLens } from './app.js';
import { createSdIterateTarget } from './iterate-target.js';
import { createSdAskProvider, createSdSuggestRuleProvider } from './providers.js';

let activeUnregisters = [];

export function initSdLens({
    getContext = () => globalThis.Luker?.getContext?.(),
    imageService = null,
    getRunStore = null,
    comfyBridge = null,
} = {}) {
    const ctx = getContext?.();
    const { addLocaleData, workbench } = ctx || {};

    if (typeof addLocaleData === 'function') {
        registerLensSharedLocaleData(addLocaleData);
    }

    for (const unreg of activeUnregisters.splice(0)) {
        unreg?.();
    }

    const resolveRunStore = typeof getRunStore === 'function'
        ? getRunStore
        : () => {
            try {
                return getImageActivityStore();
            } catch {
                return null;
            }
        };

    if (workbench) {
        if (typeof workbench.registerWorkspace === 'function') {
            activeUnregisters.push(
                workbench.registerWorkspace({
                    id: 'sd',
                    get title() { return i18n('Image Generation'); },
                    icon: 'image',
                    order: 30,
                    tone: 'sd',
                    flush: true,
                    mount(container, { app: hostApp, opts } = {}) {
                        return mountSdLens({
                            container,
                            hostApp,
                            opts,
                            getContext,
                            getRunStore: resolveRunStore,
                            imageService,
                        });
                    },
                }),
            );
        }
        if (typeof workbench.registerIterateTarget === 'function') {
            activeUnregisters.push(
                workbench.registerIterateTarget(createSdIterateTarget(getContext, { comfyBridge })),
            );
        }
        if (typeof workbench.registerAskProvider === 'function') {
            activeUnregisters.push(
                workbench.registerAskProvider(createSdAskProvider(getContext)),
            );
        }
        if (typeof workbench.registerSuggestRuleProvider === 'function') {
            activeUnregisters.push(
                workbench.registerSuggestRuleProvider(createSdSuggestRuleProvider(getContext)),
            );
        }
    }

    return () => {
        for (const unreg of activeUnregisters.splice(0)) {
            unreg?.();
        }
    };
}
