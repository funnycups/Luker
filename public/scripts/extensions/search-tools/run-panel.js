// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { createRunStore } from '/scripts/run-panel/store.js';

/**
 * The search agent's run store. One isolated store per call; Orchestra Lens's
 * run dock is what shows it.
 */
export function createSearchRunPanel() {
    return { store: createRunStore() };
}
