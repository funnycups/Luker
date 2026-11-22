import { MacroRegistry as activeMacroRegistry, MacroCategory } from '../engine/MacroRegistry.js';
import { eventSource, event_types } from '../../events.js';
import { findExtension } from '../../extensions.js';
import { equalsIgnoreCaseAndAccents } from '../../utils.js';

let lastGenerationTypeValue = '';
let lastGenerationTypeTrackingInitialized = false;

function ensureLastGenerationTypeTracking() {
    if (lastGenerationTypeTrackingInitialized) {
        return;
    }
    lastGenerationTypeTrackingInitialized = true;

    try {
        eventSource?.on?.(event_types.GENERATION_STARTED, (type, _params, isDryRun) => {
            if (isDryRun) return;
            lastGenerationTypeValue = type || 'normal';
        });

        eventSource?.on?.(event_types.CHAT_CHANGED, () => {
            lastGenerationTypeValue = '';
        });
    } catch {
        // In non-runtime environments (tests), eventSource may be undefined or not fully initialized.
    }
}

/**
 * Registers macros that depend on runtime application state or event tracking
 * rather than static environment fields.
 */
export function getLastGenerationType() {
    return lastGenerationTypeValue;
}

export function registerStateMacros(MacroRegistry = activeMacroRegistry) {
    if (MacroRegistry === activeMacroRegistry) ensureLastGenerationTypeTracking();

    MacroRegistry.registerMacro('lastGenerationType', {
        category: MacroCategory.STATE,
        description: 'Type of the last queued generation request (e.g. "normal", "impersonate", "regenerate", "quiet", "swipe", "continue"). Empty if none yet or chat was switched.',
        returns: 'Type of the last queued generation request.',
        handler: ({ env }) => env.contextSnapshot ? env.contextSnapshot.lastGenerationType : lastGenerationTypeValue,
    });

    // Macro that checks if an extension is enabled
    MacroRegistry.registerMacro('hasExtension', {
        category: MacroCategory.STATE,
        unnamedArgs: [{
            name: 'extensionName',
            type: 'string',
            description: 'The name of the extension to check',
        }],
        description: 'Checks if a specific extension is enabled. If the extension does not exist, returns false.',
        returns: 'true if the extension is enabled, false otherwise.',
        handler: ({ unnamedArgs: [extensionName], env }) => {
            const extension = env.contextSnapshot
                ? env.contextSnapshot.extensions.find(extension => equalsIgnoreCaseAndAccents(extension.name, extensionName)
                    || equalsIgnoreCaseAndAccents(extension.name, `third-party/${extensionName}`))
                : findExtension(extensionName);
            return String(extension?.enabled ?? false);
        },
    });
}
