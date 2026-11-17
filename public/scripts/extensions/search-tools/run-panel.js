// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { createRunStore } from '/scripts/run-panel/store.js';

function getRunContext() {
    const ctx = Luker.getContext();
    let chatLabel = '';
    if (ctx?.groupId) {
        const group = (ctx.groups || []).find(g => String(g?.id) === String(ctx.groupId));
        chatLabel = String(group?.name || '');
    } else {
        chatLabel = String(ctx?.name2 || ctx?.characters?.[ctx?.characterId]?.name || '');
    }
    return {
        chatId: String(ctx?.chatId || ctx?.getCurrentChatId?.() || ''),
        chatLabel,
    };
}

/**
 * The search agent's run store. One isolated store per call; attached to
 * Luker's shared Run Panel Dock.
 */
export function createSearchRunPanel() {
    const store = createRunStore();
    let attached = false;

    const attach = () => {
        if (attached) return;
        const ctx = Luker.getContext();
        if (typeof ctx?.runPanel?.attachDock === 'function') {
            ctx.runPanel.attachDock(store, {
                source: 'search',
                getRunContext,
            });
            attached = true;
        }
    };

    attach();

    return {
        store,
        init: () => attach(),
        open: async () => {
            attach();
            await Luker.getContext()?.runPanel?.openRunDock?.();
        },
        destroy: () => {},
    };
}
