import { registerOp } from '../../lib/edits/index.js';
import { createCardAppPatchFileOp } from './studio/cardapp-patch-op.js';
import { applyPatch } from './studio/ai-chat.js';

// Register CardApp's custom edits-lib op at module boot so applyEdits()
// knows how to handle 'cardapp_patch_file' Edits emitted by the Path 2
// file-op pipeline (see docs/.../edits-lib.md "Path 2: library-only").
registerOp('cardapp_patch_file', createCardAppPatchFileOp({ applyPatch }));

import './main.js';
