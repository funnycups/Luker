// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { createRunStore, createRunPanel } from '/scripts/run-panel/index.js';

/**
 * Build the search-tools run panel. One isolated store per call; the panel
 * auto-opens on a non-quiet RUN_STARTED, matching the orchestrator.
 */
export function createSearchRunPanel({ t }) {
    const store = createRunStore();
    const panel = createRunPanel({
        store,
        t,
        idPrefix: 'luker-search-tools-run-panel',
        autoOpen: true,
        modeLabels: { search: t('Search') },
        exportFilename: ({ runId }) => `search-agent-run-${runId}.json`,
    });
    return {
        store,
        init: () => panel.init(),
        open: () => panel.open(),
        destroy: () => panel.destroy(),
    };
}
