/**
 * Re-exports CEA's custom edits-lib ops for lorebook entries from the
 * platform-owned module in workbench/targets/card-world.js.
 */

export {
    createLorebookEntryAddOp,
    createLorebookEntryUpdateOp,
    createLorebookEntryRemoveOp,
} from '../../workbench/targets/card-world.js';
