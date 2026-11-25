// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thin wrapper re-exporting lens-shared's fitToViewport with the Workbench
// `--wb-vh` CSS variable name preserved for consumers and tests.

import { fitToViewport as fitToSharedViewport } from '../lens-shared/viewport.js';

export function fitToViewport(root, options = {}) {
    return fitToSharedViewport(root, { vhVar: '--wb-vh', ...options });
}
