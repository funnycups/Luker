// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Registers Workbench's built-in platform IterateTargets.

import { defaultRegistry } from '../registry.js';
import { createPresetTarget } from './preset.js';
import { createCardTarget } from './card.js';
import { createWorldTarget } from './world.js';

export function registerBuiltinTargets(registry = defaultRegistry) {
    const unregisters = [
        registry.registerIterateTarget(createPresetTarget()),
        registry.registerIterateTarget(createCardTarget()),
        registry.registerIterateTarget(createWorldTarget()),
    ];
    return () => {
        for (const unreg of unregisters.splice(0)) {
            unreg?.();
        }
    };
}
