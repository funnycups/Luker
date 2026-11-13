/**
 * Thin extension wrapper over the platform-owned card/world tool catalog and
 * dispatcher (`public/scripts/workbench/targets/card-tools.js`).
 * Keeps `runCeaEditorReadTool`'s legacy `helperApis` fallback wired through
 * `main.js`'s `runCharacterEditorHelperToolCall` for existing CEA callers.
 */

import { runCharacterEditorHelperToolCall } from '../main.js';
import {
    CEA_CARD_FIELD_ENUM,
    isKnownCardField,
    dispatchCeaReadCardFields,
    CONTROL_TOOL_NAMES,
    isCeaEditorControlCall,
    CONTROL_TOOL_DEFS,
    isCeaEditorReadTool,
    buildCeaEditorToolSet,
    normalizeToolCallToEdit,
    runCeaEditorReadTool as platformRunCeaEditorReadTool,
} from '../../../workbench/targets/card-tools.js';

export {
    CEA_CARD_FIELD_ENUM,
    isKnownCardField,
    dispatchCeaReadCardFields,
    CONTROL_TOOL_NAMES,
    isCeaEditorControlCall,
    CONTROL_TOOL_DEFS,
    isCeaEditorReadTool,
    buildCeaEditorToolSet,
    normalizeToolCallToEdit,
};

export async function runCeaEditorReadTool(call, opts = {}) {
    return platformRunCeaEditorReadTool(call, {
        ...opts,
        legacyRunner: opts?.legacyRunner ?? runCharacterEditorHelperToolCall,
    });
}
