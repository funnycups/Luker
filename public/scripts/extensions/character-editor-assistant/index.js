import { registerOp } from '../../lib/edits/index.js';
import { createCardAppPatchFileOp } from './studio/cardapp-patch-op.js';
import { applyPatch } from './studio/ai-chat.js';
import {
    createLorebookEntryAddOp,
    createLorebookEntryUpdateOp,
    createLorebookEntryRemoveOp,
} from './lorebook-ops.js';

// Register CardApp's custom edits-lib op at module boot so applyEdits()
// knows how to handle 'cardapp_patch_file' Edits emitted by the Path 2
// file-op pipeline (see docs/.../edits-lib.md "Path 2: library-only").
registerOp('cardapp_patch_file', createCardAppPatchFileOp({ applyPatch }));

// Register lorebook-entry ops so commitLorebookOperations → applyEdits can
// dispatch 'lorebook_entry_add' / '_update' / '_remove' emitted by the
// unified editor's normalizeToolCallToEdit. Without these the engine throws
// `applyEdits: unknown op: lorebook_entry_add` on every lorebook Apply.
registerOp('lorebook_entry_add',    createLorebookEntryAddOp());
registerOp('lorebook_entry_update', createLorebookEntryUpdateOp());
registerOp('lorebook_entry_remove', createLorebookEntryRemoveOp());

import './main.js';
