// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { createRunStore } from '/scripts/run-panel/store.js';

/**
 * The search agent's run store. One isolated store per call; Orchestra Lens's
 * run dock is what shows it.
 */
export function createSearchRunPanel() {
    const store = createRunStore();
    let standalone;
    async function loadDock() {
        const [{ createRecorder }, { createDock }, { accountLocalStorage }, { registerLensLocaleData }] = await Promise.all([
            import('../orchestrator/lens/model/recorder.js'),
            import('../orchestrator/lens/dock/dock.js'),
            import('../lens-shared/current-account.js'),
            import('../orchestrator/lens/locale-data.js'),
        ]);
        const ctx = Luker.getContext();
        registerLensLocaleData(ctx.addLocaleData);
        const style = document.createElement('link');
        style.rel = 'stylesheet';
        style.href = new URL('../orchestrator/lens/style.css', import.meta.url).href;
        document.head.appendChild(style);
        const recorder = createRecorder({
            storage: accountLocalStorage(),
            getRunContext: () => {
                const current = Luker.getContext();
                return { chatId: current.chatId, chatLabel: current.name2 };
            },
        });
        recorder.attach(store, 'search');
        return createDock({ recorder });
    }
    return {
        store,
        standaloneDock() {
            standalone ??= loadDock().catch(error => { standalone = null; throw error; });
            return standalone;
        },
    };
}
